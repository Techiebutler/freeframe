from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional
from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset
from ..models.folder import Folder
from ..models.project import Project, ProjectMember
from ..models.share import AssetShare
from ..models.activity import Mention, Notification
from ..models.comment import Comment
from ..schemas.asset import AssetResponse, NotificationResponse
from ..routers.assets import _build_asset_response, _build_asset_responses_bulk

router = APIRouter(prefix="/me", tags=["me"])


def _escape_like(s: str) -> str:
    """Escape special LIKE pattern characters so user-supplied search
    text is matched literally (not as wildcards). See users._escape_like."""
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("/assets", response_model=list[AssetResponse])
def list_my_assets(
    filter: Optional[str] = Query(default=None, description="owned|shared|mentioned|assigned|due_soon"),
    q: Optional[str] = Query(default=None, description="Search by asset name"),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if filter == "owned":
        query = db.query(Asset).filter(
            Asset.created_by == current_user.id,
            Asset.deleted_at.is_(None),
        )

    elif filter == "shared":
        shared_ids = db.query(AssetShare.asset_id).filter(
            AssetShare.shared_with_user_id == current_user.id,
            AssetShare.deleted_at.is_(None),
        ).subquery()
        query = db.query(Asset).filter(
            Asset.id.in_(shared_ids),
            Asset.deleted_at.is_(None),
        )

    elif filter == "mentioned":
        mentioned_asset_ids = (
            db.query(Asset.id)
            .join(Comment, Comment.asset_id == Asset.id)
            .join(Mention, Mention.comment_id == Comment.id)
            .filter(
                Mention.mentioned_user_id == current_user.id,
                Asset.deleted_at.is_(None),
                Comment.deleted_at.is_(None),
            )
            .distinct()
            .all()
        )
        ids = [r[0] for r in mentioned_asset_ids]
        query = db.query(Asset).filter(Asset.id.in_(ids), Asset.deleted_at.is_(None))

    elif filter == "assigned":
        query = db.query(Asset).filter(
            Asset.assignee_id == current_user.id,
            Asset.deleted_at.is_(None),
        )

    elif filter == "due_soon":
        now = datetime.now(timezone.utc)
        query = db.query(Asset).filter(
            Asset.assignee_id == current_user.id,
            Asset.due_date.isnot(None),
            Asset.due_date <= now + timedelta(days=7),
            Asset.deleted_at.is_(None),
        )

    else:
        # All accessible: member of project OR directly shared OR assigned
        project_ids = db.query(ProjectMember.project_id).filter(
            ProjectMember.user_id == current_user.id,
            ProjectMember.deleted_at.is_(None),
        ).subquery()
        shared_ids = db.query(AssetShare.asset_id).filter(
            AssetShare.shared_with_user_id == current_user.id,
            AssetShare.deleted_at.is_(None),
        ).subquery()
        query = db.query(Asset).filter(
            Asset.deleted_at.is_(None),
        ).filter(
            or_(
                Asset.project_id.in_(project_ids),
                Asset.id.in_(shared_ids),
                Asset.assignee_id == current_user.id,
            )
        )

    # Apply search filter
    if q and q.strip():
        query = query.filter(Asset.name.ilike(f"%{_escape_like(q.strip())}%"))

    assets = query.order_by(Asset.created_at.desc()).offset(skip).limit(limit).all()
    return _build_asset_responses_bulk(assets, db)


@router.get("/folders")
def search_my_folders(
    q: Optional[str] = Query(default=None, description="Search by folder name"),
    limit: int = Query(default=10, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Search folders across all projects the user has access to."""
    project_ids = db.query(ProjectMember.project_id).filter(
        ProjectMember.user_id == current_user.id,
        ProjectMember.deleted_at.is_(None),
    ).subquery()

    query = db.query(Folder).filter(
        Folder.project_id.in_(project_ids),
        Folder.deleted_at.is_(None),
    )
    if q and q.strip():
        query = query.filter(Folder.name.ilike(f"%{_escape_like(q.strip())}%"))

    folders = query.order_by(Folder.name).limit(limit).all()

    # Include project name for context
    results = []
    for f in folders:
        project = db.query(Project).filter(Project.id == f.project_id).first()
        results.append({
            "id": str(f.id),
            "name": f.name,
            "project_id": str(f.project_id),
            "project_name": project.name if project else None,
            "item_count": f.item_count if hasattr(f, 'item_count') else 0,
        })
    return results


## Notification endpoints moved to routers/notifications.py (enriched responses)
