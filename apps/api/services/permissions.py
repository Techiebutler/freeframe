from fastapi import HTTPException, status
from sqlalchemy import exists, func, or_, select
from sqlalchemy.orm import Session
import uuid
from ..models.user import User, UserStatus
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.asset import Asset
from ..models.folder import Folder
from ..models.share import AssetShare, ShareLink, ShareLinkItem, SharePermission
from ..services.redis_service import verify_share_session


# ── Project-level ──────────────────────────────────────────────────────────────

def get_project_member(db: Session, project_id: uuid.UUID, user_id: uuid.UUID) -> ProjectMember | None:
    """The user's live membership of a live project. A deleted project has no members."""
    return db.query(ProjectMember).join(Project, Project.id == ProjectMember.project_id).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == user_id,
        ProjectMember.deleted_at.is_(None),
        Project.deleted_at.is_(None),
    ).first()


def require_live_project(db: Session, project_id: uuid.UUID) -> Project:
    """The project, or 404 "Project not found" when it does not exist or is deleted,
    the same answer GET /projects/{id} gives. Deleting a project has no undo, so
    to everyone who was in it a deleted project is gone."""
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.deleted_at.is_(None),
    ).first()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


def asset_project_is_live(db: Session, asset_id: uuid.UUID) -> bool:
    """Whether the asset's project exists and is not deleted."""
    live = (
        db.query(Project.id)
        .join(Asset, Asset.project_id == Project.id)
        .filter(Asset.id == asset_id, Project.deleted_at.is_(None))
        .scalar()
    )
    return live is not None


def require_asset_project_live(db: Session, asset_id: uuid.UUID) -> None:
    """404 "Project not found" when the asset's project is deleted, as require_live_project.
    For the routes reached by owning a row (a comment, an upload) rather than by a role."""
    if not asset_project_is_live(db, asset_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")


def require_project_role(
    db: Session,
    project_id: uuid.UUID,
    user: User,
    minimum_role: ProjectRole,
) -> ProjectMember:
    """Require the user to have at least `minimum_role` on the project.

    Role hierarchy (descending): owner > editor > reviewer > viewer
    A project that does not exist or is deleted is 404, before the role check.
    """
    ROLE_RANK = {
        ProjectRole.owner: 4,
        ProjectRole.editor: 3,
        ProjectRole.reviewer: 2,
        ProjectRole.viewer: 1,
    }
    require_live_project(db, project_id)
    member = get_project_member(db, project_id, user.id)
    if not member:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a project member")
    if ROLE_RANK[member.role] < ROLE_RANK[minimum_role]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Requires {minimum_role.value} role or higher",
        )
    return member


def require_project_visible(db: Session, project_id: uuid.UUID, user: User) -> ProjectMember | None:
    """For what a public project also shows non-members: 404 for a project that does
    not exist or is deleted, 403 unless the user is a member or the project is public.
    Returns the membership, if any."""
    project = require_live_project(db, project_id)
    member = get_project_member(db, project_id, user.id)
    if not member and not project.is_public:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a project member")
    return member


# ── Asset-level ────────────────────────────────────────────────────────────────

def is_public_project(db: Session, project_id: uuid.UUID) -> bool:
    """Check if a project is public."""
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.deleted_at.is_(None),
    ).first()
    return project is not None and project.is_public


# Reasons project_events_denial() can give. They are sent to the subscriber in
# the stream's final `revoked` event, so the client can tell "sign in again"
# (the token) apart from "you no longer have access" (everything else).
EVENTS_TOKEN_EXPIRED = "token_expired"
EVENTS_TOKEN_REVOKED = "token_revoked"
EVENTS_ACCESS_REVOKED = "access_revoked"


