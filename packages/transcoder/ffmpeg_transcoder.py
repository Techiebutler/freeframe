import asyncio
import json
import os
import select
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional
import boto3
from botocore.config import Config
from .base import BaseTranscoder, TranscodeJob, TranscodeResult, VideoMetadata


def parse_probe_metadata(data: dict) -> Optional[VideoMetadata]:
    """Parse ffprobe JSON into the metadata persisted by v1.5.

    Returns None when no video stream exists.  A zero/invalid frame rate stays
    zero rather than inventing a value, and format-level duration is used when
    the video stream does not provide one.
    """
    streams = data.get("streams") or []
    if not streams:
        return None
    stream = streams[0]
    fps = 0.0
    raw_rate = stream.get("r_frame_rate") or ""
    if "/" in raw_rate:
        num, _, den = raw_rate.partition("/")
        try:
            if float(den) != 0:
                fps = float(num) / float(den)
        except ValueError:
            fps = 0.0
    duration = float(stream.get("duration") or 0)
    if not duration:
        duration = float((data.get("format") or {}).get("duration") or 0)
    return VideoMetadata(
        duration_seconds=duration,
        width=int(stream.get("width") or 0),
        height=int(stream.get("height") or 0),
        fps=fps,
    )


# ---------------------------------------------------------------------------
# Hardware-acceleration backend support
# ---------------------------------------------------------------------------
# Selects an ffmpeg acceleration backend at runtime. The container ffmpeg
# (Debian) ships nvenc/qsv/vaapi encoders; the nvidia runtime must expose the
# "video" capability (e.g. NVIDIA_DRIVER_CAPABILITIES=all) for NVENC to load.
# Default is "auto"; an explicit backend falls back to cpu if unavailable.
_BACKEND_CACHE: dict | None = None


def _ffmpeg_has_encoder(encoder: str) -> bool:
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, errors="replace", timeout=30,
        ).stdout
        return encoder in out
    except Exception:
        return False


def _nvidia_available() -> bool:
    try:
        r = subprocess.run(
            ["nvidia-smi", "-L"],
            capture_output=True, text=True, errors="replace", timeout=30,
        )
        return r.returncode == 0 and bool(r.stdout.strip())
    except Exception:
        return False


def _nvenc_supports_temporal_aq() -> bool:
    # -temporal-aq needs NVENC 7 (Turing, CUDA compute capability >= 7.5).
    # Pascal (6.x) and Volta (7.0) parts do NOT support it -- hevc_nvenc fails
    # to open with "Provided device doesn't support required NVENC features".
    # Default to False when detection is inconclusive so an unknown GPU is
    # never broken by enabling an unsupported option.
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader"],
            capture_output=True, text=True, errors="replace", timeout=30,
        ).stdout
    except Exception:
        return False
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            cc = float(".".join(line.split(".")[:2]))
        except Exception:
            continue
        return cc >= 7.5
    return False


def _intel_available() -> bool:
    return os.path.exists("/dev/dri")


def _dovi_profile(stream: dict) -> int | None:
    """Return the Dolby Vision profile, if the stream carries one.

    Profile 5 is the IPT-only form with no usable HDR base layer and must go
    through libplacebo. Profiles with a base layer (including the iPhone's
    profile 8 HLG files and profile 7 HDR10 files) should use the normal HDR
    hardware path so NVDEC/NVENC remains active.
    """
    for sd in stream.get("side_data_list", []) or []:
        if not isinstance(sd, dict) or sd.get("dv_profile") is None:
            continue
        try:
            return int(sd["dv_profile"])
        except (TypeError, ValueError):
            return None
    return None


def _pipeline_to_backend(pipeline: str | None) -> str | None:
    """Map the high-level TRANSCODER_PIPELINE knob to an internal backend.

    Software -> cpu, NVIDIA -> nvenc, Intel -> vaapi (QSV can't init on the
    NAS iGPU, so Intel maps to VAAPI). Auto / unknown -> None (caller falls
    through to auto-detection).
    """
    p = (pipeline or "").strip().lower()
    return {"software": "cpu", "cpu": "cpu", "nvidia": "nvenc",
            "intel": "vaapi"}.get(p)


