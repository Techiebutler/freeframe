import uuid
import tempfile
import os
import subprocess
import sys

# Ensure the workspace root is on the path (same pattern as transcode_tasks)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from .celery_app import celery_app
from ..database import SessionLocal
from ..models.asset import Asset, MediaFile
from ..config import settings


def _publish_event(project_id: str, event_type: str, payload: dict):
    """Publish an SSE event from Celery worker context (best-effort)."""
    from ..services import event_service
    return event_service.publish_sync(project_id, event_type, payload)


@celery_app.task(name="apply_watermark", bind=True, max_retries=3, default_retry_delay=60)
def apply_watermark(
    self,
    asset_id: str,
    watermark_text: str,
    position: str,
    opacity: float,
    image_key: str | None,
):
    """Burn a text watermark into a video/image asset and upload the result to S3."""
    from ..services.s3_service import get_s3_client, put_object

    db = SessionLocal()
    try:
        asset = db.query(Asset).filter(
            Asset.id == uuid.UUID(asset_id),
            Asset.deleted_at.is_(None),
        ).first()
        if not asset:
            return

        # Find the first media file for this asset (via latest version)
        from ..models.asset import AssetVersion
        latest_version = (
            db.query(AssetVersion)
            .filter(
                AssetVersion.asset_id == asset.id,
                AssetVersion.deleted_at.is_(None),
            )
            .order_by(AssetVersion.version_number.desc())
            .first()
        )
        if not latest_version:
            return

        source = db.query(MediaFile).filter(
            MediaFile.version_id == latest_version.id
        ).first()
        if not source:
            return

        s3 = get_s3_client()

        with tempfile.TemporaryDirectory() as tmp:
            # Determine file extension from original filename
            _, ext = os.path.splitext(source.original_filename)
            ext = ext.lower() or ".mp4"
            local_path = os.path.join(tmp, f"source{ext}")

            # Download source from S3
            s3.download_file(settings.s3_bucket, source.s3_key_raw, local_path)

            output_ext = ".mp4"
            output_path = os.path.join(tmp, f"watermarked_{asset_id}{output_ext}")

            # Build ffmpeg drawtext filter if we have watermark text
            vf_filters = []
            if watermark_text:
                escaped = watermark_text.replace("'", r"'\''").replace(":", r"\:")
                fontsize = 24
                if position == "center":
                    x, y = "(w-text_w)/2", "(h-text_h)/2"
                elif position == "tiled":
                    x, y = "w/4", "h/4"
                else:  # corner / bottom_right
                    x, y = "w-text_w-10", "h-text_h-10"
                vf_filters.append(
                    f"drawtext=text='{escaped}':fontsize={fontsize}"
                    f":fontcolor=white@{opacity}:x={x}:y={y}"
                )

            if vf_filters:
                cmd = [
                    "ffmpeg", "-y",
                    "-i", local_path,
                    "-vf", ",".join(vf_filters),
                    "-c:a", "copy",
                    output_path,
                ]
                subprocess.run(cmd, check=True, timeout=600)
            else:
                # No watermark text — copy as-is
                output_path = local_path

            # Upload watermarked file back to S3
            wm_key = f"watermarked/{asset_id}/output{output_ext}"
            with open(output_path, "rb") as f:
                put_object(wm_key, f.read(), "video/mp4")

        # Publish SSE event (best-effort)
        _publish_event(
            str(asset.project_id),
            "watermark_complete",
            {"asset_id": asset_id, "key": wm_key},
        )

    except Exception as exc:
        raise self.retry(exc=exc)
    finally:
        db.close()
