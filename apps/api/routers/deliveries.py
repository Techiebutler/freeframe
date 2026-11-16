"""The public side of a delivery: the token is the permission, exactly as a share link's is."""
from datetime import datetime, timezone
from typing import Optional

import uuid
from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.rate_limit import rate_limit
from ..models.asset import Asset
from ..models.delivery import Delivery
from ..services import deliveries

router = APIRouter(tags=["deliveries"])


def _delivery(db: Session, token: str) -> Delivery:
    d = db.query(Delivery).filter(Delivery.token == token).first()
    if d is None:
        raise HTTPException(404, "not_found")
    return d


@router.get("/deliveries/{token}", dependencies=[Depends(rate_limit("delivery_view", 60, 600))])
def view(token: str, format: Optional[str] = None, db: Session = Depends(get_db)):
    """The page's data. `?format=json` (what /d/<token>?format=json is rewritten to) also fills in each file's sha256."""
    out = deliveries.delivery_v1(db, _delivery(db, token), hashes=format == "json")
    if out is None:
        raise HTTPException(404, "not_found")
    return out


@router.get("/deliveries/{token}/files/{media_file_id}", dependencies=[Depends(rate_limit("delivery_file", 60, 600))])
def download(token: str, media_file_id: uuid.UUID, db: Session = Depends(get_db)):
    from ..services.s3_service import build_download_filename, generate_presigned_get_url
    d = _delivery(db, token)
    f = next((m for m in deliveries.media_files(db, d) if m.id == media_file_id), None)
    asset = db.get(Asset, d.asset_id)
    if f is None or asset is None or asset.deleted_at is not None:
        raise HTTPException(404, "not_found")
    return RedirectResponse(generate_presigned_get_url(f.s3_key_raw, download_filename=build_download_filename(asset.name, f.original_filename)), status_code=302)


@router.post("/deliveries/{token}/handed-on", status_code=204, dependencies=[Depends(rate_limit("delivery_handed_on", 30, 600))])
def handed_on(token: str, db: Session = Depends(get_db)):
    """The reviewer copied the share link: the request leaves the overview for the Delivered archive. Idempotent."""
    d = _delivery(db, token)
    if d.handed_on_at is None:
        d.handed_on_at = datetime.now(timezone.utc)
        db.commit()
    return Response(status_code=204)
