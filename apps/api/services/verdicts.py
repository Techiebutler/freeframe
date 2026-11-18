"""Review verdicts: the one place every write to `approvals` goes through.

A verdict is one person's call (approved, changes requested, rejected) on one
version of an asset. The person is a signed-in user or a share-link guest, never
both, and each holds at most one verdict per version (the two partial unique
indexes on `approvals`).

The team routes, the share routes and the legacy approve/reject routes all call
in here, so the notification, the activity log and the live-update event cannot
drift between them. Callers are responsible for access: this module trusts that
`asset` is live, that `version` is a live version of it, and that `actor` is
allowed to act. It never reads or writes `Asset.status`.

Every write commits once, at the end, then dispatches its side effects. A caller
may add rows of its own to the session first (a ShareLinkActivity, say) and rely
on that single commit to persist them with the verdict.
"""
import uuid
from dataclasses import dataclass
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ..config import settings
from ..models.activity import ActivityLog, Notification, NotificationType
from ..models.approval import Approval, ApprovalStatus
from ..models.asset import Asset, AssetVersion
from ..models.project import Project, ProjectMember
from ..models.share import ShareLink
from ..models.user import GuestUser, User
from ..schemas.verdict import VerdictResponse, VerdictSummary, VerdictWho
from ..services import event_service
from ..services.avatar_keys import sign_avatar
from ..tasks.celery_app import send_task_safe
from ..tasks.email_tasks import send_approval_email

VERDICT_VALUES = ("approved", "changes_requested", "rejected")
# `pending` is stored by nothing and is not a verdict; legacy rows holding it are
# left out of every read rather than failing the response.
_VERDICT_STATUSES = [ApprovalStatus(v) for v in VERDICT_VALUES]

_GUEST_SUFFIX = " (guest)"
_NOTIFICATION_NAME_LIMIT = 255


@dataclass
class Actor:
    """Who is acting: a signed-in user or a guest (exactly one), and the share link
    they came through, if any."""
    user: Optional[User] = None
    guest: Optional[GuestUser] = None
    share_link: Optional[ShareLink] = None

    @property
    def display_name(self) -> str:
        if self.user is not None:
            return self.user.name
        if self.guest is not None:
            return self.guest.name
        raise ValueError("An actor needs a user or a guest")

    @property
    def is_guest(self) -> bool:
        """A share-link guest with no account, as opposed to a signed-in non-member."""
        return self.user is None and self.guest is not None


def clean_note(note: Optional[str]) -> Optional[str]:
    """What is stored for a note: trimmed, and nothing at all when it was only space."""
    if note is None:
        return None
    return note.strip() or None


def _require_one_actor(actor: Actor) -> None:
    if (actor.user is None) == (actor.guest is None):
        raise ValueError("A verdict needs exactly one of a user or a guest")


def _coerce_status(status) -> str:
    value = getattr(status, "value", status)
    if value not in VERDICT_VALUES:
        raise ValueError(f"{status!r} is not a verdict")
    return value


def _require_version_of(asset: Asset, version: AssetVersion) -> None:
    if version.asset_id != asset.id:
        raise ValueError("The version does not belong to the asset")


def _own_row(actor: Actor):
    """The filter that picks out this actor's row among a version's verdicts."""
    if actor.user is not None:
        return Approval.user_id == actor.user.id
    return Approval.guest_user_id == actor.guest.id


def _own_verdict(db: Session, version: AssetVersion, actor: Actor) -> Optional[Approval]:
    return db.query(Approval).filter(
        Approval.version_id == version.id,
        Approval.deleted_at.is_(None),
        _own_row(actor),
    ).first()


def verdict_unchanged(
    db: Session, version: AssetVersion, actor: Actor, status: str, note: Optional[str],
) -> bool:
    """Whether giving `status` with `note` would repeat the actor's current verdict
    exactly. `set_verdict` treats such a repeat as no change; a caller that records
    something of its own per verdict (the share route's link activity) asks first."""
    _require_one_actor(actor)
    value = _coerce_status(status)
    row = _own_verdict(db, version, actor)
    return row is not None and row.status.value == value and row.note == note


