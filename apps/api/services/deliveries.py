"""Deliveries: an approval creates one public hand-off page (`/d/<token>`); the agent learns of it from /agent/feedback."""
import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..models.approval import Approval, ApprovalStatus
from ..models.asset import Asset, AssetVersion, MediaFile
from ..models.delivery import Delivery
from ..models.project import Project
from ..models.upload_request import RequestUpload, UploadRequest
from ..models.user import User
from . import feedback_rounds

# An approval stays undoable for 5 s in the review UI; an agent hears of it only after that, so it never acts on a take-back.
SETTLE = timedelta(seconds=6)
LIVE_NOTES = ["Ads: upload it in Ads Manager, or to the channel it was made for, and set it live.",
              "Team: post this link in the team channel so everyone has the final file.",
              "Questions or changes: reply in the review, not on this page."]


def share_url(d: Delivery) -> str:
    return f"{(settings.frontend_url or '').rstrip('/')}/d/{d.token}"


def out(d: Delivery) -> dict:
    return {"token": d.token, "share_url": share_url(d)}


def on_approved(db: Session, asset: Asset, version_id: uuid.UUID, user: User) -> Delivery:
    """The delivery of this version (one per version, created by the first approval); commits."""
    find = lambda: db.query(Delivery).filter(Delivery.asset_id == asset.id, Delivery.version_id == version_id).first()  # noqa: E731
    d = find()
    if d is None:
        req = feedback_rounds.request_for_asset(db, asset.id)
        try:
            with db.begin_nested():
                db.add(Delivery(token=secrets.token_urlsafe(24), request_id=req.id if req else None, asset_id=asset.id,
                                version_id=version_id, approved_by=user.name or user.email, approved_at=datetime.now(timezone.utc)))
        except IntegrityError:  # a parallel approve created it first
            pass
        db.commit()
        d = find()
    return d


def on_unapproved(db: Session, asset: Asset, version_id: Optional[uuid.UUID]) -> None:
    """Take-back: the version has no approval left, so it has no delivery - unless the link was already handed on."""
    if version_id is None:
        return
    if db.query(Approval).filter(Approval.asset_id == asset.id, Approval.version_id == version_id,
                                 Approval.status == ApprovalStatus.approved, Approval.deleted_at.is_(None)).first():
        return
    db.query(Delivery).filter(Delivery.asset_id == asset.id, Delivery.version_id == version_id,
                              Delivery.handed_on_at.is_(None)).delete(synchronize_session=False)
    db.commit()


def event_at(d: Delivery) -> datetime:
    return d.approved_at + SETTLE


def agent_events(db: Session, agent_user: User, project_id: uuid.UUID, cursor: Optional[datetime], now: datetime) -> list[Delivery]:
    """Settled approvals of requests this agent handed versions in to, oldest first. Past `cursor` (compared on
    event_at, which is what next_cursor carries); without one, only what has not been handed on yet."""
    handed_in = db.query(RequestUpload.request_id).filter(RequestUpload.uploader_email == agent_user.email)
    q = db.query(Delivery).join(UploadRequest, UploadRequest.id == Delivery.request_id).filter(
        UploadRequest.project_id == project_id, UploadRequest.id.in_(handed_in), Delivery.approved_at <= now - SETTLE)
    q = q.filter(Delivery.approved_at > cursor - SETTLE) if cursor is not None else q.filter(Delivery.handed_on_at.is_(None))
    return q.order_by(Delivery.approved_at).all()


def event(d: Delivery) -> dict:
    return {"type": "approved", "request_id": str(d.request_id), "asset_id": str(d.asset_id), "version_id": str(d.version_id),
            "share_url": share_url(d), "approved_at": d.approved_at.isoformat()}


def sha256_of(key: str) -> str:
    from .s3_service import get_s3_client
    body = get_s3_client().get_object(Bucket=settings.s3_bucket, Key=key)["Body"]
    h = hashlib.sha256()
    for chunk in body.iter_chunks(1024 * 1024):
        h.update(chunk)
    return h.hexdigest()


def media_files(db: Session, d: Delivery) -> list[MediaFile]:
    return db.query(MediaFile).filter(MediaFile.version_id == d.version_id).order_by(MediaFile.sequence_order, MediaFile.created_at).all()


def delivery_v1(db: Session, d: Delivery, *, hashes: bool) -> Optional[dict]:
    """The page's content and `delivery.v1`; None when the asset or version is gone."""
    from .s3_service import build_download_filename, generate_presigned_get_url
    asset = db.query(Asset).filter(Asset.id == d.asset_id, Asset.deleted_at.is_(None)).first()
    version = db.query(AssetVersion).filter(AssetVersion.id == d.version_id, AssetVersion.deleted_at.is_(None)).first()
    if asset is None or version is None:
        return None
    project = db.get(Project, asset.project_id)
    req = db.get(UploadRequest, d.request_id) if d.request_id else None
    files = media_files(db, d)
    cache = dict(d.file_hashes or {})
    if hashes:
        missing = [f for f in files if str(f.id) not in cache]
        for f in missing:
            cache[str(f.id)] = sha256_of(f.s3_key_raw)
        if missing:
            d.file_hashes = cache
            db.commit()
    api = f"{(settings.frontend_url or '').rstrip('/')}/api"
    video = next((f for f in files if f.mime_type.startswith("video/")), None)
    return {
        "schema": "delivery.v1", "title": req.title if req else asset.name, "brand": project.name if project else "",
        "card": req.external_ref if req else None, "version": version.version_number,
        "video_url": generate_presigned_get_url(video.s3_key_raw) if video else None,
        "files": [{"name": build_download_filename(asset.name, f.original_filename), "url": f"{api}/deliveries/{d.token}/files/{f.id}",
                   "sha256": cache.get(str(f.id)), "size_bytes": f.file_size_bytes, "mime_type": f.mime_type} for f in files],
        "approved_by": d.approved_by, "approved_at": d.approved_at.isoformat(), "live_notes": LIVE_NOTES,
        "handed_on_at": d.handed_on_at.isoformat() if d.handed_on_at else None, "share_url": share_url(d),
    }
