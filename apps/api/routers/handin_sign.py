"""V3 part C (spec 2026-11-17 client delivery): the agent prepares a hand-in, a signed-in staff member signs it.

POST /agent/handins       an agent key: request + files + client text -> a one-time sign link (24 h). The same request
                          and files answer with the same hand-in (a new link each time, the old one stops working).
GET  /handins/{id}?t=     staff only: what will be handed in (videos, text, recipient), or the result once signed.
POST /handins/{id}/sign   staff only: signed_by/at + the clean client link (V3 A). Twice = the same link. Agents: 403.
Sending the link to the client stays a person's job; nothing here talks to the portal.
"""
import base64
import binascii
import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..middleware.auth import get_agent, get_optional_user
from ..middleware.rate_limit import rate_limit
from ..models.asset import Asset
from ..models.handin_sign import HandinSign
from ..models.project import Project
from ..models.share import ShareLink, ShareLinkItem, SharePermission
from ..models.upload_request import UploadRequest
from ..models.user import User
from ..services import client_view, review_bridge
from ..services.agents import AgentContext
from ..services.s3_service import generate_presigned_get_url

router = APIRouter(tags=["handin"])
SIGN_TTL = timedelta(hours=24)


def _sha(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Prepare(BaseModel):
    request_id: uuid.UUID
    asset_ids: list[uuid.UUID] = Field(min_length=1, max_length=30)
    client_text: str = Field(default="", max_length=4000)


def _client_url(h: HandinSign) -> Optional[str]:
    return f"{settings.frontend_url}/share/{h.share_token}" if h.share_token else None


@router.post("/agent/handins", dependencies=[Depends(rate_limit("handin_prepare", 30, 600))])
def prepare(body: Prepare, agent: AgentContext = Depends(get_agent), db: Session = Depends(get_db)):
    from .agent import _owner_brands
    req = db.get(UploadRequest, body.request_id)
    if req is None or req.project_id not in {p.id for p in _owner_brands(db, agent)}:
        raise HTTPException(404, {"error": "not_found", "next": "Unknown request. Call list_queue or create_request."})
    ids = sorted({str(i) for i in body.asset_ids})
    found = db.query(Asset.id).filter(Asset.id.in_(ids), Asset.folder_id == req.folder_id, Asset.deleted_at.is_(None)).count()
    if found != len(ids):
        raise HTTPException(404, {"error": "not_found", "next": "asset_ids must be files of this request."})
    same = [h for h in db.query(HandinSign).filter(HandinSign.request_id == req.id, HandinSign.deleted_at.is_(None))
            .order_by(HandinSign.prepared_at.desc()).all() if sorted(h.asset_ids) == ids]
    h = same[0] if same else None
    if h is not None and h.signed_at is not None:
        return {"id": str(h.id), "state": "signed", "client_url": _client_url(h)}
    token = secrets.token_urlsafe(32)
    if h is None:
        h = HandinSign(request_id=req.id, asset_ids=ids, prepared_by=agent.user.id, token_hash="", expires_at=_now())
        db.add(h)
    h.client_text, h.token_hash, h.expires_at = body.client_text.strip(), _sha(token), _now() + SIGN_TTL
    db.commit()
    return {"id": str(h.id), "state": "prepared", "sign_url": f"{settings.frontend_url}/handin/{h.id}?t={token}",
            "expires_at": h.expires_at.isoformat(), "next": "Open sign_url in the person's browser. Only a person signs."}


def _signable(db: Session, handin_id: uuid.UUID, t: Optional[str], user: Optional[User], authorization: Optional[str], lock=False) -> HandinSign:
    """The gates, in order: an agent never; a person must be signed-in staff; then the link must be this hand-in's
    current one and fresh. A signed hand-in shows its result whatever the link."""
    if (authorization or "").startswith("Bearer ara_") or getattr(user, "kind", "human") == "agent":
        raise HTTPException(403, "agents_may_not_sign")
    if user is None:
        raise HTTPException(401, "sign_in")
    if not client_view.viewer_is_staff(user):
        raise HTTPException(403, "staff_only")
    q = db.query(HandinSign).filter(HandinSign.id == handin_id, HandinSign.deleted_at.is_(None))
    h = (q.with_for_update() if lock else q).first()
    if h is None:
        raise HTTPException(404, "not_found")
    if h.signed_at is not None:
        return h
    if not t or not hmac.compare_digest(_sha(t), h.token_hash):
        raise HTTPException(403, "link_replaced")
    if h.expires_at <= _now():
        raise HTTPException(410, "link_expired")
    return h


PNG_PREFIX = "data:image/png;base64,"
MAX_INITIALS_BYTES = 300_000


def initials_png(data_url: str) -> Optional[str]:
    """The drawn initials as a PNG data URL, or None when it is not a real (small) PNG. Pure."""
    if not isinstance(data_url, str) or not data_url.startswith(PNG_PREFIX) or len(data_url) > MAX_INITIALS_BYTES * 4 // 3 + 64:
        return None
    try:
        raw = base64.b64decode(data_url[len(PNG_PREFIX):], validate=True)
    except (binascii.Error, ValueError):
        return None
    return data_url if raw.startswith(b"\x89PNG\r\n\x1a\n") and len(raw) > 64 else None


def brand_rules(db: Session, project: Optional[Project]) -> tuple[list[dict], bool]:
    """The brand's active rules, blockers first, as AutoReview holds them; (rules, reachable)."""
    if project is None:
        return [], False
    from .requests import project_brand
    r = review_bridge.rules(project_brand(db, project))
    if r is None:
        return [], False
    rows = [x for x in (r.get("rules") or []) if isinstance(x, dict) and x.get("active", True)]
    rows.sort(key=lambda x: (x.get("severity") != "blocker", str(x.get("name") or "")))
    return [{"id": str(x.get("id", "")), "name": str(x.get("name") or ""), "what": str(x.get("what") or ""),
             "severity": str(x.get("severity") or "")} for x in rows], True


class Sign(BaseModel):
    accepted: bool = False
    initials_png: str = Field(default="", max_length=MAX_INITIALS_BYTES * 2)


def _view(db: Session, h: HandinSign) -> dict:
    from .share import _get_latest_media_file
    req = db.get(UploadRequest, h.request_id)
    project = db.get(Project, req.project_id) if req else None
    assets = {str(a.id): a for a in db.query(Asset).filter(Asset.id.in_(h.asset_ids), Asset.deleted_at.is_(None)).all()}
    files = []
    for aid in h.asset_ids:
        a = assets.get(aid)
        if a is None:
            continue
        mf = _get_latest_media_file(db, a.id)
        files.append({"id": aid, "name": a.name,
                      "url": generate_presigned_get_url(mf.s3_key_raw) if mf and mf.s3_key_raw else None,
                      "thumbnail_url": generate_presigned_get_url(mf.s3_key_thumbnail) if mf and mf.s3_key_thumbnail else None})
    files.sort(key=lambda f: f["name"])
    signer = db.get(User, h.signed_by) if h.signed_by else None
    rules, reachable = (h.terms or [], True) if h.signed_at else brand_rules(db, project)
    return {"rules": rules, "rules_reachable": reachable, "initials_png": h.initials_png,"id": str(h.id), "state": "signed" if h.signed_at else "prepared", "title": req.title if req else "",
            "recipient": project.name if project else "", "client_text": h.client_text, "files": files,
            "signed_by": signer.name if signer else None, "signed_at": h.signed_at.isoformat() if h.signed_at else None,
            "client_url": _client_url(h)}


@router.get("/handins/{handin_id}", dependencies=[Depends(rate_limit("handin_view", 60, 600))])
def view(handin_id: uuid.UUID, t: Optional[str] = Query(None), db: Session = Depends(get_db),
         user: Optional[User] = Depends(get_optional_user), authorization: Optional[str] = Header(None)):
    return _view(db, _signable(db, handin_id, t, user, authorization))


@router.post("/handins/{handin_id}/sign", dependencies=[Depends(rate_limit("handin_sign", 30, 600))])
def sign(handin_id: uuid.UUID, body: Sign = Body(default_factory=Sign), t: Optional[str] = Query(None), db: Session = Depends(get_db),
         user: Optional[User] = Depends(get_optional_user), authorization: Optional[str] = Header(None)):
    h = _signable(db, handin_id, t, user, authorization, lock=True)
    if h.signed_at is None:
        # The brand rules were shown and ticked ("I've read this"), and the signer drew their initials (Alan 2026-11-17).
        if not body.accepted:
            raise HTTPException(400, "accept_terms")
        png = initials_png(body.initials_png)
        if png is None:
            raise HTTPException(400, "initials_required")
        req = db.get(UploadRequest, h.request_id)
        h.initials_png, h.terms = png, brand_rules(db, db.get(Project, req.project_id))[0]
        link = ShareLink(project_id=req.project_id, token=secrets.token_urlsafe(32), created_by=user.id, title=req.title,
                         permission=SharePermission.comment, visibility="public", allow_download=True)
        db.add(link)
        db.flush()
        db.add_all([ShareLinkItem(share_link_id=link.id, asset_id=uuid.UUID(a)) for a in h.asset_ids])
        h.signed_by, h.signed_at, h.share_token = user.id, _now(), link.token
        db.commit()
    return _view(db, h)
