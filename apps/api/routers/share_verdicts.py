"""Verdicts through a share link: give, clear and list.

This is the one way people without an account write verdicts, so every route
runs the same gates in the same order before it touches anything:

1. On a write, a request that carried a bearer token that no longer resolves to
   a user is refused (401). Otherwise a signed-in person whose token lapsed would
   have their verdict filed under whatever guest identity the page also sent.
2. The link resolves (`validate_share_link_with_session`): live content only,
   visibility, and the password session.
3. The link allows approvals.
4. The asset is inside the link's scope (`validate_asset_in_share`). Outside it
   reads as not found, like an asset that does not exist.
5. The version is one the link shows (`share.shown_versions`).
6. Who is acting (`_share_actor`): a project member is held to their role, a
   signed-in non-member acts as themselves, and anyone else is a guest.

The writes themselves go through `services.verdicts`, which notifies, logs,
publishes and commits. Giving and clearing also sit behind a per-address rate limit
(a change emails the creator, and anyone holding the link may press the button).
"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_optional_user, optional_bearer_scheme
from ..middleware.rate_limit import rate_limit
from ..models.asset import Asset, AssetVersion
from ..models.project import ProjectRole
from ..models.share import ShareActivityAction, ShareLink, ShareLinkActivity, SharePermission
from ..models.user import User
from ..schemas.verdict import ShareVerdictSet, VerdictResponse
from ..services.guests import find_guest, normalize_guest_email, resolve_guest
from ..services.permissions import (
    get_project_member, validate_asset_in_share, validate_share_link_with_session,
)
from ..services.verdicts import (
    Actor, clean_note, clear_verdict, list_verdicts, set_verdict, verdict_unchanged,
)
from .share import _get_asset, shown_versions

router = APIRouter(tags=["share"])

STALE_SIGN_IN = "Your sign-in has expired. Sign in again or continue as a guest."

# The roles that may give a verdict, the same floor as the team routes.
_VERDICT_ROLES = {ProjectRole.reviewer, ProjectRole.editor, ProjectRole.owner}


def _refuse_stale_sign_in(credentials: Optional[HTTPAuthorizationCredentials],
                          current_user: Optional[User]) -> None:
    if credentials is not None and current_user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=STALE_SIGN_IN)


def _approve_link(db: Session, token: str, share_session: Optional[str],
                  current_user: Optional[User]) -> ShareLink:
    link = validate_share_link_with_session(db, token, share_session=share_session, current_user=current_user)
    if link.permission != SharePermission.approve:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="This share link does not allow approvals")
    return link


def _linked_asset(db: Session, link: ShareLink, asset_id: Optional[uuid.UUID]) -> Asset:
    """The asset the caller means, and only if the link reaches it.

    A single-asset link means its own asset; a named one must be that asset.
    Folder, project and multi links hold many, so the caller has to name one.
    An asset outside the link's scope answers exactly like one that does not
    exist: the shared helper says 403, which would confirm it is there.
    """
    target_id = asset_id or link.asset_id
    if target_id is None:
        raise HTTPException(status_code=400, detail="asset_id is required for folder/project shares")
    asset = _get_asset(db, target_id)
    try:
        validate_asset_in_share(db, link, asset)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_403_FORBIDDEN:
            raise HTTPException(status_code=404, detail="Asset not found") from exc
        raise
    return asset


def _shown_version(db: Session, link: ShareLink, asset: Asset, version_id: uuid.UUID) -> AssetVersion:
    """The version, or 404 unless the link shows it: the latest ready version, or
    any ready version when the link shows every version."""
    for version in shown_versions(db, link, asset):
        if version.id == version_id:
            return version
    raise HTTPException(status_code=404, detail="Version not found")


def _share_actor(
    db: Session,
    link: ShareLink,
    asset: Asset,
    current_user: Optional[User],
    guest_name: Optional[str],
    guest_email: Optional[str],
    *,
    writing: bool,
    create_guest: bool = False,
) -> Actor:
    """Who is acting through `link`.

    A signed-in caller is themselves, and any guest fields they sent are ignored.
    A project member is held to their project role when writing: the link does not
    raise it. A signed-in non-member acts as themselves, as an external.

    Anyone else is a guest, resolved by `services.guests` as guest comments are. Only
    giving a verdict (`create_guest`) may create one, and it needs both fields.
    Clearing needs the email; an email nobody has used yields an actor with no one
    in it, which clears nothing and owns nothing.
    """
    if current_user is not None:
        if writing:
            member = get_project_member(db, asset.project_id, current_user.id)
            if member is not None and member.role not in _VERDICT_ROLES:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                    detail="Your project role can't give verdicts")
        return Actor(user=current_user, share_link=link)

    if create_guest:
        guest = resolve_guest(db, guest_email, guest_name)
        if guest is None:
            raise HTTPException(status_code=400, detail="guest_email and guest_name required")
        return Actor(guest=guest, share_link=link)

    if writing and not normalize_guest_email(guest_email):
        raise HTTPException(status_code=400, detail="guest_email required")
    return Actor(guest=find_guest(db, guest_email), share_link=link)


@router.put("/share/{token}/verdict", response_model=VerdictResponse,
            dependencies=[Depends(rate_limit("share_verdict", 20, 60))])
def put_share_verdict(
    token: str,
    body: ShareVerdictSet,
    share_session: Optional[str] = Query(None, alias="share_session"),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(optional_bearer_scheme),
):
    """Give, or change, the caller's verdict on one version the link shows."""
    _refuse_stale_sign_in(credentials, current_user)
    link = _approve_link(db, token, share_session, current_user)
    asset = _linked_asset(db, link, body.asset_id)
    version = _shown_version(db, link, asset, body.version_id)
    actor = _share_actor(db, link, asset, current_user, body.guest_name, body.guest_email,
                         writing=True, create_guest=True)

    note = clean_note(body.note)
    # Pressing the same verdict again changes nothing, so it is not link activity
    # either. Otherwise the activity row is added before the service's single
    # commit, so it lands with the verdict or not at all.
    if not verdict_unchanged(db, version, actor, body.status, note):
        db.add(ShareLinkActivity(
            share_link_id=link.id,
            action=ShareActivityAction(body.status),
            actor_email=actor.user.email if actor.user is not None else actor.guest.email,
            actor_name=actor.display_name,
            asset_id=asset.id,
            asset_name=asset.name,
        ))
    approval = set_verdict(db, asset, version, actor, body.status, note)

    given = next((v for v in list_verdicts(db, asset, version.id, me=actor, guest_scope_link_id=link.id)
                  if v.id == approval.id), None)
    if given is None:
        # Removed by someone else between the write and this read.
        raise HTTPException(status_code=404, detail="Verdict not found")
    return given


