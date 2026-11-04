"""Listing an asset's deleted versions, for the switcher's restore (#419).

`GET /assets/{asset_id}/deleted-versions` answers editors and above with the
versions `POST .../restore` would still take back: deleted on their own, ran
(processing or ready), not yet purged. Guarded here against a real
Postgres through the real app:
  * only editors and owners get it; reviewers, viewers, outsiders get 403;
  * a discarded upload, a failed version, a live version and another asset's
    version never appear, and the list is newest first;
  * each row says until when it can be restored, from the retention window;
  * no other read path hands a deleted version out, an `include_deleted` flag
    on the live version list or the share list included.
"""
from datetime import datetime, timedelta, timezone

import pytest

from apps.api.tests.test_share_links_trashed_content import _auth, client, db  # noqa: F401  (fixtures)
from apps.api.tests.test_delete_a_version import _delete, _restore, w  # noqa: F401  (fixture)
import apps.api.tasks.cleanup_tasks as cleanup


def _listed(client, w, user=None, asset=None):
    asset = asset or w.A
    return client.get(f"/assets/{asset.id}/deleted-versions", headers=_auth(user or w.editor))


@pytest.mark.parametrize("role", ["editor", "owner"])
def test_an_editor_or_owner_sees_the_deleted_version_and_its_deadline(client, db, w, monkeypatch, role):
    monkeypatch.setattr(cleanup.settings, "soft_delete_retention_days", 30)
    assert _delete(client, w, w.v2).status_code == 200
    db.expire_all()
    deleted_at = db.get(type(w.v2), w.v2.id).deleted_at

    r = _listed(client, w, user=getattr(w, role))

    assert r.status_code == 200, r.text
    rows = r.json()
    assert [(x["id"], x["version_number"], x["processing_status"]) for x in rows] == [
        (str(w.v2.id), 2, "ready")]
    until = datetime.fromisoformat(rows[0]["restorable_until"])
    assert until == deleted_at + timedelta(days=30)


def test_no_deadline_while_the_purge_is_switched_off(client, w, monkeypatch):
    monkeypatch.setattr(cleanup.settings, "soft_delete_retention_days", 0)
    assert _delete(client, w, w.v2).status_code == 200

    assert _listed(client, w).json()[0]["restorable_until"] is None


@pytest.mark.parametrize("role", ["reviewer", "viewer", "outsider"])
def test_nobody_below_editor_may_list_deleted_versions(client, w, role):
    assert _delete(client, w, w.v2).status_code == 200

    r = _listed(client, w, user=getattr(w, role))

    assert r.status_code == 403, r.text


def test_only_restorable_versions_of_this_asset_are_listed(client, db, w):
    """Processing and ready, deleted, of this asset. A discarded upload and a
    failed version (the reaper soft-deletes those on its own) stay out."""
    from apps.api.models.asset import AssetVersion, ProcessingStatus

    def row(asset, number, st):
        v = AssetVersion(asset_id=asset.id, version_number=number, created_by=w.owner.id,
                         processing_status=st, deleted_at=datetime.now(timezone.utc))
        db.add(v); db.flush()
        return v

    row(w.A, 3, ProcessingStatus.uploading)
    row(w.A, 4, ProcessingStatus.failed)
    processing = row(w.A, 5, ProcessingStatus.processing)
    row(w.B, 2, ProcessingStatus.ready)

    rows = _listed(client, w).json()

    assert [(x["id"], x["processing_status"]) for x in rows] == [(str(processing.id), "processing")], (
        "live v1/v2, the discard, the failed one and B's row stay out")


def test_the_list_is_newest_first(client, db, w):
    from apps.api.models.asset import AssetVersion, ProcessingStatus

    v3 = AssetVersion(asset_id=w.A.id, version_number=3, created_by=w.owner.id,
                      processing_status=ProcessingStatus.ready)
    db.add(v3); db.flush()
    assert _delete(client, w, w.v1).status_code == 200
    assert _delete(client, w, w.v2).status_code == 200

    assert [x["version_number"] for x in _listed(client, w).json()] == [2, 1]


def test_a_restored_version_leaves_the_list(client, w):
    assert _delete(client, w, w.v2).status_code == 200
    assert [x["id"] for x in _listed(client, w).json()] == [str(w.v2.id)]

    assert _restore(client, w, w.v2).status_code == 200

    assert _listed(client, w).json() == []


def test_a_purged_version_leaves_the_list(client, db, w, monkeypatch):
    for name in ("delete_object", "delete_prefix", "abort_multipart_upload"):
        monkeypatch.setattr(cleanup, name, lambda *_: None)
    monkeypatch.setattr(cleanup.settings, "soft_delete_retention_days", 30)
    assert _delete(client, w, w.v2).status_code == 200
    w.v2.deleted_at = datetime.now(timezone.utc) - timedelta(days=31)
    db.flush()
    cleanup._purge_soft_deleted(db, cleanup.PurgeCounts())
    db.flush()

    assert _listed(client, w).json() == []


def test_a_trashed_asset_has_no_list(client, w):
    assert _delete(client, w, w.v2).status_code == 200
    assert client.delete(f"/assets/{w.A.id}", headers=_auth(w.editor)).status_code == 204

    assert _listed(client, w).status_code == 404


def test_no_viewer_or_share_path_hands_out_a_deleted_version(client, w):
    """An `include_deleted` flag is not a thing anywhere else: it is ignored."""
    assert _delete(client, w, w.v2).status_code == 200
    gone = str(w.v2.id)
    viewer = _auth(w.viewer)

    for path in (f"/assets/{w.A.id}/versions", f"/assets/{w.A.id}/versions?include_deleted=true"):
        r = client.get(path, headers=viewer)
        assert r.status_code == 200 and gone not in r.text, path
    r = client.get(f"/assets/{w.A.id}/versions?include_deleted=true", headers=_auth(w.editor))
    assert gone not in r.text, "the live list carries no deleted version, not even for an editor"
    for link in (w.latest_only, w.all_versions):
        for path in (f"/share/{link.token}/assets/{w.A.id}/versions",
                     f"/share/{link.token}/assets/{w.A.id}/versions?include_deleted=true",
                     f"/share/{link.token}/stream/{w.A.id}?version_id={gone}"):
            r = client.get(path)
            assert r.status_code == 200 and gone not in r.text, path
