"""Outgoing webhook for transcode_complete / transcode_failed (#376).

The DB, the network and the broker are mocked: these pin the body a receiver
parses, the signature it checks, which responses are retried, and that a
transcode never waits on or fails because of the webhook.
"""
import hashlib
import hmac
import json
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
import pytest
from celery.exceptions import Retry

from apps.api.models.asset import Asset, AssetVersion
from apps.api.models.folder import Folder
from apps.api.models.project import Project
from apps.api.tasks import webhook_tasks
from apps.api.tasks.webhook_tasks import (
    build_payload, deliver_webhook, enqueue_webhook, sign,
)


def _id():
    return uuid.uuid4()


class World:
    """A project with a two-level folder tree and one asset with a version."""

    def __init__(self, folder_deleted=False, asset_in="leaf"):
        self.project = SimpleNamespace(id=_id(), name="Staffel 3", deleted_at=None)
        self.top = SimpleNamespace(id=_id(), name="Folge 04", parent_id=None, deleted_at=None)
        self.leaf = SimpleNamespace(id=_id(), name="Rohschnitt", parent_id=self.top.id, deleted_at=None)
        if folder_deleted:
            self.top.deleted_at = datetime.now(timezone.utc)
        folder_id = {"leaf": self.leaf.id, "top": self.top.id, "root": None}[asset_in]
        self.asset = SimpleNamespace(
            id=_id(), project_id=self.project.id, name="EP04_v3", folder_id=folder_id, deleted_at=None,
        )
        self.version = SimpleNamespace(id=_id(), asset_id=self.asset.id, version_number=3, deleted_at=None)

    def db(self):
        rows = {
            (Project, self.project.id): self.project,
            (Folder, self.top.id): self.top,
            (Folder, self.leaf.id): self.leaf,
            (Asset, self.asset.id): self.asset,
            (AssetVersion, self.version.id): self.version,
        }
        db = MagicMock()
        db.get.side_effect = lambda model, key: rows.get((model, key))
        return db


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(webhook_tasks.settings, "webhook_url", "https://hooks.example.com/ff")
    monkeypatch.setattr(webhook_tasks.settings, "webhook_secret", "s3cret")
    monkeypatch.setattr(webhook_tasks.settings, "webhook_events", "transcode_complete,transcode_failed")


def _payload(w, event="transcode_complete"):
    return build_payload(w.db(), event, str(w.asset.id), str(w.version.id))


class TestPayload:
    def test_carries_where_the_asset_lives(self):
        w = World()
        p = _payload(w)
        assert p["event"] == "transcode_complete"
        assert p["project"] == {"id": str(w.project.id), "name": "Staffel 3"}
        assert p["folder"] == {
            "id": str(w.leaf.id), "name": "Rohschnitt", "path": ["Folge 04", "Rohschnitt"],
        }
        assert p["asset"] == {"id": str(w.asset.id), "name": "EP04_v3"}
        assert p["version"] == {"id": str(w.version.id), "number": 3, "status": "ready"}
        assert p["delivered_at"].endswith("Z")

    def test_folder_is_null_at_the_project_root(self):
        assert _payload(World(asset_in="root"))["folder"] is None

    def test_failed_event_reports_failed(self):
        assert _payload(World(), "transcode_failed")["version"]["status"] == "failed"

    def test_path_stops_below_a_deleted_ancestor(self):
        p = _payload(World(folder_deleted=True))
        assert p["folder"]["path"] == ["Rohschnitt"]

    def test_deleted_own_folder_is_left_out(self):
        w = World()
        w.leaf.deleted_at = datetime.now(timezone.utc)
        assert _payload(w)["folder"] is None

    def test_a_parent_cycle_ends_the_walk(self):
        w = World()
        w.top.parent_id = w.leaf.id
        assert _payload(w)["folder"]["path"] == ["Folge 04", "Rohschnitt"]

    @pytest.mark.parametrize("gone", ["project", "asset", "version"])
    def test_nothing_for_something_deleted(self, gone):
        w = World()
        getattr(w, gone).deleted_at = datetime.now(timezone.utc)
        assert _payload(w) is None

    def test_nothing_for_a_version_of_another_asset(self):
        w = World()
        w.version.asset_id = _id()
        assert _payload(w) is None


class TestEnqueue:
    def test_off_without_a_url(self, monkeypatch):
        monkeypatch.setattr(webhook_tasks.settings, "webhook_url", "")
        with patch.object(deliver_webhook, "delay") as delay:
            assert enqueue_webhook("transcode_complete", "a", "v") is False
        delay.assert_not_called()

    def test_only_the_events_asked_for(self, configured, monkeypatch):
        monkeypatch.setattr(webhook_tasks.settings, "webhook_events", " transcode_failed , bogus ")
        with patch.object(deliver_webhook, "delay") as delay:
            assert enqueue_webhook("transcode_complete", "a", "v") is False
            assert enqueue_webhook("transcode_failed", "a", "v") is True
        assert delay.call_count == 1

    def test_queued_with_a_delivery_id_and_on_its_own_queue(self, configured):
        with patch.object(deliver_webhook, "delay") as delay:
            enqueue_webhook("transcode_complete", "a", "v")
        event, asset_id, version_id, delivery_id = delay.call_args.args
        assert (event, asset_id, version_id) == ("transcode_complete", "a", "v")
        uuid.UUID(delivery_id)
        from apps.api.tasks.celery_app import celery_app
        assert celery_app.amqp.router.route({}, deliver_webhook.name)["queue"].name == "webhooks"


