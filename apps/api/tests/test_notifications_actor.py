"""A notification names whoever caused it, guests included (#455).

`GET /me/notifications` resolved `actor_name` from `Comment.author_id` alone. A
comment left through a share link has no author account: it carries
`guest_author_id` instead, so the actor came back as None and the drawer read
"Someone mentioned you". The guest's name is now the actor, flagged with
`actor_is_guest` so a client can mark it as a guest.

Real database, through the real app: the guest comment is posted with
`POST /share/{token}/comment`, exactly as a link holder does.
"""
import uuid

from apps.api.tests.test_share_links_trashed_content import (  # noqa: F401  (fixtures)
    _auth, _seed, client, db,
)


def _notifications(client, user, asset):
    r = client.get("/me/notifications", headers=_auth(user))
    assert r.status_code == 200, r.text
    return [n for n in r.json() if n["asset_id"] == str(asset.id)]


def test_a_guest_mention_names_the_guest(client, db):
    w = _seed(db)
    r = client.post(f"/share/{w.links['asset'].token}/comment", json={
        "asset_id": str(w.A.id),
        "body": f"over to you @{w.editor.email}",
        "guest_email": f"jane-{uuid.uuid4().hex[:8]}@t.local",
        "guest_name": "Jane",
    })
    assert r.status_code == 201, r.text

    [n] = _notifications(client, w.editor, w.A)
    assert n["type"] == "mention"
    assert n["actor_name"] == "Jane"
    assert n["actor_is_guest"] is True


def test_a_guest_reply_names_the_guest(client, db):
    from apps.api.models.comment import Comment

    w = _seed(db)
    parent = Comment(asset_id=w.A.id, version_id=w.versions[w.A.id].id,
                     author_id=w.editor.id, body="thoughts?")
    db.add(parent); db.flush()
    r = client.post(f"/share/{w.links['asset'].token}/comment", json={
        "asset_id": str(w.A.id),
        "parent_id": str(parent.id),
        "body": "looks good",
        "guest_email": f"jane-{uuid.uuid4().hex[:8]}@t.local",
        "guest_name": "Jane",
    })
    assert r.status_code == 201, r.text

    [n] = _notifications(client, w.editor, w.A)
    assert n["type"] == "comment"
    assert n["actor_name"] == "Jane"
    assert n["actor_is_guest"] is True


def test_a_registered_author_is_not_a_guest(client, db):
    from apps.api.models.activity import Notification, NotificationType
    from apps.api.models.comment import Comment

    w = _seed(db)
    comment = Comment(asset_id=w.A.id, version_id=w.versions[w.A.id].id,
                      author_id=w.owner.id, body="note")
    db.add(comment); db.flush()
    db.add(Notification(user_id=w.editor.id, type=NotificationType.comment,
                        asset_id=w.A.id, comment_id=comment.id))
    db.flush()

    [n] = _notifications(client, w.editor, w.A)
    assert n["actor_name"] == "owner"
    assert n["actor_is_guest"] is False
