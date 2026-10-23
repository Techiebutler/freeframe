"""S3_STORAGE_CLASS has to reach every media write, and nothing else (#514).

S3 fixes an object's storage class when the object is created. For an original
that is CreateMultipartUpload, which the API sends itself, so the browser's part
uploads need no header and must not carry one: boto3 signs it into a presigned
URL, and Silo and Garage refuse it on part uploads. The transcoder's outputs are
created by the worker, so it has to send the class on each of them too.

Unset sends nothing at all, because backends disagree on what they accept:
MinIO and Silo refuse everything but STANDARD and REDUCED_REDUNDANCY.
"""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from apps.api.config import Settings, settings
from apps.api.services import s3_service
from apps.api.tasks import transcode_tasks
from packages.transcoder import image_processor
from packages.transcoder.base import TranscodeJob
from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder


def _settings(**overrides):
    base = dict(
        database_url="postgresql://u:p@localhost:5432/db",
        redis_url="redis://localhost:6379/0",
        jwt_secret="test-secret",
    )
    base.update(overrides)
    return Settings(_env_file=None, **base)


# ─────────────────────────────────── the setting

def test_unset_means_no_storage_class():
    assert _settings().s3_storage_class is None


@pytest.mark.parametrize("raw", ["", "   "])
def test_a_blank_value_is_the_same_as_unset(raw):
    # `S3_STORAGE_CLASS=` left in an env file must not send an empty header.
    assert _settings(s3_storage_class=raw).s3_storage_class is None


def test_the_value_is_trimmed_and_upper_cased():
    assert _settings(s3_storage_class=" standard_ia ").s3_storage_class == "STANDARD_IA"


@pytest.mark.parametrize("value", ["EXPRESS_ONEZONE", "STANDARD", "REDUCED_REDUNDANCY", "GLACIER_IR"])
def test_classes_freeframe_can_read_directly_are_accepted(value):
    # No allow-list beyond the archive classes: providers name their own tiers.
    assert _settings(s3_storage_class=value).s3_storage_class == value


@pytest.mark.parametrize("value", ["GLACIER", "glacier", "DEEP_ARCHIVE"])
def test_archive_classes_are_refused_at_startup(value):
    # FreeFrame streams and downloads objects directly; these need a restore first.
    with pytest.raises(ValidationError, match="S3_STORAGE_CLASS"):
        _settings(s3_storage_class=value)


# ─────────────────────────────────── originals

class _InitiateClient:
    def __init__(self):
        self.calls = []

    def create_multipart_upload(self, **kwargs):
        self.calls.append(kwargs)
        return {"UploadId": "upload-1"}


def _initiate(monkeypatch, storage_class):
    monkeypatch.setattr(settings, "s3_storage_class", storage_class)
    client = _InitiateClient()
    monkeypatch.setattr(s3_service, "_get_initiate_client", lambda: client)
    s3_service.create_multipart_upload("raw/p/a/v/original.mov", "video/quicktime")
    assert len(client.calls) == 1
    return client.calls[0]


def test_an_original_is_started_in_the_configured_class(monkeypatch):
    assert _initiate(monkeypatch, "STANDARD_IA")["StorageClass"] == "STANDARD_IA"


def test_an_original_sends_no_class_when_unset(monkeypatch):
    assert "StorageClass" not in _initiate(monkeypatch, None)


# ─────────────────────────────────── server-side small writes

def _put(monkeypatch, **kwargs):
    monkeypatch.setattr(settings, "s3_storage_class", "STANDARD_IA")
    client = MagicMock()
    monkeypatch.setattr(s3_service, "get_s3_client", lambda: client)
    s3_service.put_object("some/key", b"x", "video/mp4", **kwargs)
    return client.put_object.call_args.kwargs


def test_a_media_put_carries_the_class(monkeypatch):
    assert _put(monkeypatch, media=True)["StorageClass"] == "STANDARD_IA"


def test_any_other_put_stays_on_the_bucket_default(monkeypatch):
    # Project posters go through put_object too, and they are not media.
    assert "StorageClass" not in _put(monkeypatch)


def test_a_browser_presigned_put_never_signs_a_class(monkeypatch):
    """Avatars, logos and posters upload straight from the browser.

    A class in the presign params becomes a signed `x-amz-storage-class` header
    the browser does not send, so every such upload would be refused.
    """
    monkeypatch.setattr(settings, "s3_storage_class", "STANDARD_IA")
    client = MagicMock()
    client.generate_presigned_url.return_value = "https://s3.example.com/x"
    monkeypatch.setattr(s3_service, "_get_presign_client", lambda: client)

    s3_service.generate_presigned_put_url("avatars/u/a.png", "image/png")

    assert "StorageClass" not in client.generate_presigned_url.call_args.kwargs["Params"]


# ─────────────────────────────────── the video transcoder

def _hls_tree(root: Path) -> Path:
    variant = root / "v0"
    variant.mkdir(parents=True)
    (root / "master.m3u8").write_text("#EXTM3U")
    (variant / "playlist.m3u8").write_text("#EXTM3U")
    (variant / "seg_000.ts").write_bytes(b"\0" * 16)
    return root


