#!/bin/sh
# Refuse to start when NEXT_PUBLIC_BASE_PATH does not match the base path this
# image was built with. Next bakes the base path into the build, so a mismatch
# would not fail loudly: the server would start and every link would be wrong.
set -eu

manifest=/app/.next/required-server-files.json
if ! baked=$(node -p "require('$manifest').config.basePath||''" 2>/dev/null); then
  echo "FreeFrame: could not read this image's base path from $manifest; the image may be damaged, rebuild or re-pull it." >&2
  exit 1
fi
runtime="${NEXT_PUBLIC_BASE_PATH:-}"

if [ -n "$runtime" ] && [ "$runtime" != "$baked" ]; then
  if [ -z "$baked" ]; then
    echo "FreeFrame: this web image was built to be served from \"/\", but NEXT_PUBLIC_BASE_PATH is \"$runtime\". Published images only support the domain root. To serve FreeFrame under a sub-path, build the web image yourself: docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build web" >&2
  else
    echo "FreeFrame: this web image was built to be served from \"$baked\", but NEXT_PUBLIC_BASE_PATH is \"$runtime\". NEXT_PUBLIC_BASE_PATH must match the path the image was built for, or the web image must be rebuilt: docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build web" >&2
  fi
  exit 1
fi

exec "$@"
