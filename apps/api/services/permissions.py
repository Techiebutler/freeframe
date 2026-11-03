from fastapi import HTTPException, status
from sqlalchemy import exists, func, or_, select
from sqlalchemy.orm import Session
import logging
import uuid
from ..models.user import User, UserStatus
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.asset import Asset
from ..models.folder import Folder
from ..models.share import AssetShare, ShareLink, ShareLinkItem, SharePermission
from ..services.redis_service import verify_share_session


_log = logging.getLogger("freeframe.permissions")


# ── Instance administrators ────────────────────────────────────────────────────

# The one role that reaches past project membership. `users.is_superadmin` is the
# instance administrator the setup wizard creates and the admin dashboard calls
# "Admin"; there is no second instance-level role to extend, and adding one would
# leave two places to keep in step. Project roles (owner > editor > reviewer >
# viewer) are untouched: a project owner still cannot see a project they are not
# in, and nothing below superadmin gains anything from this module.
#
# Every bypass lives here on purpose. The routers call require_project_role,
# require_project_visible and can_access_asset, so a new endpoint inherits the
# rule instead of having to remember it.


def is_instance_admin(user: "User | None") -> bool:
    """Whether the account carries the instance-wide superadmin flag.

    Tolerates a missing attribute so a share-link caller (no user) and a mock
    in a test both answer False rather than raising.
    """
    return bool(getattr(user, "is_superadmin", False))


def admin_membership(project_id: uuid.UUID, user: User) -> ProjectMember:
    """A transient owner-equivalent membership standing in for a superadmin's
    instance-wide access.

    Never added to the session: the administrator is *not* a member, and the
    project's member list, its member count and its emails must keep saying so.
    It exists only so the permission helpers can keep returning a ProjectMember
    to callers that type against one.
    """
    return ProjectMember(project_id=project_id, user_id=user.id, role=ProjectRole.owner)


# The action string for an administrator acting on a project they are not a
# member of. `payload.via = "superadmin"` is what separates these rows from the
# same action taken by a member.
ADMIN_ACCESS_ACTION = "admin_project_access"

# Every path an administrator can reach a project by is audited, read tiers
# included: a review tool's whole reason for wanting this log is the line that
# says an outsider was in there, and "they only looked" is exactly the case a
# project owner asks about afterwards.
#
# The scopes that are not a role tier. A project tier is logged as the tier it
# asked for; these two name a path that has no tier of its own.
AUDIT_SCOPE_ASSET = "asset"      # require_asset_access: asset, version, comment, attachment
AUDIT_SCOPE_EVENTS = "events"    # the live event stream, at connect

# What `asset_access_reason` answers when nothing but the instance-admin flag
# let the caller through. The one reason that is audited.
ASSET_ACCESS_VIA_SUPERADMIN = "superadmin"

# How much each path proves about what the administrator did, so one row per
# request can carry the heaviest access instead of the first one. A request that
# reads an asset and then deletes it reports the delete.
_SCOPE_WEIGHT = {
    AUDIT_SCOPE_EVENTS: 1,
    ProjectRole.viewer: 1,
    AUDIT_SCOPE_ASSET: 2,
    ProjectRole.reviewer: 3,
    ProjectRole.editor: 4,
    ProjectRole.owner: 5,
}

# Where the per-request bookkeeping lives. `Session.info` is a plain dict that
# belongs to the one session, and a session is one request (`get_db`), so it is
# the request scope without a middleware or a context variable to keep in step.
_AUDIT_STATE_KEY = "admin_project_access_rows"


def _audit_state(db: Session) -> "dict | None":
    """The per-session map of project_id -> (weight, row), or None for a session
    that cannot carry one.

    The unit-test harness hands the routers a MagicMock whose `.info` is another
    MagicMock. Refusing to dedupe there is the safe direction: a duplicate row
    in a test is visible, a swallowed one is not.
    """
    info = getattr(db, "info", None)
    if not isinstance(info, dict):
        return None
    return info.setdefault(_AUDIT_STATE_KEY, {})


