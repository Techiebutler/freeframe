FROM python:3.11-slim

WORKDIR /workspace

RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install API dependencies.
#
# This is the DEV image, and it installs requirements-dev.txt: the test tooling
# now lives there rather than in requirements.txt, and every documented way to
# run the suite goes through a container built from this file
# (CONTRIBUTING.md, docs/contributing.md, AGENTS.md, the PR template). The
# production image is Dockerfile.prod and deliberately stays on
# requirements.txt, which is what keeps pytest out of production.
#
# requirements-dev.txt opens with `-r requirements.txt`, so both have to be
# copied even though only one is installed.
COPY apps/api/requirements.txt apps/api/requirements-dev.txt /workspace/apps/api/
RUN pip install --no-cache-dir -r /workspace/apps/api/requirements-dev.txt

# Copy transcoder package and API
COPY packages/transcoder /workspace/packages/transcoder
COPY apps/api /workspace/apps/api

# Stay in /workspace so imports work as packages
WORKDIR /workspace

CMD ["uvicorn", "apps.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
