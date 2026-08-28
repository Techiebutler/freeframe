import uuid
import sys
import os
import asyncio
import json
import logging

# Ensure the workspace root is on the path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from .celery_app import celery_app
from ..database import SessionLocal
from ..models.asset import AssetVersion, MediaFile, ProcessingStatus, AssetType
from ..models.asset import Asset
from ..services.s3_service import get_s3_client
from ..config import settings

log = logging.getLogger("celery.transcode")


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@celery_app.task(bind=True, max_retries=3, default_retry_delay=60)
def process_asset(self, asset_id: str, version_id: str):
    """Main processing task dispatched after upload completes."""
    db = SessionLocal()
    try:
        version = db.query(AssetVersion).filter(AssetVersion.id == uuid.UUID(version_id)).first()
        if not version:
            return  # version already cleaned up

        asset = db.query(Asset).filter(Asset.id == uuid.UUID(asset_id)).first()
        if not asset:
            if version:
                version.processing_status = ProcessingStatus.failed
                db.commit()
            return

        media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
        if not media_file:
            version.processing_status = ProcessingStatus.failed
            db.commit()
            return

        # Reset to processing status before each attempt
        version.processing_status = ProcessingStatus.processing
        db.commit()

        output_prefix = f"processed/{asset.project_id}/{asset_id}/{version_id}"
        s3 = get_s3_client()

        try:
            if asset.asset_type in (AssetType.video,):
                _process_video(db, asset, version, media_file, s3, output_prefix)
            elif asset.asset_type == AssetType.audio:
                _process_audio(db, asset, version, media_file, s3, output_prefix)
            elif asset.asset_type in (AssetType.image, AssetType.image_carousel):
                _process_image(db, asset, version, media_file, s3, output_prefix)

            version.processing_status = ProcessingStatus.ready
            db.commit()

            # Publish SSE event (best-effort)
            _publish_event(str(asset.project_id), "transcode_complete", {
                "asset_id": asset_id,
                "version_id": version_id,
            })

        except Exception as exc:
            version.processing_status = ProcessingStatus.failed
            db.commit()
            _publish_event(str(asset.project_id), "transcode_failed", {
                "asset_id": asset_id,
                "error": str(exc),
            })
            raise self.retry(exc=exc)

    finally:
        db.close()


def _process_video(db, asset, version, media_file, s3, output_prefix):
    from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder
    from packages.transcoder.base import TranscodeJob

    transcoder = FFmpegTranscoder(s3, settings.s3_bucket, settings.s3_endpoint)
    # Progress is cosmetic; the transcode is not. If the broker stops answering,
    # every publish costs the socket timeout, and this runs inside the loop
    # draining ffmpeg's stdout -- so paying it ~100 times would stall the encode
    # behind a full pipe. One failure is enough to stop trying for this job.
    progress_ok = {"enabled": True, "high_water": -1}

    def _on_progress(percent: int) -> None:
        if not progress_ok["enabled"]:
            return
        # A hardware attempt that fails at runtime is retried on the software
        # backend, and the second ffmpeg starts counting from zero. Clamp so the
        # bar never runs backwards from the viewer's point of view.
        if percent <= progress_ok["high_water"]:
            return
        progress_ok["high_water"] = percent
        delivered = _publish_event(str(asset.project_id), "transcode_progress", {
            "asset_id": str(asset.id),
            "percent": percent,
        })
        if delivered is False:
            progress_ok["enabled"] = False

    job = TranscodeJob(
        media_id=str(asset.id),
        version_id=str(version.id),
        input_s3_key=media_file.s3_key_raw,
        output_s3_prefix=output_prefix,
        qualities=["1080p", "720p", "360p"],
        progress_cb=_on_progress,
    )
    result = _run_async(transcoder.transcode(job))
    if not result.success:
        raise RuntimeError(f"Transcode failed: {result.error}")

    media_file.s3_key_processed = result.hls_prefix
    if result.thumbnail_keys:
        media_file.s3_key_thumbnail = result.thumbnail_keys[0]
    if result.duration_seconds:
        media_file.duration_seconds = result.duration_seconds
    if result.width:
        media_file.width = result.width
    if result.height:
        media_file.height = result.height
    if result.fps:
        media_file.fps = result.fps
    db.flush()


