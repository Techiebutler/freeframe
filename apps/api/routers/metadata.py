import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.asset import Asset
from ..models.metadata import AssetMetadata, Collection, CollectionShare, MetadataField
from ..models.project import ProjectRole
from ..models.user import User
from ..schemas.asset import AssetResponse
from ..schemas.metadata import (
    AssetMetadataResponse,
    AssetMetadataSet,
    CollectionCreate,
    CollectionResponse,
    CollectionShareCreate,
    CollectionShareResponse,
    MetadataFieldCreate,
    MetadataFieldResponse,
)
from ..services.permissions import require_project_role
from ..services.search import escape_like

router = APIRouter(tags=["metadata"])


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_project_for_asset(db: Session, asset_id: uuid.UUID) -> uuid.UUID:
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset.project_id


def _apply_smart_filter(db: Session, project_id: uuid.UUID, rules: dict):
    q = db.query(Asset).filter(
        Asset.project_id == project_id,
        Asset.deleted_at.is_(None),
    )
    if rules and "status" in rules:
        q = q.filter(Asset.status == rules["status"])
    if rules and "asset_type" in rules:
        q = q.filter(Asset.asset_type == rules["asset_type"])
    if rules and "name_contains" in rules:
        # Escape wildcards: a smart collection saved with name_contains="%"
        # would otherwise match every asset in the project.
        q = q.filter(Asset.name.ilike(f"%{escape_like(str(rules['name_contains']))}%"))
    return q


def _is_smart(collection: Collection) -> bool:
    return bool(collection.filter_rules)


def _collection_asset_count(db: Session, collection: Collection) -> int:
    if not _is_smart(collection):
        return 0
    return _apply_smart_filter(db, collection.project_id, collection.filter_rules or {}).count()


def _collection_to_response(db: Session, collection: Collection) -> CollectionResponse:
    asset_count = _collection_asset_count(db, collection)
    return CollectionResponse(
        id=collection.id,
        project_id=collection.project_id,
        name=collection.name,
        filter_rules=collection.filter_rules or None,
        is_smart=_is_smart(collection),
        asset_count=asset_count,
    )


# ── Metadata Fields ────────────────────────────────────────────────────────────