def detect_backend(preferred: str | None = None) -> str:
    # 1) High-level PIPELINE knob (Software / NVIDIA / Intel / Auto)
    pb = _pipeline_to_backend(os.environ.get("TRANSCODER_PIPELINE"))
    if pb == "cpu":
        return "cpu"
    if pb == "nvenc":
        return "nvenc" if (_nvidia_available() and _ffmpeg_has_encoder("hevc_nvenc")) else "cpu"
    if pb == "vaapi":
        return "vaapi" if (_intel_available() and _ffmpeg_has_encoder("hevc_vaapi")) else "cpu"
    # pb is None ("auto" or unset) -> fall through to auto-detection below.

    # 2) Legacy low-level TRANSCODER_BACKEND (nvenc/qsv/vaapi/cpu/auto).
    preferred = (preferred or os.environ.get("TRANSCODER_BACKEND", "auto")).lower()
    if preferred in ("nvidia",):
        return "nvenc" if (_nvidia_available() and _ffmpeg_has_encoder("hevc_nvenc")) else "cpu"
    if preferred in ("intel",):
        return "vaapi" if (_intel_available() and _ffmpeg_has_encoder("hevc_vaapi")) else "cpu"
    if preferred == "cpu":
        return "cpu"
    if preferred == "nvenc":
        return "nvenc" if (_nvidia_available() and _ffmpeg_has_encoder("hevc_nvenc")) else "cpu"
    if preferred == "qsv":
        return "qsv" if (_intel_available() and _ffmpeg_has_encoder("hevc_qsv")) else "cpu"
    if preferred == "vaapi":
        return "vaapi" if (_intel_available() and _ffmpeg_has_encoder("hevc_vaapi")) else "cpu"
    # auto: prefer the dedicated GPU (nvenc), then Intel VAAPI, then CPU.
    # QSV is intentionally skipped in auto on this box: its MFX session won't
    # init on the Gen9 iGPU with the oneVPL stack on Debian trixie (see
    # FREEFRAME.md). VAAPI uses the same silicon and works, so the Intel
    # pipeline maps to VAAPI.
    if _nvidia_available() and _ffmpeg_has_encoder("hevc_nvenc"):
        return "nvenc"
    if _intel_available() and _ffmpeg_has_encoder("hevc_vaapi"):
        return "vaapi"
    return "cpu"


# Per-backend ffmpeg pieces.
_BACKEND_HWACCEL = {
    "nvenc": ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
    "qsv": ["-hwaccel", "qsv", "-init_hw_device", "qsv=qsv", "-hwaccel_output_format", "qsv"],
    "vaapi": ["-hwaccel", "vaapi", "-vaapi_device", "/dev/dri/renderD128", "-hwaccel_output_format", "vaapi"],
    "cpu": [],
}
_BACKEND_SCALE = {
    "nvenc": "scale_cuda",
    "qsv": "scale_qsv",
    "vaapi": "scale_vaapi",
    "cpu": "scale",
}

# Per-backend extra options appended to the scale filter. CUDA defaults to
# bilinear (softest); lanczos (interp_algo=4) crisps text on downscale.
# QSV hq (mode=2) is the high-quality scaling path. VAAPI already defaults to
# hq; CPU scale uses bicubic by default.
_BACKEND_SCALE_OPTS = {
    "nvenc": ":interp_algo=4",
    "qsv": ":mode=2",
    "vaapi": "",
    "cpu": "",
}

# Force the scale-filter output to the desired bit depth so the encoder
# receives a frame it can actually encode. nvenc/qsv/vaapi must be told
# explicitly (10-bit -> p010, 8-bit -> nv12); the software `scale` filter has
# no `format` option, so bit-depth is set at the encoder via -pix_fmt instead.
# Without this, a 10-bit source fed to an 8-bit encoder (e.g. h264_nvenc on a
# GPU that can't do 10-bit H.264) fails with "10 bit encode not supported".
_BACKEND_SCALE_FORMAT = {
    "nvenc": {"10": ":format=p010", "8": ":format=nv12"},
    "qsv":   {"10": ":format=p010", "8": ":format=nv12"},
    "vaapi": {"10": ":format=p010", "8": ":format=nv12"},
    "cpu":   {"10": "", "8": ""},
}

# HDR (HLG/PQ/DOVI) detection + tone-map-to-SDR. The tone-map runs in software
# (zscale -> tonemap -> zscale); on HW backends the frame is re-uploaded to the
# device afterwards, while on the cpu backend it stays in software so HDR works
# on CPU-only / ARM hosts with no GPU. Output is 10-bit (Main10) with Rec.709
# tags when tone-mapped, or the original HDR tags when preserved.
# Detection is transfer-only per upstream review (#127): bt2020 primaries alone
# do not signal HDR (SDR wide-gamut footage carries bt2020 + bt709 transfer).
_HDR_TRANSFERS = {"smpte2084", "arib-std-b67", "smpte2094"}
_HDR_TONEMAP_ALGO = "mobius"
_HDR_UPLOAD = {"nvenc": "_cuda", "vaapi": "", "qsv": "_qsv"}

