"""Self-review phase of a request, derived from its assets and never stored (contract Nachtrag 5)."""
import uuid
from typing import Optional

from sqlalchemy.orm import Session

from ..models.asset import Asset, AssetVersion
from ..models.user import User

STUCK_AFTER = 3


def review_phase(assets: list[dict]) -> Optional[str]:
    """assets: {review_state, latest_is_agent, agent_versions, latest_at}, one per asset (latest version).

    None when the newest version of the request is a person's; otherwise self_review while an agent version is
    unclear, ready_for_editor once everything is clear, agent_stuck after 3 agent versions of an asset that
    still hold must-fixes."""
    if not assets or not max(assets, key=lambda a: a["latest_at"])["latest_is_agent"]:
        return None
    if any(a["latest_is_agent"] and a["review_state"] == "held" and a["agent_versions"] >= STUCK_AFTER for a in assets):
        return "agent_stuck"
    return "ready_for_editor" if all(a["review_state"] == "clear" for a in assets) else "self_review"


def phase_of_reviews(db: Session, reviews: list[dict]) -> Optional[str]:
    """`reviews` are routers.requests._review_assets entries (current version per asset)."""
    ids = [uuid.UUID(r["asset_id"]) for r in reviews if r.get("version_id")]
    if not ids:
        return None
    versions = db.query(AssetVersion.id, AssetVersion.asset_id, AssetVersion.created_at, AssetVersion.created_by, User.kind) \
        .join(User, User.id == AssetVersion.created_by).filter(AssetVersion.asset_id.in_(ids), AssetVersion.deleted_at.is_(None)).all()
    by_asset: dict[uuid.UUID, list] = {}
    for v in versions:
        by_asset.setdefault(v.asset_id, []).append(v)
    assets = []
    for r in reviews:
        mine = by_asset.get(uuid.UUID(r["asset_id"]), [])
        current = next((v for v in mine if str(v.id) == r.get("version_id")), None)
        if current is None:
            continue
        assets.append({"review_state": r["review_state"], "latest_is_agent": current.kind == "agent",
                       "agent_versions": sum(v.kind == "agent" for v in mine), "latest_at": current.created_at})
    return review_phase(assets)
