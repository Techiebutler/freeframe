"""Deploy compose files (opt-in HTTPS, published images, bundled storage).

The base docker-compose.prod.yml routes by PathPrefix only. Traefik derives the
domains it asks Let's Encrypt for from Host() rules, so with no Host() rule it
logs `No domain parsed in provider ACME` and never requests a certificate, even
with DOMAIN and ACME_EMAIL set. docker-compose.https.yml adds Host() routers on
the websecure entrypoint and an http -> https redirect, and is opt-in: the base
file must not change for anyone who does not pass `-f docker-compose.https.yml`.

docker-compose.images.yml names the published GHCR images,
docker-compose.storage.yml runs the optional bundled Silo storage and
docker-compose.gpu.yml gives the transcoding worker an NVIDIA GPU. All are
opt-in extra `-f` files too: nothing here may change docker-compose.prod.yml.
"""
import re
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
PROD_COMPOSE = REPO_ROOT / "docker-compose.prod.yml"
HTTPS_COMPOSE = REPO_ROOT / "docker-compose.https.yml"
IMAGES_COMPOSE = REPO_ROOT / "docker-compose.images.yml"
STORAGE_COMPOSE = REPO_ROOT / "docker-compose.storage.yml"
GPU_COMPOSE = REPO_ROOT / "docker-compose.gpu.yml"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"

APP_SERVICES = ("api", "worker", "email_worker", "maintenance_worker", "beat", "web")
API_IMAGE_SERVICES = ("api", "worker", "email_worker", "maintenance_worker", "beat")
SILO_TAG = "RELEASE.2026-09-16T00-00-00Z"

# The commented-out Silo block in docker-compose.prod.yml, byte for byte. A
# clone that uncommented it must not get a `git pull` conflict, so it never
# changes; new installs use docker-compose.storage.yml instead.
PROD_SILO_BLOCK = """\
  # minio:
  #   image: pgsty/silo:RELEASE.2026-09-16T00-00-00Z   # maintained MinIO fork; minio/minio is no longer pullable (#461)
  #   command: server /data --console-address ":9001"
  #   environment:
  #     MINIO_ROOT_USER: ${S3_ACCESS_KEY}
  #     MINIO_ROOT_PASSWORD: ${S3_SECRET_KEY}
  #   volumes:
  #     - miniodata:/data
  #   healthcheck:
  #     test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
  #     interval: 10s
  #     timeout: 5s
  #     retries: 5
  #   restart: unless-stopped
  #   labels:
  #     - traefik.enable=true
  #     - traefik.http.routers.minio.rule=Host(`storage.${DOMAIN}`)
  #     - traefik.http.routers.minio.entrypoints=websecure
  #     - traefik.http.routers.minio.tls.certresolver=letsencrypt
  #     - traefik.http.services.minio.loadbalancer.server.port=9000
  #
  # minio-init:                     # one-shot: create the bucket (idempotent)
  #   image: pgsty/mc:RELEASE.2026-09-16T00-00-00Z
  #   env_file:
  #     - .env.prod                    # the S3_* vars below are read inside the container
  #   depends_on:
  #     minio:
  #       condition: service_healthy
  #   entrypoint: >
  #     /bin/sh -c "
  #     mc alias set local http://minio:9000 $${S3_ACCESS_KEY} $${S3_SECRET_KEY} &&
  #     mc mb --ignore-existing local/$${S3_BUCKET}
  #     "
"""


def _services(path: Path) -> dict:
    return yaml.safe_load(path.read_text())["services"]


def _labels(path: Path, service: str) -> dict[str, str]:
    """List-form labels as {key: value} (compose merges list labels by key)."""
    out = {}
    for item in _services(path)[service]["labels"]:
        key, _, value = item.partition("=")
        out[key] = value
    return out