# NVENC constant-quality (CQ) settings, keyed by output mode.
# This ffmpeg/nvenc build has no "-rc cq" mode and ignores "-rc vbr -cq",
# so constant quality is achieved via "-rc constqp -qp <value>"
# (constant QP). Lower QP = higher quality. The same QP is applied to every
# rendition, so quality stays consistent and bitrate follows content
# complexity (1080p naturally carries more bits than 360p at the same QP).
# Tunable per output mode.
_NVENC_CQ = {
    "h265_10": 24,   # 10-bit HEVC, high quality
    "h264_8":  28,   # 8-bit H.264, smaller files
}

# Output codec / quality selection (TRANSCODER_OUTPUT).
#   h264_8  -> H.264 8-bit, DEFAULT (broad device compatibility, smaller files)
#   h265_10 -> HEVC 10-bit, high quality (opt-in via the env var below)
_OUTPUT_MODES = {
    "h265_10": {"family": "hevc", "ten_bit": True, "quality": "high"},
    "h264_8":  {"family": "h264", "ten_bit": False, "quality": "low"},
}


def get_output_mode() -> str:
    return os.environ.get("TRANSCODER_OUTPUT", "h264_8").lower()


# HDR handling (TRANSCODER_HDR):
#   convert  -> tone-map HDR -> Rec.709 SDR (default; matches prior behaviour)
#   preserve -> keep HDR10/HLG passthrough (10-bit, original colour tags)
def get_hdr_mode() -> str:
    return os.environ.get("TRANSCODER_HDR", "convert").lower()


# Runtime hardware failures that should transparently fall back to software.
# These are environmental (no/!busy device, exhausted VRAM, missing driver
# library), not input-specific, so re-running the same job on the CPU pipeline
# is expected to succeed.
_HW_RUNTIME_FAILURES = (
    "cuda_error_out_of_memory",
    "out of memory",
    "hwaccel initialisation returned error",
    "failed setup for format cuda",
    "no capable devices found",
    "cannot load libnvidia-encode",
    "cannot load libcuda",
    "openencodesessionex failed",
    "no free encoding sessions",
    "function not implemented",
    "failed to create specified hw device",
    "device creation failed",
    "error creating a mfx session",
)


def _is_hw_runtime_failure(err: str) -> bool:
    lowered = (err or "").lower()
    return any(marker in lowered for marker in _HW_RUNTIME_FAILURES)


def _hw_failure_reason(err: str) -> str:
    """First matching hardware-failure marker, for a compact log line."""
    lowered = (err or "").lower()
    for marker in _HW_RUNTIME_FAILURES:
        if marker in lowered:
            return marker
    return "unknown hardware failure"


def get_backend() -> str:
    global _BACKEND_CACHE
    if _BACKEND_CACHE is None:
        _BACKEND_CACHE = {"name": detect_backend()}
    return _BACKEND_CACHE["name"]


def parse_progress_percent(line: str, duration_seconds: float | None) -> int | None:
    """Map one line of ffmpeg `-progress pipe:1` output to a percent, or None.

    ffmpeg emits `out_time_us=<microseconds>` repeatedly and a final
    `progress=end`. Anything else in the block is ignored. 100 is reserved for
    `progress=end` so a rounding error can never report complete early.
    """
    line = line.strip()
    if line == "progress=end":
        return 100
    if not line.startswith("out_time_us="):
        return None
    if not duration_seconds or duration_seconds <= 0:
        return None
    raw = line.split("=", 1)[1].strip()
    try:
        micros = int(raw)
    except ValueError:
        return None  # ffmpeg emits "N/A" before the first frame is written
    if micros < 0:
        return None
    percent = int(micros / 1_000_000 / duration_seconds * 100)
    return max(0, min(99, percent))