def log_admin_project_access(
    db: Session,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
    scope: "ProjectRole | str",
    *,
    membership: str = "none",
    asset_id: "uuid.UUID | None" = None,
) -> None:
    """Record that a superadmin reached a project their own membership did not
    cover, either because they are not a member or because their project role
    ranks below what the endpoint asked for.

    `payload.membership` says which of the two it was, so the log distinguishes
    "an outsider acted here" from "a member used their admin powers".
    `payload.scope` says which path got them in, and `payload.required_role` the
    tier, where the path has one.

    **One row per request and project, not one per object.** A listing checks
    every asset it returns, and `GET /events` re-checks for as long as the
    stream stays open; a row per check would turn one open tab into unbounded
    rows in a table nothing prunes on a schedule. The first access in a request writes
    the row, a later heavier one rewrites it in place (it is still pending, or
    at worst dirty, in the same session), and anything lighter is dropped.

    Added to the session, not committed: the request's own commit carries it, so
    a write that ends in a rollback leaves no row claiming it happened. A
    read-only request commits nothing of its own, so `get_db` commits the row on
    its way out; see `persist_admin_access_audit`.
    """
    from ..models.activity import ActivityLog
    from ..services.activity_service import log_activity

    weight = _SCOPE_WEIGHT.get(scope, 0)
    payload = {
        "via": "superadmin",
        "membership": membership,
        "scope": scope.value if isinstance(scope, ProjectRole) else scope,
        "required_role": scope.value if isinstance(scope, ProjectRole) else None,
    }

    state = _audit_state(db)
    if state is not None:
        previous = state.get(project_id)
        if previous is not None:
            seen_weight, row = previous
            if weight <= seen_weight:
                return
            # Rewrite rather than add: reassigned, not mutated in place, so a
            # row that has already been flushed is marked dirty and updated.
            row.payload = payload
            if asset_id is not None:
                row.asset_id = asset_id
            state[project_id] = (weight, row)
            return

    log_activity(
        db,
        action=ADMIN_ACCESS_ACTION,
        user_id=user_id,
        project_id=project_id,
        asset_id=asset_id,
        payload=payload,
    )
    if state is not None:
        row = next(
            (
                o for o in reversed(list(db.new))
                if isinstance(o, ActivityLog) and o.action == ADMIN_ACCESS_ACTION
            ),
            None,
        )
        if row is not None:
            state[project_id] = (weight, row)


def persist_admin_access_audit(db: Session) -> int:
    """Commit the admin-access rows of a request that committed nothing itself,
    and return how many were written.

    A read-only endpoint never commits, so without this the row for a
    superadmin reading a project they are not in would be dropped when the
    session closes, and the log would only ever show writes.

    Only when those rows are the *whole* of the pending work. A request with its
    own pending changes either committed already (nothing is pending) or is on
    its way to a rollback, and committing half of someone else's transaction to
    save a log row would be the worse bug by far.
    """
    from ..models.activity import ActivityLog

    try:
        pending = list(db.new)
        if not pending or db.dirty or db.deleted:
            return 0
        rows = [
            o for o in pending
            if isinstance(o, ActivityLog) and o.action == ADMIN_ACCESS_ACTION
        ]
        if not rows or len(rows) != len(pending):
            return 0
        db.commit()
        return len(rows)
    except Exception:
        _log.warning("could not persist the admin access audit rows", exc_info=True)
        try:
            db.rollback()
        except Exception:
            pass
        return 0


# ── Project-level ──────────────────────────────────────────────────────────────

