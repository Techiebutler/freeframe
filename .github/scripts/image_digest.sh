#!/usr/bin/env bash
# Print the digest a registry reference points at, or nothing when the tag
# does not exist. Used by publish-images.yml and promote-stable.yml.
#
#   .github/scripts/image_digest.sh ghcr.io/techiebutler/freeframe-api:1.21.0
#
# `imagetools inspect` exits 1 both for a missing tag and for an auth or
# network error. Only the first prints `not found`, so anything else fails
# here: a registry outage must never read as "no image", or a rebuild would
# skip re-pointing its aliases and a promotion check would be meaningless.
set -euo pipefail

ref="${1:?usage: image_digest.sh <image>:<tag>}"
err="$(mktemp)"
trap 'rm -f "$err"' EXIT

if out="$(docker buildx imagetools inspect --format '{{json .Manifest}}' "$ref" 2>"$err")"; then
  digest="$(jq -r .digest <<<"$out")"
  if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "image_digest.sh: unexpected digest for ${ref}: ${digest}" >&2
    exit 1
  fi
  echo "$digest"
elif grep -q "not found" "$err"; then
  : # missing tag: print nothing
else
  cat "$err" >&2
  exit 1
fi