class FFmpegTranscoder(BaseTranscoder):
    def __init__(self, s3_client, bucket: str, s3_endpoint: str = None):
        self.s3 = s3_client
        self.bucket = bucket
        self.s3_endpoint = s3_endpoint
    
    def _get_presigned_url(self, s3_key: str, expires_in: int = 7200) -> str:
        """Generate a presigned URL for streaming input to FFmpeg."""
        return self.s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": s3_key},
            ExpiresIn=expires_in,
        )

    def _run_with_progress(
        self,
        cmd: list[str],
        timeout: int | None,
        duration_seconds: float | None,
        on_percent,
        label: str = "ffmpeg",
    ) -> None:
        """Run ffmpeg, reporting percent complete as it goes.

        Separate from _run rather than folded into it: _run is also used for
        ffprobe and for short calls where streaming buys nothing, and this path
        needs Popen, a stderr file and its own timeout handling.

        stderr goes to a temp file rather than a pipe. ffmpeg is chatty, and
        reading stdout while stderr fills its 64KB pipe buffer deadlocks a long
        transcode -- which is exactly the case this feature exists for.
        """
        cmd = [cmd[0], "-progress", "pipe:1", "-nostats", *cmd[1:]]
        last_sent = -1
        timed_out = False
        deadline = (time.monotonic() + timeout) if timeout else None

        with tempfile.TemporaryFile(mode="w+", errors="replace") as err_file:
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=err_file,
            )
            fd = proc.stdout.fileno()
            buf = b""
            try:
                # Deadline-driven select rather than `for line in proc.stdout`.
                # Iterating the pipe blocks until it is closed, and killing the
                # child does not necessarily close it -- any grandchild that
                # inherited the descriptor keeps it open. That turns the 4-hour
                # ceiling into an unbounded hang, which is the exact failure the
                # ceiling exists to stop. Waiting on the descriptor instead means
                # the deadline holds no matter who is holding the pipe.
                while True:
                    if deadline is not None and time.monotonic() >= deadline:
                        timed_out = True
                        break
                    wait_for = 1.0
                    if deadline is not None:
                        wait_for = max(0.0, min(1.0, deadline - time.monotonic()))
                    ready, _, _ = select.select([fd], [], [], wait_for)
                    if ready:
                        chunk = os.read(fd, 65536)
                        if not chunk:
                            break  # EOF: ffmpeg closed stdout
                        buf += chunk
                        *lines, buf = buf.split(b"\n")
                        for raw in lines:
                            percent = parse_progress_percent(
                                raw.decode("utf-8", "replace"), duration_seconds
                            )
                            # Only forward whole-percent advances: ffmpeg emits a
                            # progress block about twice a second, which would be
                            # thousands of Redis publishes on a feature film.
                            if percent is not None and percent > last_sent:
                                last_sent = percent
                                try:
                                    on_percent(percent)
                                except Exception:
                                    pass  # a broken listener must not fail the transcode
                    elif proc.poll() is not None:
                        break  # exited and drained
                if not timed_out:
                    proc.wait()
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                proc.stdout.close()

            if timed_out:
                # Same exception subprocess.run(timeout=...) raises, so callers
                # that already handle it keep working unchanged.
                raise subprocess.TimeoutExpired(cmd, timeout)

            if proc.returncode != 0:
                err_file.seek(0)
                stderr = err_file.read().strip()
                raise RuntimeError(
                    f"{label} exited {proc.returncode}: {stderr or 'no stderr output'}"
                )

    @staticmethod
    def _run(cmd: list[str], timeout: int | None = None, label: str = "ffmpeg") -> str:
        """Run a command, raising RuntimeError with stderr on failure.

        Uses errors='replace' because ffmpeg often echoes input metadata
        (Latin-1 / Shift-JIS) to stderr, which would break strict UTF-8 decode.
        """
        result = subprocess.run(
            cmd, capture_output=True, text=True, errors='replace', timeout=timeout,
        )
        if result.returncode != 0:
            stderr = result.stderr.strip()
            raise RuntimeError(
                f"{label} exited {result.returncode}: {stderr or 'no stderr output'}"
            )
        return result.stdout

    async def get_video_metadata(self, s3_key: str) -> VideoMetadata:
        """Get video metadata using streaming (no full download)."""
        input_url = self._get_presigned_url(s3_key)
        cmd = [
            "ffprobe", "-v", "error", "-print_format", "json",
            "-show_streams", "-select_streams", "v:0", "-show_format", input_url,
        ]
        stdout = self._run(cmd, timeout=120, label="ffprobe")
        meta = parse_probe_metadata(json.loads(stdout))
        if meta is None:
            raise RuntimeError(f"No video stream found in {s3_key}")
        return meta

    async def generate_thumbnails(self, s3_key: str, count: int) -> list[str]:
        """Generate thumbnails at 1 per 10 seconds using streaming input."""
        input_url = self._get_presigned_url(s3_key)
        thumb_dir = tempfile.mkdtemp()
        try:
            cmd = [
                "ffmpeg", "-i", input_url,
                "-vf", "fps=0.1,format=yuvj420p",
                "-q:v", "2",
                f"{thumb_dir}/thumb_%04d.jpg",
            ]
            self._run(cmd, timeout=600, label="ffmpeg")
            return [str(p) for p in sorted(Path(thumb_dir).glob("thumb_*.jpg"))]
        finally:
            shutil.rmtree(thumb_dir, ignore_errors=True)

    async def generate_waveform(self, s3_key: str) -> dict:
        """Generate waveform data for audio visualization using streaming."""
        input_url = self._get_presigned_url(s3_key)
        # Simplified waveform: just return peak data (full waveform extraction is complex)
        return {"samples": [], "peak": 1.0, "source": s3_key}

    async def transcode(self, job: TranscodeJob) -> TranscodeResult:
        """
        Transcode video using streaming input from S3.
        FFmpeg reads directly from presigned URL - no full download needed.
        Only output files are written to disk, reducing disk usage by ~2/3.
        """
        work_dir = Path(tempfile.mkdtemp(prefix=f"transcode_{job.version_id}_"))
        
        # Generate presigned URL for streaming input (2 hour expiry for large files)
        input_url = self._get_presigned_url(job.input_s3_key, expires_in=7200)

        try:
            # 1. Get video metadata via streaming (no download)
            # Note: ffprobe result is used for metadata logging only;
            # _run() already fail-fasts on non-zero exit.
            cmd = [
                "ffprobe", "-v", "error", "-print_format", "json",
                "-show_streams", "-select_streams", "v:0", "-show_format", input_url,
            ]
            vid_info = self._run(cmd, timeout=120, label="ffprobe")
            vid_data = json.loads(vid_info)
            meta = parse_probe_metadata(vid_data)
            _vid_stream = (vid_data.get("streams") or [{}])[0]
            # HDR detection: PQ (smpte2084), HLG (arib-std-b67) transfer.
            # DV (profile 5) is handled separately below. (transfer-only per
            # upstream review #127: bt2020 primaries alone are not an HDR signal.)
            is_hdr = _vid_stream.get("color_transfer") in _HDR_TRANSFERS
            dovi_profile = _dovi_profile(_vid_stream)
            hdr_mode = get_hdr_mode()
            # Profile 5 has no usable base layer, so re-encoding must inverse-map
            # it with libplacebo. DV profiles with HDR/HLG base layers follow the
            # ordinary HDR path and retain hardware decode/scale/encode.
            dv_software = dovi_profile == 5
            tone_map = (is_hdr and hdr_mode == "convert") or dv_software

            # 2. Check if input has an audio stream
            audio_cmd = [
                "ffprobe", "-v", "error", "-print_format", "json",
                "-show_streams", "-select_streams", "a", input_url,
            ]
            audio_result = self._run(audio_cmd, timeout=120, label="ffprobe")
            has_audio = bool(json.loads(audio_result).get("streams"))

            # 3. Build quality ladder based on available qualities
            QUALITY_MAP = {
                "1080p": ("1920:1080", 20),
                "720p": ("1280:720", 22),
                "360p": ("640:360", 26),
            }
            # Filter the ladder against the source resolution so a small
            # source never gets upscaled renditions (upstream #204/#201).
            # force_original_aspect_ratio=decrease prevents distortion but not
            # upscaling, so the ladder itself must be trimmed here.
            requested = [q for q in job.qualities if q in QUALITY_MAP]
            source_height = (meta.height if meta else 0) or 0
            qualities = [
                q for q in requested
                if int(QUALITY_MAP[q][0].split(":")[1]) <= source_height
            ]
            if not qualities and requested:
                # Never emit an empty ladder: keep the smallest requested rung.
                qualities = [min(requested, key=lambda q: int(QUALITY_MAP[q][0].split(":")[1]))]

            primary_backend = get_backend()

            hls_dir = work_dir / "hls"
            hls_dir.mkdir()

            def _build_ffmpeg_cmd(backend: str) -> list[str]:
                """Build the full ffmpeg command for a given backend.

                Kept as a closure so the whole graph (hwaccel, scale filter,
                HDR prefix, encoders, colour tags) is rebuilt consistently when
                a hardware attempt has to fall back to software.
                """
                # DV is tone-mapped via libplacebo and encoded in software (see
                # below), so force the CPU scale filter for it.
                scale_filter = "scale" if dv_software else _BACKEND_SCALE.get(backend, "scale")
                out_mode = _OUTPUT_MODES.get(get_output_mode(), _OUTPUT_MODES["h264_8"])


                # Build filter_complex: split then per-quality scale.
                # force_original_aspect_ratio=decrease preserves aspect (no distortion);
                # the GPU scale filters (scale_cuda/scale_qsv/scale_vaapi) keep the
                # whole pipeline on the hardware device.
                split_outputs = "".join(f"[v{i}]" for i in range(len(qualities)))
                if dv_software:
                    # Dolby Vision profile 5 is IPT-encoded with no usable base
                    # layer. The frames must be inverse-mapped via the RPU, which
                    # only libplacebo knows how to parse, so tone-map to Rec.709
                    # SDR here. This runs on the CPU/Vulkan path and is encoded with
                    # the software encoder (avoids cuda<->vulkan interop); hwaccel
                    # is skipped for DV. Output is bt709 SDR (8- or 10-bit).
                    _lp = "libplacebo=tonemapping=bt.2446a:colorspace=bt709:color_trc=bt709:range=tv"
                    _lp += ":format=yuv420p10le" if out_mode["ten_bit"] else ":format=yuv420p"
                    # libplacebo's colorspace option sets the matrix but can retain
                    # the source's bt2020 primaries in frame metadata.  Normalize
                    # all three Rec.709 tags before the software encoder.
                    _lp += ",setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709"
                    hdr_prefix = f"[v:0]{_lp}[tcpu];"
                    src = "[tcpu]"
                elif is_hdr:
                    # Normalize HDR to 10-bit p010, tone-map to Rec.709 SDR (or keep
                    # the 10-bit HDR frames when preserving), then feed the encoder.
                    # On a hardware backend the source is a hardware frame, so it is
                    # downloaded first (hwdownload) and re-uploaded after the CPU
                    # tone-map (hwupload). On the cpu backend there is no hardware
                    # frame context, so the whole chain stays in software
                    # (no hwdownload/hwupload) -- this is what lets HDR decode work
                    # on CPU-only and ARM self-hosts with no GPU.
                    if backend == "cpu":
                        hdr_prefix = "[v:0]format=p010"
                        if tone_map:
                            hdr_prefix += (",zscale=t=linear:npl=100,format=gbrpf32le,"
                                           f"zscale=p=bt709,tonemap=tonemap={_HDR_TONEMAP_ALGO}:desat=0,"
                                           f"zscale=t=bt709:m=bt709:r=tv,format=yuv420p10le")
                        hdr_prefix += "[tcpu];"
                        src = "[tcpu]"
                    else:
                        hdr_prefix = "[v:0]hwdownload,format=p010"
                        if tone_map:
                            hdr_prefix += (",zscale=t=linear:npl=100,format=gbrpf32le,"
                                           f"zscale=p=bt709,tonemap=tonemap={_HDR_TONEMAP_ALGO}:desat=0,"
                                           f"zscale=t=bt709:m=bt709:r=tv,format=yuv420p10le")
                        hdr_prefix += f"[tcpu];[tcpu]hwupload{_HDR_UPLOAD.get(backend, '')}[t];"
                        src = "[t]"
                else:
                    hdr_prefix = ""
                    src = "[v:0]"
                # Scale-filter suffix: append 10-bit surface forcing when requested.
                scale_extra = _BACKEND_SCALE_OPTS.get(backend, "")
                _sf = _BACKEND_SCALE_FORMAT.get(backend, {}).get(
                    "10" if out_mode["ten_bit"] else "8", "")
                scale_extra += _sf
                if dv_software:
                    # DV runs on the CPU scale filter, which takes no interp_algo
                    # or format option; the libplacebo prefix already set the target
                    # bit depth and the software encoder sets -pix_fmt itself.
                    scale_extra = ""
                filter_complex = f"{hdr_prefix}{src}split={len(qualities)}{split_outputs};"
                filter_complex += ";".join(
                    f"[v{i}]{scale_filter}={QUALITY_MAP[q][0]}:force_original_aspect_ratio=decrease:force_divisible_by=2{scale_extra}[{q}]"
                    for i, q in enumerate(qualities)
                )

                ffmpeg_cmd = ["ffmpeg", "-y"]
                if not dv_software:
                    ffmpeg_cmd += _BACKEND_HWACCEL.get(backend, [])
                ffmpeg_cmd += ["-i", input_url]
                ffmpeg_cmd += ["-filter_complex", filter_complex]

                # Per-backend encoder selection driven by TRANSCODER_OUTPUT.
                family = out_mode["family"]      # "hevc" or "h264"
                ten_bit = out_mode["ten_bit"]    # True=10-bit, False=8-bit
                for i, quality in enumerate(qualities):
                    _, crf = QUALITY_MAP[quality]
                    ffmpeg_cmd += ["-map", f"[{quality}]"]
                    if has_audio:
                        ffmpeg_cmd += ["-map", "a:0"]
                    if backend == "cpu" or dv_software:
                        enc = "libx265" if family == "hevc" else "libx264"
                        ffmpeg_cmd += [f"-c:v:{i}", enc, "-preset", "fast",
                                       "-force_key_frames", "expr:gte(t,n_forced*2)"]
                        if ten_bit:
                            ffmpeg_cmd += ["-pix_fmt", "yuv420p10le", "-crf", str(crf - 4)]
                        else:
                            ffmpeg_cmd += ["-pix_fmt", "yuv420p", "-crf", str(crf + 4)]
                    elif backend == "nvenc":
                        enc = "hevc_nvenc" if family == "hevc" else "h264_nvenc"
                        cq = _NVENC_CQ.get(get_output_mode(), 26)
                        ffmpeg_cmd += [f"-c:v:{i}", enc, "-preset", "p6", "-rc", "constqp",
                                       "-qp", str(cq), "-force_key_frames", "expr:gte(t,n_forced*2)"]
                        if family == "hevc":
                            ffmpeg_cmd += ["-profile:v", "main10" if ten_bit else "main"]
                        else:
                            ffmpeg_cmd += ["-profile:v", "high"]
                    elif backend == "qsv":
                        enc = "hevc_qsv" if family == "hevc" else "h264_qsv"
                        ffmpeg_cmd += [f"-c:v:{i}", enc, "-global_quality", str(crf),
                                       "-look_ahead", "1",
                                       "-force_key_frames", "expr:gte(t,n_forced*2)"]
                    elif backend == "vaapi":
                        enc = "hevc_vaapi" if family == "hevc" else "h264_vaapi"
                        ffmpeg_cmd += [f"-c:v:{i}", enc, "-global_quality", str(crf),
                                       "-force_key_frames", "expr:gte(t,n_forced*2)"]
                        if family == "hevc":
                            ffmpeg_cmd += ["-profile:v", "main10" if ten_bit else "main"]
                        ffmpeg_cmd += ["-pix_fmt", "p010" if ten_bit else "nv12"]

                # Colour tags: tone-mapped SDR -> Rec.709; preserved HDR -> pass
                # through the source's HDR tags; plain SDR -> no override.
                color_args = []
                if tone_map:
                    # These are output-stream options.  Without the explicit video
                    # stream specifier, FFmpeg can retain bt2020 primaries on HLG
                    # and Dolby Vision renditions even after the filtergraph has
                    # tone-mapped transfer and matrix to Rec.709.
                    for stream_index in range(len(qualities)):
                        color_args += [
                            f"-color_primaries:v:{stream_index}", "bt709",
                            f"-color_trc:v:{stream_index}", "bt709",
                            f"-colorspace:v:{stream_index}", "bt709",
                        ]
                elif is_hdr and hdr_mode == "preserve":
                    for stream_index in range(len(qualities)):
                        color_args += [
                            f"-color_primaries:v:{stream_index}",
                            _vid_stream.get("color_primaries", "bt2020"),
                            f"-color_trc:v:{stream_index}",
                            _vid_stream.get("color_transfer", "smpte2084"),
                            f"-colorspace:v:{stream_index}",
                            _vid_stream.get("color_space", "bt2020nc"),
                        ]
                ffmpeg_cmd += color_args
                segment_dir = hls_dir / "%v"
                ffmpeg_cmd += [
                    "-f", "hls",
                    "-hls_time", "2",
                    "-hls_playlist_type", "vod",
                    "-hls_flags", "independent_segments",
                    "-hls_segment_type", "mpegts",
                    "-master_pl_name", "master.m3u8",
                    "-var_stream_map", " ".join(
                        f"v:{i},a:{i}" if has_audio else f"v:{i}"
                        for i in range(len(qualities))
                    ),
                    "-hls_segment_filename", str(hls_dir / "%v" / "seg_%03d.ts"),
                    str(hls_dir / "%v" / "playlist.m3u8"),
                ]

                # Create per-quality directories
                for q in qualities:
                    (hls_dir / q).mkdir(exist_ok=True)

                # Timeout scales with expected duration - 4 hours for very large files
                return ffmpeg_cmd

            # Try hardware first, then degrade to the software pipeline if the
            # device is unusable at runtime (most commonly another process on the
            # box has exhausted VRAM, so CUDA decode init fails with
            # CUDA_ERROR_OUT_OF_MEMORY). A slow transcode beats a failed asset.
            attempts = [primary_backend]
            if primary_backend != "cpu" and not dv_software:
                attempts.append("cpu")

            backend = primary_backend
            for attempt_index, attempt_backend in enumerate(attempts):
                ffmpeg_cmd = _build_ffmpeg_cmd(attempt_backend)
                try:
                    if job.progress_cb:
                        self._run_with_progress(
                            ffmpeg_cmd,
                            timeout=14400,
                            duration_seconds=(meta.duration_seconds if meta else None),
                            on_percent=job.progress_cb,
                            label="ffmpeg",
                        )
                    else:
                        self._run(ffmpeg_cmd, timeout=14400, label="ffmpeg")
                    backend = attempt_backend
                    break
                except RuntimeError as exc:
                    is_last = attempt_index == len(attempts) - 1
                    if is_last or not _is_hw_runtime_failure(str(exc)):
                        raise
                    print(
                        f"[transcoder] backend '{attempt_backend}' failed at runtime "
                        f"({_hw_failure_reason(str(exc))}); retrying on the software "
                        f"pipeline for {job.input_s3_key}",
                        flush=True,
                    )
                    # Discard any partial HLS output before retrying.
                    shutil.rmtree(hls_dir, ignore_errors=True)
                    hls_dir.mkdir(exist_ok=True)

            # 4. Upload HLS files to S3
            uploaded_keys = []
            for f in hls_dir.rglob("*"):
                if f.is_file():
                    relative = f.relative_to(hls_dir)
                    s3_key = f"{job.output_s3_prefix}/{relative}"
                    content_type, cache_control = self._get_content_type(f.name)
                    self.s3.upload_file(
                        str(f), self.bucket, s3_key,
                        ExtraArgs={"ContentType": content_type, "CacheControl": cache_control},
                    )
                    uploaded_keys.append(s3_key)

            # 5. Generate and upload thumbnail (using streaming URL)
            thumb_path = work_dir / "thumb_0001.jpg"
            thumb_vf = "thumbnail"
            if dv_software:
                thumb_vf += ",libplacebo=tonemapping=bt.2446a:colorspace=bt709:color_trc=bt709:range=tv,format=yuvj420p"
            elif is_hdr:
                # Match the HLS path's full zscale->tonemap->zscale chain so the
                # thumbnail converts BOTH the HDR transfer (PQ/HLG->linear->bt709)
                # AND the wide gamut (bt2020->bt709 primaries). The older short
                # form (tonemap=mobius only) tone-mapped the curve but left
                # bt2020 primaries, producing a washed-out "log on Rec709" look.
                thumb_vf += (
                    ",format=p010,zscale=t=linear:npl=100,format=gbrpf32le,"
                    "zscale=p=bt709,tonemap=tonemap=" + _HDR_TONEMAP_ALGO + ":desat=0,"
                    "zscale=t=bt709:m=bt709:r=tv"
                )
            thumb_vf += ",format=yuvj420p"
            thumb_cmd = [
                "ffmpeg", "-y", "-i", input_url,
                "-vf", thumb_vf, "-q:v", "2", "-frames:v", "1",
                str(work_dir / "thumb_%04d.jpg"),
            ]
            self._run(thumb_cmd, label="ffmpeg")
            thumbnail_key = f"{job.output_s3_prefix}/thumbnail.jpg"
            uploaded_thumb = False
            if thumb_path.exists():
                self.s3.upload_file(
                    str(thumb_path), self.bucket, thumbnail_key,
                    ExtraArgs={"ContentType": "image/jpeg", "CacheControl": "max-age=86400"},
                )
                uploaded_thumb = True

            return TranscodeResult(
                success=True,
                hls_prefix=job.output_s3_prefix,
                thumbnail_keys=[thumbnail_key] if uploaded_thumb else [],
                duration_seconds=(meta.duration_seconds or None) if meta else None,
                width=(meta.width or None) if meta else None,
                height=(meta.height or None) if meta else None,
                fps=(meta.fps or None) if meta else None,
            )

        except Exception as e:
            return TranscodeResult(success=False, error=str(e))
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    @staticmethod
    def _get_content_type(filename: str) -> tuple[str, str]:
        ext = Path(filename).suffix.lower()
        MAP = {
            ".m3u8": ("application/vnd.apple.mpegurl", "no-cache"),
            ".ts": ("video/mp2t", "max-age=31536000"),
            ".jpg": ("image/jpeg", "max-age=86400"),
        }
        return MAP.get(ext, ("application/octet-stream", "no-cache"))