def project_events_denial(
    db: Session,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
    token_version: int,
) -> str | None:
    """Why this user, holding an access token minted at `token_version`, may not
    receive the project's live events. None means they may.

    The same rule as connecting to GET /events/{project_id}: a live, active
    account whose token has not been revoked (token_version is bumped by a
    password change), on a project that is not deleted, which the user is a
    member of or which is public. An open event stream calls this repeatedly
    for as long as it stays open, so it is a single indexed round trip.
    Token expiry is not checked here; the caller has the token's `exp`.
    """
    is_member = exists().where(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == user_id,
        ProjectMember.deleted_at.is_(None),
    )
    row = db.execute(
        select(User.status, User.token_version, Project.is_public, is_member.label("is_member"))
        .join(Project, Project.id == project_id)
        .where(
            User.id == user_id,
            User.deleted_at.is_(None),
            Project.deleted_at.is_(None),
        )
    ).first()
    if row is None or row.status == UserStatus.deactivated:
        return EVENTS_ACCESS_REVOKED
    if row.token_version != token_version:
        return EVENTS_TOKEN_REVOKED
    if not (row.is_member or row.is_public):
        return EVENTS_ACCESS_REVOKED
    return None


def can_access_asset(db: Session, asset: Asset, user: User) -> bool:
    """Check if user can access the asset via any path.

    No path reaches an asset whose project is in the trash.
    """
    project_live = db.query(Project.id).filter(
        Project.id == asset.project_id,
        Project.deleted_at.is_(None),
    ).first()
    if not project_live:
        return False

    # 1. Asset creator
    if asset.created_by == user.id:
        return True

    # 2. Project member
    if get_project_member(db, asset.project_id, user.id):
        return True

    # 3. Direct AssetShare with user
    direct = db.query(AssetShare).filter(
        AssetShare.asset_id == asset.id,
        AssetShare.shared_with_user_id == user.id,
        AssetShare.deleted_at.is_(None),
    ).first()
    if direct:
        return True

    # 4. Public project — any authenticated user can view
    if is_public_project(db, asset.project_id):
        return True

    return False


def require_asset_access(db: Session, asset: Asset, user: User) -> None:
    if not can_access_asset(db, asset, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def get_asset_share_permission(db: Session, asset: Asset, user: User) -> SharePermission:
    """Get the effective share permission for a user on an asset (highest wins)."""
    PERM_RANK = {
        SharePermission.approve: 3,
        SharePermission.comment: 2,
        SharePermission.view: 1,
    }

    best = SharePermission.view

    # Direct share
    direct = db.query(AssetShare).filter(
        AssetShare.asset_id == asset.id,
        AssetShare.shared_with_user_id == user.id,
        AssetShare.deleted_at.is_(None),
    ).first()
    if direct and PERM_RANK[direct.permission] > PERM_RANK[best]:
        best = direct.permission

    return best


# ── Share link validation ──────────────────────────────────────────────────────

def folder_chain_is_live(db: Session, folder_id: uuid.UUID) -> bool:
    """True when the folder exists and neither it nor any folder above it is in the trash.

    One round trip: a recursive walk up `parent_id` (at most MAX_FOLDER_DEPTH levels).
    UNION rather than UNION ALL, so a parent cycle ends the walk instead of looping.
    """
    chain = (
        select(Folder.id, Folder.parent_id, Folder.deleted_at)
        .where(Folder.id == folder_id)
        .cte("folder_chain", recursive=True)
    )
    chain = chain.union(
        select(Folder.id, Folder.parent_id, Folder.deleted_at)
        .join(chain, Folder.id == chain.c.parent_id)
    )
    found, trashed = db.execute(
        select(func.count(), func.count(chain.c.deleted_at))
    ).one()
    return found > 0 and trashed == 0


def validate_share_link(db: Session, token: str) -> ShareLink:
    """Validate a share link token and return the link. Raises 404/410 on failure.

    A link resolves only while what it points into is live: its project, its
    asset or folder, and every folder above that. Links into trashed content
    resolve as not found, before the enabled and expiry checks, so they answer
    exactly like a token that does not exist. The link row itself is left alone,
    so restoring the content brings the link back.
    """
    from datetime import datetime, timezone
    row = (
        db.query(ShareLink, func.coalesce(ShareLink.folder_id, Asset.folder_id))
        .outerjoin(Asset, Asset.id == ShareLink.asset_id)
        .outerjoin(Folder, Folder.id == ShareLink.folder_id)
        .join(Project, Project.id == func.coalesce(ShareLink.project_id, Asset.project_id, Folder.project_id))
        .filter(
            ShareLink.token == token,
            ShareLink.deleted_at.is_(None),
            Project.deleted_at.is_(None),
            or_(ShareLink.asset_id.is_(None), Asset.deleted_at.is_(None)),
        )
        .first()
    )
    link, folder_id = row if row is not None else (None, None)
    if link is not None and folder_id is not None and not folder_chain_is_live(db, folder_id):
        link = None
    if not link:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share link not found")
    if not link.is_enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Share link is disabled")
    if link.expires_at and link.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Share link has expired")
    return link


def enforce_share_link_visibility(link: ShareLink, current_user: "User | None") -> None:
    """Enforce a share link's visibility setting. Raises 403 for a `secure` link
    with no authenticated caller.

    Every endpoint that serves share-link content must run this — gating it only
    where the link is first validated leaves the content endpoints (stream,
    thumbnail, versions, listings, comments) reachable with the token alone,
    which defeats the login requirement `secure` exists to impose.
    """
    if link.visibility == "secure" and not current_user:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authentication required for this link's visibility setting",
        )


