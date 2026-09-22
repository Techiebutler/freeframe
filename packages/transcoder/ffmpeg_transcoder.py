import asyncio
import json
import math
import os
import select
import shutil
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional
import boto3
from botocore.config import Config
from .base import BaseTranscoder, TranscodeJob, TranscodeResult, VideoMetadata


def _stream_start_seconds(stream: dict) -> float:
    """Where a stream's first packet sits on the timeline, or 0.0."""
    try:
        return max(0.0, float(stream.get("start_time")))
    except (TypeError, ValueError):
        return 0.0


def _tag_end_seconds(stream: dict) -> Optional[float]:
    """Seconds from a Matroska `DURATION` stream tag, or None.

    Matroska and WebM carry no per-stream `duration` field; the muxer writes the
    track's extent as a tag instead, formatted `HH:MM:SS.nnnnnnnnn`, optionally
    suffixed with a language (`DURATION-eng`).

    It is an **end timestamp**, not a length: ffmpeg writes zero-to-last-packet,
    so a track whose first frame sits at 3s reports 33s for 30s of picture.
    Measured on a file built for it -- `start_time 3.023`, `DURATION
    00:00:33.023`, 750 packets at 25fps. Hence the name, and hence the
    subtraction wherever this is used as a length.
    """
    for key, value in (stream.get("tags") or {}).items():
        if not key.upper().startswith("DURATION"):
            continue
        parts = str(value).split(":")
        if len(parts) != 3:
            continue
        try:
            hours, minutes, seconds = (float(p) for p in parts)
        except ValueError:
            continue
        total = hours * 3600 + minutes * 60 + seconds
        if total > 0:
            return total
    return None


