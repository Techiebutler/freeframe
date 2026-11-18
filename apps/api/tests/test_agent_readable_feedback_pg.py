"""Agent-readable feedback (spec 2026-11-18) against Postgres: dictations persisted and linked, frame_png of the exact
version, audio attachments, round hold-back while a frame renders, 90-day audio purge."""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from PIL import Image

from .agent_pg import env, needs_pg  # noqa: F401
from .test_feedback_rounds import BOF_MARKS, BOF_WORDS, T0

pytestmark = needs_pg
URL = lambda key, expires_in=0: f"https://s3/{key}"  # noqa: E731
SEND = "apps.api.tasks.celery_app.send_task_safe"


@pytest.fixture
def scene(env):
    agent = env.pair_agent(env.project_a)
    req = env.request(env.project_a, env.owner, "Hook tests")
    asset = env.asset(req, "Hook 1", versions=2, by=agent.who)
    env.scene = type("S", (), {"agent": agent, "req": req, "asset": asset})
    return env


def media(e, version, raw="raw/x.mp4"):
    from apps.api.models.asset import FileType, MediaFile
    with e.Session() as db:
        db.add(MediaFile(version_id=version.id, file_type=FileType.video, original_filename="x.mp4", mime_type="video/mp4",
                         file_size_bytes=1, s3_key_raw=raw, s3_key_processed=f"processed/{version.id}"))
        db.commit()


def dictation(did, segs=None):
    return {"id": str(did), "text": "Make this pop. as likeable as possible", "raw_text": "Make this pop. as likeable as possible", "lang": "de",
            "words": [{"w": w["w"], "start_s": w["start_s"], "end_s": w["end_s"]} for w in BOF_WORDS],
            "segments": segs or [{"text": "Make this pop.", "start_s": 0.2, "end_s": 1.2, "video_t": 4.0, "segment_index": 0},
                                 {"text": "as likeable as possible", "start_s": 6.1, "end_s": 7.6, "video_t": 7.7, "segment_index": 1}]}


def post(e, asset, text, t, version=None, **extra):
    body = {"version_id": str((version or asset.versions[-1]).id), "body": text, "timecode_start": t, **extra}
    r = e.client.post(f"/assets/{asset.id}/comments", json=body, headers=e.headers(e.owner))
    assert r.status_code == 201, r.text
    return r.json()["id"]


def close(e):
    return e.client.post(f"/requests/{e.scene.req.id}/feedback-rounds/close", json={"reason": "button"}, headers=e.headers(e.owner))


def v1(e):
    with patch("apps.api.services.s3_service.generate_presigned_get_url", side_effect=URL):
        r = close(e)
    assert r.status_code == 200, r.text
    return r.json()


def test_a_dictation_split_into_two_comments_is_one_dictation_in_the_round(scene):
    e, did = scene, uuid.uuid4()
    a = e.scene.asset
    c0 = post(e, a, "Make this pop.", 4.0, dictation=dictation(did), segment_index=0)
    c1 = post(e, a, "as likeable as possible", 12.4, dictation=dictation(did), segment_index=1,
              annotation={"drawing_data": {"format": "ink.v1", "mark_offset_ms": 6900, "marks": BOF_MARKS}})
    typed = post(e, a, "Louder music", 20.0)
    out = v1(e)
    by_id = {c["comment_id"]: c for c in out["files"][0]["comments"]}
    assert by_id[c0]["dictation_id"] == by_id[c1]["dictation_id"] == str(did) and by_id[typed]["dictation_id"] is None
    assert (by_id[c0]["segment_index"], by_id[c1]["segment_index"], by_id[typed]["segments"]) == (0, 1, [])
    seg = by_id[c1]["segments"]
    assert [(s["text"], s["video_t"], s["mark_ids"]) for s in seg] == [("as likeable as possible", 7.7, ["m0"])]
    assert by_id[c1]["drawing"]["drawing_data"]["marks"][0]["mark_id"] == "m0"   # the stroke the segment points at
    [d] = out["dictations"]
    assert d["dictation_id"] == str(did) and d["comment_ids"] == [c0, c1] and d["clock"] == "recording_s" and d["lang"] == "de"
    assert [(s["comment_id"], s["mark_ids"], s["video_t"]) for s in d["segments"]] == [(c0, [], 4.0), (c1, ["m0"], 7.7)]
    starts = [w["start_s"] for w in d["words"]]
    assert starts == sorted(starts) and d["words"][0] == {"w": "Make", "start_s": 0.2, "end_s": 0.5}
    with e.Session() as db:   # one row however many sentences sent it
        from apps.api.models.comment import CommentDictation
        assert db.query(CommentDictation).count() == 1


