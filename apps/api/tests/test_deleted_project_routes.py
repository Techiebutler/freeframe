"""A deleted project is gone for the people who were in it.

Deleting a project only sets `Project.deleted_at`, and there is no route that
undoes it. `GET /projects/{id}`, the project list and the member list already
answered 404 for it, but every other signed-in route checked membership alone,
so members could keep listing its assets and folders, editing, approving,
uploading new versions, minting and managing share links, and changing its
branding, metadata and collections until the retention purge.

Guarded here, each route against a real Postgres through the real app, first on
the live project (so the request is known to be one the route accepts) and then
once the project is deleted:
  * `require_project_role` answers 404 "Project not found" for a deleted project,
    before the role check, and `get_project_member` finds no membership in one.
    Every project-, folder-, asset- and share-link-management route that checks
    a role goes through them;
  * `require_project_visible` does the same for the listings a public project
    also opens to non-members (assets, folders, folder tree);
  * routes a comment's author or an upload's starter reaches without a role
    check (editing, deleting a comment or its attachment; presigning, resuming
    and completing an upload) refuse with the same 404;
  * routes gated by `can_access_asset` keep its 403, pinned here so the table is
    complete.

Aborting an upload is left open on purpose: it is what the web client's Cancel
sends, and it disposes of the upload's bytes now. Refusing it too would only
leave them for the reaper. It never promotes an upload in a deleted project,
even one whose object is already assembled: that is recorded failed.

`/me/notifications` leaves out notifications about a deleted project's assets
(and a trashed asset's), since each names the asset and quotes the comment.
"""
import uuid
from datetime import datetime, timezone

import pytest

from apps.api.tests.test_share_links_trashed_content import (  # noqa: F401  (fixtures)
    _auth, _seed, _trash_project, client, db,
)

GONE = (404, {"detail": "Project not found"})
NO_ACCESS = (403, {"detail": "Access denied"})


class StorageReached(Exception):
    """Raised by the storage stubs: the request got past every guard."""


def _seed_more(db, w):
    """What the routes below act on, beyond the share-link world."""
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, MediaFile, FileType, ProcessingStatus,
    )
    from apps.api.models.branding import WatermarkSettings
    from apps.api.models.comment import Comment, CommentAttachment
    from apps.api.models.folder import Folder
    from apps.api.models.metadata import Collection, CollectionShare, FieldType, MetadataField
    from apps.api.models.share import AssetShare, SharePermission

    now = datetime.now(timezone.utc)
    w.v = w.versions[w.A.id]
    w.comment = Comment(asset_id=w.A.id, version_id=w.v.id, author_id=w.editor.id, body="note")
    db.add(w.comment); db.flush()
    w.attachment = CommentAttachment(comment_id=w.comment.id, file_type="image/png",
                                     s3_key=f"comment-attachments/{w.comment.id}/x.png",
                                     original_filename="x.png", file_size_bytes=10)
    w.field = MetadataField(project_id=w.project.id, name="Scene", field_type=FieldType.text)
    w.collection = Collection(project_id=w.project.id, name="Picks", filter_rules={},
                              created_by=w.owner.id)
    db.add_all([w.attachment, w.field, w.collection,
                WatermarkSettings(project_id=w.project.id, enabled=True)]); db.flush()
    w.collection_share = CollectionShare(collection_id=w.collection.id, token=uuid.uuid4().hex,
                                         created_by=w.owner.id)
    w.folder_share = AssetShare(folder_id=w.F.id, shared_with_user_id=w.direct.id,
                                permission=SharePermission.view, shared_by=w.owner.id)
    # A folder and an asset already in the project's trash, so restore has a target.
    w.T = Folder(project_id=w.project.id, name="T", created_by=w.owner.id, deleted_at=now)
    w.TA = Asset(project_id=w.project.id, name="TA", asset_type=AssetType.video,
                 created_by=w.owner.id, deleted_at=now)
    db.add_all([w.collection_share, w.folder_share, w.T, w.TA]); db.flush()
    db.add(AssetVersion(asset_id=w.TA.id, version_number=1, created_by=w.owner.id,
                        processing_status=ProcessingStatus.ready))
    # An upload the owner started on A and has not finished.
    w.upload = AssetVersion(asset_id=w.A.id, version_number=2, created_by=w.owner.id,
                            processing_status=ProcessingStatus.uploading, upload_id="up-1")
    db.add(w.upload); db.flush()
    w.upload_key = f"raw/{w.project.id}/{w.A.id}/{w.upload.id}/original.mov"
    db.add(MediaFile(version_id=w.upload.id, file_type=FileType.video,
                     original_filename="v2.mov", mime_type="video/quicktime",
                     file_size_bytes=1000, s3_key_raw=w.upload_key))
    db.flush()


