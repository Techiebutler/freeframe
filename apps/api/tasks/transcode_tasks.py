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

logger = logging.getLogger(__name__)

log = logging.getLogger("celery.transcode")


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# acks_late: the job is confirmed to the broker only when it finishes. Confirmed on receipt (the
# default), a worker that restarts or dies mid-encode - a deploy, an out-of-memory kill - loses the
# job outright and the version stays "Processing" forever; unconfirmed, the broker redelivers it.
# reject_on_worker_lost is deliberately NOT set: a file that kills its worker every time would then
# be redelivered in a loop.
@celery_app.task(bind=True, max_retries=3, default_retry_delay=60, acks_late=True)
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

        upgrade_later = False
        try:
            if asset.asset_type in (AssetType.video,):
                upgrade_later = _process_video(db, asset, version, media_file, s3, output_prefix)
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

            # And tell the automation, if one is configured. It cannot hold an SSE connection
            # open - it is a Cloudflare Worker - so without this it finds out by polling, and
            # half of every wait is spent on a file that was ready the whole time.
            try:
                from ..services import automation_share
                automation_share.announce_asset_ready(db, asset, version_id)
            except Exception:  # noqa: BLE001 - never fail a finished transcode over a webhook
                logger.warning("asset-ready announce failed for %s", asset_id, exc_info=True)

            # The full-quality ladder goes to the BACK of the queue: every file already waiting
            # gets its quick pass (and so its review) before any file gets its 1080p.
            if upgrade_later:
                try:
                    upgrade_video_renditions.delay(asset_id, version_id)
                except Exception:  # noqa: BLE001 - the 360p version stays playable without it
                    logger.warning("could not queue full renditions for %s", asset_id, exc_info=True)

        except Exception as exc:
            # A failed flush leaves the session unusable ("PendingRollbackError"), and then marking
            # the version failed raised too: no retry, version stuck in "Processing" for ever.
            db.rollback()
            version.processing_status = ProcessingStatus.failed
            db.commit()
            _publish_event(str(asset.project_id), "transcode_failed", {
                "asset_id": asset_id,
                "error": str(exc),
            })
            raise self.retry(exc=exc)

    finally:
        db.close()


# TWO PASSES, so the review never waits for 1080p.
#
# Auto Review only sees a version once it is `ready`, and it reads the 360p `ai_proxy.mp4`. It used
# to become ready only after the full 1080p/720p/360p ladder of the original, two jobs at a time -
# so a hand-in of large five-minute cuts waited 40+ minutes, mostly in the queue, for an encode the
# review never reads. The quick pass makes only 360p (plus the proxy and poster) and marks the
# version ready; `upgrade_video_renditions` then builds the full ladder into the version's main
# prefix and switches playback over. The quick output lives under QUICK_SUFFIX inside that prefix,
# so deleting the version still removes both.
FULL_QUALITIES = ["1080p", "720p", "540p", "360p"]
# 540p is the review proxy (HLS rung + review_540.mp4); 360p stays for the AI proxy and weak links.
QUICK_QUALITIES = ["540p", "360p"]
QUICK_SUFFIX = "quick"
UPGRADE_MIN_SOURCE_HEIGHT = 720  # below this the ladder trims to 360p anyway (see the transcoder)


def _process_video(db, asset, version, media_file, s3, output_prefix) -> bool:
    """Quick pass. Returns True when a full-quality upgrade should follow."""
    from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder
    from packages.transcoder.base import TranscodeJob

    transcoder = FFmpegTranscoder(s3, settings.s3_bucket, settings.s3_endpoint)
    job = TranscodeJob(
        media_id=str(asset.id),
        version_id=str(version.id),
        input_s3_key=media_file.s3_key_raw,
        output_s3_prefix=f"{output_prefix}/{QUICK_SUFFIX}",
        qualities=QUICK_QUALITIES,
    )
    if getattr(asset,'iteration_source',False) is True:
        # Trusted server probe of the stored original permits review before playback renditions.
        meta=_run_async(transcoder.get_video_metadata(media_file.s3_key_raw))
        if not meta or not (0 < meta.duration_seconds <= 600) or meta.width<=0 or meta.height<=0:
            raise RuntimeError('Source video is invalid or exceeds 600 seconds.')
        media_file.duration_seconds=meta.duration_seconds;media_file.width=meta.width;media_file.height=meta.height
        media_file.fps=meta.fps;version.iteration_review_ready=True;db.commit()
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
    return (result.height or 0) >= UPGRADE_MIN_SOURCE_HEIGHT