def _log_payload(version_id: uuid.UUID, actor: Actor) -> dict:
    return {
        "version_id": str(version_id),
        "actor_name": actor.display_name,
        "guest": actor.is_guest,
        "via_link": actor.share_link.title if actor.share_link is not None else None,
    }


def _creator_facing_name(db: Session, project_id: uuid.UUID, actor: Actor) -> str:
    """How the asset's creator is told who acted, in the drawer and in the email.

    The one place that decides it, so the two cannot drift. Anyone who is not a live
    member of the project is outside the team, and is tagged: a guest, and a signed-in
    person with no membership alike, since the name is whatever they typed or signed up
    with and must not read like a colleague. A team member is named as they are.
    The name is clipped so the tag still fits the notification's column.
    """
    name = actor.display_name
    if actor.user is not None and actor.user.id in _live_member_user_ids(db, project_id):
        return name[:_NOTIFICATION_NAME_LIMIT]
    return name[:_NOTIFICATION_NAME_LIMIT - len(_GUEST_SUFFIX)] + _GUEST_SUFFIX


def _publish(project_id: uuid.UUID, payload: dict) -> None:
    event_service.publish_sync(project_id, "approval_updated", payload)


def set_verdict(
    db: Session,
    asset: Asset,
    version: AssetVersion,
    actor: Actor,
    status: str,
    note: Optional[str],
) -> Approval:
    """Give or change the actor's verdict on `version`.

    An upsert on (version, actor). The link and its title are rewritten on every
    write, so a person who moves from a share page to the project does not keep a
    stale origin. Notifies the asset's creator unless the actor is the creator.

    Repeating the actor's current verdict exactly (same status, same note) is no
    change: only the link is refreshed, and nothing is logged, notified, emailed or
    published. Otherwise anyone holding an approve link could send the creator an
    email per request by pressing the same button again.
    """
    value = _coerce_status(status)
    _require_one_actor(actor)
    _require_version_of(asset, version)

    link = actor.share_link
    existing = _own_verdict(db, version, actor)
    if existing is not None and existing.status.value == value and existing.note == note:
        existing.share_link_id = link.id if link is not None else None
        existing.via_link_title = link.title if link is not None else None
        db.commit()
        return existing

    asset_id, project_id, version_id = asset.id, asset.project_id, version.id
    asset_name, creator_id = asset.name, asset.created_by

    insert_stmt = pg_insert(Approval).values(
        asset_id=asset_id,
        version_id=version_id,
        user_id=actor.user.id if actor.user is not None else None,
        guest_user_id=actor.guest.id if actor.guest is not None else None,
        share_link_id=link.id if link is not None else None,
        via_link_title=link.title if link is not None else None,
        status=ApprovalStatus(value),
        note=note,
    )
    # The unique indexes are partial, so Postgres only matches one when the
    # statement repeats its predicate.
    if actor.user is not None:
        conflict = dict(index_elements=[Approval.version_id, Approval.user_id],
                        index_where=Approval.user_id.isnot(None))
    else:
        conflict = dict(index_elements=[Approval.version_id, Approval.guest_user_id],
                        index_where=Approval.guest_user_id.isnot(None))
    upsert = insert_stmt.on_conflict_do_update(
        **conflict,
        set_={
            "status": insert_stmt.excluded.status,
            "note": insert_stmt.excluded.note,
            "share_link_id": insert_stmt.excluded.share_link_id,
            "via_link_title": insert_stmt.excluded.via_link_title,
            "updated_at": func.now(),
            # No verdict code soft-deletes a row, but a retention-era one would still
            # hold the unique index, and must come back to life rather than stay hidden.
            "deleted_at": None,
        },
    ).returning(Approval)
    approval = db.execute(upsert, execution_options={"populate_existing": True}).scalar_one()

    db.add(ActivityLog(
        user_id=actor.user.id if actor.user is not None else None,
        project_id=project_id,
        asset_id=asset_id,
        action=value,
        payload=_log_payload(version_id, actor),
    ))

    # A guest has no account, so only a signed-in actor can be the creator.
    acted_as_creator = actor.user is not None and actor.user.id == creator_id
    email = None
    if not acted_as_creator:
        creator_facing_name = _creator_facing_name(db, project_id, actor)
        db.add(Notification(
            user_id=creator_id,
            type=NotificationType.approval,
            asset_id=asset_id,
            actor_name=creator_facing_name,
            detail=value,
        ))
        creator = db.get(User, creator_id)
        if creator is not None and creator.email:
            email = dict(
                to_email=creator.email,
                reviewer_name=creator_facing_name,
                asset_name=asset_name,
                status=value,
                asset_link=f"{settings.frontend_url}/projects/{project_id}/assets/{asset_id}",
                note=note,
                # An untitled link is not named, as the drawer does not name it.
                via_link=(link.title or None) if link is not None else None,
            )

    db.commit()

    if email is not None:
        send_task_safe(send_approval_email, **email)
    _publish(project_id, {
        "asset_id": str(asset_id), "version_id": str(version_id), "status": value,
    })
    return approval