def test_https_file_routes_by_host():
    for service in ("web", "api"):
        labels = _labels(HTTPS_COMPOSE, service)
        router = f"traefik.http.routers.{service}-https"
        rule = labels[f"{router}.rule"]
        assert rule.startswith("Host(`") and "DOMAIN:?" in rule, rule
        assert labels[f"{router}.entrypoints"] == "websecure"
        assert labels[f"{router}.tls.certresolver"] == "letsencrypt"
        assert labels[f"{router}.service"] == service

    web_rule = _labels(HTTPS_COMPOSE, "web")["traefik.http.routers.web-https.rule"]
    assert web_rule.endswith("`)") and "&&" not in web_rule, web_rule

    api = _labels(HTTPS_COMPOSE, "api")
    api_rule = api["traefik.http.routers.api-https.rule"]
    assert api_rule.startswith("Host(`") and "DOMAIN:?" in api_rule
    assert api_rule.endswith(" && PathPrefix(`/api`)"), api_rule
    assert api["traefik.http.routers.api-https.middlewares"] == "strip-api-prefix"


def test_https_file_requires_acme_email():
    # The base Traefik command cannot change, so the requirement is enforced by
    # interpolation in the override.
    env = _services(HTTPS_COMPOSE)["traefik"]["environment"]
    assert "ACME_EMAIL:?" in env["ACME_EMAIL"], env


def test_https_file_redirects_plain_http():
    web = _labels(HTTPS_COMPOSE, "web")
    api = _labels(HTTPS_COMPOSE, "api")
    assert (
        web["traefik.http.middlewares.https-redirect.redirectscheme.scheme"] == "https"
    )
    assert web["traefik.http.routers.web.middlewares"] == "https-redirect"
    # Redirect first, then strip the prefix.
    assert (
        api["traefik.http.routers.api.middlewares"]
        == "https-redirect,strip-api-prefix"
    )


def test_https_file_only_adds_to_the_base_file():
    base = _services(PROD_COMPOSE)
    over = _services(HTTPS_COMPOSE)
    assert set(over) <= {"traefik", "api", "web"}
    for service in ("api", "web"):
        assert set(over[service]) == {"labels"}
    # The only base label the override may re-set is the plain-http router's
    # middlewares attachment; everything else is new.
    for service in ("api", "web"):
        base_labels = _labels(PROD_COMPOSE, service)
        for key, value in _labels(HTTPS_COMPOSE, service).items():
            if key in base_labels:
                assert key == f"traefik.http.routers.{service}.middlewares", key
    assert "command" not in over["traefik"]
    assert base["traefik"]["image"] == "traefik:v2.11"


def test_base_prod_file_unchanged():
    """Opt-in means opt-in: the base file's behaviour is frozen here."""
    services = _services(PROD_COMPOSE)
    assert set(services) == {
        "traefik",
        "postgres",
        "redis",
        "api",
        "worker",
        "email_worker",
        "maintenance_worker",
        "beat",
        "web",
    }
    for name in APP_SERVICES:
        assert "image" not in services[name], name

    assert services["api"]["labels"] == [
        "traefik.enable=true",
        "traefik.http.routers.api.rule=PathPrefix(`/api`)",
        "traefik.http.routers.api.entrypoints=web",
        "traefik.http.routers.api.middlewares=strip-api-prefix",
        "traefik.http.routers.api-secure.rule=PathPrefix(`/api`)",
        "traefik.http.routers.api-secure.entrypoints=websecure",
        "traefik.http.routers.api-secure.tls.certresolver=letsencrypt",
        "traefik.http.routers.api-secure.middlewares=strip-api-prefix",
        "traefik.http.routers.api-secure.service=api",
        "traefik.http.middlewares.strip-api-prefix.stripprefix.prefixes=/api",
        "traefik.http.services.api.loadbalancer.server.port=8000",
    ]
    assert services["web"]["labels"] == [
        "traefik.enable=true",
        "traefik.http.routers.web.rule=PathPrefix(`/`)",
        "traefik.http.routers.web.entrypoints=web",
        "traefik.http.routers.web.priority=1",
        "traefik.http.routers.web-secure.rule=PathPrefix(`/`)",
        "traefik.http.routers.web-secure.entrypoints=websecure",
        "traefik.http.routers.web-secure.tls.certresolver=letsencrypt",
        "traefik.http.routers.web-secure.priority=1",
        "traefik.http.routers.web-secure.service=web",
        "traefik.http.services.web.loadbalancer.server.port=3000",
    ]

    for name in ("api", "worker", "email_worker", "maintenance_worker", "beat"):
        assert services[name]["build"] == {
            "context": ".",
            "dockerfile": "apps/api/Dockerfile.prod",
        }, name

    web_build = dict(services["web"]["build"])
    args = web_build.pop("args")
    assert web_build == {"context": "./apps/web", "dockerfile": "Dockerfile.prod"}
    # NEXT_PUBLIC_UPLOAD_CONCURRENCY is being removed by a separate change, so
    # it may be present or absent; every other build arg is frozen.
    args.pop("NEXT_PUBLIC_UPLOAD_CONCURRENCY", None)
    assert args == {
        "NEXT_PUBLIC_API_URL": "/api",
        "NEXT_PUBLIC_BASE_PATH": "${NEXT_PUBLIC_BASE_PATH:-}",
    }