def _process_audio(db, asset, version, media_file, s3, output_prefix):
    from packages.transcoder.image_processor import process_audio
    result = process_audio(s3, settings.s3_bucket, media_file.s3_key_raw, output_prefix)
    media_file.s3_key_processed = result.get("mp3_key")
    if result.get("waveform_key"):
        media_file.s3_key_thumbnail = result["waveform_key"]
    if result.get("duration_seconds"):
        media_file.duration_seconds = result["duration_seconds"]
    db.flush()


def _process_image(db, asset, version, media_file, s3, output_prefix):
    from packages.transcoder.image_processor import process_image
    result = process_image(s3, settings.s3_bucket, media_file.s3_key_raw, output_prefix)
    media_file.s3_key_processed = result.get("webp_key")
    media_file.s3_key_thumbnail = result.get("thumbnail_key")
    db.flush()


def _publish_event(project_id: str, event_type: str, payload: dict):
    """Publish an SSE event from Celery worker context.

    Delegates to event_service so there is a single emit path; it is pooled and
    already best-effort, which is what this needs.
    """
    from ..services import event_service
    return event_service.publish_sync(project_id, event_type, payload)


def _eligible_media_rows(db):
    """Rows the #124 backfill still needs: (MediaFile, asset_type) pairs."""
    return (
        db.query(MediaFile, Asset.asset_type)
        .join(AssetVersion, MediaFile.version_id == AssetVersion.id)
        .join(Asset, AssetVersion.asset_id == Asset.id)
        .filter(
            AssetVersion.processing_status == ProcessingStatus.ready,
            AssetVersion.deleted_at.is_(None),
            Asset.deleted_at.is_(None),
            MediaFile.duration_seconds.is_(None),
            Asset.asset_type.in_([AssetType.video, AssetType.audio]),
        )
        .all()
    )


@celery_app.task(bind=True)
def backfill_media_metadata(self):
    """One-off backfill for #124: probe raw S3 files to populate missing
    duration/width/height/fps on already-processed media. Idempotent —
    only touches rows where duration_seconds IS NULL."""
    import subprocess
    from packages.transcoder.ffmpeg_transcoder import parse_probe_metadata

    db = SessionLocal()
    updated = skipped = 0
    try:
        rows = _eligible_media_rows(db)
        s3 = get_s3_client()
        for media_file, asset_type in rows:
            row_id = media_file.id
            try:
                url = s3.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": settings.s3_bucket, "Key": media_file.s3_key_raw},
                    ExpiresIn=3600,
                )
                cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_format"]
                if asset_type == AssetType.video:
                    cmd += ["-show_streams", "-select_streams", "v:0"]
                probe = subprocess.run(cmd + [url], capture_output=True, text=True, timeout=300)
                if probe.returncode != 0:
                    skipped += 1
                    continue
                try:
                    data = json.loads(probe.stdout)
                except json.JSONDecodeError:
                    skipped += 1
                    continue
                if asset_type == AssetType.video:
                    meta = parse_probe_metadata(data)
                    if meta is None:
                        skipped += 1
                        continue
                    media_file.duration_seconds = meta.duration_seconds or None
                    media_file.width = meta.width or None
                    media_file.height = meta.height or None
                    media_file.fps = meta.fps or None
                else:
                    duration = float((data.get("format") or {}).get("duration") or 0)
                    media_file.duration_seconds = duration or None
                db.commit()
                updated += 1
            except Exception as exc:
                db.rollback()
                skipped += 1
                log.warning("backfill: skipping media_file %s: %s", row_id, exc)
                continue
        return {"updated": updated, "skipped": skipped}
    finally:
        db.close()