def parse_probe_metadata(data: dict) -> Optional[VideoMetadata]:
    """Parse ffprobe JSON into the metadata persisted by v1.5.

    Returns None when no video stream exists.  A zero/invalid frame rate stays
    zero rather than inventing a value, and format-level duration is used when
    the video stream does not provide one.

    `duration_seconds` is left exactly as it was -- the video stream's own
    duration where the container publishes one, the format's otherwise -- since
    it is what reaches the database and the comment timecodes, and changing it
    is not this function's business.

    `video_duration_seconds` is new, and is the picture track's length and
    nothing else. None when the file does not say, which is a real answer: the
    two numbers differ whenever another stream outlives the video, and a caller
    that needs the video timeline must not be handed the other one by default.
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
    stream_duration = float(stream.get("duration") or 0) or None
    video_duration = stream_duration
    if video_duration is None:
        tag_end = _tag_end_seconds(stream)
        if tag_end is not None:
            # An end timestamp, so the offset comes off. MP4 and MOV need no
            # such correction: their per-stream `duration` is a track length,
            # measured with `-itsoffset 3` giving start_time 3.0 alongside
            # duration 30.0.
            video_duration = tag_end - _stream_start_seconds(stream)
            if video_duration <= 0:
                video_duration = None
    duration = stream_duration or 0.0
    if not duration:
        duration = float((data.get("format") or {}).get("duration") or 0)
    return VideoMetadata(
        duration_seconds=duration,
        width=int(stream.get("width") or 0),
        height=int(stream.get("height") or 0),
        fps=fps,
        video_duration_seconds=video_duration,
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

# The rungs a deployment can ask for, as scale target and CRF.
#
# Module level rather than local to transcode(), because the names are now
# configuration and something outside this file has to be able to tell a valid
# one from a typo before a job is built.
QUALITY_MAP = {
    "1080p": ("1920:1080", 20),
    "720p": ("1280:720", 22),
    "360p": ("640:360", 26),
}

# What a deployment gets without saying anything. Unchanged behaviour.
DEFAULT_QUALITIES = ("1080p", "720p", "360p")


def rung_height(name: str) -> int:
    """The vertical resolution a rung encodes to (QUALITY_MAP holds `w:h`)."""
    return int(QUALITY_MAP[name][0].split(":")[1])


def parse_qualities(raw: str | None) -> list[str]:
    """Turn a configured rung list into one this transcoder can build.

    Silence is the failure mode worth avoiding here. An unrecognised name used
    to be dropped without a word further down, and a value where *every* name
    was unrecognised produced `split=0` and an empty `-var_stream_map`, which
    ffmpeg rejects -- so a single typo failed every upload, through the retry
    ladder, ending at `failed` with nothing pointing at the setting. The cost of a
    typo should be a line in the log, not every video.

    Falls back rather than refusing to start, matching how an unrecognised
    TRANSCODER_OUTPUT already resolves to its default; the difference is that
    this one says so.
    """
    names = [n.strip() for n in (raw or "").split(",") if n.strip()]
    known = [n for n in names if n in QUALITY_MAP]
    unknown = [n for n in names if n not in QUALITY_MAP]

    if unknown:
        print(
            f"[transcoder] ignoring unknown quality rung(s) {', '.join(unknown)}; "
            f"valid: {', '.join(QUALITY_MAP)}",
            flush=True,
        )
    if not known:
        if names:
            print(
                "[transcoder] no valid quality rung configured; falling back to "
                f"{', '.join(DEFAULT_QUALITIES)}",
                flush=True,
            )
        return list(DEFAULT_QUALITIES)
    # Deduplicated, and ordered as QUALITY_MAP is rather than as typed: the
    # ladder's order decides the variant indices in the manifest.
    return [q for q in QUALITY_MAP if q in known]


# ----------------------------------------------------------------- CPU budget
#
# How much of the machine one transcode may take (TRANSCODER_CPU_LIMIT).
#
# Unset keeps what this has always done: ffmpeg chooses its own thread counts,
# which on a 16-core host works out at about 10.6 cores for the default ladder.
# Trimming the ladder is not a way to get the machine back -- a single rung
# still takes 9.5 -- so an instance that wants to stay responsive while a
# transcode runs has nothing to reach for. A review instance is not a render
# farm: nobody is waiting on the encode with a stopwatch, and finishing later on
# a machine that stays usable is usually the better trade.
#
# Measured on a 16-vCPU host, 20 s of 1080p30, libx264 preset fast:
#
#   3 rungs, unbounded           6.3 s wall   66.9 s CPU   10.6 cores
#   3 rungs, 2 threads each     13.6 s wall   66.5 s CPU    4.9 cores
#   3 rungs, 1 thread each      29.2 s wall   61.6 s CPU    2.1 cores
#
# The middle column is why this is safe to offer: total CPU time barely moves.
# A budget buys wall-clock time, it does not waste work.
#
# It has to be a per-output-stream option. A global `-threads` before `-i` is an
# input option and reaches the decoder; the encoders never see it, and occupancy
# stays at ~11 cores for every value from 1 to 8.
#
# Every thread count below has a `max(1, ...)` floor, and the reason is not that
# ffmpeg refuses a zero. It accepts one everywhere: `-threads 0`, `-threads:v:0
# 0` and `-filter_complex_threads 0` all run to completion, because zero is how
# ffmpeg spells "pick for yourself". Measured on the same host, one 1080p
# encode: `-threads:v:0 0` occupies 7.97 cores, `1` occupies 1.17, `2` occupies
# 2.50. A zero anywhere in the plan therefore does not break the command, it
# silently switches the cap off for that stage -- which is the outcome this
# setting exists to prevent, and the one an operator would never spot.

_CPU_LIMIT_ENV = "TRANSCODER_CPU_LIMIT"


def available_cpus() -> int:
    """Cores this process may actually use, cgroup quota included.

    `os.cpu_count()` reports the host's cores even inside a container with a
    `cpus:` limit, so a deployment that already caps the worker at 4 of 16 and
    then asks for 50% would get 8 -- twice what it has. The quota is read first
    for that reason, affinity second, and the host count only as a last resort.
    """
    for quota_path, period_path in (
        ("/sys/fs/cgroup/cpu.max", None),                                  # cgroup v2
        ("/sys/fs/cgroup/cpu/cpu.cfs_quota_us",
         "/sys/fs/cgroup/cpu/cpu.cfs_period_us"),                          # cgroup v1
    ):
        try:
            raw = Path(quota_path).read_text().strip()
            if period_path is None:
                quota_s, period_s = raw.split()
            else:
                quota_s, period_s = raw, Path(period_path).read_text().strip()
            if quota_s not in ("max", "-1"):
                cores = int(quota_s) / int(period_s)
                # A sub-core quota still gets one thread. Zero would not be a
                # smaller budget, it would be no budget -- see the note above.
                return int(cores) if cores >= 1 else 1
        except (OSError, ValueError):
            pass
    try:
        return len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        return os.cpu_count() or 1


def parse_cpu_budget(raw: str | None, cpu_count: int | None = None) -> Optional[int]:
    """Turn TRANSCODER_CPU_LIMIT into a core count, or None for unbounded.

    Accepts an absolute number of cores ("6") or a share of what is available
    ("50%"). Both shapes are here because operators think in both: someone who
    knows the box says six, someone on a VPS says half. The share also survives
    moving the instance to a different machine, where an absolute number quietly
    means something else.

    An unusable value falls back to unbounded and says so, the way an
    unrecognised TRANSCODER_OUTPUT resolves to its default rather than refusing
    to start. Silence would be the worst outcome here: the setting gets written
    precisely when the machine is already struggling, and an operator who
    mistyped it would watch the same problem continue with no hint why.
    """
    text = (raw or "").strip()
    if not text:
        return None

    total = cpu_count if cpu_count is not None else available_cpus()

    if text.endswith("%"):
        try:
            share = float(text[:-1].strip().replace(",", "."))
        except ValueError:
            share = float("nan")
        # Not-a-number covers both the strings float() rejects and the three it
        # accepts and should not. "nan", "inf" and "infinity" get past a
        # ValueError check and then raise inside round() below, ValueError for
        # NaN and OverflowError for inf, and nothing between there and the job's
        # outer handler catches either -- so one mistyped share failed every
        # upload at 0% with an error that never named this setting, which is the
        # outcome falling back to unbounded exists to prevent.
        if not math.isfinite(share):
            print(f"[transcoder] {_CPU_LIMIT_ENV}={text!r} is not a percentage; "
                  "leaving CPU use unbounded", flush=True)
            return None
        if share <= 0:
            print(f"[transcoder] {_CPU_LIMIT_ENV}={text!r} would leave no cores; "
                  "leaving CPU use unbounded", flush=True)
            return None
        # Rounded, not truncated: on a 2-core box "50%" has to mean 1, and
        # truncation would make every share below one core mean "no limit".
        cores = max(1, round(total * share / 100))
    else:
        try:
            cores = int(text)
        except ValueError:
            print(f"[transcoder] {_CPU_LIMIT_ENV}={text!r} is neither a core count "
                  "nor a percentage; leaving CPU use unbounded", flush=True)
            return None
        if cores < 1:
            print(f"[transcoder] {_CPU_LIMIT_ENV}={text!r} would leave no cores; "
                  "leaving CPU use unbounded", flush=True)
            return None

    if cores >= total:
        # Asking for everything is the same as asking for nothing, and saying so
        # is kinder than letting someone believe a limit is in force.
        print(f"[transcoder] {_CPU_LIMIT_ENV}={text!r} is {cores} of {total} available "
              "core(s); leaving CPU use unbounded", flush=True)
        return None
    return cores


def get_cpu_budget() -> Optional[int]:
    return parse_cpu_budget(os.environ.get(_CPU_LIMIT_ENV))


def thread_plan(budget: Optional[int], rung_count: int) -> Optional[tuple[list[int], int]]:
    """Split a core budget into per-encoder threads plus filter-graph threads.

    Returns None when there is no budget, so the command is built exactly as it
    was before this setting existed.

    The encoders get the budget split between them and the filter graph gets
    half of it. Both numbers are measured, and the graph's share is the one that
    had to be measured twice.

    It was one thread at first, on the strength of a 1080p SDR source where
    capping the graph cost nothing (13.7 s against 13.5 s unbounded). That
    number is real and still reproduces -- and it is a statement about a graph
    that has almost nothing to do, not about this setting. A 4K source scales
    three rungs, and an HDR one tone-maps every frame before the split through
    `zscale, tonemap, zscale`, which are slice-threaded. Pinning the graph at
    one thread serialises exactly the expensive part.

    Measured on 16 cores, three rungs, budget 6, three runs each, spread 1-4%:

        source                 graph=1          graph=3        graph=6
        1080p SDR          16.2 s / 4.44    16.2 s / 4.38   16.5 s / 4.39
        4K, scale only     30.4 s / 2.99    16.2 s / 5.87   10.7 s / 9.02
        4K HDR, tone-map  101.5 s / 1.65    51.1 s / 3.68   30.5 s / 6.44

    Half the budget is the largest share tried that stayed inside the cap on all
    three. The whole budget is 1.5x faster again and overruns it on both 4K sources, by
    0.44 cores on the tone-map graph and by 3.0 on the scaling one. One thread
    holds the cap only by wasting it: the operator granted six cores and the job
    takes 1.65. On the 1080p source, where the first measurement was taken, the
    share makes no measurable difference at all, so nothing is traded away for
    the sources that do need it.

    The graph's threads are not subtracted from the encoders'. Thread counts are
    ceilings on parallelism rather than reservations, and the stages run as a
    pipeline: whichever is slowest holds the others back, so the sum of the
    ceilings is not what the job occupies. On the three sources above, at half
    the budget, what it occupied stayed inside the cap.

    That is a measurement and not a promise, because one stage is inside no
    budget: decoding. A capped job can exceed its cap, and the amount is the
    decoder's CPU time divided by how long the rest of the job runs -- an
    uncapped decoder runs only as fast as the capped stages take frames from it,
    so the same decode is a fraction of a core over a long job and several cores
    over a short one. Measured on 16 cores at a budget of 6, the same 12.5s of
    1080p, three runs each:

        master                decode alone     3 rungs      1 rung
        H.264                  5.8 CPU-s     4.45 cores   5.92 cores
        ProRes 4444 XQ        24.0 CPU-s     5.47 cores   7.70 cores

    Only the last cell is over, and it is over by 28%. The three sources in the
    first table held for the length of their jobs rather than for their codec:
    two of those rows are one ProRes 422 HQ 10-bit master (`4K, scale only` is
    that file with `TRANSCODER_HDR=preserve`), and at half the budget they run
    16.2s and 51.1s, which is long enough to spread even that decode thin. A
    shorter ladder and a faster machine both shrink the divisor, so
    `TRANSCODER_QUALITIES` trimmed to one rung is the configuration where this
    leaks most -- and an upstream report (#390) on an 11-core host, with a real
    NLE export rather than a master built to match one, measured 7.46 cores at
    three rungs where this host measured 5.47.

    Capping the decoder is not the fix. `-threads` before `-i` does reach it, and
    on the full job it moved occupancy by less than the run-to-run spread, here
    and on the reporting host -- not because the decoder is cheap, but because
    the option is a loose bound on a codec that threads on frame and slice
    level: `-threads 2` was measured at 4.61 cores, not 2.

    Every rung keeps at least one thread, so `n` rungs cannot go below `n`
    encoder threads. A budget under the rung count is honoured as closely as it
    can be, and the shortfall is reported rather than quietly rounded away.
    """
    if budget is None or rung_count < 1:
        return None

    base, remainder = divmod(budget, rung_count)
    # The remainder goes to the earliest rungs, which are the largest ones and
    # the slowest to encode.
    per_rung = [max(1, base + (1 if i < remainder else 0)) for i in range(rung_count)]

    if sum(per_rung) > budget:
        print(f"[transcoder] {_CPU_LIMIT_ENV} asks for {budget} core(s) but "
              f"{rung_count} rungs need one thread each; using {sum(per_rung)}",
              flush=True)
    return per_rung, max(1, budget // 2)


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


# Stream copy (TRANSCODER_SOURCE_COPY), off unless a deployment asks for it.
# It only ever applies where the ladder has already resolved to a single
# rendition at the source's own size, so it changes what a transcode costs,
# never what it produces a rendition of.
#
# "The same picture" is only true of a source that survives being remuxed, and
# two properties of a video do not: its display rotation, which lives in the
# container, and its random-access points, which a copy keeps as they are
# instead of making new ones. Both are checked before anything is copied, and
# both fail toward encoding. See the gate in transcode().
_TRUTHY = {"1", "true", "yes", "on"}


def source_copy_enabled() -> bool:
    return os.environ.get("TRANSCODER_SOURCE_COPY", "").strip().lower() in _TRUTHY


# What may be remuxed rather than encoded, kept deliberately narrow.
# `codec_name == "h264"` on its own is not enough: High 10 and High 4:2:2 carry
# the same codec name and play in no browser, and an NLE exports High 10 without
# being asked. The pixel format is what tells them apart, so both are checked.
_BROWSER_SAFE_CODECS = {"h264"}
_BROWSER_SAFE_PIX_FMTS = {"yuv420p", "yuvj420p"}


def is_browser_safe(stream: dict) -> bool:
    """Whether this video stream is already what every browser can play."""
    return (
        stream.get("codec_name") in _BROWSER_SAFE_CODECS
        and stream.get("pix_fmt") in _BROWSER_SAFE_PIX_FMTS
    )


def display_rotation(stream: dict) -> float:
    """Degrees a player is told to rotate this stream by, 0 if none.

    This is the one property of a source that survives encoding and does not
    survive copying, so it has to be checked separately from the pixels. It
    lives in the container as a display matrix rather than in the stream, and
    MPEG-TS has nowhere to carry one, so a remux drops it: a portrait clip off a
    phone or a DSLR is H.264 8-bit 4:2:0 at its own size, passes every other
    condition, and comes out lying on its side, next to a thumbnail that is
    upright because thumbnails are made through a filter graph.

    The encoding path never had to ask, because ffmpeg autorotates whenever a
    filter graph is present and the ladder always has one -- so the rotation is
    baked into the pixels there, and the rendition is upright.

    `rotate` in the stream tags is the older spelling of the same thing and is
    still what some files carry, so both are read.
    """
    for side_data in stream.get("side_data_list") or []:
        if side_data.get("rotation") is not None:
            try:
                return abs(float(side_data["rotation"])) % 360
            except (TypeError, ValueError):
                return 0.0
    tag = (stream.get("tags") or {}).get("rotate")
    if tag is not None:
        try:
            return abs(float(tag)) % 360
        except (TypeError, ValueError):
            return 0.0
    return 0.0


def rung_is_source_size(target: str, width: int, height: int) -> bool:
    """Whether a rung's scale target resolves to the source's own dimensions.

    The ladder applies its `w:h` with `force_original_aspect_ratio=decrease`, so
    the nominal target and what comes out are not the same string whenever the
    source is not 16:9: a 1440x1080 master under `1920:1080` is scaled by a
    factor of exactly 1 and written out at 1440x1080. Comparing the strings
    reads that as a rung to encode, so the copy silently never engaged for
    anything but 16:9 -- a false negative rather than a wrong rendition, but it
    hid the setting from exactly the 4:3 and cinema-ratio masters it was meant
    for.

    The factor is `min(tw/sw, th/sh)`, which is 1 when the box is at least as
    large as the source in both directions and exactly its size in one. Stated
    that way there is no floating-point comparison and no rounding to match
    against `force_divisible_by=2`, which cannot bite when nothing is scaled.
    """
    if not width or not height:
        return False
    try:
        target_width, target_height = (int(v) for v in target.split(":"))
    except ValueError:
        return False
    return (
        target_width >= width
        and target_height >= height
        and (target_width == width or target_height == height)
    )


# The keyframe probe below reads this much of the source, and refuses a copy
# whose sync samples are further apart than this. A copy cannot make keyframes,
# so the master's own spacing *is* the segment length -- `-hls_time` is a floor
# rather than a target on this path. Bounding it here is what keeps a long-GOP
# master from turning into a handful of enormous segments.
_COPY_PROBE_SECONDS = 30.0
_MAX_COPY_SEGMENT_SECONDS = 12.0


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


class TranscodeTruncated(RuntimeError):
    """ffmpeg reported success but wrote less than the source holds.

    Its own type because a truncated result must not be absorbed by the
    fallbacks below. A remux that fails for a reason of its own is worth
    encoding instead; a remux that stopped early is worth *reading again*,
    which is what a task retry does and a fallback does not.

    What does the passing-through is the `except TranscodeTruncated: raise`
    placed ahead of `except RuntimeError` in the attempt loop, not the base
    class. `RuntimeError` is kept only because every other failure the
    transcoder raises is one, and nothing here should be the exception to that.
    """


# How far short of the source the output may fall before it counts as truncated
# rather than rounded. The last segment is cut wherever the frames end, and a
# copy's segment boundaries come from the source's GOP, so an exact match is not
# on offer.
#
# A flat number rather than a share of the duration, because the drift it covers
# is flat. Measured against the video track's own duration on 1-, 10- and
# 40-minute sources, both paths:
#
#     copy    +0.0230s   at every length
#     encode  -0.0400s   at every length
#
# It is a rounding remainder in the last segment, so it does not grow with the
# file. A proportional term would grow anyway -- 24s of blindness on a
# 40-minute master, 36s on an hour -- and buy nothing: 3s is already 75 times
# the largest drift measured.
_TRUNCATION_SLACK_SECONDS = 3.0

# How much of the tail to read when a container publishes no video duration at
# all. Wide enough that the last packet is inside it even when the container's
# own duration is a little off, and bounded so this stays a ranged request
# rather than a second pass over a master that can be tens of gigabytes.
_VIDEO_END_PROBE_SECONDS = 60.0


def hls_output_seconds(hls_dir: Path) -> Optional[float]:
    """How long the longest variant in a finished HLS directory actually is.

    Read from the playlists, which are the only place the muxer records what it
    wrote. Counting segments would not do: their length varies with the frame
    rate, and on the copy path it follows the source's GOP rather than
    `-hls_time`.

    Returns None when there is no playlist at all, which is its own kind of
    failure and is reported as one by the caller.
    """
    longest: Optional[float] = None
    for playlist in sorted(hls_dir.glob("*/playlist.m3u8")):
        try:
            text = playlist.read_text(errors="replace")
        except OSError:
            # A path that matched the glob but cannot be read -- a directory of
            # that name, a dangling symlink. Skipping it leaves the decision to
            # the other variants, or to "no playlist at all", both of which are
            # handled. Letting an OSError out here would escape the attempt
            # loop's RuntimeError handler and burn the fallbacks.
            continue
        total = 0.0
        for line in text.splitlines():
            if not line.startswith("#EXTINF:"):
                continue
            try:
                seconds = float(line.split(":", 1)[1].split(",")[0])
            except ValueError:
                continue  # a malformed line is not a reason to lose the rest
            # `nan` fails every comparison, so a single one would make the whole
            # check accept anything; `inf` does the same by swamping the sum.
            if not math.isfinite(seconds):
                continue
            total += seconds
        longest = total if longest is None else max(longest, total)
    return longest


def refuse_a_truncated_result(
    hls_dir: Path, source_video_seconds: Optional[float], label: str = "ffmpeg"
) -> None:
    """Raise unless the ladder just written is as long as the source's video.

    The argument is the *video track's* duration, not the file's, and the name
    says so because handing it the wrong one is silent and wrong rather than
    loud: `#EXTINF` measures picture, a container's duration is its longest
    stream, and a rough cut whose audio runs past its last frame would be
    refused at 57% while being perfectly intact. `VideoMetadata` carries both
    numbers separately for this reason. None when the source does not say,
    which is not judged -- see below.

    ffmpeg's exit code does not answer this. If the input stops being readable
    at a frame boundary -- a dropped read, an object the store has not finished
    assembling -- the demuxer sees an ordinary end of file, the muxer closes the
    playlist with `#EXT-X-ENDLIST`, and ffmpeg exits 0. Measured on a 31:18
    master cut at three successive frame boundaries: 92.4s, 96.1s and 99.8s of
    output, exit 0 every time, every playlist well-formed. Cut a byte *inside* a
    frame instead and ffmpeg exits 183, which is why this is rare and why it
    survived being rare: the failure that reports itself is the common one.

    A live instance carried such a version for two days. The database had
    `ready` and the source's real duration side by side with 5% of it in the
    bucket, and it took someone dragging the scrubber to the end to notice.

    The source is not what is damaged -- it is whole in the store and the
    download served from it was always complete -- so the remedy is to read it
    again, which is what failing here arranges.
    """
    if not source_video_seconds or source_video_seconds <= 0:
        # Nothing trustworthy to compare against: either probing failed and said
        # so already, or the container does not publish a video-track duration
        # (Matroska without a DURATION tag). Guessing with the container's
        # duration instead is what would refuse intact files, so this declines
        # to judge rather than judging on the wrong number.
        return
    written = hls_output_seconds(hls_dir)
    if written is None:
        # No playlist at all is not judged here. ffmpeg with an HLS muxer either
        # writes one or exits non-zero, so in production this branch means the
        # layout moved, not that a transcode failed -- and failing every asset
        # over a renamed directory is the worse error. `test_the_check_is_wired
        # _into_the_transcode` is what keeps this from being a quiet way for the
        # whole check to stop applying.
        return
    if written < source_video_seconds - _TRUNCATION_SLACK_SECONDS:
        raise TranscodeTruncated(
            f"{label} exited 0 after writing {written:.1f}s of a "
            f"{source_video_seconds:.1f}s source "
            f"({written / source_video_seconds:.0%}); "
            "the read ended early and the result would have been stored as "
            "complete"
        )


# Segments are uploaded by a small pool of threads rather than one after the
# other. A PUT to a remote object store costs most of a round-trip whatever it
# carries, and a 50-minute encode at the default segment length produces on the
# order of 850 of them -- sent serially that is twenty minutes of a worker doing
# nothing but waiting for latency.
#
# Eight because the gain flattens above it, and because botocore's default
# connection pool holds ten: workers never queue for a socket, and the two
# thumbnail PUTs that follow still have room. Raising this without raising
# max_pool_connections on the client would trade waiting on the network for
# waiting on the pool.
_UPLOAD_THREADS = 8


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

    def _copy_probe_windows(self, duration_seconds: float | None) -> list[tuple[float, float]]:
        """Which stretches of the master to inspect, as `(start, length)`.

        The head, always. Plus the tail when the file is longer than one window,
        because the thing the head cannot see is a master built out of parts: a
        slate spliced onto the front, or a lossless join of clips from different
        encoders. Both leave the first window describing something the rest of
        the file is not (#379).

        Two windows is a sample, not a proof. A three-part join whose middle
        piece is the odd one still passes, and a full-file read is the only
        thing that would not. That trade is the whole reason this is bounded:
        the alternative is a second complete pass over a master that can be
        tens of gigabytes, which is the cost this setting exists to avoid.
        """
        head = (0.0, _COPY_PROBE_SECONDS)
        if not duration_seconds or duration_seconds <= _COPY_PROBE_SECONDS:
            return [head]
        return [head, (max(0.0, duration_seconds - _COPY_PROBE_SECONDS), _COPY_PROBE_SECONDS)]

    def _copy_keyframe_refusal(
        self, input_url: str, duration_seconds: float | None = None
    ) -> str | None:
        """Why this source's sync samples make it unsafe to copy, or None.

        A stream copy hands the segmenter whatever random-access points the
        master already carries, so they have to be points a player can actually
        start at. Two ways they are not:

        * **They are not IDRs.** An open-GOP master marks its later
          random-access points with a recovery-point SEI instead, and a segment
          beginning there carries neither the parameter sets nor a clean decode
          point -- every segment after the first decodes to `non-existing PPS 0
          referenced`. Nothing about this fails loudly: the parameter sets live
          in segment 0, so playback from the top works and the job reports
          success. What breaks is seeking, which is what a comment's timecode
          and the scrubber's hover preview both are, and in a review tool
          seeking is the product.
        * **They are too far apart.** `-hls_time` is a floor here, so the
          master's own spacing decides how long a segment is.

        Each window from `_copy_probe_windows` is judged on its own and the
        first complaint wins. Anything that goes wrong in here refuses the copy.
        A refusal costs encode time, which is the thing this setting exists to
        save; the other direction costs an asset nobody can seek in, which is
        worse.
        """
        for start, length in self._copy_probe_windows(duration_seconds):
            refusal = self._copy_window_refusal(input_url, start, length, duration_seconds)
            if refusal:
                return refusal
        return None

    def _copy_window_refusal(
        self, input_url: str, start: float, length: float,
        duration_seconds: float | None,
    ) -> str | None:
        """`_copy_keyframe_refusal` for one window, or None if it looks copyable."""
        where = "" if start <= 0 else f" at {start:g}s"
        interval = f"{start:g}%+{length:g}" if start > 0 else f"%+{length:g}"
        try:
            probed = self._run(
                [
                    "ffprobe", "-v", "error", "-select_streams", "v:0",
                    "-read_intervals", interval,
                    "-show_entries", "packet=pts_time,flags",
                    "-print_format", "json", input_url,
                ],
                timeout=300, label="ffprobe",
            )
            packets = json.loads(probed).get("packets") or []
        except (RuntimeError, ValueError, subprocess.SubprocessError) as exc:
            return f"the keyframe probe failed ({exc})"

        keyframe_times: list[float] = []
        for packet in packets:
            if "K" not in (packet.get("flags") or ""):
                continue
            try:
                keyframe_times.append(float(packet.get("pts_time")))
            except (TypeError, ValueError):
                continue
        keyframe_times.sort()

        if len(keyframe_times) < 2:
            return (
                f"only {len(keyframe_times)} sync sample(s) in {length:g}s{where}, "
                "so segments would be at least that long"
            )

        # The gap running off the end of the window counts too. Taking only the
        # pairwise gaps measures the distance between sync samples and never the
        # distance after the last one, so a master whose keyframes are dense at
        # the head and absent afterwards -- a slate spliced onto a long-GOP body
        # -- reported a fraction of a second and copied into one segment as long
        # as the file (#378). Clamped to the real end so a short source, whose
        # window is mostly past the end of the media, is not refused for silence
        # that is not there.
        window_end = start + length
        if duration_seconds:
            window_end = min(window_end, duration_seconds)
        gaps = [b - a for a, b in zip(keyframe_times, keyframe_times[1:])]
        gaps.append(max(0.0, window_end - keyframe_times[-1]))
        widest_gap = max(gaps)
        if widest_gap > _MAX_COPY_SEGMENT_SECONDS:
            return (
                f"sync samples up to {widest_gap:.1f}s apart{where}, past the "
                f"{_MAX_COPY_SEGMENT_SECONDS:g}s a copied segment may span"
            )

        # Which of those sync samples are IDRs. trace_headers names every NAL
        # unit it parses, which is the only place the distinction is visible:
        # ffprobe reports an open-GOP recovery point as `key_frame=1` and
        # `pict_type=I`, exactly as it reports a real IDR.
        seek = ["-ss", f"{start:g}"] if start > 0 else []
        try:
            traced = subprocess.run(
                [
                    "ffmpeg", "-v", "trace", *seek, "-t", f"{length:g}",
                    "-i", input_url, "-map", "0:v:0", "-c", "copy",
                    "-bsf:v", "trace_headers", "-f", "null", "-",
                ],
                capture_output=True, text=True, errors="replace", timeout=600,
            )
        except subprocess.SubprocessError as exc:
            return f"the keyframe probe failed ({exc})"
        if traced.returncode != 0:
            return f"the keyframe probe failed (ffmpeg exited {traced.returncode})"

        # Only the lines trace_headers itself emitted. `avformat_find_stream_info`
        # decodes a little to identify the stream and logs its own
        # `nal_unit_type: 5(IDR)` from an `[h264 @ ...]` context before
        # trace_headers runs, so counting every occurrence came out exactly one
        # high and the backstop below tolerated one sync sample that was not an
        # IDR (#377). Measured: a closed-GOP file with 15 sync samples prints 15
        # trace_headers lines and 1 h264 line.
        idr_units = recovery_points = traced_lines = 0
        for line in traced.stderr.splitlines():
            if "[trace_headers @" not in line:
                continue
            traced_lines += 1
            if "nal_unit_type: 5(IDR)" in line:
                idr_units += 1
            elif "recovery_frame_cnt" in line:
                recovery_points += 1

        # If trace_headers said nothing at all, the parse this gate rests on did
        # not happen, whatever the exit code says. Refusing is the safe
        # direction and turns any future change in ffmpeg's log spelling into an
        # encode rather than into an unseekable asset (#381).
        if not traced_lines:
            return f"the keyframe probe produced no trace output{where}"

        if recovery_points:
            return (
                f"{recovery_points} recovery point(s) in {length:g}s{where}: this is an "
                "open-GOP master, and a segment starting at one is not seekable"
            )
        if idr_units < len(keyframe_times):
            return (
                f"{idr_units} IDR(s) against {len(keyframe_times)} sync samples{where}: not "
                "every random-access point is one a player can start at"
            )
        return None

    def _probe_expected_video_seconds(
        self, input_url: str, stream: dict, claim: Optional[float]
    ) -> Optional[float]:
        """How much video the source says it holds, when it says it only once.

        FLV publishes no per-stream video duration at all -- not remuxed, not
        re-encoded -- and a Matroska or WebM written to a pipe, which is what a
        live recorder and a browser capture produce, publishes neither that nor
        a `DURATION` tag. Declining for those would leave the check permanently
        inert for a whole family of uploads, which is the shape of bug it exists
        to catch.

        What is left is the container's own duration, and the question is what
        that number is about. One ranged probe of the tail answers it, because
        the three cases look different -- all measured on real files:

            file                 last picture   last packet   container says
            intact FLV               120.0         120.0          120.0
            FLV cut at 30%            35.9          35.9          120.0
            mkv with an audio tail    30.0          90.0           90.0

        A file that does not reach its own claim was cut short, and the claim is
        still what it was supposed to hold. A file that does reach it, with the
        picture ending earlier, has an audio tail and its ladder is complete at
        the picture's length. Only the third shape -- readable to the end, with
        no picture anywhere in the window -- is undecidable, and declines.

        Costs one probe, and only for containers that publish no video duration;
        everything else never reaches here.
        """
        if not claim or claim <= 0:
            return None            # nothing to aim the window at, and no claim
        start = max(0.0, claim - _VIDEO_END_PROBE_SECONDS)
        interval = (f"{start:g}%+{_VIDEO_END_PROBE_SECONDS * 2:g}" if start > 0
                    else f"%+{_VIDEO_END_PROBE_SECONDS * 2:g}")
        try:
            probed = self._run(
                [
                    "ffprobe", "-v", "error",
                    "-read_intervals", interval,
                    "-show_entries", "packet=pts_time,codec_type",
                    "-print_format", "json", input_url,
                ],
                timeout=300, label="ffprobe",
            )
            packets = json.loads(probed).get("packets") or []
        except (RuntimeError, ValueError, subprocess.SubprocessError) as exc:
            # Never fails the transcode on its own: this exists to make a check
            # possible, and a probe that did not work means the check declines,
            # exactly as it did before this existed.
            print(f"[transcoder] could not probe where the video ends: {exc}", flush=True)
            return None

        last_picture: Optional[float] = None
        last_packet: Optional[float] = None
        for packet in packets:
            try:
                moment = float(packet.get("pts_time"))
            except (TypeError, ValueError):
                continue
            last_packet = moment if last_packet is None else max(last_packet, moment)
            if packet.get("codec_type") == "video":
                last_picture = (moment if last_picture is None
                                else max(last_picture, moment))

        offset = _stream_start_seconds(stream)
        if last_packet is None or last_packet < claim - _TRUNCATION_SLACK_SECONDS:
            return (claim - offset) or None        # cut short of its own claim
        if last_picture is None:
            return None                            # readable, but no picture here
        return (last_picture - offset) or None

    def _upload_directory(self, source_dir: Path, s3_prefix: str) -> list[str]:
        """Upload every file under `source_dir` to `s3_prefix`, several at a time.

        This is where a transcode spends time that has nothing to do with
        encoding. Each PUT is dominated by the round-trip rather than by the
        segment, so the worker sits idle for most of the phase; overlapping them
        turns that wait into throughput. Measured against a real master over a
        remote store (~3.9 GB source, HLS output): 197s serially, 65s with the
        pool. The saving is largest exactly where it is felt most -- a long
        encode produces more segments, and a distant store makes each one cost
        more.

        The client is shared across the threads. boto3 clients are thread-safe,
        and HLS segments sit far below the multipart threshold, so each
        `upload_file` is a single PUT that spawns no threads of its own.

        Files are sorted so the returned keys do not depend on directory order,
        and `list()` drains the results inside the pool so a failed upload
        surfaces here rather than being dropped inside a worker.
        """
        files = sorted(f for f in source_dir.rglob("*") if f.is_file())
        if not files:
            return []

        def _upload(path: Path) -> str:
            s3_key = f"{s3_prefix}/{path.relative_to(source_dir)}"
            content_type, cache_control = self._get_content_type(path.name)
            self.s3.upload_file(
                str(path), self.bucket, s3_key,
                ExtraArgs={"ContentType": content_type, "CacheControl": cache_control},
            )
            return s3_key

        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=min(_UPLOAD_THREADS, len(files))) as pool:
            uploaded = list(pool.map(_upload, files))
        print(
            f"[transcoder] uploaded {len(uploaded)} files in "
            f"{time.monotonic() - started:.1f}s",
            flush=True,
        )
        return uploaded

    def _build_download_mp4(
        self,
        hls_dir: Path,
        qualities: list[str],
        work_dir: Path,
        output_prefix: str,
    ) -> Optional[str]:
        """Remux the best rendition's segments into one MP4, for download.

        The ladder is HLS, which is a playlist and a few hundred `.ts` files:
        there is nothing in it that can be handed to someone as "the video", so
        a download had only the camera master to offer — often an order of
        magnitude larger than what the reviewer actually watched, and on a slow
        link a bad default.

        The segments of one variant are a single continuous MPEG-TS stream that
        we encoded ourselves, so this is `-c copy`: no decode, no encode, and
        the same bytes the reviewer streamed. `-movflags +faststart` moves the
        moov atom to the front so the file plays while it is still arriving,
        which is the whole point of downloading a proxy instead of the master.

        It costs one more object per version, about the size of the top rung,
        and the same again on the worker's disk while it is being written.

        Best-effort by design. The ladder is the product; if this fails the
        transcode still succeeded, the caller records no download rung, and the
        download path falls back to the raw master as it always did.
        """
        if not qualities:
            return None
        # `-var_stream_map` carries no `name:` field, so ffmpeg writes variant
        # *i* to a directory named `i`, in the order the rungs were mapped. The
        # tallest rung is the closest thing to what was reviewed.
        best = max(range(len(qualities)), key=lambda i: rung_height(qualities[i]))
        playlist = hls_dir / str(best) / "playlist.m3u8"
        mp4_path = work_dir / "download.mp4"
        key = f"{output_prefix}/download.mp4"
        try:
            self._run(
                [
                    "ffmpeg", "-y",
                    "-i", str(playlist),
                    "-c", "copy",
                    # AAC inside MPEG-TS is ADTS-framed and MP4 wants the bare
                    # stream with an ASC in the sample entry. Recent ffmpeg
                    # inserts this filter itself (7.1 produces byte-identical
                    # output with and without it) and ignores it on a variant
                    # that carries no audio at all, so saying it costs nothing
                    # and keeps the requirement visible.
                    "-bsf:a", "aac_adtstoasc",
                    "-movflags", "+faststart",
                    str(mp4_path),
                ],
                timeout=3600,
                label="ffmpeg",
            )
            self.s3.upload_file(
                str(mp4_path), self.bucket, key,
                ExtraArgs={"ContentType": "video/mp4", "CacheControl": "max-age=86400"},
            )
        except Exception as exc:  # noqa: BLE001 - never fail a good ladder over this
            print(
                f"[transcoder] no download MP4 for {output_prefix}: {exc}",
                flush=True,
            )
            return None
        return key

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
            if meta is None:
                # No video stream. Every rung of the ladder would be filtered
                # out, the "never emit an empty ladder" fallback would re-add
                # one anyway, and ffmpeg would die on `[v:0] matches no
                # streams` -- an error that says nothing about the real cause.
                # Report it as its own outcome so the caller can decide; an
                # audio-only file in a video container is a normal upload, not
                # a broken one.
                return TranscodeResult(
                    success=False,
                    no_video_stream=True,
                    error=f"No video stream in {job.input_s3_key}",
                )
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
            audio_streams = json.loads(audio_result).get("streams") or []
            has_audio = bool(audio_streams)
            # Only the copy path below reads this: AAC is what HLS carries, so
            # it rides along untouched, and anything else (PCM is common out of
            # an NLE) is encoded to AAC, which costs seconds and leaves the
            # picture alone. The encoding path re-encodes audio regardless.
            audio_codec = (audio_streams[0].get("codec_name") or "") if has_audio else ""

            # 3. Build quality ladder based on available qualities
            # Filter the ladder against the source resolution so a small
            # source never gets upscaled renditions (upstream #204/#201).
            # force_original_aspect_ratio=decrease prevents distortion but not
            # upscaling, so the ladder itself must be trimmed here.
            # Guarded here as well as at the configuration boundary: this is the
            # line that turns an unrecognised name into `split=0`, and a job can
            # reach it from any caller, not only from the configured default.
            requested = [q for q in job.qualities if q in QUALITY_MAP] or list(DEFAULT_QUALITIES)
            source_height = (meta.height if meta else 0) or 0
            source_width = (meta.width if meta else 0) or 0

            qualities = [q for q in requested if rung_height(q) <= source_height]
            # What each rung scales to. Its own nominal size, except for the one
            # kept below.
            scale_targets = {q: QUALITY_MAP[q][0] for q in requested}
            if not qualities and requested:
                # Never emit an empty ladder: keep the smallest requested rung,
                # clamped to the source instead of scaled up to its nominal
                # size. Restoring it unchanged is what made
                # `TRANSCODER_QUALITIES=1080p` turn a 640x360 upload into a
                # single upscaled 1920x1080 rendition -- more encode time and
                # more storage than the source itself, and #201 re-entering
                # through configuration. Clamped, a one-rung ladder above the
                # source means "source size", which is the only useful reading
                # of it. Without probed dimensions there is nothing to clamp
                # against, so the rung stands as before.
                smallest = min(requested, key=rung_height)
                qualities = [smallest]
                if source_width and source_height:
                    scale_targets[smallest] = f"{source_width}:{source_height}"

            # 3b. Can this source be shipped as it is, rather than encoded?
            #
            # The ladder above has sometimes resolved to exactly one rendition
            # at the source's own dimensions -- either a rung that matches the
            # source, or the clamp doing it. When that is what is being built
            # and the source is already the format browsers play, the encoder is
            # being asked for a slightly worse copy of what it was handed.
            # Remuxing produces the same picture in minutes instead of hours:
            # measured on a 36 min 1080p H.264 master, 355s against ~55min on
            # six CPU cores.
            #
            # Every condition is required, and together they are what keeps this
            # from being a policy change:
            #   * the deployment asked for it,
            #   * one rendition, at exactly the source's size -- anyone who
            #     configured a real ladder, or a rung below the source, still
            #     gets every rendition they asked for,
            #   * H.264 8-bit 4:2:0, checked on the pixel format and not on the
            #     codec name alone,
            #   * SDR, since HDR and Dolby Vision are the cases the filter graph
            #     exists for,
            #   * no display rotation, which a remux cannot carry, and
            #   * sync samples a player can start at, which costs a probe and so
            #     is asked last, only once everything free has passed.
            #
            # `dovi_profile is None` is redundant against the pixel format, since
            # every Dolby Vision profile is 10-bit and none of them reach
            # yuv420p; it is stated anyway because it is the condition a reader
            # looks for, and because "DV is always 10-bit" is a fact about the
            # format rather than about this code.
            copy_source = (
                source_copy_enabled()
                and len(qualities) == 1
                and rung_is_source_size(
                    scale_targets[qualities[0]], source_width, source_height
                )
                and is_browser_safe(_vid_stream)
                and not is_hdr
                and dovi_profile is None
                and not display_rotation(_vid_stream)
            )

            if copy_source:
                refusal = self._copy_keyframe_refusal(
                    input_url,
                    duration_seconds=(meta.duration_seconds if meta else None),
                )
                if refusal:
                    copy_source = False
                    print(
                        f"[transcoder] {job.input_s3_key} is browser-safe but will be "
                        f"encoded: {refusal}",
                        flush=True,
                    )

            if copy_source:
                print(
                    f"[transcoder] {job.input_s3_key} is already browser-safe "
                    f"({_vid_stream.get('codec_name')}/{_vid_stream.get('pix_fmt')}) and the "
                    f"ladder asks for {source_width}x{source_height}: remuxing, not re-encoding",
                    flush=True,
                )

            primary_backend = "copy" if copy_source else get_backend()

            # Computed once rather than inside _build_ffmpeg_cmd, which runs a
            # second time when a hardware attempt falls back to software: the
            # plan does not depend on the backend, and reporting a shortfall
            # twice for one job would read like two jobs. Computing it for a
            # job that goes on to stream-copy is harmless -- a copy only happens
            # when the ladder has resolved to a single rung, and a single rung
            # is never short of threads.
            cpu_plan = thread_plan(get_cpu_budget(), len(qualities))

            hls_dir = work_dir / "hls"
            hls_dir.mkdir()

            def _build_copy_cmd() -> list[str]:
                """Remux the source into HLS, leaving the video stream alone.

                No filter graph and no encoder: the frames written out are the
                ones that were uploaded, so there is no scale target, no CRF and
                no colour handling to get right here, and no hardware to fall
                back from.

                Segments can only start on a keyframe, and a copy cannot make
                new ones, so `-hls_time` is a floor rather than a target: a
                master with a long GOP gets longer segments. Players handle
                that, and the alternative would be re-encoding, which is the
                thing being avoided.
                """
                cmd = ["ffmpeg", "-y", "-i", input_url, "-map", "0:v:0"]
                if has_audio:
                    cmd += ["-map", "0:a:0"]
                cmd += ["-c:v", "copy"]
                if has_audio:
                    cmd += (
                        ["-c:a", "copy"] if audio_codec == "aac"
                        else ["-c:a", "aac", "-b:a", "192k"]
                    )
                cmd += [
                    "-f", "hls",
                    "-hls_time", "2",
                    "-hls_playlist_type", "vod",
                    "-hls_flags", "independent_segments",
                    "-hls_segment_type", "mpegts",
                    # ffmpeg writes the master playlist itself, with the CODECS
                    # and RESOLUTION it reads off the stream. Hand-writing it
                    # against a copied stream would be guessing, and hls.js
                    # refuses a manifest whose codec string does not match.
                    "-master_pl_name", "master.m3u8",
                    "-var_stream_map", "v:0,a:0" if has_audio else "v:0",
                    "-hls_segment_filename", str(hls_dir / "%v" / "seg_%03d.ts"),
                    str(hls_dir / "%v" / "playlist.m3u8"),
                ]
                return cmd

            def _build_ffmpeg_cmd(backend: str) -> list[str]:
                """Build the full ffmpeg command for a given backend.

                Kept as a closure so the whole graph (hwaccel, scale filter,
                HDR prefix, encoders, colour tags) is rebuilt consistently when
                a hardware attempt has to fall back to software.
                """
                if backend == "copy":
                    return _build_copy_cmd()
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
                    f"[v{i}]{scale_filter}={scale_targets[q]}:force_original_aspect_ratio=decrease:force_divisible_by=2{scale_extra}[{q}]"
                    for i, q in enumerate(qualities)
                )

                ffmpeg_cmd = ["ffmpeg", "-y"]
                if not dv_software:
                    ffmpeg_cmd += _BACKEND_HWACCEL.get(backend, [])
                ffmpeg_cmd += ["-i", input_url]
                ffmpeg_cmd += ["-filter_complex", filter_complex]
                if cpu_plan is not None:
                    ffmpeg_cmd += ["-filter_complex_threads", str(cpu_plan[1])]

                # Per-backend encoder selection driven by TRANSCODER_OUTPUT.
                family = out_mode["family"]      # "hevc" or "h264"
                ten_bit = out_mode["ten_bit"]    # True=10-bit, False=8-bit
                # Every output option emitted in here has to carry `:v:{i}`.
                # Without a stream specifier ffmpeg applies the LAST copy to
                # every video stream, so an option computed per rung silently
                # collapses to the smallest rung's value: the ladder runs
                # largest first, and `-crf` 24/26/30 made all three renditions
                # CRF 30. Measured on a 6s 1080p source, the top rung came out
                # at 1776 KB against 4264 KB qualified, and the bottom rung was
                # byte-identical because it is the one that won (#393).
                #
                # ffmpeg warns for `-pix_fmt` and `-force_key_frames` and says
                # nothing for `-crf`, `-qp` or `-global_quality`, so a clean log
                # is not evidence. `-preset`, `-rc`, `-look_ahead` and
                # `-profile:v` keep no stream index deliberately: they carry the
                # same value on every rung, so the collapse is a no-op. Give any
                # of them a per-rung value and it needs the index too.
                for i, quality in enumerate(qualities):
                    _, crf = QUALITY_MAP[quality]
                    ffmpeg_cmd += ["-map", f"[{quality}]"]
                    if has_audio:
                        ffmpeg_cmd += ["-map", "a:0"]
                    if backend == "cpu" or dv_software:
                        enc = "libx265" if family == "hevc" else "libx264"
                        ffmpeg_cmd += [f"-c:v:{i}", enc, "-preset", "fast",
                                       f"-force_key_frames:v:{i}", "expr:gte(t,n_forced*2)"]
                        if ten_bit:
                            ffmpeg_cmd += [f"-pix_fmt:v:{i}", "yuv420p10le",
                                           f"-crf:v:{i}", str(crf - 4)]
                        else:
                            ffmpeg_cmd += [f"-pix_fmt:v:{i}", "yuv420p",
                                           f"-crf:v:{i}", str(crf + 4)]
                        if cpu_plan is not None:
                            # Software encoders only. The hardware ones do their
                            # work on the device and take their thread counts
                            # from the driver, so a count here would either be
                            # ignored or throttle the one part that is not the
                            # bottleneck. On a hardware backend the CPU work
                            # that remains is decode and the filter graph;
                            # -filter_complex_threads above covers the graph,
                            # and decode is not covered on any backend -- there
                            # is deliberately no global -threads here, because
                            # before -i it would reach only the decoder and
                            # leave every encoder unbounded.
                            ffmpeg_cmd += [f"-threads:v:{i}", str(cpu_plan[0][i])]
                    elif backend == "nvenc":
                        enc = "hevc_nvenc" if family == "hevc" else "h264_nvenc"
                        cq = _NVENC_CQ.get(get_output_mode(), 26)
                        ffmpeg_cmd += [f"-c:v:{i}", enc, "-preset", "p6", "-rc", "constqp",
                                       f"-qp:v:{i}", str(cq),
                                       f"-force_key_frames:v:{i}", "expr:gte(t,n_forced*2)"]
                        if family == "hevc":
                            ffmpeg_cmd += ["-profile:v", "main10" if ten_bit else "main"]
                        else:
                            ffmpeg_cmd += ["-profile:v", "high"]
                    elif backend == "qsv":
                        enc = "hevc_qsv" if family == "hevc" else "h264_qsv"
                        ffmpeg_cmd += [f"-c:v:{i}", enc, f"-global_quality:v:{i}", str(crf),
                                       "-look_ahead", "1",
                                       f"-force_key_frames:v:{i}", "expr:gte(t,n_forced*2)"]
                    elif backend == "vaapi":
                        enc = "hevc_vaapi" if family == "hevc" else "h264_vaapi"
                        ffmpeg_cmd += [f"-c:v:{i}", enc, f"-global_quality:v:{i}", str(crf),
                                       f"-force_key_frames:v:{i}", "expr:gte(t,n_forced*2)"]
                        if family == "hevc":
                            ffmpeg_cmd += ["-profile:v", "main10" if ten_bit else "main"]
                        ffmpeg_cmd += [f"-pix_fmt:v:{i}", "p010" if ten_bit else "nv12"]

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
            #
            # A copy degrades the same way, for the same reason. It runs no
            # encoder, so there is no hardware failure to fall back from -- but
            # it can fail on things that are specific to remuxing and that an
            # encode would simply have absorbed, and the whole point of the
            # setting is to be cheaper, not to be a way to fail. So a failed
            # remux drops to the encoder rather than failing the asset, and
            # unlike the hardware case any error is reason enough: a remux has
            # no environmental failures to tell apart from input ones.
            # What the ladder will be held against. The video track's length,
            # never the file's -- see refuse_a_truncated_result -- and probed
            # from the tail when the container does not publish it.
            source_video_seconds = meta.video_duration_seconds
            if source_video_seconds is None:
                source_video_seconds = self._probe_expected_video_seconds(
                    input_url, _vid_stream, meta.duration_seconds
                )

            attempts = [primary_backend]
            if primary_backend == "copy":
                attempts.append(get_backend())
            if attempts[-1] not in ("cpu", "copy") and not dv_software:
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
                    # Exit 0 is not the same as "wrote the whole source" -- see
                    # refuse_a_truncated_result. Checked before the backend is
                    # accepted, so a short ladder is never uploaded and never
                    # reaches the database as `ready`.
                    refuse_a_truncated_result(
                        hls_dir,
                        source_video_seconds,
                        label=f"ffmpeg ({attempt_backend})",
                    )
                    backend = attempt_backend
                    break
                except TranscodeTruncated:
                    # Deliberately not absorbed by the fallbacks below. The
                    # source is intact, so the useful move is to read it again:
                    # the task retries in a minute, and the next read is a fresh
                    # connection to an object the store has certainly finished
                    # assembling. Degrading to the encoder would re-read the
                    # same input the same way and cost hours doing it.
                    raise
                except RuntimeError as exc:
                    is_last = attempt_index == len(attempts) - 1
                    remux = attempt_backend == "copy"
                    if is_last or not (remux or _is_hw_runtime_failure(str(exc))):
                        raise
                    if remux:
                        print(
                            f"[transcoder] remuxing {job.input_s3_key} failed; encoding "
                            f"it instead ({str(exc).strip()[:200]})",
                            flush=True,
                        )
                    else:
                        print(
                            f"[transcoder] backend '{attempt_backend}' failed at runtime "
                            f"({_hw_failure_reason(str(exc))}); retrying on the software "
                            f"pipeline for {job.input_s3_key}",
                            flush=True,
                        )
                    # Discard any partial HLS output before retrying.
                    shutil.rmtree(hls_dir, ignore_errors=True)
                    hls_dir.mkdir(exist_ok=True)

            # 4. One downloadable file, remuxed from the rendition just encoded.
            #    A copied source needs none: its rendition carries the uploaded
            #    file's own stream, so the master the download falls back to is
            #    the same picture at the same bitrate -- the size gap #350 exists
            #    to close is not there. Writing a second copy of it would spend
            #    exactly the storage this setting was turned on to save.
            #    Keyed on the backend that actually ran, not on the one the gate
            #    chose: a remux that fell back to the encoder produces an
            #    ordinary ladder and wants the rung like any other.
            mp4_key = None if backend == "copy" else self._build_download_mp4(
                hls_dir, qualities, work_dir, job.output_s3_prefix
            )

            # 5. Upload HLS files to S3
            uploaded_keys = self._upload_directory(hls_dir, job.output_s3_prefix)

            # 6. Generate and upload thumbnail (using streaming URL)
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
                mp4_key=mp4_key,
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