def _upload_body(w, **extra):
    return {"s3_key": w.upload_key, "upload_id": "up-1", "version_id": str(w.upload.id), **extra}


def _new_version_body(w):
    return {"project_id": str(w.project.id), "asset_name": "A", "original_filename": "v3.mov",
            "mime_type": "video/quicktime", "file_size_bytes": 1000}


# (id, who, method, path, body, refused with). `path` and `body` take the world.
# `who` is the least role the route needs, or the comment's author.
ROUTES = [
    # project
    ("project", "viewer", "GET", lambda w: f"/projects/{w.project.id}", None, GONE),
    ("project-assets", "viewer", "GET", lambda w: f"/projects/{w.project.id}/assets", None, GONE),
    ("project-folders", "viewer", "GET", lambda w: f"/projects/{w.project.id}/folders", None, GONE),
    ("project-folder-tree", "viewer", "GET", lambda w: f"/projects/{w.project.id}/folder-tree", None, GONE),
    ("create-folder", "editor", "POST", lambda w: f"/projects/{w.project.id}/folders",
     lambda w: {"name": "New"}, GONE),
    ("bulk-move", "editor", "POST", lambda w: f"/projects/{w.project.id}/bulk-move",
     lambda w: {"asset_ids": [str(w.A.id)], "target_folder_id": str(w.F.id)}, GONE),
    ("project-trash", "editor", "GET", lambda w: f"/projects/{w.project.id}/trash", None, GONE),
    ("project-share-links", "viewer", "GET", lambda w: f"/projects/{w.project.id}/share-links", None, GONE),
    ("project-share", "editor", "POST", lambda w: f"/projects/{w.project.id}/share", lambda w: {}, GONE),
    ("project-share-multi", "editor", "POST", lambda w: f"/projects/{w.project.id}/share/multi",
     lambda w: {"asset_ids": [str(w.A.id)]}, GONE),
    ("project-share-user", "editor", "POST", lambda w: f"/projects/{w.project.id}/share/user",
     lambda w: {"user_id": str(w.direct.id)}, GONE),
    ("branding", "viewer", "GET", lambda w: f"/projects/{w.project.id}/branding", None, GONE),
    ("branding-put", "editor", "PUT", lambda w: f"/projects/{w.project.id}/branding",
     lambda w: {"primary_color": "#112233"}, GONE),
    ("branding-logo-upload", "editor", "POST",
     lambda w: f"/projects/{w.project.id}/branding/logo-upload", None, GONE),
    ("watermark", "viewer", "GET", lambda w: f"/projects/{w.project.id}/watermark", None, GONE),
    ("watermark-put", "editor", "PUT", lambda w: f"/projects/{w.project.id}/watermark",
     lambda w: {"enabled": True}, GONE),
    ("watermark-image-upload", "editor", "POST",
     lambda w: f"/projects/{w.project.id}/watermark/image-upload", None, GONE),
    ("metadata-fields", "viewer", "GET", lambda w: f"/projects/{w.project.id}/metadata-fields", None, GONE),
    ("metadata-field-create", "editor", "POST", lambda w: f"/projects/{w.project.id}/metadata-fields",
     lambda w: {"name": "Take", "field_type": "text"}, GONE),
    ("metadata-field-delete", "editor", "DELETE",
     lambda w: f"/projects/{w.project.id}/metadata-fields/{w.field.id}", None, GONE),
    ("collections", "viewer", "GET", lambda w: f"/projects/{w.project.id}/collections", None, GONE),
    ("collection-create", "editor", "POST", lambda w: f"/projects/{w.project.id}/collections",
     lambda w: {"name": "More"}, GONE),
    ("collection", "viewer", "GET",
     lambda w: f"/projects/{w.project.id}/collections/{w.collection.id}", None, GONE),
    ("collection-delete", "editor", "DELETE",
     lambda w: f"/projects/{w.project.id}/collections/{w.collection.id}", None, GONE),
    ("collection-share", "editor", "POST",
     lambda w: f"/projects/{w.project.id}/collections/{w.collection.id}/share", lambda w: {}, GONE),
    ("collection-shares", "viewer", "GET",
     lambda w: f"/projects/{w.project.id}/collections/{w.collection.id}/shares", None, GONE),
    ("collection-share-delete", "editor", "DELETE",
     lambda w: f"/projects/{w.project.id}/collections/{w.collection.id}/share/{w.collection_share.id}",
     None, GONE),
    ("upload-initiate", "editor", "POST", lambda w: "/upload/initiate", _new_version_body, GONE),
    # folder
    ("folder-rename", "editor", "PATCH", lambda w: f"/folders/{w.F.id}", lambda w: {"name": "F2"}, GONE),
    ("folder-delete", "editor", "DELETE", lambda w: f"/folders/{w.F.id}", None, GONE),
    ("folder-restore", "editor", "POST", lambda w: f"/folders/{w.T.id}/restore", None, GONE),
    ("folder-share", "editor", "POST", lambda w: f"/folders/{w.F.id}/share", lambda w: {}, GONE),
    ("folder-shares", "viewer", "GET", lambda w: f"/folders/{w.F.id}/shares", None, GONE),
    ("folder-share-user", "editor", "POST", lambda w: f"/folders/{w.F.id}/share/user",
     lambda w: {"user_id": str(w.viewer.id)}, GONE),
    ("folder-share-team", "editor", "POST", lambda w: f"/folders/{w.F.id}/share/team",
     lambda w: {"team_id": str(uuid.uuid4())}, GONE),
    ("folder-direct-shares", "viewer", "GET", lambda w: f"/folders/{w.F.id}/direct-shares", None, GONE),
    ("folder-share-delete", "editor", "DELETE",
     lambda w: f"/folders/{w.F.id}/shares/{w.folder_share.id}", None, GONE),
    # asset
    ("asset", "viewer", "GET", lambda w: f"/assets/{w.A.id}", None, NO_ACCESS),
    ("asset-versions", "viewer", "GET", lambda w: f"/assets/{w.A.id}/versions", None, NO_ACCESS),
    ("asset-stream", "viewer", "GET", lambda w: f"/assets/{w.A.id}/stream", None, NO_ACCESS),
    ("asset-downloads", "viewer", "GET", lambda w: f"/assets/{w.A.id}/downloads", None, NO_ACCESS),
    ("asset-update", "editor", "PATCH", lambda w: f"/assets/{w.A.id}", lambda w: {"name": "A2"}, GONE),
    ("asset-delete", "editor", "DELETE", lambda w: f"/assets/{w.A.id}", None, GONE),
    ("asset-new-version", "editor", "POST", lambda w: f"/assets/{w.A.id}/versions", _new_version_body, GONE),
    ("asset-assignment-update", "editor", "PATCH", lambda w: f"/assets/{w.A.id}/assignment",
     lambda w: {"due_date": None}, GONE),
    ("asset-assignment", "viewer", "GET", lambda w: f"/assets/{w.A.id}/assignment", None, GONE),
    ("asset-move", "editor", "PATCH", lambda w: f"/assets/{w.A.id}/move",
     lambda w: {"folder_id": str(w.F.id)}, GONE),
    ("asset-restore", "editor", "POST", lambda w: f"/assets/{w.TA.id}/restore", None, GONE),
    ("asset-approve", "editor", "POST", lambda w: f"/assets/{w.A.id}/approve",
     lambda w: {"version_id": str(w.v.id)}, GONE),
    ("asset-reject", "editor", "POST", lambda w: f"/assets/{w.A.id}/reject",
     lambda w: {"version_id": str(w.v.id)}, GONE),
    ("asset-approvals", "viewer", "GET", lambda w: f"/assets/{w.A.id}/approvals", None, NO_ACCESS),
    ("asset-share", "editor", "POST", lambda w: f"/assets/{w.A.id}/share", lambda w: {}, GONE),
    ("asset-shares", "editor", "GET", lambda w: f"/assets/{w.A.id}/shares", None, GONE),
    ("asset-share-user", "editor", "POST", lambda w: f"/assets/{w.A.id}/share/user",
     lambda w: {"user_id": str(w.viewer.id)}, GONE),
    ("asset-share-team", "editor", "POST", lambda w: f"/assets/{w.A.id}/share/team",
     lambda w: {"team_id": str(uuid.uuid4())}, GONE),
    ("asset-direct-shares", "viewer", "GET", lambda w: f"/assets/{w.A.id}/direct-shares", None, GONE),
    ("asset-metadata", "viewer", "GET", lambda w: f"/assets/{w.A.id}/metadata", None, GONE),
    ("asset-metadata-put", "editor", "PUT", lambda w: f"/assets/{w.A.id}/metadata",
     lambda w: [{"field_id": str(w.field.id), "value": "12"}], GONE),
    ("asset-apply-watermark", "editor", "POST", lambda w: f"/assets/{w.A.id}/apply-watermark", None, GONE),
    ("asset-comments", "viewer", "GET", lambda w: f"/assets/{w.A.id}/comments", None, NO_ACCESS),
    ("asset-comment-create", "viewer", "POST", lambda w: f"/assets/{w.A.id}/comments",
     lambda w: {"version_id": str(w.v.id), "body": "hi"}, NO_ACCESS),
    ("asset-comment-reply", "viewer", "POST",
     lambda w: f"/assets/{w.A.id}/comments/{w.comment.id}/replies", lambda w: {"version_id": str(w.v.id), "body": "re"},
     NO_ACCESS),
    ("asset-comment-link", "viewer", "GET",
     lambda w: f"/assets/{w.A.id}/comments/{w.comment.id}/link", None, NO_ACCESS),
    ("asset-comments-export", "viewer", "GET",
     lambda w: f"/assets/{w.A.id}/comments/export?format=csv", None, NO_ACCESS),
    # comment
    ("comment-edit-author", "editor", "PATCH", lambda w: f"/comments/{w.comment.id}",
     lambda w: {"body": "edited"}, GONE),
    ("comment-edit-owner", "owner", "PATCH", lambda w: f"/comments/{w.comment.id}",
     lambda w: {"body": "edited"}, GONE),
    ("comment-delete-author", "editor", "DELETE", lambda w: f"/comments/{w.comment.id}", None, GONE),
    ("comment-delete-owner", "owner", "DELETE", lambda w: f"/comments/{w.comment.id}", None, GONE),
    ("comment-resolve", "viewer", "POST", lambda w: f"/comments/{w.comment.id}/resolve", None, NO_ACCESS),
    ("comment-attachment-create", "editor", "POST", lambda w: f"/comments/{w.comment.id}/attachments",
     lambda w: {"file_name": "y.png", "file_size": 10, "content_type": "image/png"}, NO_ACCESS),
    ("comment-attachment-delete-author", "editor", "DELETE",
     lambda w: f"/comments/{w.comment.id}/attachments/{w.attachment.id}", None, GONE),
    ("comment-attachment-delete-owner", "owner", "DELETE",
     lambda w: f"/comments/{w.comment.id}/attachments/{w.attachment.id}", None, GONE),
    ("comment-react", "viewer", "POST", lambda w: f"/comments/{w.comment.id}/react",
     lambda w: {"emoji": "+1"}, NO_ACCESS),
    ("comment-reactions", "viewer", "GET", lambda w: f"/comments/{w.comment.id}/reactions", None, NO_ACCESS),
    # upload (the owner started it)
    ("upload-presign-part", "owner", "POST", lambda w: "/upload/presign-part",
     lambda w: _upload_body(w, part_number=1), GONE),
    ("upload-parts", "owner", "GET", lambda w: f"/upload/{w.upload.id}/parts", None, GONE),
    ("upload-complete", "owner", "POST", lambda w: "/upload/complete",
     lambda w: _upload_body(w, asset_id=str(w.A.id)), GONE),
]