@pytest.mark.parametrize("storage_class", ["STANDARD_IA", None])
def test_every_hls_file_is_written_in_the_class(tmp_path, storage_class):
    s3 = MagicMock()
    FFmpegTranscoder(s3, "bucket", storage_class=storage_class)._upload_directory(
        _hls_tree(tmp_path / "hls"), "processed/p/a/v",
    )

    extras = [c.kwargs["ExtraArgs"] for c in s3.upload_file.call_args_list]
    assert len(extras) == 3
    for extra in extras:
        assert extra.get("StorageClass") == storage_class
        # The class is added to the per-file headers, not in place of them.
        assert extra["ContentType"] and extra["CacheControl"]


def _run_transcode(storage_class):
    """A whole transcode with ffmpeg and S3 mocked; the thumbnail is 'written'."""
    def run(cmd, **_kwargs):
        mock = MagicMock(returncode=0, stderr="")
        if "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "V:0":
            mock.stdout = json.dumps({"streams": [
                {"r_frame_rate": "25/1", "duration": 6.0, "width": 1280, "height": 720},
            ]})
        elif "-select_streams" in cmd and cmd[cmd.index("-select_streams") + 1] == "a":
            mock.stdout = json.dumps({"streams": [{"codec_name": "aac"}]})
        return mock

    real_exists = Path.exists

    def exists(self):
        return self.name == "thumb_0001.jpg" or real_exists(self)

    job = TranscodeJob(
        media_id="media-1", version_id="v1",
        input_s3_key="raw/p/a/v/original.mp4", output_s3_prefix="processed/p/a/v",
        qualities=["720p"],
    )
    s3 = MagicMock()
    s3.generate_presigned_url.return_value = "https://s3.example.com/raw/p/a/v/original.mp4"
    with patch("subprocess.run", side_effect=run), \
         patch("builtins.open", MagicMock()), \
         patch("pathlib.Path.glob", return_value=[]), \
         patch("pathlib.Path.rglob", return_value=[]), \
         patch("pathlib.Path.mkdir"), \
         patch.object(Path, "exists", exists), \
         patch("shutil.rmtree"):
        result = asyncio.run(
            FFmpegTranscoder(s3, "bucket", storage_class=storage_class).transcode(job)
        )
    assert result.success, result.error
    return {c.args[2]: c.kwargs["ExtraArgs"] for c in s3.upload_file.call_args_list}


@pytest.mark.parametrize("storage_class", ["STANDARD_IA", None])
def test_the_download_mp4_and_thumbnail_are_written_in_the_class(storage_class):
    uploads = _run_transcode(storage_class)

    assert set(uploads) == {"processed/p/a/v/download.mp4", "processed/p/a/v/thumbnail.jpg"}
    for extra in uploads.values():
        assert extra.get("StorageClass") == storage_class


# ─────────────────────────────────── images and audio

def _fake_ffmpeg(cmd, **_kwargs):
    # Every output path is the last argument; it has to exist for upload_file.
    Path(cmd[-1]).write_bytes(b"\0")
    return MagicMock(returncode=0, stdout=json.dumps({"format": {"duration": "3.0"}}))


@pytest.mark.parametrize("process", [image_processor.process_image, image_processor.process_audio])
@pytest.mark.parametrize("storage_class", ["STANDARD_IA", None])
def test_image_and_audio_outputs_are_written_in_the_class(process, storage_class):
    s3 = MagicMock()
    with patch.object(image_processor.subprocess, "run", side_effect=_fake_ffmpeg):
        process(s3, "bucket", "raw/p/a/v/original", "processed/p/a/v", storage_class=storage_class)

    extras = [c.kwargs["ExtraArgs"] for c in s3.upload_file.call_args_list]
    assert len(extras) == 2
    for extra in extras:
        assert extra.get("StorageClass") == storage_class
        assert extra["ContentType"]


# ─────────────────────────────────── the worker hands the setting over

def _media_file():
    return SimpleNamespace(
        s3_key_raw="raw/p/a/v/original", s3_key_processed=None, s3_key_download=None,
        s3_key_thumbnail=None, duration_seconds=None,
    )


def test_the_video_task_gives_the_transcoder_the_setting(monkeypatch):
    monkeypatch.setattr(settings, "s3_storage_class", "STANDARD_IA")
    asset = SimpleNamespace(id="asset-1", project_id="proj-1")
    with patch("packages.transcoder.ffmpeg_transcoder.FFmpegTranscoder") as cls, \
         patch.object(transcode_tasks, "_run_async", MagicMock(side_effect=RuntimeError("stop"))):
        with pytest.raises(RuntimeError, match="stop"):
            transcode_tasks._process_video(
                MagicMock(), asset, SimpleNamespace(id="ver-1"), _media_file(), MagicMock(),
                "processed/p/a/v",
            )

    assert cls.call_args.kwargs["storage_class"] == "STANDARD_IA"


@pytest.mark.parametrize("task, target", [
    (transcode_tasks._process_audio, "packages.transcoder.image_processor.process_audio"),
    (transcode_tasks._process_image, "packages.transcoder.image_processor.process_image"),
])
def test_the_audio_and_image_tasks_pass_the_setting(monkeypatch, task, target):
    monkeypatch.setattr(settings, "s3_storage_class", "STANDARD_IA")
    with patch(target, return_value={}) as process:
        task(MagicMock(), SimpleNamespace(), SimpleNamespace(), _media_file(), MagicMock(), "processed/p/a/v")

    assert process.call_args.kwargs["storage_class"] == "STANDARD_IA"