def test_base_prod_file_silo_block_unchanged():
    assert PROD_SILO_BLOCK in PROD_COMPOSE.read_text()


def test_images_file_names_every_app_service():
    services = _services(IMAGES_COMPOSE)
    assert set(services) == set(APP_SERVICES)
    versions = set()
    for name in API_IMAGE_SERVICES:
        assert set(services[name]) == {"image"}, name
        m = re.fullmatch(
            r"ghcr\.io/techiebutler/freeframe-api:\$\{FREEFRAME_VERSION:-(\d+\.\d+\.\d+)\}",
            services[name]["image"],
        )
        assert m, services[name]["image"]
        versions.add(m.group(1))
    assert set(services["web"]) == {"image"}
    m = re.fullmatch(
        r"ghcr\.io/techiebutler/freeframe-web:\$\{FREEFRAME_VERSION:-(\d+\.\d+\.\d+)\}",
        services["web"]["image"],
    )
    assert m, services["web"]["image"]
    versions.add(m.group(1))
    assert len(versions) == 1, versions


def test_images_default_version_matches_changelog():
    # The release PR bumps the default; this fails until it does.
    released = re.search(
        r"^## \[(\d+\.\d+\.\d+)\]", CHANGELOG.read_text(), re.MULTILINE
    ).group(1)
    image = _services(IMAGES_COMPOSE)["api"]["image"]
    assert f"FREEFRAME_VERSION:-{released}}}" in image, (released, image)


