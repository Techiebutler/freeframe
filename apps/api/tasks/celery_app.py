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
        "apps.api.tasks.product_feedback_tasks",
        "apps.api.tasks.checklist_tasks",
        "apps.api.tasks.iteration_tasks",
        "apps.api.tasks.feedback_tasks",
        "apps.api.tasks.agent_tasks",
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
    # A worker takes one job at a time instead of reserving four per slot. Reserved-but-waiting jobs
    # count as unacknowledged, and with late acks (process_asset below) an unacknowledged job older
    # than the visibility timeout is handed to another worker - a long queue would then run the
    # same file twice.
    worker_prefetch_multiplier=1,
    # How long an unacknowledged job stays invisible before Redis redelivers it. Only matters after
    # a worker is killed mid-job: redelivery then happens after this long. Must stay above the
    # longest legitimate encode (see FFMPEG_ENCODE_TIMEOUT_SECONDS) or a slow job runs twice.
    broker_transport_options={"visibility_timeout": 2 * 3600},
    # Define queues
    task_queues=(
        Queue("default"),
        Queue("transcoding"),
        Queue("email_high"),  # Invites - immediate
        Queue("email_low"),   # Mentions, comments - can be delayed
        *([Queue(settings.iteration_queue)] if settings.iteration_queue not in ("default", "transcoding", "email_high", "email_low") else []),
    ),
    task_default_queue="default",
    # Route tasks to queues
    task_routes={
        "apps.api.tasks.transcode_tasks.*": {"queue": "transcoding"},
        "apps.api.tasks.email_tasks.send_invite_email": {"queue": "email_high"},
        "apps.api.tasks.email_tasks.send_mention_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_comment_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_assignment_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_share_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_approval_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_project_added_email": {"queue": "email_low"},
        **{name: {"queue": settings.iteration_queue} for name in (
            "advance_iteration_request", "review_iteration_step", "sweep_iteration_requests",
            "prepare_checklist", "resume_checklists")},
    },
    # Rate limiting for email queues (SES limits)
    task_annotations={
        "apps.api.tasks.email_tasks.*": {"rate_limit": "10/s"},  # 10 emails per second
    },
)

celery_app.conf.beat_schedule = {
    "resume-checklists": {"task": "resume_checklists", "schedule": crontab(minute="*")},
    "daily-product-feedback": {
        "task": "send_product_feedback_digest",
        "schedule": crontab(minute=settings.product_feedback_digest_minute_utc,
                            hour=settings.product_feedback_digest_hour_utc),
    },
    "close-idle-feedback-rounds": {"task": "close_idle_feedback_rounds", "schedule": crontab(minute="*")},
    "sweep-agent-handins": {"task": "sweep_agent_handins", "schedule": crontab(minute="*")},
    "advance-iteration-requests": {"task": "sweep_iteration_requests", "schedule": 30.0},
    "due-date-reminders": {
        "task": "send_due_date_reminders",
        "schedule": crontab(minute="0"),  # every hour
    },
    "reap-stale-uploads": {
        "task": "reap_stale_uploads",
        "schedule": crontab(minute="0"),  # every hour
    },
    "fail-stuck-processing": {
        "task": "fail_stuck_processing",
        "schedule": crontab(minute="*/5"),
    },
    "cleanup-soft-deleted": {
        "task": "cleanup_soft_deleted",
        "schedule": crontab(minute=0, hour=3),  # daily at 03:00 UTC
    },
    "sweep-orphan-s3": {
        "task": "sweep_orphan_s3",
        "schedule": crontab(minute=0, hour=4, day_of_week=0),  # weekly, Sunday 04:00 UTC
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