# Share-link management, for each kind of link a project holds.
for _kind in ("asset", "folder", "project", "multi"):
    ROUTES += [
        (f"link-details-{_kind}", "viewer", "GET",
         lambda w, k=_kind: f"/share/{w.links[k].token}/details", None, GONE),
        (f"link-update-{_kind}", "editor", "PATCH",
         lambda w, k=_kind: f"/share/{w.links[k].token}", lambda w: {"title": "Renamed"}, GONE),
        (f"link-revoke-{_kind}", "editor", "DELETE",
         lambda w, k=_kind: f"/share/{w.links[k].token}", None, GONE),
        (f"link-activity-{_kind}", "viewer", "GET",
         lambda w, k=_kind: f"/share/{w.links[k].token}/activity", None, GONE),
        (f"link-add-asset-{_kind}", "editor", "POST",
         lambda w, k=_kind: f"/share/{w.links[k].token}/add-asset/{w.AS.id}", None, GONE),
    ]


@pytest.fixture
def storage(monkeypatch):
    """Storage stubs for the upload routes. Each records its name and raises, so a
    request that got past every guard shows up in the list (and answers 500)."""
    import apps.api.routers.assets as assets_module
    import apps.api.routers.upload as upload_module

    reached = []

    def stub(name):
        def call(*a, **k):
            reached.append(name)
            raise StorageReached(name)
        return call

    for name in ("presign_upload_part", "list_upload_parts", "complete_multipart_upload",
                 "abort_multipart_upload", "head_object_size"):
        monkeypatch.setattr(upload_module, name, stub(name))
    for module in (assets_module, upload_module):
        monkeypatch.setattr(module, "create_multipart_upload", lambda key, mime: "up-new")
    return reached


