"""The worker reads the compression level per job, from the database.

The value could have been read inside the transcoder from the environment, and
the feature would look identical in a code review. It would also be nearly
useless: the Celery worker is a long-lived process, so an admin who moves the
slider would be waiting for the next container restart, with nothing saying so.

So the level is read when the job is built and travels on the job. The two ways
that can go wrong quietly are mapping "unset" onto the default level (which
would silently disable `TRANSCODER_CRF_OFFSET` on every upgraded instance) and
creating the settings row from a transcode (which would turn "nobody has
chosen" into a stored level nobody chose).
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from apps.api.tasks.transcode_tasks import _instance_compression_level
from packages.transcoder.base import (
    COMPRESSION_LEVELS, DEFAULT_COMPRESSION_LEVEL, TranscodeResult,
)


def _job_for(level, *, db=None):
    """Run _process_video with a settings row carrying `level`, return the job."""
    from apps.api.tasks.transcode_tasks import _process_video

    db = db or MagicMock()
    db.query.return_value = db
    db.first.return_value = None if level == "no row" else MagicMock(compression_level=level)
    media_file = MagicMock(s3_key_raw="raw/x.mp4")
    result = TranscodeResult(success=True, hls_prefix="processed/p/a/v", thumbnail_keys=[])
    with patch("packages.transcoder.ffmpeg_transcoder.FFmpegTranscoder") as MockT:
        transcode = AsyncMock(return_value=result)
        MockT.return_value.transcode = transcode
        _process_video(db, MagicMock(), MagicMock(), media_file, MagicMock(), "processed/p/a/v")
    assert transcode.await_args, "the transcoder was never called"
    return transcode.await_args[0][0]


@pytest.mark.parametrize("level,offset", [
    *sorted(COMPRESSION_LEVELS.items()),
    # None, not 0: the transcoder reads None as "use TRANSCODER_CRF_OFFSET",
    # and a 0 here would override that variable on every instance that set it.
    # The mirror of that is level 3 above, which is a real choice of 0.
    (None, None),
    ("no row", None),
])
def test_the_chosen_level_reaches_the_job_as_an_offset(level, offset):
    assert _job_for(level).crf_offset == offset
    assert COMPRESSION_LEVELS[DEFAULT_COMPRESSION_LEVEL] == 0


def test_a_transcode_never_creates_the_settings_row():
    db = MagicMock()
    _job_for(None, db=db)
    db.add.assert_not_called()
    db.commit.assert_not_called()


def test_an_unreadable_setting_rolls_back_and_still_transcodes():
    # A settings problem must not cost an upload, and swallowing the error is
    # only half of that: a failed statement leaves the session's transaction
    # aborted, after which Postgres refuses every further statement on the
    # connection and the next flush in _process_video fails the upload.
    db = MagicMock()
    db.query.side_effect = RuntimeError("no such column")

    assert _instance_compression_level(db) is None
    db.rollback.assert_called_once()

    # Even a rollback that itself raises -- a dead connection -- is not worth
    # failing an upload over.
    db.rollback.side_effect = RuntimeError("connection is closed")
    assert _instance_compression_level(db) is None


def test_the_column_is_there_and_nullable_once_the_migration_has_run(real_db):
    # The one test that needs a real database: the migration, as the worker
    # meets it. A read against a migrated instance has to find the column and
    # find it empty, because no instance starts with a level chosen.
    row = real_db.execute(text(
        "SELECT is_nullable, column_default FROM information_schema.columns"
        " WHERE table_name = 'instance_settings' AND column_name = 'compression_level'"
    )).one()

    assert row == ("YES", None)
    assert _instance_compression_level(real_db) is None


def test_a_worker_against_an_unmigrated_database_loses_the_preference_only():
    # The situation the rollback exists for, against real Postgres: a worker
    # that already knows the column, reading a database the migration has not
    # reached. A savepoint-joined session rather than the shared `real_db`
    # fixture, because the behaviour under test is `db.rollback()` itself.
    from apps.api.database import engine

    conn = engine.connect()
    trans = conn.begin()
    session = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        session.execute(text("ALTER TABLE instance_settings DROP COLUMN compression_level"))
        session.flush()

        assert _instance_compression_level(session) is None
        # The session still works, which is the whole point: the upload goes on.
        assert session.execute(text("SELECT 1")).scalar() == 1
    finally:
        session.close()
        trans.rollback()
        conn.close()
