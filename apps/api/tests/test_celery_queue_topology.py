"""Guards that every Celery task is actually reachable by a running worker.

Regression test for #240: four beat-scheduled tasks plus `apply_watermark`
routed to the `default` queue, which no worker in either compose file
consumed. Everything looked healthy and the tasks simply never ran.

Unit tests on a task body cannot catch that. This asserts the wiring itself:
the queue a task routes to must appear in some worker's `-Q` list.
"""
import re
from pathlib import Path

import pytest

# Importing the task modules is what registers the tasks on the app.
from apps.api.tasks import celery_app as celery_module
from apps.api.tasks import (  # noqa: F401  (imported for registration side effect)
    cleanup_tasks,
    email_tasks,
    reminder_tasks,
    transcode_tasks,
    watermark_tasks,
)

celery_app = celery_module.celery_app

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_FILES = ("docker-compose.prod.yml", "docker-compose.dev.yml")


def consumed_queues(compose_filename: str) -> set[str]:
    """Every queue name any worker in this compose file subscribes to."""
    path = REPO_ROOT / compose_filename
    if not path.is_file():
        # The API container mounts only apps/api, so the compose files are not
        # there. CI runs from a full checkout, which is what this guards.
        pytest.skip(f"{compose_filename} not present (not a full checkout)")
    text = path.read_text()
    queues: set[str] = set()
    for match in re.finditer(r"worker\s+-Q\s+([\w,]+)", text):
        queues.update(match.group(1).split(","))
    return queues


def registered_task_names() -> list[str]:
    """Application task names, excluding Celery's own internal tasks."""
    return sorted(
        name for name in celery_app.tasks if not name.startswith("celery.")
    )


def effective_queue(task_name: str) -> str:
    """The queue a task really lands on when dispatched.

    A `queue=` argument on the task decorator wins over `task_routes`,
    which in turn wins over `task_default_queue`.
    """
    task = celery_app.tasks[task_name]
    explicit = getattr(task, "queue", None)
    if explicit:
        return explicit
    route = celery_app.amqp.router.route({}, task_name)
    queue = route.get("queue")
    if queue is None:
        return celery_app.conf.task_default_queue
    return getattr(queue, "name", queue)


@pytest.mark.parametrize("compose_filename", COMPOSE_FILES)
def test_every_registered_task_routes_to_a_consumed_queue(compose_filename):
    consumed = consumed_queues(compose_filename)
    assert consumed, f"no worker -Q flags found in {compose_filename}"

    stranded = {
        name: effective_queue(name)
        for name in registered_task_names()
        if effective_queue(name) not in consumed
    }

    assert not stranded, (
        f"{len(stranded)} task(s) route to a queue no worker in "
        f"{compose_filename} consumes, so they would never execute: {stranded}. "
        f"Queues consumed there: {sorted(consumed)}."
    )


def test_every_beat_scheduled_task_is_registered():
    """A beat entry naming a task that does not exist would also never run."""
    registered = set(registered_task_names())
    scheduled = {
        entry["task"] for entry in celery_app.conf.beat_schedule.values()
    }
    unknown = scheduled - registered
    assert not unknown, f"beat schedules unregistered task(s): {sorted(unknown)}"