def test_a_round_without_speech_has_no_dictations_key_and_old_fields_stay(scene):
    e = scene
    post(e, e.scene.asset, "Typed", 1.0)
    out = v1(e)
    c = out["files"][0]["comments"][0]
    assert "dictations" not in out and c["dictation_id"] is None and c["text"] == "Typed" and c["attachments"] == [] and c["drawing"] is None


def test_the_audio_is_an_attachment_of_the_comment_with_its_duration_and_the_dictation_points_at_it(scene):
    e, did = scene, uuid.uuid4()
    a = e.scene.asset
    c0 = post(e, a, "Make this pop.", 4.0, dictation=dictation(did), segment_index=0, attachments_expected=1)
    spec = {"file_name": "dictation.webm", "file_size": 5000, "content_type": "audio/webm;codecs=opus", "kind": "dictation_audio", "duration_s": 7.6}
    with patch("apps.api.services.s3_service.generate_presigned_put_url", return_value="https://put"):
        r = e.client.post(f"/comments/{c0}/attachments", json=spec, headers=e.headers(e.owner))
    assert r.status_code == 201, r.text
    assert close(e).status_code == 409   # the announced audio is not in yet: the round waits
    with patch("apps.api.services.s3_service.head_object", return_value=(5000, "audio/webm")):
        assert e.client.post(f"/comments/{c0}/attachments/{r.json()['attachment_id']}/complete", headers=e.headers(e.owner)).status_code == 200
    out = v1(e)
    [att] = out["files"][0]["comments"][0]["attachments"]
    assert (att["kind"], att["content_type"], att["duration_s"], att["version_id"]) == ("dictation_audio", "audio/webm", 7.6, str(a.versions[-1].id))
    assert out["dictations"][0]["audio_attachment_id"] == att["attachment_id"]
    assert out["dictations"][0]["words"][-1]["end_s"] <= att["duration_s"]


def test_audio_needs_a_dictation_and_a_plain_comment_cannot_carry_it(scene):
    e = scene
    c = post(e, e.scene.asset, "Typed", 1.0)
    spec = {"file_name": "d.webm", "file_size": 10, "content_type": "audio/webm", "kind": "dictation_audio"}
    assert e.client.post(f"/comments/{c}/attachments", json=spec, headers=e.headers(e.owner)).status_code == 422
    assert e.client.post(f"/comments/{c}/attachments", json={**spec, "kind": "reference_image"}, headers=e.headers(e.owner)).status_code == 422


def test_the_human_comment_list_hides_agent_only_attachments(scene):
    e, did = scene, uuid.uuid4()
    a = e.scene.asset
    c = post(e, a, "Make this pop.", 4.0, dictation=dictation(did), segment_index=0)
    from apps.api.models.comment import CommentAttachment
    with e.Session() as db:
        for kind, name, ct in (("dictation_audio", "dictation.webm", "audio/webm"), ("frame_png", "frame-1.png", "image/png"), ("reference_image", "ref.png", "image/png")):
            db.add(CommentAttachment(comment_id=uuid.UUID(c), file_type=ct, s3_key=f"k/{name}", original_filename=name, file_size_bytes=1, uploaded_at=T0, kind=kind))
        db.commit()
    with patch("apps.api.services.s3_service.generate_presigned_get_url", side_effect=URL):
        shown = e.client.get(f"/assets/{a.id}/comments", headers=e.headers(e.owner)).json()
    assert [x["file_name"] for x in shown[0]["attachments"]] == ["ref.png"]


