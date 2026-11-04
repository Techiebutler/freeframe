"""Agents (Claude Code, Codex, Hermes ...) as paired editors of one project.

Owner side: pairing codes, the agent list, revoke. Public: POST /agents/pair. Agent side lives in
routers/agent.py and authenticates with `Authorization: Bearer ara_...`.
"""
import uuid
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..middleware.rate_limit import rate_limit
from ..models.agent import AgentKey
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.user import User
from ..services import agents as agent_service
from ..services.permissions import require_project_role

router = APIRouter(tags=["agents"])


def _project(db: Session, project_id: uuid.UUID) -> Project:
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(404, "Project not found")
    return project


@router.post("/projects/{project_id}/agent-pairing-codes", status_code=status.HTTP_201_CREATED)
def create_pairing_code(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _project(db, project_id)
    require_project_role(db, project_id, current_user, ProjectRole.owner)
    code, expires = agent_service.create_pairing_code(db, project_id, current_user)
    return {"code": code, "expires_at": expires.isoformat()}


@router.get("/projects/{project_id}/agents")
def list_agents(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _project(db, project_id)
    require_project_role(db, project_id, current_user, ProjectRole.owner)
    keys = db.query(AgentKey, User).join(User, User.id == AgentKey.user_id) \
        .filter(AgentKey.project_id == project_id).order_by(AgentKey.created_at).all()
    return [{"user_id": str(k.user_id), "name": u.name, "program": k.program, "agent_name": k.agent_name,
             "created_at": k.created_at.isoformat() if k.created_at else None,
             "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
             "revoked": k.revoked_at is not None} for k, u in keys]


@router.delete("/projects/{project_id}/agents/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_agent(project_id: uuid.UUID, user_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _project(db, project_id)
    require_project_role(db, project_id, current_user, ProjectRole.owner)
    keys = db.query(AgentKey).filter(AgentKey.project_id == project_id, AgentKey.user_id == user_id).all()
    if not keys:
        raise HTTPException(404, "not_found")
    now = datetime.now(timezone.utc)
    for key in keys:
        key.revoked_at = key.revoked_at or now
    # The agent leaves the project too; pairing again brings it back (services.agents.pair).
    for member in db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id,
                                                 ProjectMember.deleted_at.is_(None)).all():
        member.deleted_at = now
    db.commit()


class PairBody(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    agent_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    program: Literal["claude-code", "codex", "hermes", "grok", "other"]


@router.post("/agents/pair", dependencies=[Depends(rate_limit("agent_pair", 20, 600))])
def pair_agent(body: PairBody, db: Session = Depends(get_db)):
    key, row, project = agent_service.pair(db, body.code, body.agent_name, body.program)
    return {"agent_key": key, "user_id": str(row.user_id), "project_id": str(project.id), "project_name": project.name}