@celery_app.task(bind=True, max_retries=1, default_retry_delay=300, acks_late=True)
def upgrade_video_renditions(self, asset_id: str, version_id: str):
    """Second pass: the full ladder into the main prefix, then switch playback to it.

    The version is already `ready` and reviewed on its 360p copy, so this never touches
    processing_status: on any failure the version simply stays at 360p.
    """
    from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder
    from packages.transcoder.base import TranscodeJob

    db = SessionLocal()
    try:
        version = db.query(AssetVersion).filter(AssetVersion.id == uuid.UUID(version_id)).first()
        asset = db.query(Asset).filter(Asset.id == uuid.UUID(asset_id)).first()
        media_file = db.query(MediaFile).filter(MediaFile.version_id == uuid.UUID(version_id)).first() if version else None
        if not (version and asset and media_file):
            return  # deleted meanwhile
        output_prefix = f"processed/{asset.project_id}/{asset_id}/{version_id}"
        quick_prefix = f"{output_prefix}/{QUICK_SUFFIX}"
        if version.processing_status != ProcessingStatus.ready or media_file.s3_key_processed != quick_prefix:
            return  # reprocessed, failed, or already upgraded
        raw_key = media_file.s3_key_raw
        db.commit()  # release the connection for the length of the encode

        transcoder = FFmpegTranscoder(get_s3_client(), settings.s3_bucket, settings.s3_endpoint)
        result = _run_async(transcoder.transcode(TranscodeJob(
            media_id=asset_id, version_id=version_id, input_s3_key=raw_key,
            output_s3_prefix=output_prefix, qualities=FULL_QUALITIES, make_thumbnail=False,
        )))
        if not result.success:
            if self.request.retries < self.max_retries:
                raise self.retry(exc=RuntimeError(result.error))
            logger.warning("full renditions failed for %s, staying at 360p: %s", asset_id, result.error)
            return

        db.refresh(media_file)
        if media_file.s3_key_processed != quick_prefix:
            return  # changed while we encoded; leave it alone
        media_file.s3_key_processed = output_prefix
        db.commit()
    finally:
        db.close()


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
    """Publish SSE event via Redis from Celery worker context."""
    try:
        import redis as sync_redis
        r = sync_redis.from_url(settings.redis_url, decode_responses=True)
        message = json.dumps({"type": event_type, "payload": payload})
        r.publish(f"project:{project_id}", message)
        r.close()
    except Exception:
        pass  # SSE publish is best-effort


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


@celery_app.task(bind=True, max_retries=1, default_retry_delay=300, acks_late=True)
def build_review_proxy(self, asset_id: str, version_id: str):
    """Backfill: add review_540.mp4 next to a version's existing ladder, without touching playback.

    Encodes only the 540p rung into a side prefix and copies the MP4 beside the live ladder, so the
    version keeps playing from its current prefix the whole time. A no-op when the proxy exists.
    """
    from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder, REVIEW_PROXY_NAME, PROXY_SHORT_SIDE
    from packages.transcoder.base import TranscodeJob
    from ..services.s3_service import object_exists

    db = SessionLocal()
    try:
        version = db.query(AssetVersion).filter(AssetVersion.id == uuid.UUID(version_id)).first()
        asset = db.query(Asset).filter(Asset.id == uuid.UUID(asset_id)).first()
        media_file = db.query(MediaFile).filter(MediaFile.version_id == uuid.UUID(version_id)).first() if version else None
        if not (version and asset and media_file) or asset.asset_type != AssetType.video:
            return
        if version.processing_status != ProcessingStatus.ready or not media_file.s3_key_processed:
            return
        if min(media_file.width or PROXY_SHORT_SIDE, media_file.height or PROXY_SHORT_SIDE) < PROXY_SHORT_SIDE:
            return  # smaller than the proxy: the HLS ladder is already lighter
        live_prefix = media_file.s3_key_processed
        target_key = f"{live_prefix}/{REVIEW_PROXY_NAME}"
        if object_exists(target_key):
            return
        raw_key = media_file.s3_key_raw
        side_prefix = f"processed/{asset.project_id}/{asset_id}/{version_id}/p540"
        db.commit()  # release the connection for the length of the encode

        s3 = get_s3_client()
        transcoder = FFmpegTranscoder(s3, settings.s3_bucket, settings.s3_endpoint)
        result = _run_async(transcoder.transcode(TranscodeJob(
            media_id=asset_id, version_id=version_id, input_s3_key=raw_key,
            output_s3_prefix=side_prefix, qualities=["540p"], make_thumbnail=False,
        )))
        if not result.success:
            if self.request.retries < self.max_retries:
                raise self.retry(exc=RuntimeError(result.error))
            logger.warning("review proxy failed for %s: %s", asset_id, result.error)
            return
        s3.copy_object(
            Bucket=settings.s3_bucket, Key=target_key,
            CopySource={"Bucket": settings.s3_bucket, "Key": f"{side_prefix}/{REVIEW_PROXY_NAME}"},
        )
    finally:
        db.close()
