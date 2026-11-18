import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from collections import deque
from pathlib import Path
from typing import Optional
import boto3
from botocore.config import Config
from .base import (
    BaseTranscoder,
    ProgressCallback,
    TranscodeJob,
    TranscodeResult,
    VideoMetadata,
)

# `-progress` writes `out_time=HH:MM:SS.microseconds`. Parsed in preference to
# `out_time_ms`, which ffmpeg reports in MICROseconds despite the name — a
# long-standing quirk that silently yields a 1000x-off percentage.
_OUT_TIME_RE = re.compile(r"^out_time=(\d+):(\d\d):(\d\d(?:\.\d+)?)$")

# Don't flood Redis/SSE: a 22-minute video emits progress twice a second.
PROGRESS_MIN_INTERVAL_S = 3.0
HLS_DURATION_ABSOLUTE_TOLERANCE_SECONDS = 5.0
HLS_DURATION_RELATIVE_TOLERANCE = 0.02

log = logging.getLogger("freeframe.transcoder")


def parse_probe_metadata(data: dict) -> Optional[VideoMetadata]:
    """Parse ffprobe JSON (-show_streams -show_format) into VideoMetadata.

    Returns None when there is no video stream. Guards r_frame_rate "0/0"
    (fps stays 0.0 — never fabricate a rate) and falls back to format-level
    duration when the stream lacks one (common for MKV/WebM).
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


# x264 presets, slowest to fastest. A faster preset spends less CPU per frame and
# produces a slightly larger file at the SAME visual quality, because the rate
# control here is CRF (constant quality), not a fixed bitrate. On CPU-bound hosts
# that is the trade you want: encoding is the bottleneck, disk is not.
X264_PRESETS = (
    "placebo", "veryslow", "slower", "slow", "medium",
    "fast", "faster", "veryfast", "superfast", "ultrafast",
)
DEFAULT_X264_PRESET = "veryfast"
_URL_RE = re.compile(r"https?://\S+")
_DIAGNOSTIC_TAIL_MAX_CHARS = 2_000


# Seconds between forced keyframes in the HLS ladder. Review players scrub with
# `fastSeek`, which lands on the nearest keyframe, so this interval is exactly
# how far apart the frames shown while dragging the progress bar are. 1s gives
# twice the scrub resolution of the former 2s for a few percent more bytes.
DEFAULT_HLS_KEYFRAME_INTERVAL = 1.0
MIN_HLS_KEYFRAME_INTERVAL = 0.25
MAX_HLS_KEYFRAME_INTERVAL = 2.0


def resolve_keyframe_interval() -> float:
    """Read HLS_KEYFRAME_INTERVAL (seconds), clamped to a sane range.

    An unparsable value falls back to the default rather than failing every
    encode. Values above 2s are capped: segments are 2s long and must start on
    a keyframe for `independent_segments` to hold.
    """
    raw = (os.environ.get("HLS_KEYFRAME_INTERVAL") or "").strip()
    try:
        value = float(raw) if raw else DEFAULT_HLS_KEYFRAME_INTERVAL
    except ValueError:
        return DEFAULT_HLS_KEYFRAME_INTERVAL
    if value != value:  # NaN
        return DEFAULT_HLS_KEYFRAME_INTERVAL
    return max(MIN_HLS_KEYFRAME_INTERVAL, min(MAX_HLS_KEYFRAME_INTERVAL, value))


def resolve_x264_preset() -> str:
    """Read TRANSCODER_PRESET, falling back to the default when unset or bogus.

    Validated against the allowlist on purpose: an unrecognised preset makes
    ffmpeg exit non-zero, which would fail EVERY video until someone noticed the
    typo. Silently using the default is the safer failure mode here.
    """
    preset = (os.environ.get("TRANSCODER_PRESET") or "").strip().lower()
    return preset if preset in X264_PRESETS else DEFAULT_X264_PRESET


def _safe_diagnostic_tail(lines: deque[str]) -> str:
    """Return bounded FFmpeg context without leaking presigned input URLs."""
    tail = "\n".join(lines).strip()
    tail = _URL_RE.sub("<redacted-url>", tail)
    return tail[-_DIAGNOSTIC_TAIL_MAX_CHARS:]


def validate_hls_output(hls_dir: Path, expected_duration_seconds: float | None) -> dict[str, float]:
    """Validate that every generated HLS rendition is complete and playable.

    FFmpeg can exit successfully after an upstream HTTP stream ends early.  In
    that case the HLS files look valid enough to upload, but the resulting VOD
    silently ends after its first few segments.  Treating a materially shorter
    playlist as a failed transcode keeps that partial output out of the viewer.
    """
    playlists = sorted(hls_dir.glob("*/playlist.m3u8"))
    if not playlists:
        raise RuntimeError("ffmpeg produced no HLS media playlists")

    durations: dict[str, float] = {}
    for playlist in playlists:
        try:
            lines = playlist.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            raise RuntimeError(f"could not read HLS playlist {playlist}") from exc

        if "#EXT-X-ENDLIST" not in lines:
            raise RuntimeError(f"HLS playlist {playlist.name} is incomplete (missing ENDLIST)")

        duration = 0.0
        segment_count = 0
        for line in lines:
            if not line.startswith("#EXTINF:"):
                continue
            value = line.removeprefix("#EXTINF:").split(",", 1)[0]
            try:
                segment_duration = float(value)
            except ValueError as exc:
                raise RuntimeError(f"HLS playlist {playlist.name} has an invalid segment duration") from exc
            if segment_duration <= 0:
                raise RuntimeError(f"HLS playlist {playlist.name} has a non-positive segment duration")
            duration += segment_duration
            segment_count += 1

        if not segment_count:
            raise RuntimeError(f"HLS playlist {playlist.name} contains no media segments")
        durations[playlist.relative_to(hls_dir).as_posix()] = duration

        if expected_duration_seconds and expected_duration_seconds > 0:
            tolerance = max(
                HLS_DURATION_ABSOLUTE_TOLERANCE_SECONDS,
                expected_duration_seconds * HLS_DURATION_RELATIVE_TOLERANCE,
            )
            if abs(duration - expected_duration_seconds) > tolerance:
                raise RuntimeError(
                    f"HLS playlist {playlist.name} duration {duration:.3f}s does not match "
                    f"source duration {expected_duration_seconds:.3f}s (tolerance {tolerance:.3f}s)"
                )

    return durations


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

    @staticmethod
    def _run_with_progress(
        cmd: list[str],
        duration_seconds: float,
        on_progress: Optional[ProgressCallback],
        timeout: int | None = None,
        label: str = "ffmpeg",
    ) -> str:
        """Run ffmpeg, reporting completion percentage as it encodes.

        Deliberately separate from `_run` instead of replacing it: `_run` also
        drives both ffprobe calls and the thumbnail pass, and a parsing mistake
        here should not be able to break those.

        stderr is merged into stdout rather than read from a second pipe. Two
        pipes need a draining thread or ffmpeg blocks once a buffer fills; one
        stream cannot deadlock. Log lines simply don't match the progress regex,
        and the last of them are kept for the error message.
        """
        cmd = [*cmd, "-progress", "pipe:1", "-nostats"]
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            bufsize=1,
        )
        tail = deque(maxlen=40)  # only for the failure message
        deadline = (time.monotonic() + timeout) if timeout else None
        last_emit = 0.0
        last_percent = -1.0

        try:
            for line in proc.stdout:
                line = line.strip()
                if line:
                    tail.append(line)

                if deadline and time.monotonic() > deadline:
                    proc.kill()
                    raise RuntimeError(f"{label} exceeded timeout of {timeout}s")

                if not (on_progress and duration_seconds > 0):
                    continue
                match = _OUT_TIME_RE.match(line)
                if not match:
                    continue
                hours, minutes, seconds = match.groups()
                encoded = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
                percent = max(0.0, min(99.0, encoded / duration_seconds * 100))

                now = time.monotonic()
                if percent - last_percent < 1.0 or now - last_emit < PROGRESS_MIN_INTERVAL_S:
                    continue
                last_percent, last_emit = percent, now
                try:
                    on_progress(percent)
                except Exception:
                    pass  # a broken progress sink must never fail the transcode
        finally:
            if proc.stdout:
                proc.stdout.close()

        returncode = proc.wait()
        output = _safe_diagnostic_tail(tail)
        if returncode != 0:
            raise RuntimeError(
                f"{label} exited {returncode}: {output or 'no output captured'}"
            )
        return output

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
                "-vf", "fps=0.1",
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

    async def transcode(
        self,
        job: TranscodeJob,
        progress_callback: Optional[ProgressCallback] = None,
    ) -> TranscodeResult:
        """
        Transcode video using streaming input from S3.
        FFmpeg reads directly from presigned URL - no full download needed.
        Only output files are written to disk, reducing disk usage by ~2/3.
        """
        work_dir = Path(tempfile.mkdtemp(prefix=f"transcode_{job.version_id}_"))
        
        # A full multi-rendition encode may take several hours on a modest
        # self-hosted CPU.  Keep the input URL valid longer than the four-hour
        # ffmpeg timeout so a later HTTP range request cannot see an expired URL.
        input_url = self._get_presigned_url(job.input_s3_key, expires_in=18000)

        try:
            # 1. Get video metadata via streaming (no download)
            cmd = [
                "ffprobe", "-v", "error", "-print_format", "json",
                "-show_streams", "-select_streams", "v:0", "-show_format", input_url,
            ]
            vid_info = self._run(cmd, timeout=120, label="ffprobe")
            meta = parse_probe_metadata(json.loads(vid_info))
            if meta is None:
                # Browsers commonly report audio-only MP4/MPEG containers as
                # video/*.  Do not build an empty HLS ladder and let FFmpeg
                # fail on a missing [v:0] stream; the task will re-route this
                # valid input to the audio pipeline.
                return TranscodeResult(
                    success=False,
                    no_video_stream=True,
                    error=f"No video stream in {job.input_s3_key}",
                )

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
            # qualities = [q for q in job.qualities if q in QUALITY_MAP]
            requested = [q for q in job.qualities if q in QUALITY_MAP]
            source_height = meta.height if meta else 0

            qualities = [
                q for q in requested
                if int(QUALITY_MAP[q][0].split(":")[1]) <= source_height
            ]
            if not qualities and requested:
                qualities = [min(requested, key=lambda q: int(QUALITY_MAP[q][0].split(":")[1]))]
            hls_dir = work_dir / "hls"
            hls_dir.mkdir()

            # Build filter_complex and map args
            # Use force_original_aspect_ratio=decrease to preserve aspect ratio,
            # then pad to even dimensions required by libx264
            split_outputs = "".join(f"[v{i}]" for i in range(len(qualities)))
            filter_complex = f"[v:0]split={len(qualities)}{split_outputs};"
            filter_complex += ";".join(
                f"[v{i}]scale={QUALITY_MAP[q][0]}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2[{q}]"
                for i, q in enumerate(qualities)
            )

            ffmpeg_cmd = [
                "ffmpeg", "-y", "-i", input_url,
                "-filter_complex", filter_complex,
            ]

            preset = resolve_x264_preset()
            keyframe_interval = resolve_keyframe_interval()
            # `:g` keeps "1" rather than "1.0" in the expression.
            keyframe_expr = f"expr:gte(t,n_forced*{keyframe_interval:g})"
            for i, quality in enumerate(qualities):
                scale, crf = QUALITY_MAP[quality]
                ffmpeg_cmd += ["-map", f"[{quality}]"]
                if has_audio:
                    ffmpeg_cmd += ["-map", "a:0"]
                ffmpeg_cmd += [
                    f"-c:v:{i}", "libx264", f"-crf", str(crf), "-preset", preset,
                    "-force_key_frames", keyframe_expr,
                    # Forced keyframes as IDR frames: decoding can restart at
                    # each one, so a scrub never has to walk back further.
                    "-forced-idr", "1",
                ]

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
            ffmpeg_tail = self._run_with_progress(
                ffmpeg_cmd,
                duration_seconds=meta.duration_seconds,
                on_progress=progress_callback,
                timeout=14400,
                label="ffmpeg",
            )

            try:
                playlist_durations = validate_hls_output(
                    hls_dir,
                    meta.duration_seconds,
                )
            except RuntimeError as exc:
                diagnostic = f"; ffmpeg tail: {ffmpeg_tail}" if ffmpeg_tail else ""
                raise RuntimeError(f"{exc}{diagnostic}") from exc
            log.info(
                "HLS output validated for version %s: source=%.3fs renditions=%s",
                job.version_id,
                meta.duration_seconds,
                playlist_durations,
            )

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
            thumb_cmd = [
                "ffmpeg", "-y", "-i", input_url,
                "-vf", "fps=0.1", "-q:v", "2", "-frames:v", "1",
                str(work_dir / "thumb_%04d.jpg"),
            ]
            self._run(thumb_cmd, label="ffmpeg")
            thumbnail_key = f"{job.output_s3_prefix}/thumbnail.jpg"
            if thumb_path.exists():
                self.s3.upload_file(
                    str(thumb_path), self.bucket, thumbnail_key,
                    ExtraArgs={"ContentType": "image/jpeg", "CacheControl": "max-age=86400"},
                )

            return TranscodeResult(
                success=True,
                hls_prefix=job.output_s3_prefix,
                thumbnail_keys=[thumbnail_key],
                duration_seconds=meta.duration_seconds or None,
                width=meta.width or None,
                height=meta.height or None,
                fps=meta.fps or None,
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
