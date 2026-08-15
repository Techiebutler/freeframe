"""Guards that every Celery task is actually reachable by a running worker.

Regression test for #240: four beat-scheduled tasks plus `apply_watermark`
routed to the `default` queue, which no worker in either compose file
consumed. Everything looked healthy and the tasks simply never ran.

Unit tests on a task body cannot catch that. This asserts the wiring itself:
the queue a task routes to must appear in some worker's `-Q` list.

Two things this file deliberately does NOT do, because both let the guard pass
while #240 is present:

- It does not grep the compose files as text. A commented-out or profile-gated
  worker is not a consumer, and a text match cannot tell the difference.
- It does not hand-maintain a list of task modules. The task set is whatever a
  real worker registers, taken from `celery_app.conf.include`, so a new module
  is covered the moment it is added.
"""
import shlex
from pathlib import Path

import pytest
import yaml

from apps.api.tasks.celery_app import celery_app

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPOSE_FILES = ("docker-compose.prod.yml", "docker-compose.dev.yml")


def queues_from_command(command) -> set[str]:
    """Queue names a `celery ... worker -Q a,b` command actually subscribes to."""
    if command is None:
        return set()

    if isinstance(command, list):
        tokens = [str(t) for t in command]
    else:
        tokens = shlex.split(str(command))
        # The prod compose wraps the real command in `sh -c "celery ..."`.
        if tokens[:2] == ["sh", "-c"] and len(tokens) > 2:
            tokens = shlex.split(tokens[2])

    # `beat` publishes but consumes nothing, so only workers count.
    if "worker" not in tokens:
        return set()

    queues: set[str] = set()
    for i, token in enumerate(tokens):
        value = None
        if token in ("-Q", "--queues") and i + 1 < len(tokens):
            value = tokens[i + 1]
        elif token.startswith("--queues="):
            value = token.split("=", 1)[1]
        elif token.startswith("-Q") and len(token) > 2:
            value = token[2:]
        if value:
            queues.update(q.strip() for q in value.split(",") if q.strip())
    return queues


def consumed_queues(compose_filename: str) -> set[str]:
    """Every queue a worker started by a plain `docker compose up` subscribes to."""
    path = REPO_ROOT / compose_filename
    if not path.is_file():
        # The API container mounts only apps/api, so the compose files are not
        # there. CI runs from a full checkout, which is what this guards.
        pytest.skip(f"{compose_filename} not present (not a full checkout)")

    compose = yaml.safe_load(path.read_text()) or {}
    queues: set[str] = set()
    for service in (compose.get("services") or {}).values():
        if not isinstance(service, dict):
            continue
        # A profile-gated service does not start unless the profile is asked
        # for, so it cannot be relied on to drain a queue.
        if service.get("profiles"):
            continue
        queues |= queues_from_command(service.get("command"))
    return queues


def registered_task_names() -> list[str]:
    """Exactly the application tasks a real worker would register."""
    celery_app.loader.import_default_modules()
    return sorted(name for name in celery_app.tasks if not name.startswith("celery."))


def effective_queue(task_name: str) -> str:
    """The queue a task really lands on when dispatched.

    A `queue=` argument on the task decorator wins over `task_routes`, which in
    turn wins over `task_default_queue`.
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


def test_task_modules_are_declared():
    """An empty include list would make the topology check trivially pass."""
    assert celery_app.conf.include, "celery_app.conf.include is empty"
    assert registered_task_names(), "no application tasks registered"


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
    scheduled = {entry["task"] for entry in celery_app.conf.beat_schedule.values()}
    unknown = scheduled - registered
    assert not unknown, f"beat schedules unregistered task(s): {sorted(unknown)}"
