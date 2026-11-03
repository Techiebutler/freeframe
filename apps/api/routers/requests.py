"""File requests: WeTransfer in reverse, with Auto Review built in (platform v2).

Spec: docs/superpowers/specs/2026-09-28-review-platform-v2-design.md.

  Owner (signed in)            Editor (no account, only the link)
  POST /requests      ──link──▶ GET  /r/{token}
  GET  /requests               POST /r/{token}/upload/{initiate,presign-part,complete,abort}
                               GET  /r/{token}/review

The token IS the permission, exactly like a share link is for viewing: whoever holds it may upload
into that one folder and read the review of what they uploaded - nothing else in the project.
Uploads reuse the normal multipart path (presigned S3 parts), so a big file behaves exactly as it
does for a signed-in editor. A file with the same name as one already handed in becomes its next
VERSION - that is how a V2 clears the gate.
"""
import base64
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from botocore.exceptions import ClientError
from pydantic import BaseModel, EmailStr, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..middleware.auth import get_current_user
from ..middleware.rate_limit import rate_limit
from ..models.asset import Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus
from ..models.comment import Comment
from ..models.folder import Folder
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.share import ShareLink, SharePermission
from ..models.branding import ProjectBranding
from ..services import s3_service
from ..models.upload_request import RequestUpload, UploadRequest
from ..models.user import GuestUser, User
from ..schemas.upload import ALLOWED_MIME_TYPES, mime_to_asset_type
from ..models.checklist_binding import ChecklistBinding
from ..services.checklists import reserve_binding, binding_out, dispatch_binding
from ..services import review_bridge
from ..services.briefing import docx_text, MAX_DOCUMENT_BASE64, validate_briefing_text
from ..services.review_timing import adopt_signed_in_upload, freeze_submission_timing
from ..services.iteration_requests import request_fields, components, upload_slot, bind_upload, revision_target, stored_upload
from ..services.permissions import effective_project_role, require_project_role
from ..services.s3_service import (
    abort_multipart_upload, complete_multipart_upload, create_multipart_upload, presign_upload_part,
)
from ..services.storage import upload_guard_error

router = APIRouter(tags=["requests"])

# Auto Review comments as this guest (feedback-agent src/freeframe-agent.ts postGuestComment).
REVIEWER_EMAIL = "review@aditor.ai"

# An internal hand-in card, in the exact shape Aditor files on a folder's description. Capturing
# (not `(?:...)`) so a caller can also pull out the bare card id/short-link as the dedup key.
CARD_URL = re.compile(r'https://trello\.com/c/([A-Za-z0-9]{8}|[A-Fa-f0-9]{24})(?:/[^?#\s]*)?/?')


# ── Pure helpers (tested directly) ─────────────────────────────────────────────

def request_state(req: UploadRequest, now: datetime) -> str:
    """live | revoked | expired. Revoked wins: an owner who pulled a link meant it."""
    if req.revoked_at is not None:
        return "revoked"
    if req.expires_at is not None and req.expires_at <= now:
        return "expired"
    return "live"


def asset_name_for(filename: str) -> str:
    """The asset a file belongs to: its name without extension, so `Hook1.mp4` and `Hook1.mov`
    handed in twice are two versions of ONE asset, never two stray copies."""
    return os.path.splitext(os.path.basename(filename or ""))[0].strip()[:255] or "Untitled"


def _request_gate(assets: list[dict], bridge: Optional[dict]) -> dict:
    """One verdict for owner, editor and finish; missing evidence never means Ready."""
    visible = sum(bool(c.get('must_fix') or c.get('weight') == 'must_fix') for a in assets for c in a.get('comments', []))
    counts = [a.get('open_must_fixes', 0) for a in assets]
    bridge_count = bridge.get('openMustFixes') if isinstance(bridge, dict) else None
    valid = type(bridge_count) is int and bridge_count >= 0 and bridge.get('status') in ('reviewing', 'held', 'clear', 'unavailable')
    count = max(visible, sum(n for n in counts if type(n) is int and n >= 0), bridge_count if valid else 0)
    states = [a.get('review_state', 'unavailable') for a in assets]
    if count or 'held' in states or (valid and bridge['status'] == 'held'):
        state = 'held'
    elif not assets:
        state = 'reviewing'
    elif not valid or bridge['status'] == 'unavailable' or any(st not in ('clear', 'reviewing', 'upload_incomplete') for st in states):
        state = 'unavailable'
    elif 'reviewing' in states or 'upload_incomplete' in states or bridge['status'] == 'reviewing':
        state = 'reviewing'
    else:
        state = 'clear'
    return {'status': state, 'open_must_fixes': count}


def project_brand(db: Session, project: Project) -> str:
    """The brand key Auto Review files this project's reviews and rules under.

    A CUSTOMER's project is namespaced by its id - never by its name, which the customer types and
    which could otherwise resolve onto a real client's brand ("Freiheit" -> freiheit-media) and
    reach that client's rules. Explicit staff bindings survive renames and apply only to future
    assignments. Unbound workspaces retain their legacy behavior until an owner confirms identity.
    """
    creator = db.query(User).filter(User.id == project.created_by).first()
    if creator is not None and getattr(creator, "is_staff", True) is False:
        return f"cust-{project.id.hex[:16]}"
    from ..services.project_brands import confirmed_brand
    bound = confirmed_brand(project)
    if bound:
        if creator is None or getattr(creator, 'is_staff', None) is not True:
            raise HTTPException(409, 'Staff workspace identity is unavailable')
        return bound['brand_slug']
    return review_bridge.brand_slug(project.name) or f"cust-{project.id.hex[:16]}"


# ── Owner ──────────────────────────────────────────────────────────────────────

class RequestCreate(BaseModel):
    receive_iterations: bool = False
    iteration_plan_token: Optional[str] = None
    aspect_ratio: Literal["9:16", "16:9", "1:1"] = "9:16"
    project_id: uuid.UUID
    title: str = Field(min_length=1, max_length=255)
    brief_text: str = ""
    brief_url: str = ""
    brief_pdf_base64: str = Field(default="", max_length=15_000_000)
    brief_docx_base64: str = Field(default="", max_length=MAX_DOCUMENT_BASE64)
    idempotency_key: Optional[uuid.UUID] = None
    expires_in_days: Optional[int] = Field(default=None, ge=1, le=365)