def _request(client, w, who, method, path, body):
    return client.request(method, path(w), json=body(w) if body else None,
                          headers=_auth(getattr(w, who)))


@pytest.mark.parametrize("name,who,method,path,body,refused",
                         ROUTES, ids=[r[0] for r in ROUTES])
def test_the_route_works_on_the_live_project(client, db, storage, name, who, method, path, body, refused):
    """The control: the same request is one the route accepts while the project is live."""
    w = _seed(db)
    _seed_more(db, w)
    r = _request(client, w, who, method, path, body)
    assert r.status_code < 300 or storage, (name, r.status_code, r.text)


@pytest.mark.parametrize("name,who,method,path,body,refused",
                         ROUTES, ids=[r[0] for r in ROUTES])
def test_the_route_is_refused_once_the_project_is_deleted(client, db, storage, name, who, method, path, body, refused):
    w = _seed(db)
    _seed_more(db, w)
    _trash_project(client, db, w)
    r = _request(client, w, who, method, path, body)
    assert (r.status_code, r.json()) == refused, (name, r.status_code, r.text)
    assert storage == [], name


def test_an_unknown_project_answers_like_a_deleted_one(client, db):
    """A 404 for a deleted project says nothing an unknown id does not."""
    w = _seed(db)
    unknown = uuid.uuid4()
    for path in (f"/projects/{unknown}", f"/projects/{unknown}/assets",
                 f"/projects/{unknown}/folders", f"/projects/{unknown}/share-links"):
        r = client.get(path, headers=_auth(w.viewer))
        assert (r.status_code, r.json()) == GONE, path