def clear_verdict(db: Session, asset: Asset, version: AssetVersion, actor: Actor) -> bool:
    """Withdraw the actor's own verdict on `version`. The row is deleted, not hidden:
    it is a person taking a label back, and a hidden row would still hold the unique
    index against the next time they decide. Notifies nobody.

    Returns whether there was a verdict to clear. Clearing nothing changes nothing, so
    it writes no log and publishes no event; it still commits, so a row the caller added
    to the session (a ShareLinkActivity) persists either way.
    """
    _require_one_actor(actor)
    _require_version_of(asset, version)

    row = db.query(Approval).filter(
        Approval.version_id == version.id,
        Approval.asset_id == asset.id,
        Approval.deleted_at.is_(None),
        _own_row(actor),
    ).first()

    project_id, asset_id, version_id = asset.project_id, asset.id, version.id
    existed = row is not None
    if existed:
        db.delete(row)
        db.add(ActivityLog(
            user_id=actor.user.id if actor.user is not None else None,
            project_id=project_id,
            asset_id=asset_id,
            action="verdict_cleared",
            payload=_log_payload(version_id, actor),
        ))
    db.commit()

    if existed:
        _publish(project_id, {"asset_id": str(asset_id), "version_id": str(version_id)})
    return existed


def remove_verdict(db: Session, asset: Asset, verdict_id: uuid.UUID, remover: User) -> None:
    """Delete somebody else's verdict. The caller has checked that `remover` may
    (owner or editor). The log names who removed it and whose it was. Notifies nobody.

    404 when no such verdict exists on this asset, so an id from another asset reads
    the same as one that was never there.
    """
    row = db.query(Approval).filter(
        Approval.id == verdict_id,
        Approval.asset_id == asset.id,
        Approval.deleted_at.is_(None),
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Verdict not found")

    if row.user_id is not None:
        owner = db.get(User, row.user_id)
    else:
        owner = db.get(GuestUser, row.guest_user_id)
    project_id, asset_id, version_id = asset.project_id, asset.id, row.version_id

    db.delete(row)
    db.add(ActivityLog(
        user_id=remover.id,
        project_id=project_id,
        asset_id=asset_id,
        action="verdict_removed",
        payload={
            "removed_actor_name": owner.name if owner is not None else "",
            "version_id": str(version_id),
        },
    ))
    db.commit()

    _publish(project_id, {"asset_id": str(asset_id), "version_id": str(version_id)})


def _live_member_user_ids(db: Session, project_id: uuid.UUID) -> set[uuid.UUID]:
    """Users who are members of the project right now. The same rule as
    `permissions.get_project_member`: a live membership of a live project."""
    rows = db.execute(
        select(ProjectMember.user_id)
        .join(Project, Project.id == ProjectMember.project_id)
        .where(
            ProjectMember.project_id == project_id,
            ProjectMember.deleted_at.is_(None),
            Project.deleted_at.is_(None),
        )
    ).scalars()
    return set(rows)


def _is_mine(row: Approval, me: Actor) -> bool:
    # Compare only the side `me` actually is: a guest's missing user id must not
    # equal every guest row's missing user id.
    if me.user is not None and row.user_id == me.user.id:
        return True
    return me.guest is not None and row.guest_user_id == me.guest.id


def list_verdicts(
    db: Session,
    asset: Asset,
    version_id: uuid.UUID,
    *,
    me: Actor,
    guest_scope_link_id: Optional[uuid.UUID] = None,
) -> list[VerdictResponse]:
    """Every verdict on one version of `asset`, oldest change first.

    `who.kind` is worked out now, not stored: a user who is a live member of the
    project is `team`, everyone else is `external`. So a client who gave a verdict
    as an outsider reads as team once they are added to the project.

    With `guest_scope_link_id` the listing is what a guest on that link may see:
    their own verdict, plus external verdicts given through this same link. Never
    team verdicts, and never another link's.
    """
    member_ids = _live_member_user_ids(db, asset.project_id)
    rows = (
        db.query(Approval, User, GuestUser)
        .outerjoin(User, User.id == Approval.user_id)
        .outerjoin(GuestUser, GuestUser.id == Approval.guest_user_id)
        .filter(
            Approval.asset_id == asset.id,
            Approval.version_id == version_id,
            Approval.deleted_at.is_(None),
            Approval.status.in_(_VERDICT_STATUSES),
        )
        .order_by(Approval.updated_at, Approval.created_at, Approval.id)
        .all()
    )

    result = []
    for row, user, guest in rows:
        is_team = row.user_id is not None and row.user_id in member_ids
        mine = _is_mine(row, me)
        if guest_scope_link_id is not None and not mine:
            if is_team or row.share_link_id != guest_scope_link_id:
                continue
        if user is not None:
            who = VerdictWho(
                kind="team" if is_team else "external",
                name=user.name,
                avatar_url=sign_avatar(user.id, user.avatar_url),
                avatar_color=user.avatar_color,
                is_guest=False,
            )
        elif guest is not None:
            who = VerdictWho(kind="external", name=guest.name, is_guest=True)
        else:
            continue
        result.append(VerdictResponse(
            id=row.id,
            version_id=row.version_id,
            status=row.status.value,
            note=row.note,
            created_at=row.created_at,
            updated_at=row.updated_at,
            who=who,
            via_link_title=row.via_link_title,
            is_mine=mine,
        ))
    return result


def verdict_summaries(db: Session, version_ids: list[uuid.UUID]) -> dict[uuid.UUID, VerdictSummary]:
    """How many of each verdict every given version holds, in one grouped query.

    Every requested id is present, zeroed when nobody has judged it, so a caller can
    index the result without a default. Counts include team and external alike.
    """
    ids = list(dict.fromkeys(version_ids))
    if not ids:
        return {}
    summaries = {vid: VerdictSummary() for vid in ids}
    rows = (
        db.query(Approval.version_id, Approval.status, func.count(Approval.id))
        .filter(
            Approval.version_id.in_(ids),
            Approval.deleted_at.is_(None),
            Approval.status.in_(_VERDICT_STATUSES),
        )
        .group_by(Approval.version_id, Approval.status)
        .all()
    )
    for version_id, status, count in rows:
        setattr(summaries[version_id], status.value, count)
    return summaries