def _request_out(req: UploadRequest, project: Optional[Project], st: Optional[dict] = None, assets: int = 0, binding=None) -> dict:
    base = (settings.frontend_url or "").rstrip("/")
    return {
        "id": str(req.id),
        "token": req.token,
        "url": f"{base}/r/{req.token}",
        "share_url": f"{base}/share/{req.review_share_token}",
        "title": req.title,
        "project_id": str(req.project_id),
        "project_name": project.name if project else "",
        "folder_id": str(req.folder_id),
        "review_share_token": req.review_share_token,
        "brand_slug": req.brand_slug,
        "brief_excerpt": req.brief_excerpt,
        "last_uploader_name": req.last_uploader_name,
        "assets": assets,
        "state": request_state(req, datetime.now(timezone.utc)),
        "created_at": req.created_at.isoformat() if req.created_at else None,
        "checklist_binding_id": str(binding.id) if binding else None,
        "checklist": binding_out(binding) if binding else None,
        **(st or {"status": "reviewing", "open_must_fixes": 0}),
        **request_fields(req),
    }


@router.post("/requests", status_code=status.HTTP_201_CREATED)
def create_request(body: RequestCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = db.query(Project).filter(Project.id == body.project_id, Project.deleted_at.is_(None)).populate_existing().with_for_update().first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_role(db, body.project_id, current_user, ProjectRole.editor)

    brief_text = validate_briefing_text('\n\n'.join(filter(None, [docx_text(body.brief_docx_base64) if body.brief_docx_base64 else '', body.brief_text])))
    brand = project_brand(db, project)
    from ..services.project_brands import require_card_reference
    require_card_reference(project, body.brief_url)
    intent = {'brand': brand, 'title': body.title.strip(), 'brief_text': brief_text,
        'brief_url': body.brief_url, 'brief_pdf_base64': body.brief_pdf_base64,
        'expires_in_days': body.expires_in_days,
        **({'receive_iterations': True, 'aspect_ratio': body.aspect_ratio,
            'iteration_plan_token': body.iteration_plan_token} if body.receive_iterations else {})}
    binding = reserve_binding(db, project.id, current_user.id, f"request:{body.idempotency_key or uuid.uuid4()}", intent)
    if binding.request_id:
        req = db.query(UploadRequest).filter(UploadRequest.id == binding.request_id, UploadRequest.project_id == project.id).first()
        if req is None:
            raise HTTPException(409, 'Assignment request is unavailable')
        db.commit()
        dispatch_binding(binding.id)
        return _request_out(req, project, binding=binding)

    manifest = None
    if body.receive_iterations:
        from .iterations import require_connected
        from ..services.iteration_manifest import read_plan
        require_connected()
        manifest = {'schema_version':1,'summary':'All selected combinations','slots':[],'recipes':[]}
        if body.iteration_plan_token:
            try:
                manifest=read_plan(body.iteration_plan_token,str(current_user.id),str(project.id),
                    {'brief_text':brief_text,'brief_url':body.brief_url,'brief_pdf_base64':body.brief_pdf_base64})
            except ValueError as error: raise HTTPException(422,str(error)) from error
    folder = Folder(project_id=project.id, name=body.title.strip(),
                    description=(body.brief_url or "File request")[:2000], created_by=current_user.id)
    db.add(folder)
    db.flush()
    # The standing link Auto Review reads the folder through. Always created here (not gated on the
    # automation webhook): a request exists to be reviewed. Same two switches as automation_share.
    link = ShareLink(folder_id=folder.id, token=secrets.token_urlsafe(32), created_by=current_user.id,
                     title="Auto Review", description="Standing link so Auto Review can see this request.",
                     permission=SharePermission.comment, allow_download=True, visibility="public")
    db.add(link)
    db.flush()
    brand = project_brand(db, project)
    excerpt = (brief_text or body.brief_url or ("PDF briefing" if body.brief_pdf_base64 else "")).strip()[:500] or None
    req = UploadRequest(
        token=secrets.token_urlsafe(24), project_id=project.id, folder_id=folder.id,
        created_by=current_user.id, title=body.title.strip(), brand_slug=brand,
        review_share_token=link.token, brief_excerpt=excerpt,
        receive_iterations=body.receive_iterations, iteration_manifest=manifest,
        iteration_state={'submitted':False,'structured':bool(body.iteration_plan_token),
            'brief_input':{'url':body.brief_url,'pdf':body.brief_pdf_base64}} if body.receive_iterations else None,
        iteration_mode='components',iteration_ratio=body.aspect_ratio,iteration_brief=brief_text,
        iteration_owner_id=project.created_by if body.receive_iterations else None,
        expires_at=(datetime.now(timezone.utc) + timedelta(days=body.expires_in_days)) if body.expires_in_days else None,
    )
    db.add(req)
    db.flush()
    binding.request_id = req.id
    binding.folder_id = folder.id
    binding.review_share_token = link.token
    db.commit()
    db.refresh(req)
    # After the commit, and fail-open: a request the review never heard of is still a working link.
    dispatch_binding(binding.id)
    return _request_out(req, project, binding=binding)


def ensure_folder_assignment(db: Session, folder: Folder, project: Project, actor_id: uuid.UUID,
                             *, create_share_if_missing: bool = False) -> tuple[UploadRequest, Optional[ChecklistBinding]]:
    """Find-or-create the ONE upload request (and surface its one checklist binding, if any) for a
    hand-in folder - idempotent, and never more than one of either. Shared by the interactive
    conversion route below and the portal's server-to-server delivery-folder endpoint, so both give
    exactly the same guarantees: a single live assignment, the brand still matching, and the
    standing review share actually usable before anyone is handed a token for it.

    `create_share_if_missing` only matters for a folder with no standing share at all (the portal
    endpoint creates folders itself, so there is no earlier step that would have made one); the
    interactive route's folders always already got one at folder-creation, so it defaults to the
    original behavior of 409'ing rather than ever creating.
    """
    requests = db.query(UploadRequest).filter(UploadRequest.folder_id == folder.id).limit(2).all()
    bindings = db.query(ChecklistBinding).filter(ChecklistBinding.folder_id == folder.id,
        ChecklistBinding.project_id == project.id, ChecklistBinding.deleted_at.is_(None)).limit(2).all()
    if len(requests) > 1 or len(bindings) > 1:
        raise HTTPException(409, 'This hand-in has conflicting assignments.')
    req = requests[0] if requests else None
    binding = bindings[0] if bindings else None
    if req and req.project_id != project.id:
        raise HTTPException(409, 'This hand-in belongs to another project.')
    if req and request_state(req, datetime.now(timezone.utc)) != 'live':
        raise HTTPException(410, 'The editor link was closed by its owner.')
    if binding and binding.request_id and (not req or binding.request_id != req.id):
        raise HTTPException(409, 'The checklist belongs to another assignment.')
    from ..services.project_brands import confirmed_brand, require_card_reference
    if confirmed_brand(project):
        brand = project_brand(db, project)
        if (req and req.brand_slug != brand) or (binding and (binding.intent or {}).get('brand') != brand):
            raise HTTPException(409, 'Workspace brand changed; create a new request. Existing assignment is unchanged.')
        require_card_reference(project, folder.description)
    shares = db.query(ShareLink).filter(ShareLink.folder_id == folder.id, ShareLink.deleted_at.is_(None),
        ShareLink.title == 'Auto Review', ShareLink.permission == SharePermission.comment).all()
    wanted = req.review_share_token if req else binding.review_share_token if binding else None
    share = next((s for s in shares if s.token == wanted), None) if wanted else shares[0] if len(shares) == 1 else None
    if share is None and not shares and create_share_if_missing:
        from ..services.automation_share import create_standing_folder_link
        share = create_standing_folder_link(db, project.id, folder.id, actor_id, bound_review=True)
    if not share or not share.is_enabled or share.password_hash or share.visibility != 'public' or (share.expires_at and share.expires_at <= datetime.now(timezone.utc)):
        raise HTTPException(409, 'The review share link is unavailable. Open the project to check its sharing settings.')
    if req is None:
        req = UploadRequest(token=secrets.token_urlsafe(24), project_id=project.id, folder_id=folder.id,
            created_by=actor_id, title=folder.name, brand_slug=project_brand(db, project),
            review_share_token=share.token, brief_excerpt=folder.description,
            iteration_state={'internal_handin': {'card_url': folder.description}})
        db.add(req); db.flush()
    if binding:
        binding.request_id = req.id
    return req, binding


@router.post('/folders/{folder_id}/editor-request')
def folder_editor_request(folder_id: uuid.UUID, db: Session = Depends(get_db),
                          current_user: User = Depends(get_current_user)):
    """Give a staff hand-in its native editor without moving files or widening a share."""
    if getattr(current_user, 'is_staff', False) is not True:
        raise HTTPException(403, 'Internal hand-in is available to staff.')
    folder = db.query(Folder).filter(Folder.id == folder_id, Folder.deleted_at.is_(None)).with_for_update().first()
    project = db.query(Project).filter(Project.id == folder.project_id, Project.deleted_at.is_(None)).populate_existing().with_for_update().first() if folder else None
    if not project or not project.is_workspace:
        raise HTTPException(404, 'Workspace hand-in not found')
    require_project_role(db, project.id, current_user, ProjectRole.editor)
    if not CARD_URL.fullmatch((folder.description or '').strip()):
        raise HTTPException(409, 'This folder is not an internal card hand-in.')
    req, binding = ensure_folder_assignment(db, folder, project, current_user.id)
    if not components(req):
        req = locked_request(db, req.id)
        for asset in _submitted_assets(db, req):
            versions = db.query(AssetVersion).filter(AssetVersion.asset_id == asset.id,
                AssetVersion.deleted_at.is_(None)).all()
            for version in versions:
                adopt_signed_in_upload(db, req, asset.id, version)
                if req.completion_versions and req.completion_versions.get(str(asset.id)) != str(version.id) and version == max(versions, key=lambda v: v.version_number):
                    req.completed_at = None
                    req.completion_versions = None
    db.commit()
    return _request_out(req, project, binding=binding)


@router.get("/requests")
def list_requests(project_id: Optional[uuid.UUID] = Query(None), db: Session = Depends(get_db),
                  current_user: User = Depends(get_current_user)):
    # Filter before the limit so deleted assignments cannot hide active deliveries.
    q = db.query(UploadRequest).filter(UploadRequest.folder_id.in_(
        select(Folder.id).where(Folder.deleted_at.is_(None))))
    if project_id:
        require_project_role(db, project_id, current_user, ProjectRole.viewer)
        q = q.filter(UploadRequest.project_id == project_id)
    else:
        member_projects = [m.project_id for m in db.query(ProjectMember).filter(
            ProjectMember.user_id == current_user.id, ProjectMember.deleted_at.is_(None)).all()]
        q = q.filter((UploadRequest.created_by == current_user.id) | (UploadRequest.project_id.in_(member_projects or [uuid.uuid4()])))
    reqs = q.order_by(UploadRequest.created_at.desc()).limit(100).all()
    projects = {}
    for project in db.query(Project).filter(Project.id.in_({r.project_id for r in reqs} or {uuid.uuid4()}), Project.deleted_at.is_(None)).all():
        try:
            require_project_role(db, project.id, current_user, ProjectRole.viewer)
        except HTTPException:
            continue
        projects[project.id] = project
    reqs = [r for r in reqs if r.project_id in projects]
    statuses = review_bridge.request_status([r.review_share_token for r in reqs])
    assets = {r.id: _submitted_assets(db, r) for r in reqs}
    stats = review_bridge.asset_stats([str(a.id) for items in assets.values() for a in items])
    reviewer = db.query(GuestUser).filter(GuestUser.email == REVIEWER_EMAIL).first()
    bindings = {b.request_id: b for b in db.query(ChecklistBinding).filter(
        ChecklistBinding.request_id.in_([r.id for r in reqs]), ChecklistBinding.deleted_at.is_(None)).all()}
    out = [_request_out(r, projects.get(r.project_id),
        _request_gate(_review_assets(db, r, assets[r.id], reviewer, stats, include_media=False), statuses.get(r.review_share_token)),
        len(assets[r.id]), bindings.get(r.id)) for r in reqs]
    db.commit()  # Persist observed campaign usage after assembling the response.
    return out


@router.delete("/requests/{request_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_request(request_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    req = db.query(UploadRequest).filter(UploadRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    if req.created_by != current_user.id:
        require_project_role(db, req.project_id, current_user, ProjectRole.owner)
    req.revoked_at = datetime.now(timezone.utc)
    db.commit()


# ── Owner: rules and time saved, proxied to Auto Review ────────────────────────

def _brands_for(db: Session, user: User) -> Optional[list[str]]:
    """Staff see every brand (None = unfiltered); a customer sees only brands of its own projects."""
    if getattr(user, "is_staff", True) is not False:
        return None
    ids = [m.project_id for m in db.query(ProjectMember).filter(
        ProjectMember.user_id == user.id, ProjectMember.deleted_at.is_(None)).all()]
    projects = db.query(Project).filter(Project.id.in_(ids or [uuid.uuid4()]), Project.deleted_at.is_(None)).all()
    return sorted({project_brand(db, p) for p in projects})


@router.get("/insights/time-saved")
def time_saved(days: int = Query(30, ge=1, le=90), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    brands = _brands_for(db, current_user)
    if brands == []:
        return {"days": days, "videos": 0, "watchSec": 0, "typeSec": 0, "totalSec": 0,
                "perDay": [], "perBrand": [], "assumptions": {"wpm": 40, "watches": 1}}
    r = review_bridge.time_saved(days, brands)
    if r is None:
        raise HTTPException(status_code=503, detail="Auto Review is not reachable right now.")
    return r


def _project_brand(db: Session, project_id: uuid.UUID, user: User, role: ProjectRole) -> str:
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_role(db, project_id, user, role)
    return project_brand(db, project)


@router.get("/insights/rules")
def list_rules(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    brand = _project_brand(db, project_id, current_user, ProjectRole.owner)
    r = review_bridge.rules(brand)
    if r is None:
        raise HTTPException(status_code=503, detail="Auto Review is not reachable right now.")
    return {"brand": brand, **r}


class RulesImport(BaseModel):
    project_id: uuid.UUID
    text: str = ""
    url: str = ""
    pdf_base64: str = ""
    docx_base64: str = Field(default="", max_length=MAX_DOCUMENT_BASE64)


@router.post("/insights/rules/import")
def import_rules(body: RulesImport, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    brand = _project_brand(db, body.project_id, current_user, ProjectRole.owner)
    text = validate_briefing_text('\n\n'.join(filter(None, [docx_text(body.docx_base64) if body.docx_base64 else '', body.text])), guidelines=True)
    if not (text.strip() or body.url.strip() or body.pdf_base64):
        raise HTTPException(status_code=400, detail="Choose a Word document or PDF, or paste text or a link.")
    r = review_bridge.import_rules(brand, text, body.url, body.pdf_base64)
    if r is None:
        raise HTTPException(status_code=503, detail="Auto Review could not read that right now.")
    if r.get('error') == 'guide-limit':
        raise HTTPException(400, 'Guidelines can contain up to 12,000 characters. Shorten the document and try again.')
    if r.get('error') == 'briefing-unavailable':
        raise HTTPException(400, 'The document could not be read. Check sharing permissions (anyone with the link), or upload the document directly as Word (.docx), PDF or text, then try again.')
    return r


# ── Editor: the public side of a request ───────────────────────────────────────

def _live_request(db: Session, token: str, *, recovery=False) -> UploadRequest:
    req = db.query(UploadRequest).filter(UploadRequest.token == token).first()
    if not req:
        raise HTTPException(status_code=404, detail="This link does not exist.")
    state = request_state(req, datetime.now(timezone.utc))
    if state != "live":
        raise HTTPException(status_code=410, detail="This link was closed by its owner." if state == "revoked" else "This link has expired.")
    # A link into a deleted workspace or folder is closed too - uploads must never land in the bin.
    project = db.query(Project).filter(Project.id == req.project_id, Project.deleted_at.is_(None)).first()
    folder = db.query(Folder).filter(Folder.id == req.folder_id, Folder.deleted_at.is_(None)).first()
    if project is None or folder is None:
        raise HTTPException(status_code=410, detail="This link was closed by its owner.")
    from ..services.campaign_access import require_project_access
    if not recovery:
        require_project_access(db, project.created_by)
    return req


def locked_request(db, request_id):
    return db.query(UploadRequest).filter(UploadRequest.id == request_id).populate_existing().with_for_update().one()


def _submitted_assets(db, req):
    alive = select(AssetVersion.asset_id).where(AssetVersion.deleted_at.is_(None))
    return db.query(Asset).filter(Asset.folder_id == req.folder_id, Asset.deleted_at.is_(None),
        Asset.id.in_(alive)).order_by(Asset.created_at).all()


def _public_brief(req, folder):
    text = getattr(req, "iteration_brief", None)
    state = req.iteration_state if isinstance(req.iteration_state, dict) else {}
    internal = state.get("internal_handin", {})
    pending = state.get("brief_input", {})
    description = getattr(folder, "description", None)
    candidates = [
        internal.get("card_url") if isinstance(internal, dict) else None,
        description if isinstance(description, str) and len(description) < 2000 else None,
        pending.get("url") if isinstance(pending, dict) else None,
    ]
    url = None
    for candidate in candidates:
        if not isinstance(candidate, str) or any(c.isspace() or ord(c) < 32 or ord(c) == 127 or c == "\\" for c in candidate):
            continue
        try:
            parsed = urlsplit(candidate)
            _ = parsed.port  # Reject malformed ports rather than return an unusable source link.
            if parsed.scheme in ("http", "https") and parsed.hostname and parsed.username is None and parsed.password is None:
                url = candidate
                break
        except ValueError:
            continue
    return {"brief_text": text if isinstance(text, str) and text.strip() else None, "brief_url": url}


@router.get("/r/{token}", dependencies=[Depends(rate_limit("request_view", 120, 600))])
def view_request(token: str, db: Session = Depends(get_db)):
    req = _live_request(db, token)
    project = db.query(Project).filter(Project.id == req.project_id).first()
    folder = db.query(Folder).filter(Folder.id == req.folder_id, Folder.project_id == req.project_id, Folder.deleted_at.is_(None)).first()
    assets = _submitted_assets(db, req)
    return {
        **request_fields(req),
        **_public_brief(req, folder),
        "title": req.title,
        "brand": project.name if project else "",
        "logo_url": _brand_logo(db, req.project_id),
        "brief_excerpt": req.brief_excerpt,
        "review_share_token": req.review_share_token,
        "assets": [{"id": str(a.id), "name": a.name} for a in assets],
        "expires_at": req.expires_at.isoformat() if req.expires_at else None,
        "completed_at": req.completed_at.isoformat() if req.completed_at else None,
    }


def _writable_request(db, token):
    req = locked_request(db, _live_request(db, token).id)
    if req.completed_at or (components(req) and (req.iteration_state or {}).get('delivery',{}).get('started')):
        raise HTTPException(409, 'This request is complete.')
    return req


def _record_uploader(db, req, version, identity) -> RequestUpload:
    record = db.query(RequestUpload).filter(RequestUpload.request_id == req.id,
        RequestUpload.asset_id == version.asset_id, RequestUpload.version_number == version.version_number).first()
    if identity.name is None:
        if not record:
            raise HTTPException(422, 'Add your name and email to submit these files.')
        return record
    if not record:
        record = RequestUpload(request_id=req.id, asset_id=version.asset_id, version_number=version.version_number)
        db.add(record)
    record.uploader_name = identity.name.strip()
    record.uploader_email = str(identity.email).lower()
    req.last_uploader_name, req.last_uploader_email = record.uploader_name, record.uploader_email
    return record


class GuestIdentity(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    email: Optional[EmailStr] = None

    @model_validator(mode="after")
    def paired_identity(self):
        if (self.name is None) != (self.email is None) or (self.name is not None and not self.name.strip()):
            raise ValueError("Provide both your name and email.")
        return self


class GuestInitiate(GuestIdentity):
    slot_id: Optional[str] = Field(default=None,max_length=80)
    asset_id: Optional[uuid.UUID] = None
    original_filename: str = Field(min_length=1, max_length=500)
    mime_type: str
    file_size_bytes: int = Field(gt=0)


@router.post("/r/{token}/upload/initiate", dependencies=[Depends(rate_limit("request_upload", 60, 600))])
def guest_initiate(token: str, body: GuestInitiate, db: Session = Depends(get_db)):
    req = _writable_request(db, token)
    if body.mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {body.mime_type}")
    if not body.mime_type.startswith('video/'):
        raise HTTPException(400, 'Automatic request review currently supports videos. Choose a video file.')
    guard = upload_guard_error(db, body.file_size_bytes)
    if guard:
        raise HTTPException(status_code=400, detail=guard)

    slot=upload_slot(req,body.slot_id,body.mime_type)
    if slot and body.file_size_bytes>200*1024*1024:
        raise HTTPException(422,'Each source part must be 200 MiB or smaller.')
    name = slot['label'] if slot else asset_name_for(body.original_filename)
    if slot:
        bound=revision_target(req,slot['id'],body.asset_id)
        asset=db.query(Asset).filter(Asset.id==uuid.UUID(bound),Asset.folder_id==req.folder_id,
            Asset.project_id==req.project_id,Asset.deleted_at.is_(None)).first() if bound else None
        if bound and not asset: raise HTTPException(404,'File not found in this request.')
    elif body.asset_id:
        asset = db.query(Asset).filter(Asset.id == body.asset_id, Asset.folder_id == req.folder_id,
                                       Asset.project_id == req.project_id, Asset.deleted_at.is_(None)).first()
        if not asset:
            raise HTTPException(404, 'File not found in this request.')
        if asset.asset_type != mime_to_asset_type(body.mime_type):
            raise HTTPException(400, 'Choose the same media type for a new version.')
    else:
        asset = db.query(Asset).filter(Asset.folder_id == req.folder_id, Asset.name == name,
                                       Asset.deleted_at.is_(None)).first()
    if not asset:
        asset = Asset(project_id=req.project_id, name=name, asset_type=mime_to_asset_type(body.mime_type),
                      created_by=req.created_by, folder_id=req.folder_id, iteration_source=bool(slot))
        db.add(asset)
        db.flush()
    # A retried upload must not leave dead "uploading" versions on top: they would become "the latest
    # version" and hide the review. Anything of this asset still uploading after 10 minutes is dead.
    stale_before = datetime.now(timezone.utc) - timedelta(minutes=10)
    for dead in db.query(AssetVersion).filter(AssetVersion.asset_id == asset.id, AssetVersion.deleted_at.is_(None),
                                              AssetVersion.processing_status == ProcessingStatus.uploading,
                                              AssetVersion.created_at < stale_before).all():
        dead.processing_status = ProcessingStatus.failed
    last = db.query(AssetVersion).filter(AssetVersion.asset_id == asset.id) \
        .order_by(AssetVersion.version_number.desc()).first()
    # The guest has no account; the version is filed under the request's owner, who asked for it.
    version = AssetVersion(asset_id=asset.id, version_number=(last.version_number + 1) if last else 1,
                           processing_status=ProcessingStatus.uploading, created_by=req.created_by)
    db.add(version)
    db.flush()
    ext = os.path.splitext(body.original_filename)[1].lower()
    s3_key = f"raw/{req.project_id}/{asset.id}/{version.id}/original{ext}"
    upload_id = create_multipart_upload(s3_key, body.mime_type)
    file_type = {AssetType.image: FileType.image, AssetType.audio: FileType.audio}.get(asset.asset_type, FileType.video)
    db.add(MediaFile(version_id=version.id, file_type=file_type, original_filename=body.original_filename,
                     mime_type=body.mime_type, file_size_bytes=body.file_size_bytes, s3_key_raw=s3_key))
    if slot: bind_upload(req,slot,asset,version,db)
    if body.name is not None:
        _record_uploader(db, req, version, body)
    db.commit()
    return {"upload_id": upload_id, "s3_key": s3_key, "asset_id": str(asset.id), "version_id": str(version.id),
            "version_number": version.version_number}


def _owned_media(db: Session, req: UploadRequest, s3_key: str) -> tuple[MediaFile, AssetVersion]:
    """The upload must belong to THIS request's folder - a token never reaches another folder."""
    media = db.query(MediaFile).filter(MediaFile.s3_key_raw == s3_key).first()
    version = db.query(AssetVersion).filter(AssetVersion.id == media.version_id, AssetVersion.deleted_at.is_(None)).first() if media else None
    asset = db.query(Asset).filter(Asset.id == version.asset_id, Asset.deleted_at.is_(None)).first() if version else None
    if not media or not version or not asset or asset.folder_id != req.folder_id:
        raise HTTPException(status_code=403, detail="Not authorized for this upload")
    return media, version


class GuestPart(BaseModel):
    s3_key: str
    upload_id: str
    part_number: int = Field(ge=1, le=10000)


@router.post("/r/{token}/upload/presign-part", dependencies=[Depends(rate_limit("request_part", 3000, 600))])
def guest_presign(token: str, body: GuestPart, db: Session = Depends(get_db)):
    req = _live_request(db, token)
    _owned_media(db, req, body.s3_key)
    return {"presigned_url": presign_upload_part(body.s3_key, body.upload_id, body.part_number),
            "part_number": body.part_number}


class GuestComplete(GuestIdentity):
    s3_key: str
    upload_id: str
    parts: list[dict]


def _trigger_processing(asset_id: uuid.UUID, version_id: uuid.UUID):
    from ..tasks.transcode_tasks import process_asset
    from ..tasks.celery_app import send_task_safe
    send_task_safe(process_asset, str(asset_id), str(version_id))


@router.post("/r/{token}/upload/complete", dependencies=[Depends(rate_limit("request_upload", 60, 600))])
def guest_complete(token: str, body: GuestComplete, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    req = locked_request(db, _live_request(db, token, recovery=True).id)
    _, version = _owned_media(db, req, body.s3_key)
    version = db.query(AssetVersion).filter(AssetVersion.id == version.id).populate_existing().with_for_update().one()
    # Completing twice (a retried request) must not re-trigger processing on a finished version.
    if version.processing_status != ProcessingStatus.uploading:
        return {"status": "processing", "asset_id": str(version.asset_id), "version_id": str(version.id)}
    # Only acknowledge already accepted bytes after cutoff. New completion still
    # requires active campaign access; cleanup remains available separately.
    _live_request(db, token)
    if req.completed_at:
        raise HTTPException(409, "This request is complete.")
    record = _record_uploader(db, req, version, body)
    # Identity can arrive only at completion; SessionLocal disables autoflush.
    db.flush()
    try:
        complete_multipart_upload(body.s3_key, body.upload_id, body.parts)
    except ClientError as error:
        # A previous complete may have stored bytes before its size check timed out.
        if error.response.get('Error', {}).get('Code') != 'NoSuchUpload':
            raise
    # The size was CLAIMED at initiate; presigned parts do not enforce it. Measure the object and
    # refuse (and delete) anything bigger than claimed - that is how the storage cap stays a cap.
    media = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
    try:
        real = s3_service.get_s3_client().head_object(Bucket=settings.s3_bucket, Key=body.s3_key)["ContentLength"]
    except Exception as error:
        raise HTTPException(503, 'Your upload size could not be verified. Try submitting again.') from error
    if media and real > media.file_size_bytes * 1.01 + 1024:
        s3_service.delete_object(body.s3_key)
        version.processing_status = ProcessingStatus.failed
        db.commit()
        raise HTTPException(status_code=413, detail="The file is larger than announced. Upload it again.")
    freeze_submission_timing(db, req, record, version)
    if components(req): stored_upload(req,version)
    version.processing_status = ProcessingStatus.processing
    db.commit()
    # The editor's answer to open client revisions (e.g. a fixed Split-upload part): same stop signal
    # as routers/upload.py `complete`, which this /r/<token> path never goes through.
    from ..services import hub_events, workflow_events
    completed_asset = db.get(Asset, version.asset_id)
    hub_events.announce_revision_submitted(db, completed_asset, version.id)
    workflow_events.announce_handin_uploaded(db, req, completed_asset, version)
    background_tasks.add_task(_trigger_processing, version.asset_id, version.id)
    return {"status": "processing", "asset_id": str(version.asset_id), "version_id": str(version.id)}


@router.post("/r/{token}/upload/abort", status_code=status.HTTP_204_NO_CONTENT)
def guest_abort(token: str, body: GuestPart, db: Session = Depends(get_db)):
    req = locked_request(db, _live_request(db, token, recovery=True).id)
    _, version = _owned_media(db, req, body.s3_key)
    if version.processing_status != ProcessingStatus.uploading:
        return
    try:
        abort_multipart_upload(body.s3_key, body.upload_id)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') != 'NoSuchUpload':
            raise
    _drop_unfinished_version(db, req, version)
    db.commit()


def _drop_unfinished_version(db, req, version):
    """Hide a version that never completed; a file with no other version goes with it. Does not commit."""
    version.processing_status = ProcessingStatus.failed
    version.deleted_at = datetime.now(timezone.utc)
    db.flush()
    previous=db.query(AssetVersion).filter(AssetVersion.asset_id==version.asset_id,
        AssetVersion.deleted_at.is_(None)).order_by(AssetVersion.version_number.desc()).first()
    if not previous:
        db.get(Asset, version.asset_id).deleted_at = version.deleted_at
    if components(req):
        from ..services.iteration_requests import aborted_upload
        record=db.query(RequestUpload).filter(RequestUpload.request_id==req.id,
            RequestUpload.asset_id==version.asset_id,RequestUpload.version_number==previous.version_number).first() if previous else None
        aborted_upload(req,version,previous,bool(record and record.submitted_at))


class GuestDiscard(BaseModel):
    asset_id: uuid.UUID
    version_id: uuid.UUID


@router.post("/r/{token}/upload/discard", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(rate_limit("request_upload", 60, 600))])
def guest_discard(token: str, body: GuestDiscard, db: Session = Depends(get_db)):
    """Remove a transfer the page can no longer finish. Unlike /upload/abort this needs no upload id: only the
    tab that started a transfer holds it. The reaper aborts the leftover multipart upload."""
    req = locked_request(db, _live_request(db, token, recovery=True).id)
    version = db.query(AssetVersion).join(Asset, Asset.id == AssetVersion.asset_id).filter(
        AssetVersion.id == body.version_id, AssetVersion.asset_id == body.asset_id, AssetVersion.deleted_at.is_(None),
        Asset.folder_id == req.folder_id, Asset.project_id == req.project_id, Asset.deleted_at.is_(None),
    ).populate_existing().with_for_update(of=AssetVersion).first()
    if not version:
        raise HTTPException(404, 'File not found in this request.')
    if version.processing_status != ProcessingStatus.uploading:
        raise HTTPException(409, 'This file already arrived and cannot be removed here.')
    _drop_unfinished_version(db, req, version)
    db.commit()


def editor_review_state(version, evidence):
    """Only a verdict for these exact bytes may clear the editor's work."""
    # `uploading` proves no running transfer: only /upload/complete ends it, and only the tab that holds the
    # File can call that. The reaper keeps request versions, so this state never resolves by waiting.
    if version and version.processing_status == ProcessingStatus.uploading:
        return 'upload_incomplete'
    if not version or version.processing_status != ProcessingStatus.ready:
        return 'unavailable' if version and version.processing_status == ProcessingStatus.failed else 'reviewing'
    if not isinstance(evidence, dict):
        return 'unavailable'
    progress = evidence.get('progress') if isinstance(evidence.get('progress'), dict) else {}
    if progress.get('stage') in ('reading', 'failed', 'skipped') and progress.get('version_id') != str(version.id):
        return 'reviewing' if evidence.get('watching') is True else 'unavailable'
    if progress.get('version_id') in (None, str(version.id)):
        if progress.get('stage') in ('failed', 'skipped'):
            return 'unavailable'
        if evidence.get('reviewed') is False and progress.get('stage') in ('waiting', 'reading'):
            return 'reviewing'
    if evidence.get('watching') is False and evidence.get('version_id') != str(version.id) and progress.get('version_id') != str(version.id):
        return 'unavailable'
    if not evidence.get('version_id'):
        return 'reviewing' if evidence.get('watching') is True and progress.get('stage') in ('waiting', 'reading') else 'unavailable'
    if evidence['version_id'] != str(version.id) or evidence.get('reviewed') is not True:
        return 'reviewing'
    if type(evidence.get('openMustFix')) is not int or evidence['openMustFix'] < 0:
        return 'unavailable'
    return 'held' if evidence['openMustFix'] else 'clear'


def _version_review(db, req, asset, version, reviewer, evidence, include_media=True):
    comments = []
    if version and reviewer and version.processing_status == ProcessingStatus.ready:
        rows = db.query(Comment).filter(Comment.asset_id == asset.id, Comment.version_id == version.id,
            Comment.guest_author_id == reviewer.id, Comment.parent_id.is_(None),
            Comment.deleted_at.is_(None)).order_by(Comment.timecode_start.asc().nullsfirst()).all()
        withdrawn = {r.parent_id for r in db.query(Comment).filter(
            Comment.asset_id == asset.id, Comment.version_id == version.id, Comment.guest_author_id == reviewer.id,
            Comment.parent_id.isnot(None), Comment.deleted_at.is_(None), Comment.body.like("You're right%")).all()}
        from ..schemas.comment import public_review_source
        comments = [{'id': str(c.id), 't': c.timecode_start, 'body': c.body.replace('Must fix — ', '', 1),
                     'must_fix': c.body.startswith('Must fix'),
                     'review_source': public_review_source(getattr(c, 'review_source', None))}
                    for c in rows if c.id not in withdrawn]
    state = editor_review_state(version, evidence)
    if version and components(req):
        item=next((v for category in ('slots','outputs') for v in (req.iteration_state or {}).get(category,{}).values()
            if v.get('asset_id')==str(asset.id) and v.get('version_id')==str(version.id)),None)
        if item:
            state={'clear':'clear','delivered':'clear','held':'held','error':'unavailable'}.get(item.get('status'),'reviewing')
            comments=item.get('findings',[])
    # Visible unresolved blockers must never be contradicted by a green engine projection.
    if state == 'clear' and any(c.get('must_fix') for c in comments):
        state = 'held'
    media = db.query(MediaFile).filter(MediaFile.version_id == version.id).first() if version else None
    media_url = None
    thumbnail_url = None
    if include_media and media and version.processing_status != ProcessingStatus.uploading:
        media_url = s3_service.generate_presigned_get_url(media.s3_key_raw if asset.asset_type == AssetType.video else media.s3_key_processed or media.s3_key_raw)
        if media.s3_key_thumbnail and asset.asset_type != AssetType.audio:
            thumbnail_url = s3_service.generate_presigned_get_url(media.s3_key_thumbnail)
    progress = dict(evidence['progress']) if state != 'upload_incomplete' and isinstance(evidence, dict) and isinstance(evidence.get('progress'), dict) else {}
    if progress and ((progress.get('stage') in ('reading', 'failed', 'skipped') and progress.get('version_id') != (str(version.id) if version else None)) or progress.get('version_id') not in (None, str(version.id) if version else None)):
        progress = {'stage': 'waiting'} if evidence.get('watching') is True else {}
    if progress and not progress.get('estimate') and media and media.duration_seconds and evidence.get('estimates'):
        bucket = 'short' if media.duration_seconds <= 60 else 'medium' if media.duration_seconds <= 120 else 'long'
        progress['estimate'] = evidence['estimates'].get(bucket)
    review_error = None if asset.asset_type == AssetType.video else 'Automatic review supports videos. Ask the owner to move this attachment out of the request.'
    return {'asset_id': str(asset.id), 'name': asset.name, 'asset_type': asset.asset_type.value, 'review_error': review_error,
            'version_id': str(version.id) if version else None, 'version': version.version_number if version else 0,
            'processing': version.processing_status.value if version else 'uploading',
            'media_url': media_url, 'thumbnail_url': thumbnail_url, 'duration_seconds': media.duration_seconds if media else None,
            'comments': comments, 'review_state': state, 'review_progress': progress or None,
            'open_must_fixes': evidence['openMustFix'] if state in ('held', 'clear') and evidence else sum(bool(c.get('must_fix')) for c in comments)}


def _review_assets(db, req, assets, reviewer, stats, include_media=True):
    out = []
    for asset in assets:
        versions = db.query(AssetVersion).filter(AssetVersion.asset_id == asset.id, AssetVersion.deleted_at.is_(None)) \
            .order_by(AssetVersion.version_number.desc()).all()
        current = versions[0] if versions else None
        evidence = stats.get(str(asset.id))
        entry = _version_review(db, req, asset, current, reviewer, evidence, include_media)
        # A ready/failed record without successful transfer evidence cannot be a delivery.
        record = db.query(RequestUpload).filter(RequestUpload.request_id == req.id,
            RequestUpload.asset_id == asset.id, RequestUpload.version_number == current.version_number).first() if current else None
        if current and current.processing_status != ProcessingStatus.uploading and (not record or not record.submitted_at):
            entry['review_state'] = 'unavailable'
        if record and record.submitted_at and entry.get('review_progress'):
            entry['review_progress']['queued_at'] = record.submitted_at.isoformat()
            submitted = record.submitted_at
            if submitted.tzinfo is None:
                submitted = submitted.replace(tzinfo=timezone.utc)
            entry['review_progress']['elapsedSeconds'] = max(0, (datetime.now(timezone.utc) - submitted).total_seconds())
        entry['versions'] = [{'id': str(v.id), 'version_number': v.version_number, 'processing': v.processing_status.value} for v in versions]
        out.append(entry)
    from ..services.campaign_usage import record_request_successes
    record_request_successes(db, req, out)
    return out


def _editor_review(db, req):
    assets = _submitted_assets(db, req)
    stats = review_bridge.asset_stats([str(a.id) for a in assets], request_token=req.review_share_token)
    reviewer = db.query(GuestUser).filter(GuestUser.email == REVIEWER_EMAIL).first()
    out = _review_assets(db, req, assets, reviewer, stats)
    bridge = review_bridge.request_status([req.review_share_token]).get(req.review_share_token)
    return {'assets': out, 'gate': _request_gate(out, bridge), 'review_share_token': req.review_share_token,
            'completed_at': req.completed_at.isoformat() if req.completed_at else None}


@router.get("/r/{token}/review", dependencies=[Depends(rate_limit("request_view", 120, 600))])
def guest_review(token: str, db: Session = Depends(get_db)):
    out = _editor_review(db, _live_request(db, token))
    db.commit()
    return out


@router.get("/r/{token}/assets/{asset_id}/versions/{version_id}", dependencies=[Depends(rate_limit("request_view", 120, 600))])
def guest_version(token: str, asset_id: uuid.UUID, version_id: uuid.UUID, db: Session = Depends(get_db)):
    req = _live_request(db, token)
    asset = db.query(Asset).filter(Asset.id == asset_id,
                                  Asset.project_id == req.project_id, Asset.deleted_at.is_(None)).first()
    allowed_output=components(req) and any(v.get('asset_id')==str(asset_id) and v.get('version_id')==str(version_id) for v in (req.iteration_state or {}).get('outputs',{}).values())
    if not asset or (asset.folder_id!=req.folder_id and not allowed_output):
        raise HTTPException(404, 'File not found in this request.')
    version = db.query(AssetVersion).filter(AssetVersion.id == version_id, AssetVersion.asset_id == asset.id,
                                          AssetVersion.deleted_at.is_(None)).first()
    if not version:
        raise HTTPException(404, 'Version not found.')
    reviewer = db.query(GuestUser).filter(GuestUser.email == REVIEWER_EMAIL).first()
    evidence = review_bridge.asset_stats([str(asset.id)]).get(str(asset.id))
    return _version_review(db, req, asset, version, reviewer, evidence)


@router.post("/r/{token}/finish", dependencies=[Depends(rate_limit("request_view", 120, 600))])
def finish_request(token: str, db: Session = Depends(get_db)):
    req = locked_request(db, _live_request(db, token).id)
    if not req.completed_at:
        if components(req): raise HTTPException(409,'Component batches finish after every assembled ad passes final review.')
        review = _editor_review(db, req)
        if any(a.get('review_error') for a in review['assets']):
            raise HTTPException(409, 'This request includes an attachment automatic review cannot verify. Ask the owner to move it out of the request.')
        if not review['assets'] or review['gate']['status'] != 'clear' or review['gate']['open_must_fixes'] or any(a['review_state'] != 'clear' for a in review['assets']):
            raise HTTPException(409, 'All submitted versions must finish review before completing this request.')
        req.completed_at = datetime.now(timezone.utc)
        req.completion_versions = {a['asset_id']: a['version_id'] for a in review['assets']}
        db.commit()
        from ..services import workflow_events
        workflow_events.announce_handin_finished(db, req)
    return {'completed_at': req.completed_at.isoformat(), 'completion_versions': req.completion_versions}


class SuggestionDecision(BaseModel):
    project_id: uuid.UUID
    suggestion_id: str
    action: str = Field(pattern="^(accept|dismiss)$")


@router.post("/insights/rules/suggestion")
def decide_suggestion(body: SuggestionDecision, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    brand = _project_brand(db, body.project_id, current_user, ProjectRole.owner)
    r = review_bridge.decide_suggestion(brand, body.suggestion_id, body.action, current_user.email)
    if r is None:
        raise HTTPException(status_code=503, detail="Auto Review could not save that right now.")
    return r


class GuestObjection(BaseModel):
    asset_id: uuid.UUID
    version_id: Optional[uuid.UUID] = None
    comment_id: str = ""
    body: str = Field(default="", max_length=2000)
    text: str = Field(min_length=3, max_length=1000)
    name: str = Field(default="", max_length=255)


@router.post("/r/{token}/object", dependencies=[Depends(rate_limit("request_object", 20, 600))])
def guest_object(token: str, body: GuestObjection, db: Session = Depends(get_db)):
    """The editor says a note is wrong. Auto Review judges it, biased toward the editor, and withdraws
    it from the gate if they are right - the release valve that keeps a wrong must-fix from trapping
    anyone. The asset must be in this request's folder."""
    req = locked_request(db, _live_request(db, token).id)
    asset = db.query(Asset).filter(Asset.id == body.asset_id, Asset.deleted_at.is_(None)).first()
    if not asset or asset.folder_id != req.folder_id:
        raise HTTPException(status_code=403, detail="Not part of this request")
    current = db.query(AssetVersion).filter(AssetVersion.asset_id == asset.id, AssetVersion.deleted_at.is_(None),
        AssetVersion.processing_status != ProcessingStatus.failed).order_by(AssetVersion.version_number.desc()).first()
    if not current or (body.version_id and body.version_id != current.id):
        raise HTTPException(409, 'Open the current version before replying to feedback.')
    if body.comment_id:
        try:
            comment_id = uuid.UUID(body.comment_id)
        except ValueError as error:
            raise HTTPException(400, 'Invalid feedback reference.') from error
        reviewer = db.query(GuestUser).filter(GuestUser.email == REVIEWER_EMAIL).first()
        note = db.query(Comment).filter(Comment.id == comment_id, Comment.asset_id == asset.id,
            Comment.version_id == current.id, Comment.guest_author_id == reviewer.id,
            Comment.deleted_at.is_(None)).first() if reviewer else None
        if not note:
            raise HTTPException(409, 'This feedback does not belong to the current version.')
    r = review_bridge.object_to_note(req.review_share_token, str(asset.id), body.comment_id, body.body,
                                     body.text, body.name or req.last_uploader_name or "the editor", version_id=str(current.id))
    if r is None:
        raise HTTPException(status_code=503, detail="Could not reach the reviewer. Try again in a minute.")
    if components(req) and r.get('withdrawn') is True:
        from ..services.iteration_requests import withdraw_finding
        req=locked_request(db,req.id)
        withdraw_finding(req,str(asset.id),str(current.id),body.comment_id)
        db.commit()
    from ..services import workflow_events
    workflow_events.announce_revision_responded(db, req, asset, body.comment_id)
    return r


def _brand_logo(db: Session, project_id: uuid.UUID) -> Optional[str]:
    """The brand's own logo, for a white-label request page. None = show the brand name."""
    b = db.query(ProjectBranding).filter(ProjectBranding.project_id == project_id).first()
    if not b or not b.logo_s3_key:
        return None
    try:
        return s3_service.generate_presigned_get_url(b.logo_s3_key)
    except Exception:  # noqa: BLE001 - a missing logo must never break the editor's page
        return None


def rank_editors(uploads: list[dict], stats: dict[str, dict]) -> list[dict]:
    """People ranked by accuracy: the share of their videos with no must-fix on the first version.

    One row per email. A video counts once (its first version is the one that shows how right the
    editor got it); versions per video says how many rounds it took. Videos whose first review is
    unknown are left out of the rate but still counted, so a small sample is visible as small.
    """
    people: dict[str, dict] = {}
    for u in uploads:
        p = people.setdefault(u["email"], {"email": u["email"], "name": u["name"], "assets": set()})
        p["name"] = u["name"] or p["name"]
        p["assets"].add(u["asset_id"])
    out = []
    for p in people.values():
        known = [stats[a] for a in p["assets"] if a in stats and stats[a].get("v1MustFix") is not None]
        clean = sum(1 for s in known if s["v1MustFix"] == 0)
        versions = [stats[a]["versions"] for a in p["assets"] if a in stats]
        out.append({
            "email": p["email"], "name": p["name"], "videos": len(p["assets"]),
            "rated": len(known),
            "first_try_rate": round(clean / len(known), 3) if known else None,
            "avg_versions": round(sum(versions) / len(versions), 2) if versions else None,
            "open_must_fixes": sum(stats[a].get("openMustFix", 0) for a in p["assets"] if a in stats),
        })
    # Most accurate first; unknowns last; more videos breaks a tie (a 100% on 1 is not a 100% on 20).
    out.sort(key=lambda r: (r["first_try_rate"] is None, -(r["first_try_rate"] or 0), -r["rated"], r["name"].lower()))
    return out


@router.get("/insights/editors")
def editors(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """The owner's editors, most accurate first - everyone who handed in through their requests."""
    q = db.query(RequestUpload, UploadRequest).join(UploadRequest, RequestUpload.request_id == UploadRequest.id)
    if not current_user.is_superadmin:   # superadmins see every editor; everyone else, their own requests
        member_projects = [m.project_id for m in db.query(ProjectMember).filter(
            ProjectMember.user_id == current_user.id, ProjectMember.deleted_at.is_(None)).all()]
        q = q.filter((UploadRequest.created_by == current_user.id) | (UploadRequest.project_id.in_(member_projects or [uuid.uuid4()])))
    rows = q.limit(5000).all()
    uploads = [{"email": u.uploader_email, "name": u.uploader_name, "asset_id": str(u.asset_id)} for u, _ in rows]
    stats = review_bridge.asset_stats(sorted({u["asset_id"] for u in uploads}))
    return {"editors": rank_editors(uploads, stats), "reviewed": bool(stats) or not uploads}
