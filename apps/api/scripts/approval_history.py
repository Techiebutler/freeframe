"""Read-only: per asset of the given requests, every approval (with version, status, deleted_at) and the approve activity.
Answers "I approved it, why does Gen not count it?" (approval on an older version, or voided by a later round).

Usage (inside the api container):
    python -m apps.api.scripts.approval_history e68185cd b13cdffc   # request id prefixes
"""
import sys, os
sys.path.insert(0, os.getcwd())
from sqlalchemy import cast, String
from apps.api.database import SessionLocal
from apps.api.models.upload_request import UploadRequest
from apps.api.models.asset import Asset, AssetVersion
from apps.api.models.approval import Approval
from apps.api.models.activity import ActivityLog
db = SessionLocal()
for pre in sys.argv[1:]:
    q = db.query(UploadRequest).filter(cast(UploadRequest.id, String).like(pre + "%")).first()
    if not q: print(pre, "no request"); continue
    assets = db.query(Asset).filter(Asset.folder_id == q.folder_id, Asset.deleted_at.is_(None)).all()
    print("REQ", pre, (q.title or "")[:40], "assets", len(assets))
    for a in assets:
        vs = {v.id: v.version_number for v in db.query(AssetVersion).filter(AssetVersion.asset_id == a.id, AssetVersion.deleted_at.is_(None))}
        cur = max(vs.values()) if vs else None
        aps = db.query(Approval).filter(Approval.asset_id == a.id).order_by(Approval.created_at).all()
        acts = db.query(ActivityLog).filter(ActivityLog.asset_id == a.id, ActivityLog.action.ilike("%approv%")).order_by(ActivityLog.created_at).all()
        print(" A", a.name[:28], "cur v%s" % cur, "| approvals:", [("v%s" % vs.get(x.version_id, "?"), x.status.value, x.created_at.strftime("%m-%d %H:%M"), "DEL " + x.deleted_at.strftime("%m-%d %H:%M") if x.deleted_at else "") for x in aps],
              "| acts:", [(x.action, x.created_at.strftime("%m-%d %H:%M")) for x in acts][-6:])
