import asyncio
import json
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional
import boto3
from botocore.config import Config
from .base import BaseTranscoder, TranscodeJob, TranscodeResult, VideoMetadata

logger = logging.getLogger("transcoder.ffmpeg")


# Upper bound on the thread pool ffmpeg may build, per encoder and for the
# filter graph. Left unset, x264 sizes a frame-thread pool to the whole machine
# and builds one per rendition, so a single 3-rendition job floods the run
# queue. On aditor-platform (8 cores, shared with n8n, Teable, Postgres and ~16
# other vhosts) one 10-file upload batch pushed the 5-minute load average to
# 7.68 on 2026-08-16 while the box was still 57-64% idle and context switches
# ran 12x baseline: the queue was full of x264 threads descheduling each other,
# not of work. Actual throughput measured ~3.4 cores, so a small pool keeps the
# encode as fast as it ever was and stops the load average from tracking
# scheduler churn instead of CPU. Raise FFMPEG_THREADS on a dedicated encoder
# box, where starving the pool would cost real throughput.
FFMPEG_THREADS = max(1, int(os.getenv("FFMPEG_THREADS", "2")))

# transcode() downloads the original before encoding and reads it from local disk. It used to
# stream it over HTTP (a presigned URL), where every seek is a fresh range request: a valid MP4
# whose audio and video sit far apart in the file (some editors' exports, 2026-10-18: up to 186 MB
# apart, 32k jumps) took over 25 minutes to read a 9-minute 581 MB video and hit the encode
# timeout, while the download alone took 3 s and the local encode about a minute. A stalled
# transfer is now boto3's to catch (60 s read timeout plus retries), so the job still fails and is
# retried instead of holding a transcoding slot - what -rw_timeout/-reconnect did for the stream.

# Wall-clock cap for the whole encode. It used to be a flat 4 hours, so a hung or crawling ffmpeg
# kept a transcoding slot (of only 2) busy for 4 hours. The cap now scales with the video's
# length - a long video legitimately needs longer - but never below this floor, never above 4 h.
FFMPEG_ENCODE_TIMEOUT_SECONDS = max(600, int(os.getenv("FFMPEG_ENCODE_TIMEOUT_SECONDS", "2700")))
FFMPEG_ENCODE_TIMEOUT_MAX_SECONDS = 14400


# Review proxy rung: the embed/share player starts here (see apps/web/lib/hls-review.ts).
PROXY_QUALITY = "540p"
PROXY_SHORT_SIDE = 540
PROXY_MAXRATE = "2000k"
PROXY_BUFSIZE = "4000k"
# The same rung as ONE faststart MP4 next to the HLS output. The embed plays it with plain range
# requests: one connection instead of a segment round trip every 2 s (the measured bottleneck).
REVIEW_PROXY_NAME = "review_540.mp4"


def _scale_filter(quality: str, box: str) -> str:
    """The older rungs fit a landscape box; the proxy fixes the short side at 540."""
    if quality == PROXY_QUALITY:
        return f"scale='if(gt(iw,ih),-2,{PROXY_SHORT_SIDE})':'if(gt(iw,ih),{PROXY_SHORT_SIDE},-2)'"
    return f"scale={box}:force_original_aspect_ratio=decrease"


