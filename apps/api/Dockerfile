FROM python:3.11-slim

WORKDIR /workspace

RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 -o Acquire::https::No-Cache=true update \
    && apt-get -o Acquire::Retries=5 -o Acquire::https::No-Cache=true install -y \
    ffmpeg \
    imagemagick \
    poppler-utils \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install API dependencies
COPY apps/api/requirements.txt /workspace/apps/api/requirements.txt
RUN pip install --no-cache-dir -r /workspace/apps/api/requirements.txt

# Copy transcoder package and API
COPY packages/transcoder /workspace/packages/transcoder
COPY apps/api /workspace/apps/api

# Stay in /workspace so imports work as packages
WORKDIR /workspace

CMD ["uvicorn", "apps.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
