from datetime import datetime, timezone

from .celery_app import celery_app
from ..database import SessionLocal
from ..services import feedback_rounds


@celery_app.task(name="close_idle_feedback_rounds")
def close_idle_feedback_rounds() -> int:
    """Every minute: close rounds whose owner has been idle for 5 minutes."""
    db = SessionLocal()
    try:
        return feedback_rounds.close_idle(db, datetime.now(timezone.utc))
    finally:
        db.close()
