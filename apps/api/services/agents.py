"""Agent identities: pairing codes, keys, and the Bearer ara_ lookup. Pure helpers first, DB after."""
import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models.agent import AgentKey, AgentPairingCode
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.user import User, UserStatus

CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789"
CODE_TTL = timedelta(minutes=15)
KEY_PREFIX = "ara_"
LAST_USED_EVERY = timedelta(seconds=60)


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))


def new_key() -> str:
    return KEY_PREFIX + secrets.token_urlsafe(30)[:40]


@dataclass
class AgentContext:
    user: User
    key: AgentKey


def create_pairing_code(db: Session, project_id: uuid.UUID, owner: User) -> tuple[str, datetime]:
    code = new_code()
    expires = datetime.now(timezone.utc) + CODE_TTL
    db.add(AgentPairingCode(project_id=project_id, created_by=owner.id, code_hash=sha256(code), expires_at=expires))
    db.commit()
    return code, expires


def pair(db: Session, code: str, agent_name: str, program: str) -> tuple[str, AgentKey, Project]:
    """Spend a code and return (plain key, key row, project). Same project+program+name rotates that row's key.
    Two codes racing for the same new agent hit the unique key once; the retry then rotates the winner's row."""
    try:
        return _pair(db, code, agent_name, program)
    except IntegrityError:
        db.rollback()
        return _pair(db, code, agent_name, program)


def _pair(db: Session, code: str, agent_name: str, program: str) -> tuple[str, AgentKey, Project]:
    row = db.query(AgentPairingCode).filter(AgentPairingCode.code_hash == sha256((code or "").strip().upper())) \
        .populate_existing().with_for_update().first()
    if row is None:
        raise HTTPException(404, "code_unknown")
    if row.used_at is not None:
        raise HTTPException(410, "code_used")
    now = datetime.now(timezone.utc)
    if row.expires_at <= now:
        raise HTTPException(410, "code_expired")
    project = db.query(Project).filter(Project.id == row.project_id, Project.deleted_at.is_(None)).first()
    if project is None:
        raise HTTPException(404, "code_unknown")
    row.used_at = now
    plain, key = _issue_key(db, project, row.created_by, agent_name, program, None)
    db.commit()
    return plain, key, project


def create_key(db: Session, project: Project, creator: User, agent_name: str, program: str, scope: str) -> tuple[str, AgentKey]:
    """A key straight from the signed-in owner or editor (Agent Mode), for AIs that cannot pair. Same row rules as pair."""
    def once():
        plain, key = _issue_key(db, project, creator.id, agent_name, program, scope)
        db.commit()
        return plain, key
    try:
        return once()
    except IntegrityError:
        db.rollback()
        return once()


def _issue_key(db: Session, project: Project, invited_by: uuid.UUID, agent_name: str, program: str,
               scope: Optional[str]) -> tuple[str, AgentKey]:
    """New agent user + editor membership + key, or rotate the key of the same (project, program, name).
    scope None keeps the row's scope (re-pairing never narrows or widens a key)."""
    plain = new_key()
    key = db.query(AgentKey).filter(AgentKey.project_id == project.id, AgentKey.program == program,
                                    AgentKey.agent_name == agent_name).with_for_update().first()
    if key is None:
        user = User(email=f"agent+{uuid.uuid4()}@agents.autoreview.local", name=f"{agent_name} ({program})",
                    status=UserStatus.active, is_staff=False, kind="agent", email_verified=True)
        db.add(user)
        db.flush()
        db.add(ProjectMember(project_id=project.id, user_id=user.id, role=ProjectRole.editor, invited_by=invited_by))
        key = AgentKey(user_id=user.id, project_id=project.id, program=program, agent_name=agent_name,
                       key_hash=sha256(plain), scope=scope or "deliver")
        db.add(key)
    else:
        key.key_hash, key.revoked_at = sha256(plain), None
        if scope:
            key.scope = scope
        member = db.query(ProjectMember).filter(ProjectMember.project_id == project.id, ProjectMember.user_id == key.user_id).first()
        if member is None:
            db.add(ProjectMember(project_id=project.id, user_id=key.user_id, role=ProjectRole.editor, invited_by=invited_by))
        else:
            member.deleted_at, member.role = None, ProjectRole.editor
    return plain, key


def presented_key(authorization: Optional[str]) -> Optional[str]:
    """The ara_ token of an Authorization header, or None when it is some other kind of bearer."""
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    token = token.strip()
    return token if scheme.lower() == "bearer" and token.startswith(KEY_PREFIX) else None


def resolve_key(db: Session, token: str) -> AgentContext:
    key = db.query(AgentKey).filter(AgentKey.key_hash == sha256(token)).first()
    if key is None:
        raise HTTPException(401, "invalid_agent_key")
    if key.revoked_at is not None:
        raise HTTPException(403, "revoked_agent_key")
    user = db.query(User).filter(User.id == key.user_id, User.deleted_at.is_(None)).first()
    if user is None or user.status == UserStatus.deactivated:
        raise HTTPException(403, "revoked_agent_key")
    now = datetime.now(timezone.utc)
    if key.last_used_at is None or now - key.last_used_at >= LAST_USED_EVERY:  # not a write per poll
        key.last_used_at = now
        db.commit()
    return AgentContext(user=user, key=key)


def require_scope(agent: AgentContext, write: bool) -> None:
    """A read key may look but not hand in, file requests, ack or suggest (Agent Mode spec E)."""
    if write and agent.key.scope == "read":
        raise HTTPException(403, "scope_read_only")