# ── Server-rendered frame ─────────────────────────────────────────────────────

DRAW = {"drawing_data": {"format": "ink.v1", "mark_offset_ms": 6900, "marks": BOF_MARKS}}


def render(e, cid, **kw):
    from apps.api.services import drawn_frame
    puts, asked = [], []

    def extract(key, t):
        asked.append((key, t))
        return Image.new("RGB", (90, 160), (30, 30, 30))
    with e.Session() as db:
        status = drawn_frame.render_comment(db, uuid.UUID(cid), extract=kw.get("extract", extract), put=lambda k, b: puts.append((k, len(b))))
    return status, puts, asked


def test_a_drawn_comment_is_rendered_from_the_exact_version_it_was_written_on(scene):
    e = scene
    a = e.scene.asset
    v1_, v2_ = a.versions
    media(e, v1_, raw="raw/v1.mp4")
    media(e, v2_, raw="raw/v2.mp4")
    with patch(SEND) as send:
        c = post(e, a, "Circle this", 12.4, version=v1_, annotation=DRAW)   # written on version 1, version 2 is the latest
        post(e, a, "No ink", 3.0, version=v1_)
    assert send.call_count == 1 and send.call_args.args[1] == c   # only drawings are queued
    status, puts, asked = render(e, c)
    assert status == "done" and asked == [("raw/v1.mp4", 7.67)]   # version 1's master at the MARK's time, not t_start 12.4 and not the latest version
    assert render(e, c)[0] == "skipped"   # re-running never doubles the picture
    out = v1(e)
    [cm] = [x for x in out["files"][0]["comments"] if x["comment_id"] == c]
    [png] = [x for x in cm["attachments"] if x["kind"] == "frame_png"]
    assert (png["content_type"], png["version_id"], png["t"], png["mark_ids"]) == ("image/png", str(v1_.id), 7.67, ["m0"])
    assert (png["width"], png["height"]) == (90, 160) and png["file_name"] == "frame-7.670.png"
    assert out["files"][0]["version_id"] == png["version_id"] == str(v1_.id)
    assert cm["drawing"]["frame_url"] == png["url"] and cm["drawing"]["frame_source"] == "server" and cm["drawing"]["frame_status"] == "ready"


def test_a_round_waits_for_the_frame_then_goes_on_when_it_failed_or_timed_out(scene):
    e = scene
    a = e.scene.asset
    media(e, a.versions[-1])
    with patch(SEND):
        c = post(e, a, "Circle this", 12.4, annotation=DRAW)
    r = close(e)
    assert r.status_code == 409 and r.json()["detail"] == {"error": "images_pending", "comment_ids": [c]}   # still rendering
    status, _puts, _ = render(e, c, extract=lambda k, t: (_ for _ in ()).throw(RuntimeError("no raw")))
    assert status == "failed"
    out = v1(e)   # failed: released, with the fallback marked
    d = out["files"][0]["comments"][0]["drawing"]
    assert d["frame_status"] == "failed" and d["frame_source"] in ("thumbnail", None) and not [x for x in out["files"][0]["comments"][0]["attachments"] if x["kind"] == "frame_png"]


def test_a_frame_older_than_60_seconds_no_longer_holds_the_round(scene):
    e = scene
    a = e.scene.asset
    media(e, a.versions[-1])
    with patch(SEND):
        c = post(e, a, "Circle this", 12.4, annotation=DRAW)
    from apps.api.models.agent import FeedbackRound
    from apps.api.models.comment import Comment
    old = datetime.now(timezone.utc) - timedelta(seconds=61)
    with e.Session() as db:
        db.get(Comment, uuid.UUID(c)).created_at = old
        rnd = db.query(FeedbackRound).one()
        rnd.opened_at = rnd.last_activity_at = old
        db.commit()
    assert v1(e)["files"][0]["comments"][0]["drawing"]["frame_status"] == "failed"