@router.delete("/share/{token}/verdict", status_code=status.HTTP_204_NO_CONTENT,
               dependencies=[Depends(rate_limit("share_verdict", 20, 60))])
def clear_share_verdict(
    token: str,
    version_id: uuid.UUID = Query(...),
    asset_id: Optional[uuid.UUID] = Query(None),
    guest_email: Optional[str] = Query(None, max_length=255),
    share_session: Optional[str] = Query(None, alias="share_session"),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(optional_bearer_scheme),
):
    """Withdraw the caller's own verdict. 204 even when there was none, including
    for a guest email nobody has used."""
    _refuse_stale_sign_in(credentials, current_user)
    link = _approve_link(db, token, share_session, current_user)
    asset = _linked_asset(db, link, asset_id)
    version = _shown_version(db, link, asset, version_id)
    actor = _share_actor(db, link, asset, current_user, None, guest_email, writing=True)
    if actor.user is not None or actor.guest is not None:
        clear_verdict(db, asset, version, actor)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/share/{token}/verdicts", response_model=list[VerdictResponse])
def get_share_verdicts(
    token: str,
    version_id: uuid.UUID = Query(...),
    asset_id: Optional[uuid.UUID] = Query(None),
    guest_email: Optional[str] = Query(None, max_length=255),
    share_session: Optional[str] = Query(None, alias="share_session"),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
):
    """What a holder of this link may see on one version: the caller's own verdict
    plus external verdicts given through this link. Never a team verdict, never
    another link's, never an email. The same for a signed-in member: the team's
    full view is GET /assets/{id}/verdicts.

    A token that no longer works is read as no token here, since reading writes
    nothing under anyone's name.
    """
    link = _approve_link(db, token, share_session, current_user)
    asset = _linked_asset(db, link, asset_id)
    version = _shown_version(db, link, asset, version_id)
    me = _share_actor(db, link, asset, current_user, None, guest_email, writing=False)
    return list_verdicts(db, asset, version.id, me=me, guest_scope_link_id=link.id)
