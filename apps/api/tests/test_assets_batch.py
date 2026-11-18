"""`GET /assets/batch` is what the uploads panel polls with (#524).

The panel used to send one `GET /assets/{id}` per processing or interrupted
row every five seconds, 12 reads a minute per row against a read limit of 600
a minute per user, so about fifty rows left processing spent the whole budget
on the poll alone. One request now answers for up to 100 assets.

An id the caller would get a 403 or 404 for from `GET /assets/{id}` (trashed,
in a trashed project, never theirs) is left out of the answer rather than
failing the request, so one gone asset cannot cost the other rows their
answers. The panel reads an absent id the way it read a 403 or 404.
"""
import uuid
from datetime import datetime, timezone


def _seed(real_db):
    """The caller's project, and a stranger's project the caller is not in."""
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType, ProjectMember, ProjectRole

    caller = User(email=f"batch-a-{uuid.uuid4()}@t.local", name="caller")
    stranger = User(email=f"batch-b-{uuid.uuid4()}@t.local", name="stranger")
    real_db.add_all([caller, stranger]); real_db.flush()

    mine = Project(name="mine", project_type=ProjectType.personal, created_by=caller.id)
    theirs = Project(name="theirs", project_type=ProjectType.personal, created_by=stranger.id)
    real_db.add_all([mine, theirs]); real_db.flush()
    real_db.add_all([
        ProjectMember(project_id=mine.id, user_id=caller.id, role=ProjectRole.owner),
        ProjectMember(project_id=theirs.id, user_id=stranger.id, role=ProjectRole.owner),
    ])
    real_db.flush()
    return caller, stranger, mine, theirs


def _asset(real_db, project, owner, name, status="processing", **over):
    from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus

    a = Asset(project_id=project.id, name=name, asset_type=AssetType.video,
              created_by=owner.id, **over)
    real_db.add(a); real_db.flush()
    v = AssetVersion(asset_id=a.id, version_number=1,
                     processing_status=ProcessingStatus(status), created_by=owner.id)
    real_db.add(v); real_db.flush()
    return a, v


def _batch(real_db, user, ids):
    from apps.api.routers.assets import get_assets_batch
    return get_assets_batch(ids=ids, db=real_db, current_user=user)


def test_answers_for_every_asset_asked_about_in_one_call(real_db):
    caller, _stranger, mine, _theirs = _seed(real_db)
    a, va = _asset(real_db, mine, caller, "a", "processing")
    b, vb = _asset(real_db, mine, caller, "b", "ready")

    rows = _batch(real_db, caller, [a.id, b.id])

    by_id = {r.id: r for r in rows}
    assert set(by_id) == {a.id, b.id}
    # The same payload `GET /assets/{id}` gives, which the poll reads the
    # version id and processing status from.
    assert by_id[a.id].latest_version.id == va.id
    assert by_id[a.id].latest_version.processing_status.value == "processing"
    assert by_id[b.id].latest_version.id == vb.id
    assert by_id[b.id].latest_version.processing_status.value == "ready"


def test_answers_once_for_an_id_asked_twice(real_db):
    caller, _stranger, mine, _theirs = _seed(real_db)
    a, _ = _asset(real_db, mine, caller, "a")

    rows = _batch(real_db, caller, [a.id, a.id])

    assert [r.id for r in rows] == [a.id]


def test_leaves_out_what_get_asset_would_refuse(real_db):
    """Trashed, in a trashed project, someone else's, or not there at all."""
    caller, stranger, mine, theirs = _seed(real_db)
    now = datetime.now(timezone.utc)
    live, _ = _asset(real_db, mine, caller, "live")
    trashed, _ = _asset(real_db, mine, caller, "trashed", deleted_at=now)
    not_mine, _ = _asset(real_db, theirs, stranger, "not-mine")

    from apps.api.models.project import Project
    doomed = Project(name="doomed", project_type=mine.project_type, created_by=caller.id)
    real_db.add(doomed); real_db.flush()
    in_trashed_project, _ = _asset(real_db, doomed, caller, "in-trashed-project")
    doomed.deleted_at = now
    real_db.flush()

    rows = _batch(real_db, caller, [
        live.id, trashed.id, not_mine.id, in_trashed_project.id, uuid.uuid4(),
    ])

    assert [r.id for r in rows] == [live.id]


def test_route_is_not_taken_for_an_asset_id(client, mock_db, auth_headers):
    """Declared after `/assets/{asset_id}`, "batch" is parsed as an asset id and 422s."""
    mock_db.all.return_value = []

    resp = client.get(f"/assets/batch?ids={uuid.uuid4()}", headers=auth_headers)

    assert resp.status_code == 200, resp.text
    assert resp.json() == []


def test_refuses_more_than_100_ids(client, mock_db, auth_headers):
    mock_db.all.return_value = []
    many = "&".join(f"ids={uuid.uuid4()}" for _ in range(101))

    assert client.get(f"/assets/batch?{many}", headers=auth_headers).status_code == 422
    hundred = "&".join(f"ids={uuid.uuid4()}" for _ in range(100))
    assert client.get(f"/assets/batch?{hundred}", headers=auth_headers).status_code == 200


def test_needs_at_least_one_id(client, mock_db, auth_headers):
    assert client.get("/assets/batch", headers=auth_headers).status_code == 422
