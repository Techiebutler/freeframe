"""Server-side watermark burn-in.

Renders a resolved watermark template (a list of text blocks with final
display text) onto a video or image file with FFmpeg and uploads the result
to S3. Outputs are cached by content signature, so repeat downloads with the
same watermark are served instantly.
"""

import json
import os
import subprocess
import sys
import tempfile
import uuid

# Ensure the workspace root is on the path (same pattern as transcode_tasks)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from .celery_app import celery_app
from ..database import SessionLocal
from ..models.asset import Asset, AssetType, MediaFile
from ..config import settings

FFMPEG_TIMEOUT_SECONDS = 1800

# Grid positions (percent) used to emulate a tiled watermark
TILE_POSITIONS = [
    (17, 17), (50, 12), (83, 17),
    (12, 50), (50, 50), (88, 50),
    (17, 83), (50, 88), (83, 83),
]


def _publish_event(project_id: str, event_type: str, payload: dict):
    """Publish SSE event via Redis from Celery worker context (best-effort)."""
    try:
        import redis as sync_redis
        r = sync_redis.from_url(settings.redis_url, decode_responses=True)
        message = json.dumps({"type": event_type, "payload": payload})
        r.publish(f"project:{project_id}", message)
        r.close()
    except Exception:
        pass


def _ffprobe_dimensions(path: str) -> tuple[int, int]:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "json", path,
        ],
        capture_output=True, text=True, check=True, timeout=60,
    )
    stream = json.loads(out.stdout)["streams"][0]
    return int(stream["width"]), int(stream["height"])


def _escape_drawtext(text: str) -> str:
    """Escape a string for use inside a quoted drawtext text option.

    The text is emitted inside single quotes with expansion=none, so only
    backslashes and single quotes need handling (quotes are swapped for a
    typographic apostrophe to avoid nested-escaping pitfalls).
    """
    return text.replace("\\", "\\\\").replace("'", "\u2019")


def _ffmpeg_color(hex_color: str, opacity: float) -> str:
    color = hex_color.lstrip("#")
    if len(color) != 6:
        color = "FFFFFF"
    return f"0x{color}@{opacity}"


def build_watermark_filter(blocks: list[dict], width: int, height: int, is_video: bool) -> str:
    """Build an ffmpeg filter_complex string that burns the blocks into [0:v].

    Each block is drawn on a full-frame transparent canvas, optionally
    rotated, then overlaid — this supports rotation and tiling, which plain
    drawtext cannot do.
    """
    parts = []
    current = "[0:v]"

    for i, block in enumerate(blocks):
        text = _escape_drawtext(block["text"])
        fontsize = max(8, int(round(height * float(block["size"]) / 100.0)))
        color = _ffmpeg_color(block.get("color", "#FFFFFF"), float(block.get("opacity", 0.35)))
        rotation = float(block.get("rotation", 0.0))
        tiled = bool(block.get("tiled", False))
        scroll = bool(block.get("scroll", False)) and is_video

        shadow = ""
        if block.get("shadow"):
            shadow_alpha = round(min(1.0, float(block.get("opacity", 0.35)) * 0.8), 3)
            shadow = f":shadowcolor=0x000000@{shadow_alpha}:shadowx=2:shadowy=2"

        common = f"fontsize={fontsize}:fontcolor={color}{shadow}:expansion=none:text='{text}'"

        if tiled:
            # Draw the text at each grid position on the canvas
            draws = ",".join(
                f"drawtext={common}:x=(w*{tx / 100.0})-(text_w/2):y=(h*{ty / 100.0})-(text_h/2)"
                for tx, ty in TILE_POSITIONS
            )
            overlay_x = "0"
            overlay_y = "0"
        else:
            # Draw centered on the canvas; the overlay offset positions it
            draws = f"drawtext={common}:x=(w-text_w)/2:y=(h-text_h)/2"
            ox = int(round(width * float(block["x"]) / 100.0 - width / 2.0))
            oy = int(round(height * float(block["y"]) / 100.0 - height / 2.0))
            overlay_x = str(ox)
            overlay_y = str(oy)

        canvas = f"color=c=black@0.0:s={width}x{height},format=rgba,{draws}"
        if rotation:
            # Rotate the whole canvas around its center, keeping size
            canvas += f",rotate={rotation}*PI/180:c=none:ow=iw:oh=ih"

        if scroll:
            # Drift the layer horizontally across the frame (~15s per pass)
            overlay_x = f"mod(t*{width}/15\\,{2 * width})-{width}+({overlay_x})"

        parts.append(f"{canvas}[wm{i}]")
        out_label = f"[v{i}]" if i < len(blocks) - 1 else "[vout]"
        parts.append(f"{current}[wm{i}]overlay=x={overlay_x}:y={overlay_y}{out_label}")
        current = f"[v{i}]"

    return ";".join(parts)


def _content_type_for_ext(ext: str) -> str:
    return {
        ".mp4": "video/mp4",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(ext, "application/octet-stream")


@celery_app.task(name="render_watermark", bind=True, max_retries=2, default_retry_delay=30)
def render_watermark(
    self,
    asset_id: str,
    media_file_id: str,
    blocks: list,
    out_key: str,
):
    """Burn resolved watermark blocks into an asset's file and upload to S3.

    `blocks` are fully-resolved render blocks (text already substituted).
    `out_key` is the deterministic cache key the API polls for.
    """
    from ..services.s3_service import get_s3_client, put_object

    db = SessionLocal()
    try:
        asset = db.query(Asset).filter(
            Asset.id == uuid.UUID(asset_id),
            Asset.deleted_at.is_(None),
        ).first()
        if not asset:
            return

        source = db.query(MediaFile).filter(
            MediaFile.id == uuid.UUID(media_file_id)
        ).first()
        if not source:
            return

        is_video = asset.asset_type == AssetType.video
        source_key = source.s3_key_raw or source.s3_key_processed
        if not source_key:
            return

        s3 = get_s3_client()
        out_ext = os.path.splitext(out_key)[1].lower()

        with tempfile.TemporaryDirectory() as tmp:
            _, src_ext = os.path.splitext(source.original_filename or source_key)
            local_path = os.path.join(tmp, f"source{src_ext.lower() or '.bin'}")
            s3.download_file(settings.s3_bucket, source_key, local_path)

            output_path = os.path.join(tmp, f"out{out_ext}")

            width, height = _ffprobe_dimensions(local_path)
            filter_complex = build_watermark_filter(blocks, width, height, is_video)

            cmd = ["ffmpeg", "-y", "-i", local_path]
            if filter_complex:
                cmd += ["-filter_complex", filter_complex, "-map", "[vout]"]
            if is_video:
                cmd += [
                    "-map", "0:a?",
                    "-c:v", "libx264", "-preset", "fast", "-crf", "20",
                    "-pix_fmt", "yuv420p",
                    # Re-encode audio: copied codecs (e.g. PCM from MOV) may
                    # not be valid in an MP4 container
                    "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart",
                ]
            else:
                cmd += ["-frames:v", "1"]
            cmd.append(output_path)

            subprocess.run(cmd, check=True, timeout=FFMPEG_TIMEOUT_SECONDS, capture_output=True)

            with open(output_path, "rb") as f:
                put_object(out_key, f.read(), _content_type_for_ext(out_ext))

        _publish_event(
            str(asset.project_id),
            "watermark_complete",
            {"asset_id": asset_id, "key": out_key},
        )

    except Exception as exc:
        raise self.retry(exc=exc)
    finally:
        db.close()
