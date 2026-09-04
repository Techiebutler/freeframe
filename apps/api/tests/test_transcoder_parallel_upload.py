"""Tests for uploading a transcode's HLS output several files at a time.

The property under test is that the uploads overlap. It is easy to write a test
that passes whether they do or not -- every file lands either way -- so the
concurrency test below observes how many uploads are in flight at once rather
than inferring it from the result.
"""
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder, _UPLOAD_THREADS


def _hls_tree(root: Path, segments: int = 12) -> Path:
    """A directory shaped like real HLS output: a master, and a nested variant."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "master.m3u8").write_text("#EXTM3U")
    variant = root / "v0"
    variant.mkdir()
    (variant / "playlist.m3u8").write_text("#EXTM3U")
    for i in range(segments):
        (variant / f"seg_{i:03}.ts").write_bytes(b"\0" * 16)
    return root


def _transcoder(upload_file) -> FFmpegTranscoder:
    s3 = MagicMock()
    s3.upload_file = upload_file
    return FFmpegTranscoder(s3, "test-bucket")


# ------------------------------------------------------------------ correctness

def test_every_file_is_uploaded_once_under_its_own_key(tmp_path):
    hls = _hls_tree(tmp_path / "hls", segments=3)
    calls = []
    t = _transcoder(lambda path, bucket, key, **kw: calls.append((key, kw)))

    keys = t._upload_directory(hls, "processed/asset/v1")

    assert sorted(keys) == [
        "processed/asset/v1/master.m3u8",
        "processed/asset/v1/v0/playlist.m3u8",
        "processed/asset/v1/v0/seg_000.ts",
        "processed/asset/v1/v0/seg_001.ts",
        "processed/asset/v1/v0/seg_002.ts",
    ]
    # Nested paths keep their relative shape -- a flattened key would collide
    # every variant's playlist onto one object.
    assert len(calls) == len(keys)
    assert len({key for key, _ in calls}) == len(keys)


def test_each_file_keeps_its_content_type_and_cache_control(tmp_path):
    hls = _hls_tree(tmp_path / "hls", segments=1)
    seen = {}
    t = _transcoder(
        lambda path, bucket, key, **kw: seen.__setitem__(key, kw["ExtraArgs"])
    )

    t._upload_directory(hls, "p")

    # A playlist that is cached like a segment is the failure mode here: the
    # player keeps serving a stale manifest for a year.
    assert seen["p/master.m3u8"]["ContentType"] == "application/vnd.apple.mpegurl"
    assert seen["p/master.m3u8"]["CacheControl"] == "no-cache"
    assert seen["p/v0/seg_000.ts"]["ContentType"] == "video/mp2t"
    assert seen["p/v0/seg_000.ts"]["CacheControl"] == "max-age=31536000"


def test_an_empty_directory_uploads_nothing(tmp_path):
    empty = tmp_path / "hls"
    empty.mkdir()
    called = []
    t = _transcoder(lambda *a, **k: called.append(a))

    assert t._upload_directory(empty, "p") == []
    assert called == []


def test_the_returned_keys_do_not_depend_on_directory_order(tmp_path):
    hls = _hls_tree(tmp_path / "hls", segments=5)
    t = _transcoder(lambda *a, **k: None)

    assert t._upload_directory(hls, "p") == sorted(t._upload_directory(hls, "p"))


# ------------------------------------------------------------------ concurrency

def test_uploads_actually_overlap(tmp_path):
    """The point of the change. Without the pool this peaks at one."""
    hls = _hls_tree(tmp_path / "hls", segments=15)
    lock = threading.Lock()
    state = {"now": 0, "peak": 0}

    def _slow_upload(path, bucket, key, **kw):
        with lock:
            state["now"] += 1
            state["peak"] = max(state["peak"], state["now"])
        # Long enough that the workers are provably in flight together, short
        # enough that the test stays quick.
        time.sleep(0.05)
        with lock:
            state["now"] -= 1

    _transcoder(_slow_upload)._upload_directory(hls, "p")

    assert state["peak"] > 1, "uploads ran one after another"
    assert state["peak"] <= _UPLOAD_THREADS, (
        f"{state['peak']} uploads in flight, more than the pool allows"
    )


def test_the_pool_is_never_wider_than_the_work(tmp_path):
    # Eight threads for two files is eight threads created to do nothing.
    hls = tmp_path / "hls"
    hls.mkdir()
    (hls / "master.m3u8").write_text("#EXTM3U")
    seen = set()

    def _record(path, bucket, key, **kw):
        seen.add(threading.current_thread().name)
        time.sleep(0.02)

    _transcoder(_record)._upload_directory(hls, "p")

    assert len(seen) == 1


# ---------------------------------------------------------------- failure paths

def test_a_failed_upload_is_raised_rather_than_lost_in_its_thread(tmp_path):
    """An exception inside a worker is the risk this change introduces.

    `ThreadPoolExecutor.map` is lazy: without draining the results the failure
    would sit unread in a future, the transcode would report success, and the
    version would go `ready` with segments missing from the bucket.
    """
    hls = _hls_tree(tmp_path / "hls", segments=6)

    def _fail_on_one(path, bucket, key, **kw):
        if key.endswith("seg_003.ts"):
            raise RuntimeError("storage said no")

    with pytest.raises(RuntimeError, match="storage said no"):
        _transcoder(_fail_on_one)._upload_directory(hls, "p")
