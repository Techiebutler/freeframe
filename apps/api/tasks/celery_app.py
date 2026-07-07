from celery import Celery
from celery.schedules import crontab
from kombu import Queue
from kombu.exceptions import OperationalError

try:
    from ..config import settings
except ImportError:
    from config import settings

celery_app = Celery(
    "freeframe",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "apps.api.tasks.transcode_tasks",
        "apps.api.tasks.watermark_tasks",
        "apps.api.tasks.reminder_tasks",
        "apps.api.tasks.email_tasks",
        "apps.api.tasks.cleanup_tasks",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    broker_connection_retry_on_startup=True,
    broker_connection_retry=True,
    broker_connection_max_retries=5,
    broker_pool_limit=0,  # Disable connection pooling in web process to avoid stale connections
    # Define queues
    task_queues=(
        Queue("default"),
        Queue("transcoding"),
        Queue("email_high"),  # Magic codes, invites - immediate
        Queue("email_low"),   # Mentions, comments - can be delayed
    ),
    task_default_queue="default",
    # Route tasks to queues
    task_routes={
        "apps.api.tasks.transcode_tasks.*": {"queue": "transcoding"},
        "apps.api.tasks.email_tasks.send_magic_code_email": {"queue": "email_high"},
        "apps.api.tasks.email_tasks.send_invite_email": {"queue": "email_high"},
        "apps.api.tasks.email_tasks.send_mention_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_comment_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_assignment_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_share_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_approval_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_project_added_email": {"queue": "email_low"},
    },
    # Rate limiting for email queues (SES limits)
    task_annotations={
        "apps.api.tasks.email_tasks.*": {"rate_limit": "10/s"},  # 10 emails per second
    },
)

celery_app.conf.beat_schedule = {
    "due-date-reminders": {
        "task": "send_due_date_reminders",
        "schedule": crontab(minute="0"),  # every hour
    },
    "reap-stale-uploads": {
        "task": "reap_stale_uploads",
        "schedule": crontab(minute="0"),  # every hour
    },
}


import threading
import logging

_task_logger = logging.getLogger("celery.dispatch")


def _dispatch_task(task, args, kwargs):
    """Actually send the task to Celery broker (runs in background thread)."""
    try:
        task.delay(*args, **kwargs)
    except (OperationalError, ConnectionError, OSError):
        try:
            with celery_app.producer_or_acquire() as producer:
                task.apply_async(args=args, kwargs=kwargs, producer=producer)
        except Exception:
            _task_logger.warning("Failed to dispatch task %s after retry", task.name)
    except Exception:
        _task_logger.warning("Failed to dispatch task %s", task.name)


def send_task_safe(task, *args, **kwargs):
    """Send a Celery task in a background thread so it never blocks the API response.

    Broker connections can take seconds (especially with pool_limit=0).
    This ensures the API returns immediately while the task is dispatched async.
    """
    thread = threading.Thread(
        target=_dispatch_task,
        args=(task, args, kwargs),
        daemon=True,
    )
    thread.start()