def validate_share_link_with_session(
    db: Session,
    token: str,
    share_session: "str | None" = None,
    current_user: "User | None" = None,
) -> ShareLink:
    """Validate a share link, enforce its visibility setting, and verify the
    password session if the link is password-protected.
    Skips password check if the caller is the authenticated link creator."""
    link = validate_share_link(db, token)
    enforce_share_link_visibility(link, current_user)
    if link.password_hash:
        # Skip password for authenticated link creator (e.g. admin settings preview)
        if current_user and link.created_by == current_user.id:
            return link
        if not share_session or not verify_share_session(token, share_session):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Password required",
            )
    return link


def _is_descendant_of(db: Session, folder_id: uuid.UUID, ancestor_id: uuid.UUID) -> bool:
    """Check if folder_id is a descendant of ancestor_id via parent chain traversal.

    Only live folders count: a trashed folder anywhere on the path, ancestor_id
    included, means it is not a descendant.
    """
    current_id = folder_id
    visited = set()
    while current_id and current_id not in visited:
        visited.add(current_id)
        folder = db.query(Folder.parent_id, Folder.deleted_at).filter(Folder.id == current_id).first()
        if not folder or folder.deleted_at is not None:
            return False
        if current_id == ancestor_id:
            return True
        current_id = folder.parent_id
    return False


def validate_asset_in_share(db: Session, link: ShareLink, asset: Asset) -> None:
    """Validate that an asset belongs to a share link (folder, asset, project, or multi-share).

    Every endpoint that accepts a client-supplied asset_id alongside a share token must call
    this — the token alone only proves the caller holds *some* valid link, not that this
    particular asset is within its shared scope.
    """
    if link.folder_id:
        if asset.folder_id != link.folder_id:
            if not asset.folder_id or not _is_descendant_of(db, asset.folder_id, link.folder_id):
                raise HTTPException(status_code=403, detail="Asset is not within the shared folder")
    elif link.asset_id:
        if asset.id != link.asset_id:
            raise HTTPException(status_code=403, detail="Asset does not match share link")
    elif link.project_id:
        if asset.project_id != link.project_id:
            raise HTTPException(status_code=403, detail="Asset is not within the shared project")
        # An asset under a trashed folder is treated as trashed itself.
        if asset.folder_id and not folder_chain_is_live(db, asset.folder_id):
            raise HTTPException(status_code=404, detail="Asset not found")
        # For multi-share links, also check ShareLinkItem entries
        multi_items = db.query(ShareLinkItem).filter(ShareLinkItem.share_link_id == link.id).all()
        if multi_items:
            multi_asset_ids = {item.asset_id for item in multi_items if item.asset_id}
            multi_folder_ids = {item.folder_id for item in multi_items if item.folder_id}
            if asset.id not in multi_asset_ids:
                # Check if asset is in one of the shared folders
                if not any(asset.folder_id == fid or (asset.folder_id and _is_descendant_of(db, asset.folder_id, fid)) for fid in multi_folder_ids):
                    raise HTTPException(status_code=403, detail="Asset is not in the shared items")
    else:
        raise HTTPException(status_code=400, detail="Invalid share link")
