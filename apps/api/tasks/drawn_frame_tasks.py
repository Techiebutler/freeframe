from datetime import datetime, timedelta, timezone

from .celery_app import celery_app
from ..database import SessionLocal
from ..services import drawn_frame, feedback_rounds


@celery_app.task(name="render_drawn_frames")
def render_drawn_frames(comment_id: str) -> str:
    """ffmpeg frame of the comment's exact version at each mark time + burned-in strokes -> frame_png attachments."""
    import uuid
    db = SessionLocal()
    try:
        return drawn_frame.render_comment(db, uuid.UUID(comment_id))
    finally:
        db.close()


@celery_app.task(name="purge_dictation_audio")
def purge_dictation_audio() -> int:
    """Daily: reviewer voice recordings are deleted 90 days after their round was acknowledged."""
    db = SessionLocal()
    try:
        return feedback_rounds.purge_dictation_audio(db, datetime.now(timezone.utc))
    finally:
        db.close()