def get_project_member(
    db: Session,
    project_id: uuid.UUID,
    user_id: uuid.UUID,
    include_trashed: bool = False,
) -> ProjectMember | None:
    """The user's live membership of a live project. A deleted project has no members.

    `include_trashed=True` answers for a project that is in the trash as well, for
    the one endpoint whose whole subject is such a project: `POST /{id}/restore`.
    The membership itself must still be live either way, so a member whose own
    membership was removed is not an owner of the trashed project.
    """
    q = db.query(ProjectMember).join(Project, Project.id == ProjectMember.project_id).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == user_id,
        ProjectMember.deleted_at.is_(None),
    )
    if not include_trashed:
        q = q.filter(Project.deleted_at.is_(None))
    return q.first()


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
    project: "Project | None" = None,
    include_trashed: bool = False,
) -> ProjectMember:
    """Require the user to have at least `minimum_role` on the project.

    Role hierarchy (descending): owner > editor > reviewer > viewer
    A project that does not exist or is deleted is 404, before the role check.
    Pass `project` when the caller has already established it is live, to save
    the lookup; it must be the live row for `project_id`.

    An instance superadmin passes every tier on every live project, membership
    or not, and is answered with a transient owner membership. Reaching a tier
    that their own membership did not cover writes an activity-log row, read
    tiers included, deduplicated to one row per request and project. A
    superadmin whose real role already covers the tier takes the ordinary path,
    is answered with their real membership, and is not logged: nothing about
    that access was administrative.

    `include_trashed=True` is for `POST /{id}/restore`, the one endpoint that
    acts on a project precisely because it is in the trash. Such a caller has
    already loaded the trashed row and must pass it as `project`, because the
    404 above is exactly what it does not want. The tier, the refusals and the
    audit row are then the same ones every other reach gets, which is the point:
    a superadmin taking somebody else's project out of the trash is a reach past
    their own membership and belongs in the log with the rest.
    """
    ROLE_RANK = {
        ProjectRole.owner: 4,
        ProjectRole.editor: 3,
        ProjectRole.reviewer: 2,
        ProjectRole.viewer: 1,
    }
    if project is None:
        require_live_project(db, project_id)
    member = get_project_member(db, project_id, user.id, include_trashed=include_trashed)
    if member and ROLE_RANK[member.role] >= ROLE_RANK[minimum_role]:
        return member
    if is_instance_admin(user):
        log_admin_project_access(
            db, project_id, user.id, minimum_role,
            membership=member.role.value if member else "none",
        )
        return admin_membership(project_id, user)
    if not member:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a project member")
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=f"Requires {minimum_role.value} role or higher",
    )