@router.post(
    "/projects/{project_id}/metadata-fields",
    response_model=MetadataFieldResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_metadata_field(
    project_id: uuid.UUID,
    body: MetadataFieldCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    # Check for duplicate name (active fields only)
    existing = db.query(MetadataField).filter(
        MetadataField.project_id == project_id,
        MetadataField.name == body.name,
        MetadataField.deleted_at.is_(None),
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="A metadata field with this name already exists")

    field = MetadataField(
        project_id=project_id,
        name=body.name,
        field_type=body.field_type,
        options=body.options,
        required=body.required,
    )
    db.add(field)
    db.commit()
    db.refresh(field)
    return field


@router.get(
    "/projects/{project_id}/metadata-fields",
    response_model=list[MetadataFieldResponse],
)
def list_metadata_fields(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.viewer)
    fields = db.query(MetadataField).filter(
        MetadataField.project_id == project_id,
        MetadataField.deleted_at.is_(None),
    ).all()
    return fields


@router.delete(
    "/projects/{project_id}/metadata-fields/{field_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_metadata_field(
    project_id: uuid.UUID,
    field_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    field = db.query(MetadataField).filter(
        MetadataField.id == field_id,
        MetadataField.project_id == project_id,
        MetadataField.deleted_at.is_(None),
    ).first()
    if not field:
        raise HTTPException(status_code=404, detail="Metadata field not found")
    field.deleted_at = datetime.now(timezone.utc)
    db.commit()


# ── Asset Metadata ─────────────────────────────────────────────────────────────

@router.put(
    "/assets/{asset_id}/metadata",
    response_model=list[AssetMetadataResponse],
)
def set_asset_metadata(
    asset_id: uuid.UUID,
    body: list[AssetMetadataSet],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project_id = _get_project_for_asset(db, asset_id)
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    for item in body:
        # Validate field exists and belongs to this project
        field = db.query(MetadataField).filter(
            MetadataField.id == item.field_id,
            MetadataField.project_id == project_id,
            MetadataField.deleted_at.is_(None),
        ).first()
        if not field:
            raise HTTPException(
                status_code=404,
                detail=f"Metadata field {item.field_id} not found in this project",
            )

        existing = db.query(AssetMetadata).filter(
            AssetMetadata.asset_id == asset_id,
            AssetMetadata.field_id == item.field_id,
        ).first()
        if existing:
            existing.value = item.value
        else:
            db.add(AssetMetadata(
                asset_id=asset_id,
                field_id=item.field_id,
                value=item.value,
            ))

    db.commit()

    # Return current metadata with field names
    return _get_asset_metadata_responses(db, asset_id)


@router.get(
    "/assets/{asset_id}/metadata",
    response_model=list[AssetMetadataResponse],
)
def get_asset_metadata(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project_id = _get_project_for_asset(db, asset_id)
    require_project_role(db, project_id, current_user, ProjectRole.viewer)
    return _get_asset_metadata_responses(db, asset_id)


def _get_asset_metadata_responses(db: Session, asset_id: uuid.UUID) -> list[AssetMetadataResponse]:
    rows = (
        db.query(AssetMetadata, MetadataField)
        .join(MetadataField, AssetMetadata.field_id == MetadataField.id)
        .filter(
            AssetMetadata.asset_id == asset_id,
            MetadataField.deleted_at.is_(None),
        )
        .all()
    )
    return [
        AssetMetadataResponse(
            field_id=meta.field_id,
            field_name=field.name,
            field_type=field.field_type,
            value=meta.value,
        )
        for meta, field in rows
    ]


# ── Collections ────────────────────────────────────────────────────────────────

@router.post(
    "/projects/{project_id}/collections",
    response_model=CollectionResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_collection(
    project_id: uuid.UUID,
    body: CollectionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    collection = Collection(
        project_id=project_id,
        name=body.name,
        filter_rules=body.filter_rules or {},
        created_by=current_user.id,
    )
    db.add(collection)
    db.commit()
    db.refresh(collection)
    return _collection_to_response(db, collection)


@router.get(
    "/projects/{project_id}/collections",
    response_model=list[CollectionResponse],
)
def list_collections(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.viewer)
    collections = db.query(Collection).filter(
        Collection.project_id == project_id,
        Collection.deleted_at.is_(None),
    ).all()

    return [_collection_to_response(db, col) for col in collections]


@router.get(
    "/projects/{project_id}/collections/{collection_id}",
    response_model=CollectionResponse,
)
def get_collection(
    project_id: uuid.UUID,
    collection_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.viewer)
    collection = db.query(Collection).filter(
        Collection.id == collection_id,
        Collection.project_id == project_id,
        Collection.deleted_at.is_(None),
    ).first()
    if not collection:
        raise HTTPException(status_code=404, detail="Collection not found")

    return _collection_to_response(db, collection)


@router.delete(
    "/projects/{project_id}/collections/{collection_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_collection(
    project_id: uuid.UUID,
    collection_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    collection = db.query(Collection).filter(
        Collection.id == collection_id,
        Collection.project_id == project_id,
        Collection.deleted_at.is_(None),
    ).first()
    if not collection:
        raise HTTPException(status_code=404, detail="Collection not found")
    collection.deleted_at = datetime.now(timezone.utc)
    db.commit()


# ── Collection Sharing ─────────────────────────────────────────────────────────

@router.post(
    "/projects/{project_id}/collections/{collection_id}/share",
    status_code=status.HTTP_201_CREATED,
)
def share_collection(
    project_id: uuid.UUID,
    collection_id: uuid.UUID,
    body: CollectionShareCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    collection = db.query(Collection).filter(
        Collection.id == collection_id,
        Collection.project_id == project_id,
        Collection.deleted_at.is_(None),
    ).first()
    if not collection:
        raise HTTPException(status_code=404, detail="Collection not found")

    token = secrets.token_urlsafe(32)
    share = CollectionShare(
        collection_id=collection_id,
        token=token,
        permission=body.permission,
        expires_at=body.expires_at,
        created_by=current_user.id,
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    return {"id": str(share.id), "token": share.token, "permission": share.permission}


@router.get(
    "/projects/{project_id}/collections/{collection_id}/shares",
    response_model=list[CollectionShareResponse],
)
def list_collection_shares(
    project_id: uuid.UUID,
    collection_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.viewer)
    collection = db.query(Collection).filter(
        Collection.id == collection_id,
        Collection.project_id == project_id,
        Collection.deleted_at.is_(None),
    ).first()
    if not collection:
        raise HTTPException(status_code=404, detail="Collection not found")

    shares = db.query(CollectionShare).filter(
        CollectionShare.collection_id == collection_id,
        CollectionShare.deleted_at.is_(None),
    ).all()
    return shares


@router.delete(
    "/projects/{project_id}/collections/{collection_id}/share/{share_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_collection_share(
    project_id: uuid.UUID,
    collection_id: uuid.UUID,
    share_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    collection = db.query(Collection).filter(
        Collection.id == collection_id,
        Collection.project_id == project_id,
        Collection.deleted_at.is_(None),
    ).first()
    if not collection:
        raise HTTPException(status_code=404, detail="Collection not found")

    share = db.query(CollectionShare).filter(
        CollectionShare.id == share_id,
        CollectionShare.collection_id == collection_id,
        CollectionShare.deleted_at.is_(None),
    ).first()
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    share.deleted_at = datetime.now(timezone.utc)
    db.commit()
