"""A container stop has to reach Celery.

`sh -c "celery ..."` leaves the shell as the container's main process. dash does
not forward SIGTERM, so a stop waited out the grace period and killed the worker.
"""
import shlex
from pathlib import Path

import pytest
import yaml

PROD_COMPOSE = Path(__file__).resolve().parents[3] / "docker-compose.prod.yml"
CELERY_SERVICES = {"worker", "email_worker", "maintenance_worker", "beat"}


def _celery_services():
    if not PROD_COMPOSE.is_file():
        pytest.skip("docker-compose.prod.yml not present (not a full checkout)")
    services = yaml.safe_load(PROD_COMPOSE.read_text())["services"]
    return {
        name: service
        for name, service in services.items()
        if "celery" in str(service.get("command", ""))
    }


def test_the_celery_services_are_the_ones_checked_here():
    assert set(_celery_services()) == CELERY_SERVICES


@pytest.mark.parametrize("name", sorted(CELERY_SERVICES))
def test_celery_replaces_the_shell(name):
    tokens = shlex.split(_celery_services()[name]["command"])
    assert tokens[:2] == ["sh", "-c"]
    assert shlex.split(tokens[2])[:2] == ["exec", "celery"]


@pytest.mark.parametrize("name", sorted(CELERY_SERVICES))
def test_an_init_process_reaps_orphans(name):
    assert _celery_services()[name].get("init") is True


def test_only_the_transcoding_worker_gets_a_long_stop():
    """A transcode may finish; nothing else should hold up a deploy."""
    grace = {
        name: service["stop_grace_period"]
        for name, service in _celery_services().items()
        if "stop_grace_period" in service
    }
    assert grace == {"worker": "10m"}