def require_project_visible(
    db: Session,
    project_id: uuid.UUID,
    user: User,
    project: "Project | None" = None,
) -> ProjectMember | None:
    """For what a public project also shows non-members: 404 for a project that does
    not exist or is deleted, 403 unless the user is a member or the project is public.
    Returns the membership, if any. Pass `project` when the caller already has
    the live row.

    An instance superadmin is visible on every live project. The read is logged
    as the viewer tier, once per request and project.
    """
    if project is None:
        project = require_live_project(db, project_id)
    member = get_project_member(db, project_id, user.id)
    if not member and not project.is_public:
        if is_instance_admin(user):
            log_admin_project_access(db, project_id, user.id, ProjectRole.viewer)
            return admin_membership(project_id, user)
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
    audit: bool = False,
) -> str | None:
    """Why this user, holding an access token minted at `token_version`, may not
    receive the project's live events. None means they may.

    The same rule as connecting to GET /events/{project_id}: a live, active
    account whose token has not been revoked (token_version is bumped by a
    password change), on a project that is not deleted, which the user is a
    member of or which is public. An open event stream calls this repeatedly
    for as long as it stays open, so it is a single indexed round trip.
    Token expiry is not checked here; the caller has the token's `exp`.

    An instance superadmin passes the membership test, so a project they opened
    without being a member streams instead of revoking a second later. The flag
    is read from the same row, so this stays one round trip, and losing it mid
    stream revokes the subscriber like losing a membership does.

    `audit=True` logs an admin-only subscription. The caller passes it on the
    check at connect and not on the rechecks: the stream re-checks on its own
    short-lived session for as long as it stays open, so a row per check would
    be a row per recheck interval per open tab.
    """
    is_member = exists().where(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == user_id,
        ProjectMember.deleted_at.is_(None),
    )
    row = db.execute(
        select(
            User.status,
            User.token_version,
            User.is_superadmin,
            Project.is_public,
            is_member.label("is_member"),
        )
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
    if not (row.is_member or row.is_public or row.is_superadmin):
        return EVENTS_ACCESS_REVOKED
    if audit and row.is_superadmin and not row.is_member and not row.is_public:
        log_admin_project_access(db, project_id, user_id, AUDIT_SCOPE_EVENTS)
    return None


def asset_access_reason(db: Session, asset: Asset, user: User) -> "str | None":
    """Why this user may reach the asset, or None if they may not.

    Split out of `can_access_asset` so the one caller that gates on it can tell
    an access that only the instance-admin flag allowed from one any member
    would have had, and log the first. `can_access_asset` itself must not log:
    it is also read to filter a list (which mentions resolve, who sees a
    comment), and a row per item in a list is exactly the flood this audit has
    to avoid.

    No path reaches an asset whose project is in the trash.
    """
    project_live = db.query(Project.id).filter(
        Project.id == asset.project_id,
        Project.deleted_at.is_(None),
    ).first()
    if not project_live:
        return None

    # 1. Asset creator
    if asset.created_by == user.id:
        return "creator"

    # 2. Project member
    if get_project_member(db, asset.project_id, user.id):
        return "member"

    # 3. Direct AssetShare with user
    direct = db.query(AssetShare).filter(
        AssetShare.asset_id == asset.id,
        AssetShare.shared_with_user_id == user.id,
        AssetShare.deleted_at.is_(None),
    ).first()
    if direct:
        return "share"

    # 4. Public project — any authenticated user can view
    if is_public_project(db, asset.project_id):
        return "public"

    # 5. Instance superadmin — every live project, membership or not. Last, so
    #    an admin who is a member or creator still takes the cheaper path above.
    if is_instance_admin(user):
        return ASSET_ACCESS_VIA_SUPERADMIN

    return None


def can_access_asset(db: Session, asset: Asset, user: User) -> bool:
    """Check if user can access the asset via any path.

    No path reaches an asset whose project is in the trash. Never logs; see
    `asset_access_reason`.
    """
    return asset_access_reason(db, asset, user) is not None


def can_access_asset_audited(db: Session, asset: Asset, user: User) -> bool:
    """`can_access_asset`, and log an access the instance-admin flag alone allowed.

    For a caller that is handed asset ids and answers with the ones the user may
    reach, rather than refusing the request: `GET /assets/batch`, which is one
    request in place of a `GET /assets/{id}` per id. Those would each log, so the
    batch form has to log as well, or whether an administrator's read is recorded
    depends on which endpoint the client happened to call.

    Deduped like every other path, so one request writes one row per project
    however many ids it carries. Not for filtering a list the user did not name
    (who a mention resolves to, who sees a comment): that is `can_access_asset`.
    """
    reason = asset_access_reason(db, asset, user)
    if reason is None:
        return False
    if reason == ASSET_ACCESS_VIA_SUPERADMIN:
        log_admin_project_access(
            db, asset.project_id, user.id, AUDIT_SCOPE_ASSET, asset_id=asset.id,
        )
    return True


def require_asset_access(db: Session, asset: Asset, user: User) -> None:
    """403 unless the user may reach the asset.

    The gate every asset, version, comment and attachment route goes through,
    and therefore where an administrator's reach past membership into the asset
    path is logged: `can_access_asset` has no business writing rows, this does.
    """
    if not can_access_asset_audited(db, asset, user):
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