def _run(w, response=None, error=None, retries=0):
    """Run the task once; return (post mock, retry mock)."""
    post = MagicMock(side_effect=error) if error else MagicMock(return_value=response)
    with patch.object(webhook_tasks, "SessionLocal", return_value=w.db()), \
         patch.object(webhook_tasks.httpx, "post", post), \
         patch.object(deliver_webhook, "retry", side_effect=Retry()) as retry, \
         patch.object(deliver_webhook.request, "retries", retries, create=True):
        try:
            deliver_webhook.run("transcode_complete", str(w.asset.id), str(w.version.id), "d-1")
        except Retry:
            pass
    return post, retry


def _resp(status):
    return httpx.Response(status, request=httpx.Request("POST", "https://hooks.example.com/ff"))


class TestDelivery:
    def test_posts_signed_json_with_the_headers(self, configured):
        post, retry = _run(World(), _resp(200))
        retry.assert_not_called()
        kwargs = post.call_args.kwargs
        assert post.call_args.args == ("https://hooks.example.com/ff",)
        body = kwargs["content"]
        assert json.loads(body)["event"] == "transcode_complete"
        h = kwargs["headers"]
        assert h["X-FreeFrame-Event"] == "transcode_complete"
        assert h["X-FreeFrame-Delivery"] == "d-1"
        expected = "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
        assert h["X-FreeFrame-Signature"] == expected == sign("s3cret", body)
        assert kwargs["follow_redirects"] is False
        assert kwargs["timeout"] == webhook_tasks.REQUEST_TIMEOUT

    def test_unsigned_without_a_secret(self, configured, monkeypatch):
        monkeypatch.setattr(webhook_tasks.settings, "webhook_secret", "")
        post, _ = _run(World(), _resp(204))
        assert "X-FreeFrame-Signature" not in post.call_args.kwargs["headers"]

    def test_no_request_when_nothing_is_live(self, configured):
        w = World()
        w.project.deleted_at = datetime.now(timezone.utc)
        post, _ = _run(w, _resp(200))
        post.assert_not_called()

    @pytest.mark.parametrize("status", [500, 502, 408, 429])
    def test_retried_on_server_errors_and_throttling(self, configured, status):
        _, retry = _run(World(), _resp(status))
        retry.assert_called_once_with(countdown=30)

    def test_retried_on_a_connection_error(self, configured):
        _, retry = _run(World(), error=httpx.ConnectError("down"))
        retry.assert_called_once_with(countdown=30)

    def test_backoff_doubles(self, configured):
        _, retry = _run(World(), _resp(503), retries=3)
        retry.assert_called_once_with(countdown=240)

    @pytest.mark.parametrize("status", [400, 401, 404, 410, 301])
    def test_not_retried_when_asking_again_cannot_help(self, configured, status):
        _, retry = _run(World(), _resp(status))
        retry.assert_not_called()

    def test_given_up_after_the_last_attempt(self, configured):
        _, retry = _run(World(), _resp(500), retries=webhook_tasks.MAX_RETRIES)
        retry.assert_not_called()


class TestTranscodeIsNeverHeldUp:
    def test_a_broker_failure_is_swallowed(self, configured):
        from apps.api.tasks import transcode_tasks
        with patch.object(deliver_webhook, "delay", side_effect=OSError("broker down")):
            transcode_tasks._notify_webhook("transcode_complete", "a", "v")  # must not raise

    def _run_process_asset(self, transcode, retries):
        from apps.api.models.asset import AssetType, MediaFile
        from apps.api.tasks import transcode_tasks
        w = World()
        w.asset.asset_type = AssetType.video
        rows = {AssetVersion: w.version, Asset: w.asset, MediaFile: SimpleNamespace(id=_id())}

        def query(model):
            q = MagicMock()
            q.filter.return_value = q
            q.first.return_value = rows[model]
            return q

        db = MagicMock()
        db.query.side_effect = query
        with patch.object(transcode_tasks, "SessionLocal", return_value=db), \
             patch.object(transcode_tasks, "get_s3_client"), \
             patch.object(transcode_tasks, "_process_video", side_effect=transcode), \
             patch.object(transcode_tasks, "_record_derived_size"), \
             patch.object(transcode_tasks, "_publish_event"), \
             patch.object(transcode_tasks, "_notify_webhook") as notify, \
             patch.object(transcode_tasks.process_asset, "retry", side_effect=Retry()), \
             patch.object(transcode_tasks.process_asset.request, "retries", retries, create=True):
            try:
                transcode_tasks.process_asset.run(str(w.asset.id), str(w.version.id))
            except Exception:
                pass
        return w, notify

    def test_a_finished_transcode_announces_complete(self):
        w, notify = self._run_process_asset(lambda *a, **k: None, retries=0)
        notify.assert_called_once_with("transcode_complete", str(w.asset.id), str(w.version.id))

    def test_a_transcode_that_gave_up_announces_failed(self):
        def boom(*a, **k):
            raise RuntimeError("ffmpeg died")
        w, notify = self._run_process_asset(boom, retries=3)
        notify.assert_called_once_with("transcode_failed", str(w.asset.id), str(w.version.id))

    def test_a_transcode_that_will_retry_announces_nothing(self):
        def boom(*a, **k):
            raise RuntimeError("ffmpeg died")
        _, notify = self._run_process_asset(boom, retries=0)
        notify.assert_not_called()