def test_the_client_picture_stays_as_the_labelled_fallback_until_the_png_exists(scene):
    e = scene
    a = e.scene.asset   # no media: nothing to render from, so the client JPEG is what the agent gets
    c = post(e, a, "Circle this", 12.4, annotation=DRAW)
    from apps.api.models.comment import CommentAttachment
    with e.Session() as db:
        db.add(CommentAttachment(comment_id=uuid.UUID(c), file_type="image/jpeg", s3_key=f"k/{c}/drawn-frame.jpg", original_filename="drawn-frame.jpg",
                                 file_size_bytes=1, uploaded_at=T0))
        db.commit()
    d = v1(e)["files"][0]["comments"][0]["drawing"]
    assert (d["frame_url"], d["frame_source"], d["frame_status"]) == (f"https://s3/k/{c}/drawn-frame.jpg", "client", "unavailable")


# ── Guests and retention ──────────────────────────────────────────────────────

def test_a_guest_dictation_with_audio_is_stored_like_a_members(scene):
    e, did = scene, uuid.uuid4()
    from .test_level_up_api import link
    a = e.scene.asset
    token = link(e, e.scene.req.folder_id)
    guest = {"guest_email": "client@example.test", "guest_name": "Client"}
    body = {"asset_id": str(a.id), "version_id": str(a.versions[-1].id), "body": "Make this pop.", "timecode_start": 4.0,
            "dictation": dictation(did), "segment_index": 0, "attachments_expected": 1, **guest}
    cid = e.client.post(f"/share/{token}/comment", json=body).json()["id"]
    spec = {"file_name": "dictation.webm", "file_size": 900, "content_type": "audio/webm", "kind": "dictation_audio", "duration_s": 3.5, **guest}
    with patch("apps.api.services.s3_service.generate_presigned_put_url", return_value="https://put"):
        r = e.client.post(f"/share/{token}/comments/{cid}/attachments", json=spec)
    assert r.status_code == 201, r.text
    with patch("apps.api.services.s3_service.head_object", return_value=(900, "audio/webm")):
        assert e.client.post(f"/share/{token}/comments/{cid}/attachments/{r.json()['attachment_id']}/complete", json=guest).status_code == 200
    out = v1(e)
    c = out["files"][0]["comments"][0]
    assert c["author_kind"] == "guest" and c["dictation_id"] == str(did) and [x["kind"] for x in c["attachments"]] == ["dictation_audio"]
    assert out["dictations"][0]["audio_attachment_id"] == c["attachments"][0]["attachment_id"]


def test_audio_is_deleted_90_days_after_the_round_is_acknowledged_and_only_then(scene):
    e, did = scene, uuid.uuid4()
    a = e.scene.asset
    c = post(e, a, "Make this pop.", 4.0, dictation=dictation(did), segment_index=0)
    from apps.api.models.agent import FeedbackRound
    from apps.api.models.comment import CommentAttachment, CommentDictation
    from apps.api.services import feedback_rounds
    with e.Session() as db:
        att = CommentAttachment(comment_id=uuid.UUID(c), file_type="audio/webm", s3_key="k/dictation.webm", original_filename="dictation.webm",
                                file_size_bytes=1, uploaded_at=T0, kind="dictation_audio")
        db.add(att)
        db.flush()
        db.get(CommentDictation, did).audio_attachment_id = att.id
        db.commit()
    v1(e)
    now = datetime.now(timezone.utc)
    with patch("apps.api.services.s3_service.delete_object") as gone:
        with e.Session() as db:   # closed but never acknowledged: the audio stays however old
            assert feedback_rounds.purge_dictation_audio(db, now + timedelta(days=400)) == 0
        with e.Session() as db:
            db.query(FeedbackRound).one().acked_at = now
            db.commit()
        with e.Session() as db:
            assert feedback_rounds.purge_dictation_audio(db, now + timedelta(days=89)) == 0
        with e.Session() as db:
            assert feedback_rounds.purge_dictation_audio(db, now + timedelta(days=91)) == 1
        gone.assert_called_once_with("k/dictation.webm")
    with e.Session() as db:
        assert db.query(CommentAttachment).filter(CommentAttachment.kind == "dictation_audio").count() == 0
        assert db.get(CommentDictation, did).audio_attachment_id is None and db.get(CommentDictation, did).words   # the words stay
