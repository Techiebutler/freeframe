"""Embed round close: `left` (iframe removed), `all_reviewed` (every part commented or approved), and the notes count."""
from .agent_pg import env, needs_pg  # noqa: F401
from .test_feedback_rounds import comment, rounds, scene  # noqa: F401
from .test_share_approve import link

pytestmark = needs_pg


def done(e, kind="comment", by=None, asset=None):
    tok = link(e, e.scene.req.folder_id, kind)
    a = asset or e.scene.asset
    return e.client.post(f"/share/{tok}/assets/{a.id}/feedback-done" + (f"?by={by}" if by else "")), tok


def test_left_closes_a_round_that_has_a_comment(scene):
    e = scene
    comment(e, e.scene.asset)
    r, _ = done(e, by="left")
    assert r.status_code == 204
    [rnd] = rounds(e)
    assert rnd.closed_by == "left" and rnd.closed_at is not None


def test_left_twice_is_a_no_op_and_keeps_the_first_close(scene):
    e = scene
    comment(e, e.scene.asset)
    done(e, by="left")
    first = rounds(e)[0].closed_at
    r, _ = done(e, by="left")
    assert r.status_code == 204 and len(rounds(e)) == 1 and rounds(e)[0].closed_at == first
    r, _ = done(e)  # a Send after it: still nothing to do
    assert r.status_code == 204 and rounds(e)[0].closed_by == "left"


def test_left_without_a_comment_closes_nothing(scene):
    e = scene
    r, _ = done(e, by="left")
    assert r.status_code == 204 and rounds(e) == []


def test_the_default_close_is_still_the_button_and_unknown_reasons_are_refused(scene):
    e = scene
    comment(e, e.scene.asset)
    r, _ = done(e, by="bogus")
    assert r.status_code == 422 and rounds(e)[0].closed_at is None
    done(e)
    assert rounds(e)[0].closed_by == "button"


def test_round_sync_counts_notes_and_closes_when_every_part_is_commented_or_approved(scene):
    e = scene
    b = e.asset(e.scene.req, "Hook 2")
    tok = link(e, e.scene.req.folder_id, "approve")
    sync = lambda a: e.client.post(f"/share/{tok}/assets/{a.id}/round-sync")
    assert sync(e.scene.asset).json() == {"notes": 0, "closed_by": None}
    comment(e, e.scene.asset)
    assert sync(e.scene.asset).json() == {"notes": 1, "closed_by": None}     # Hook 2 still unreviewed
    assert e.client.post(f"/share/{tok}/assets/{b.id}/approve", json={}).status_code == 200
    assert sync(b).json() == {"notes": 0, "closed_by": "all_reviewed"}      # commented + approved: round closed
    [rnd] = rounds(e)
    assert rnd.closed_by == "all_reviewed" and rnd.closed_at is not None
    assert sync(b).json() == {"notes": 0, "closed_by": None}                # repeat: nothing new


def test_round_sync_all_commented_closes_too_and_needs_a_comment_in_the_round(scene):
    e = scene
    b = e.asset(e.scene.req, "Hook 2")
    tok = link(e, e.scene.req.folder_id, "comment")
    comment(e, e.scene.asset)
    comment(e, b, "Cut the end")
    r = e.client.post(f"/share/{tok}/assets/{b.id}/round-sync")
    assert r.json() == {"notes": 0, "closed_by": "all_reviewed"}
    assert e.client.post(f"/share/{link(e, e.scene.req.folder_id, 'view')}/assets/{b.id}/round-sync").status_code == 403


def test_all_approved_without_any_comment_opens_and_closes_no_round(scene):
    e = scene
    tok = link(e, e.scene.req.folder_id, "approve")
    assert e.client.post(f"/share/{tok}/assets/{e.scene.asset.id}/approve", json={}).status_code == 200
    assert e.client.post(f"/share/{tok}/assets/{e.scene.asset.id}/round-sync").json() == {"notes": 0, "closed_by": None}
    assert rounds(e) == []


def test_round_sync_never_closes_a_round_of_a_single_part_request(scene):
    e = scene                                                                # one part: the reviewer sends or leaves, a note is not the end
    tok = link(e, e.scene.req.folder_id, "comment")
    comment(e, e.scene.asset)
    comment(e, e.scene.asset, "And the logo", 5.0)
    r = e.client.post(f"/share/{tok}/assets/{e.scene.asset.id}/round-sync")
    assert r.json() == {"notes": 2, "closed_by": None}
    [rnd] = rounds(e)
    assert rnd.closed_at is None


def test_folder_assets_report_the_open_round_notes_not_the_comment_total(scene):
    e = scene
    tok = link(e, e.scene.req.folder_id, "comment")
    get = lambda: e.client.get(f"/share/{tok}/assets?page=1&per_page=50&embed=true").json()
    assert get()["open_round_notes"] == 0                                    # no round yet
    comment(e, e.scene.asset)
    comment(e, e.scene.asset, "And the logo", 5.0)
    assert get()["open_round_notes"] == 2
    done(e)                                                                  # Send closes the round: the comments stay, the open count is 0
    out = get()
    assert out["open_round_notes"] == 0 and out["assets"][0]["comment_count"] == 2
