"""Share-link guest identity: one typed email is one guest, on every route.

`services.guests` is the only place a typed email and name become a GuestUser.
Guest comments and share verdicts used to each carry their own copy, and the
copies already disagreed (one trimmed the name, the other did not). Since the
email decides whose verdict a guest may change or clear, a drift there would
make one person two guests.

Real Postgres through the real app, on the share-link world from
`test_share_links_trashed_content`.
"""
from unittest.mock import MagicMock

import pytest

from apps.api.tests.test_share_links_trashed_content import (  # noqa: F401  (fixtures)
    _seed, client, db,
)

from apps.api.models.comment import Comment
from apps.api.models.share import SharePermission
from apps.api.models.user import GuestUser
from apps.api.services.guests import find_guest, normalize_guest_email, resolve_guest


@pytest.fixture(autouse=True)
def _no_broker(monkeypatch):
    monkeypatch.setattr("apps.api.services.verdicts.send_task_safe", MagicMock())


def _guests(db, email):
    return db.query(GuestUser).filter(GuestUser.email == email).all()


def test_the_email_is_trimmed_and_lowercased():
    assert normalize_guest_email("  Dana@Client.TEST ") == "dana@client.test"
    assert normalize_guest_email("   ") == ""
    assert normalize_guest_email(None) == ""


def test_resolve_creates_once_and_finds_after(db):
    first = resolve_guest(db, " Dana@Client.test ", "  Dana  ")
    assert (first.email, first.name) == ("dana@client.test", "Dana")

    # Any spelling of the same email is the same guest, and keeps the first name.
    again = resolve_guest(db, "DANA@client.TEST", "Someone else")
    assert again.id == first.id and again.name == "Dana"
    assert find_guest(db, "  dana@CLIENT.test").id == first.id
    assert len(_guests(db, "dana@client.test")) == 1


@pytest.mark.parametrize("email,name", [
    ("dana@client.test", None), ("dana@client.test", ""), ("dana@client.test", "   "),
    (None, "Dana"), ("", "Dana"), ("   ", "Dana"),
])
def test_a_blank_email_or_name_resolves_to_nobody(db, email, name):
    assert resolve_guest(db, email, name) is None
    assert _guests(db, "dana@client.test") == []


def test_find_never_creates(db):
    assert find_guest(db, "nobody@client.test") is None
    assert find_guest(db, "") is None
    assert _guests(db, "nobody@client.test") == []


def _comment(client, link, **guest):
    return client.post(f"/share/{link.token}/comment", json={"body": "hello", **guest})


def test_a_guest_comment_with_a_blank_name_is_refused(client, db):
    w = _seed(db)
    link = w.links["asset"]

    r = _comment(client, link, guest_name="   ", guest_email="dana@client.test")
    assert (r.status_code, r.json()) == (
        400, {"detail": "guest_email and guest_name required for anonymous comments"})
    assert db.query(Comment).filter(Comment.asset_id == w.A.id).count() == 0
    assert _guests(db, "dana@client.test") == []


def test_a_comment_and_a_verdict_from_one_email_are_one_guest(client, db):
    w = _seed(db)
    link = w.links["asset"]
    link.permission = SharePermission.approve
    link.show_versions = True
    db.flush()

    r = _comment(client, link, guest_name=" Dana ", guest_email=" Dana@Client.test ")
    assert r.status_code == 201, r.text
    r = client.put(f"/share/{link.token}/verdict", json={
        "version_id": str(w.versions[w.A.id].id), "status": "approved",
        "guest_name": "Dana", "guest_email": "dana@CLIENT.test",
    })
    assert r.status_code == 200, r.text

    [guest] = _guests(db, "dana@client.test")
    assert guest.name == "Dana"
    [comment] = db.query(Comment).filter(Comment.asset_id == w.A.id).all()
    assert comment.guest_author_id == guest.id