def test_a_live_project_still_refuses_a_non_member(client, db):
    w = _seed(db)
    for path in (f"/projects/{w.project.id}/assets", f"/projects/{w.project.id}/share-links"):
        r = client.get(path, headers=_auth(w.creator))
        assert (r.status_code, r.json()) == (403, {"detail": "Not a project member"}), path


def test_a_public_projects_listings_close_with_it(client, db):
    w = _seed(db)
    w.project.is_public = True
    db.flush()
    paths = [f"/projects/{w.project.id}/{p}" for p in ("assets", "folders", "folder-tree")]
    for path in paths:
        assert client.get(path, headers=_auth(w.creator)).status_code == 200, path
    _trash_project(client, db, w)
    for path in paths:
        r = client.get(path, headers=_auth(w.creator))
        assert (r.status_code, r.json()) == GONE, path


def test_get_project_member_finds_no_membership_in_a_deleted_project(client, db):
    from apps.api.services.permissions import get_project_member
    w = _seed(db)
    assert get_project_member(db, w.project.id, w.viewer.id) is not None
    _trash_project(client, db, w)
    assert get_project_member(db, w.project.id, w.viewer.id) is None


def test_aborting_an_upload_into_a_deleted_project_still_resolves_it(client, db, monkeypatch):
    """The one upload route left open, so a cancelled upload is still resolved
    instead of sitting at `uploading` until the reaper."""
    import apps.api.routers.upload as upload_module
    from apps.api.models.asset import ProcessingStatus

    aborted = []
    monkeypatch.setattr(upload_module, "abort_multipart_upload", lambda key, uid: aborted.append(uid))
    monkeypatch.setattr(upload_module, "head_object_size", lambda key: 0)
    w = _seed(db)
    _seed_more(db, w)
    _trash_project(client, db, w)
    r = client.post("/upload/abort", json=_upload_body(w), headers=_auth(w.owner))
    assert r.status_code == 204, r.text
    assert aborted == ["up-1"]
    db.expire_all()
    assert w.upload.processing_status == ProcessingStatus.failed