def test_storage_file_matches_commented_block():
    services = _services(STORAGE_COMPOSE)

    minio = services["minio"]
    assert minio["image"] == f"pgsty/silo:{SILO_TAG}"
    assert minio["command"] == 'server /data --console-address ":9001"'
    assert minio["volumes"] == ["miniodata:/data"]
    assert minio["restart"] == "unless-stopped"
    assert minio["environment"] == {
        "MINIO_ROOT_USER": "${S3_ACCESS_KEY}",
        "MINIO_ROOT_PASSWORD": "${S3_SECRET_KEY}",
    }
    # Only the S3 port, and only where STORAGE_PORT_BIND says. The console
    # (9001) is never published.
    assert minio["ports"] == ["${STORAGE_PORT_BIND:-127.0.0.1:9000}:9000"]
    assert minio["healthcheck"]["test"] == [
        "CMD",
        "curl",
        "-f",
        "http://localhost:9000/minio/health/live",
    ]

    labels = _labels(STORAGE_COMPOSE, "minio")
    assert labels["traefik.enable"] == "${STORAGE_ROUTED:-false}"
    assert (
        labels["traefik.http.routers.minio.rule"]
        == "Host(`${STORAGE_DOMAIN:-storage.invalid}`)"
    )
    assert labels["traefik.http.routers.minio.entrypoints"] == "websecure"
    assert labels["traefik.http.routers.minio.tls.certresolver"] == "letsencrypt"
    assert labels["traefik.http.services.minio.loadbalancer.server.port"] == "9000"

    init = services["minio-init"]
    assert init["image"] == f"pgsty/mc:{SILO_TAG}"
    assert init["env_file"] == [".env.prod"]
    assert init["depends_on"] == {"minio": {"condition": "service_healthy"}}
    assert "mc mb --ignore-existing" in init["entrypoint"]

    for name in API_IMAGE_SERVICES:
        assert services[name]["depends_on"] == {
            "minio": {"condition": "service_healthy"}
        }, name

    assert set(services) == {"minio", "minio-init", *API_IMAGE_SERVICES}
    assert "miniodata" in yaml.safe_load(STORAGE_COMPOSE.read_text())["volumes"]

    # Same pinned tags as the commented block in the base file.
    base = PROD_COMPOSE.read_text()
    assert f"pgsty/silo:{SILO_TAG}" in base and f"pgsty/mc:{SILO_TAG}" in base


def test_gpu_file_touches_only_the_worker():
    services = _services(GPU_COMPOSE)
    assert set(services) == {"worker"}
    assert set(services["worker"]) == {"environment", "deploy"}
    # Nothing but the GPU reservation: no limits, no replicas, no restart
    # policy that would change the base file's worker.
    assert services["worker"]["deploy"] == {
        "resources": {"reservations": {"devices": services["worker"]["deploy"]["resources"]["reservations"]["devices"]}}
    }


def test_gpu_file_reserves_an_nvidia_gpu_with_the_video_capability():
    worker = _services(GPU_COMPOSE)["worker"]
    devices = worker["deploy"]["resources"]["reservations"]["devices"]
    assert len(devices) == 1, devices
    device = devices[0]
    assert device["driver"] == "nvidia"
    assert device["count"] == 1
    # "gpu" picks Docker's NVIDIA driver; NVENC needs the "video" driver
    # capability, and nvidia-smi (the transcoder's check, and status's) needs
    # "utility". Docker passes these on as NVIDIA_DRIVER_CAPABILITIES.
    assert set(device["capabilities"]) == {"gpu", "compute", "utility", "video"}
    env = worker["environment"]
    assert env["NVIDIA_DRIVER_CAPABILITIES"] == "compute,utility,video"


def test_gpu_file_prefers_nvenc_and_keeps_the_cpu_fallback():
    env = _services(GPU_COMPOSE)["worker"]["environment"]
    # NVIDIA, not a backend that refuses to run without one: the transcoder
    # falls back to the CPU when NVENC is missing or fails (detect_backend).
    # A TRANSCODER_PIPELINE in .env.prod still wins.
    assert env["TRANSCODER_PIPELINE"] == "${TRANSCODER_PIPELINE:-NVIDIA}"
    assert set(env) == {"TRANSCODER_PIPELINE", "NVIDIA_DRIVER_CAPABILITIES"}


def test_gpu_pipeline_maps_to_nvenc_with_cpu_fallback():
    # The value the GPU file sets is one the transcoder knows, and it never
    # forces a GPU that is not there.
    import os
    from unittest import mock

    from packages.transcoder import ffmpeg_transcoder as ft

    assert ft._pipeline_to_backend("NVIDIA") == "nvenc"

    with mock.patch.dict(os.environ, {"TRANSCODER_PIPELINE": "NVIDIA"}), \
            mock.patch.object(ft, "_nvidia_available", return_value=False):
        assert ft.detect_backend() == "cpu"


def test_base_prod_worker_has_no_gpu():
    worker = _services(PROD_COMPOSE)["worker"]
    assert "deploy" not in worker
    assert "environment" not in worker