def encode_timeout_seconds(duration_seconds: Optional[float]) -> int:
    """Whole-encode timeout for a video of this length: 4x its duration, within [floor, 4 h]."""
    scaled = int(4 * (duration_seconds or 0))
    return min(FFMPEG_ENCODE_TIMEOUT_MAX_SECONDS, max(FFMPEG_ENCODE_TIMEOUT_SECONDS, scaled))


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
                # Force full-range JPEG. The mjpeg encoder rejects limited-range
                # (tv) yuv420p input ("Non full-range YUV is non-standard" ->
                # ff_frame_thread_encoder_init failed), which is most portrait
                # source footage. yuvj420p is exactly what mjpeg expects.
                "-pix_fmt", "yuvj420p",
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
        Transcode video from a local copy of the S3 original.
        The original is downloaded into the work dir first and deleted with it.
        """
        work_dir = Path(tempfile.mkdtemp(prefix=f"transcode_{job.version_id}_"))

        try:
            # Local copy of the original - see the note below FFMPEG_THREADS.
            input_path = str(work_dir / f"input{Path(job.input_s3_key).suffix or '.mp4'}")
            self.s3.download_file(self.bucket, job.input_s3_key, input_path)

            # 1. Get video metadata
            cmd = [
                "ffprobe", "-v", "error", "-print_format", "json",
                "-show_streams", "-select_streams", "v:0", "-show_format", input_path,
            ]
            vid_info = self._run(cmd, timeout=120, label="ffprobe")
            meta = parse_probe_metadata(json.loads(vid_info))

            # 2. Check if input has an audio stream
            audio_cmd = [
                "ffprobe", "-v", "error", "-print_format", "json",
                "-show_streams", "-select_streams", "a", input_path,
            ]
            audio_result = self._run(audio_cmd, timeout=120, label="ffprobe")
            has_audio = bool(json.loads(audio_result).get("streams"))

            # 3. Build quality ladder based on available qualities
            QUALITY_MAP = {
                "1080p": ("1920:1080", 20),
                "720p": ("1280:720", 22),
                "540p": ("960:540", 23),
                "360p": ("640:360", 26),
            }
            # qualities = [q for q in job.qualities if q in QUALITY_MAP]
            requested = [q for q in job.qualities if q in QUALITY_MAP]
            source_height = meta.height if meta else 0

            # 540p is sized by its SHORT side (a 9:16 ad becomes 540x960, not 304x540), so it is
            # eligible by the source's short side; the older rungs keep their height rule.
            source_short = min(meta.width, meta.height) if meta else 0
            qualities = [
                q for q in requested
                if (source_short >= PROXY_SHORT_SIDE if q == PROXY_QUALITY
                    else int(QUALITY_MAP[q][0].split(":")[1]) <= source_height)
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
                f"[v{i}]{_scale_filter(q, QUALITY_MAP[q][0])},pad=ceil(iw/2)*2:ceil(ih/2)*2[{q}]"
                for i, q in enumerate(qualities)
            )

            ffmpeg_cmd = [
                "ffmpeg", "-y",
                # Applies to the next file specified, i.e. the input decoder.
                "-threads", str(FFMPEG_THREADS),
                "-i", input_path,
                "-filter_complex", filter_complex,
                "-filter_complex_threads", str(FFMPEG_THREADS),
            ]

            for i, quality in enumerate(qualities):
                scale, crf = QUALITY_MAP[quality]
                ffmpeg_cmd += ["-map", f"[{quality}]"]
                if has_audio:
                    ffmpeg_cmd += ["-map", "a:0"]
                ffmpeg_cmd += [
                    f"-c:v:{i}", "libx264", f"-crf", str(crf), "-preset", "fast",
                    f"-threads:v:{i}", str(FFMPEG_THREADS),
                    "-force_key_frames", "expr:gte(t,n_forced*2)",
                ]
                if quality == PROXY_QUALITY:
                    # Review proxy: ~2 Mbit/s cap and a keyframe every second, so a scrub lands
                    # within a second of any point and the player never decodes a long GOP.
                    fps_gop = str(max(1, round(meta.fps))) if meta and meta.fps else "30"
                    ffmpeg_cmd += [
                        f"-maxrate:v:{i}", PROXY_MAXRATE, f"-bufsize:v:{i}", PROXY_BUFSIZE,
                        f"-g:v:{i}", fps_gop, f"-keyint_min:v:{i}", fps_gop, f"-sc_threshold:v:{i}", "0",
                        f"-force_key_frames:v:{i}", "expr:gte(t,n_forced*1)",
                        f"-b:a:{i}", "128k",
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

            self._run(ffmpeg_cmd, timeout=encode_timeout_seconds(meta.duration_seconds if meta else 0), label="ffmpeg")

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

            # 4.5. Remux the lowest rendition into one small MP4 for AI review clients.
            #
            # An AI reader (an external review integration; see docs/integrations) needs the
            # PIXELS, not streaming quality - it samples at ~1fps regardless of source
            # resolution. Today the only single-file option such a client can fetch is the RAW
            # ORIGINAL (?download=1), because the HLS output above is segmented (.ts + .m3u8),
            # which most simple HTTP clients cannot read as one file. That forces every review
            # to upload the full original - often 10-50x the bytes a 360p copy would need - for
            # no quality benefit the reader can use.
            #
            # The 360p rendition is ALREADY FULLY ENCODED above; this is a container remux
            # (`-c copy`), not a re-encode, so it costs a few seconds even on a multi-minute
            # source, not a second transcode pass. Best-effort and additive: on any failure here
            # the asset is still `ready` with its normal HLS renditions - a missing proxy just
            # means a caller falls back to the original, same as before this existed.
            try:
                smallest_q = min(qualities, key=lambda q: int(QUALITY_MAP[q][0].split(":")[1]))
                # The HLS muxer names each variant's directory by its INDEX in -var_stream_map
                # (%v -> 0, 1, 2), not by quality. Looking in "360p/" found nothing, so the proxy
                # was silently never made and every review uploaded the full original instead
                # (2026-10-03: a 175 MB hook, proxy endpoint 404, master lists 0/ 1/ 2/).
                playlist = hls_dir / str(qualities.index(smallest_q)) / "playlist.m3u8"
                if playlist.exists():
                    proxy_path = work_dir / "ai_proxy.mp4"
                    remux_cmd = [
                        "ffmpeg", "-y",
                        "-i", str(playlist),
                        "-c", "copy",
                        "-movflags", "+faststart",
                        str(proxy_path),
                    ]
                    self._run(remux_cmd, timeout=300, label="ffmpeg")
                    if proxy_path.exists():
                        proxy_key = f"{job.output_s3_prefix}/ai_proxy.mp4"
                        self.s3.upload_file(
                            str(proxy_path), self.bucket, proxy_key,
                            ExtraArgs={"ContentType": "video/mp4", "CacheControl": "max-age=86400"},
                        )
            except Exception as proxy_exc:
                logger.warning(
                    "ai_proxy remux failed for %s, continuing without it: %s",
                    job.output_s3_prefix, proxy_exc,
                )

            # 4.6. The 540p review proxy as a progressive MP4 (container remux, no re-encode).
            # Best-effort like the AI proxy: without it the player falls back to the HLS ladder.
            if PROXY_QUALITY in qualities:
                try:
                    playlist = hls_dir / str(qualities.index(PROXY_QUALITY)) / "playlist.m3u8"
                    review_path = work_dir / REVIEW_PROXY_NAME
                    self._run(
                        ["ffmpeg", "-y", "-i", str(playlist), "-c", "copy", "-movflags", "+faststart", str(review_path)],
                        timeout=300, label="ffmpeg",
                    )
                    self.s3.upload_file(
                        str(review_path), self.bucket, f"{job.output_s3_prefix}/{REVIEW_PROXY_NAME}",
                        ExtraArgs={"ContentType": "video/mp4", "CacheControl": "max-age=86400"},
                    )
                except Exception as proxy_exc:
                    logger.warning(
                        "review proxy remux failed for %s, continuing without it: %s",
                        job.output_s3_prefix, proxy_exc,
                    )

            # 5. Generate and upload thumbnail (using streaming URL).
            # Best-effort: the HLS renditions are already uploaded, so a poster
            # failure must never fail the whole asset (which would mark it
            # `failed`, retry, and - on a concurrency-1 worker - wedge the queue,
            # leaving every later upload stuck on "processing"). A missing poster
            # is cosmetic; the video is still reviewable.
            # -pix_fmt yuvj420p forces full-range JPEG: the mjpeg encoder rejects
            # limited-range (tv) yuv420p input ("Non full-range YUV is
            # non-standard" -> ff_frame_thread_encoder_init failed), which is
            # most portrait source footage.
            thumbnail_keys: list[str] = []
            if job.make_thumbnail:
                try:
                    thumb_path = work_dir / "thumb_0001.jpg"
                    # Reads the local copy; the cap stays: without it, a hung ffmpeg here held one
                    # of the two transcoding slots with no limit at all.
                    thumb_cmd = [
                        "ffmpeg", "-y", "-i", input_path,
                        "-vf", "fps=0.1", "-q:v", "2", "-pix_fmt", "yuvj420p", "-frames:v", "1",
                        str(work_dir / "thumb_%04d.jpg"),
                    ]
                    self._run(thumb_cmd, timeout=600, label="ffmpeg")
                    thumbnail_key = f"{job.output_s3_prefix}/thumbnail.jpg"
                    if thumb_path.exists():
                        self.s3.upload_file(
                            str(thumb_path), self.bucket, thumbnail_key,
                            ExtraArgs={"ContentType": "image/jpeg", "CacheControl": "max-age=86400"},
                        )
                        thumbnail_keys = [thumbnail_key]
                except Exception as thumb_exc:
                    logger.warning(
                        "thumbnail generation failed for %s, continuing without poster: %s",
                        job.output_s3_prefix, thumb_exc,
                    )

            return TranscodeResult(
                success=True,
                hls_prefix=job.output_s3_prefix,
                thumbnail_keys=thumbnail_keys,
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