def _abort_assembled(client, db, monkeypatch, trash):
    """Abort an upload whose object storage already holds at full size: the
    CompleteMultipartUpload succeeded but its status was never saved."""
    import apps.api.routers.upload as upload_module

    triggered = []
    monkeypatch.setattr(upload_module, "abort_multipart_upload", lambda key, uid: None)
    monkeypatch.setattr(upload_module, "head_object_size", lambda key: 1000)
    monkeypatch.setattr(upload_module, "_trigger_processing",
                        lambda asset_id, version_id: triggered.append(version_id))
    w = _seed(db)
    _seed_more(db, w)
    if trash:
        _trash_project(client, db, w)
    r = client.post("/upload/abort", json=_upload_body(w), headers=_auth(w.owner))
    assert r.status_code == 204, r.text
    db.expire_all()
    return w, triggered


def test_aborting_an_assembled_upload_promotes_it_in_a_live_project(client, db, monkeypatch):
    """The control: an assembled object is recorded as processing and transcoded."""
    from apps.api.models.asset import ProcessingStatus
    w, triggered = _abort_assembled(client, db, monkeypatch, trash=False)
    assert w.upload.processing_status == ProcessingStatus.processing
    assert triggered == [w.upload.id]


def test_aborting_an_assembled_upload_never_promotes_it_into_a_deleted_project(client, db, monkeypatch):
    """/upload/complete refuses a deleted project's upload, so abort must not
    publish the same object by the back door: it is recorded failed, for the
    project's purge, and nothing is transcoded."""
    from apps.api.models.asset import ProcessingStatus
    w, triggered = _abort_assembled(client, db, monkeypatch, trash=True)
    assert w.upload.processing_status == ProcessingStatus.failed
    assert triggered == []


def _notify_everyone(db, w):
    """A comment notification on asset A for each person who could see it."""
    from apps.api.models.activity import Notification, NotificationType
    from apps.api.models.comment import Comment

    comment = Comment(asset_id=w.A.id, version_id=w.versions[w.A.id].id,
                      author_id=w.owner.id, body="secret-note")
    db.add(comment); db.flush()
    people = (w.editor, w.viewer, w.direct, w.creator)
    for u in people:
        db.add(Notification(user_id=u.id, type=NotificationType.comment,
                            asset_id=w.A.id, comment_id=comment.id))
    db.flush()
    return people


def _notified_about(client, user, asset):
    r = client.get("/me/notifications", headers=_auth(user))
    assert r.status_code == 200, r.text
    return [n for n in r.json() if n["asset_id"] == str(asset.id)]


def test_notifications_about_a_deleted_project_are_left_out(client, db):
    """Each notification names its asset and quotes its comment, so it goes with
    the project: shown while the project is live, gone once it is deleted."""
    w = _seed(db)
    people = _notify_everyone(db, w)
    for u in people:
        shown = _notified_about(client, u, w.A)
        assert len(shown) == 1, u.name
        assert (shown[0]["asset_name"], shown[0]["comment_preview"]) == ("A", "secret-note")
    _trash_project(client, db, w)
    for u in people:
        assert _notified_about(client, u, w.A) == [], u.name
        assert client.get("/me/notifications?unread_only=true",
                          headers=_auth(u)).json() == [], u.name


def test_notifications_about_a_trashed_asset_come_back_with_it(client, db):
    w = _seed(db)
    _notify_everyone(db, w)
    assert len(_notified_about(client, w.viewer, w.A)) == 1
    assert client.delete(f"/assets/{w.A.id}", headers=_auth(w.owner)).status_code == 204
    db.expire_all()
    assert _notified_about(client, w.viewer, w.A) == []
    assert client.post(f"/assets/{w.A.id}/restore", headers=_auth(w.owner)).status_code == 200
    db.expire_all()
    assert len(_notified_about(client, w.viewer, w.A)) == 1
