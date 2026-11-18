"""A spoken dictation kept with the comments it became (spec 2026-11-18, decision 1: one comment per sentence, linked)."""
import uuid
from typing import Optional

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ..models.comment import Comment, CommentDictation


def attach(db: Session, comment: Comment, dictation, segment_index: Optional[int]) -> None:
    """Link `comment` to its dictation, creating the row on the first sentence. Every sentence of one dictation sends
    the same payload with the same client-made id: concurrent inserts are harmless (the first one wins)."""
    if dictation is None:
        return
    db.execute(pg_insert(CommentDictation).values(
        id=dictation.id, version_id=comment.version_id, text=dictation.text,
        raw_text=dictation.raw_text if dictation.raw_text != dictation.text else None, lang=dictation.lang,
        words=[w.model_dump() for w in dictation.words], segments=[s.model_dump() for s in dictation.segments],
    ).on_conflict_do_nothing(index_elements=["id"]))
    comment.dictation_id = dictation.id
    comment.segment_index = segment_index if segment_index is not None else 0
    db.flush()


def queue_render(db: Session, comment: Comment, has_drawing: bool) -> None:
    """After commit: a drawn comment on a version with media gets its PNG rendered by the worker. Never raises."""
    if not has_drawing:
        return
    try:
        from . import drawn_frame
        if not drawn_frame.has_renderable_media(db, comment.version_id):
            return
        from ..tasks.celery_app import send_task_safe
        from ..tasks.drawn_frame_tasks import render_drawn_frames
        send_task_safe(render_drawn_frames, str(comment.id))
    except Exception:  # noqa: BLE001 - the comment is saved; the round falls back to the client picture
        pass
