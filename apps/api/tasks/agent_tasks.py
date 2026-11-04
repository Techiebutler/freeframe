from datetime import datetime, timezone

from .celery_app import celery_app
from ..database import SessionLocal
from ..services import agent_notify


@celery_app.task(name="sweep_agent_handins")
def sweep_agent_handins() -> int:
    """Every minute: tell owners about agent hand-ins that cleared (or got stuck) while the agent was away."""
    db = SessionLocal()
    try:
        return agent_notify.sweep(db, datetime.now(timezone.utc))
    finally:
        db.close()
