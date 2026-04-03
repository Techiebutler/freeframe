"""HLS proxy for secure video streaming.

Rewrites m3u8 manifests so that:
- Variant playlist URLs go through this proxy (with token auth)
- Segment (.ts) URLs become presigned S3 URLs (direct to S3)

This eliminates the need for a public bucket policy on processed/*.
"""

import logging
import posixpath
from datetime import datetime, timedelta, timezone

from jose import jwt, JWTError
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from ..config import settings
from ..services.s3_service import generate_presigned_get_url, get_s3_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["streaming"])


def create_hls_token(s3_prefix: str, expires_hours: int = 4) -> str:
    """Create a short-lived JWT for HLS proxy access."""
    payload = {
        "sub": "hls",
        "pfx": s3_prefix,
        "exp": datetime.now(timezone.utc) + timedelta(hours=expires_hours),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def _verify_hls_token(token: str) -> str:
    """Verify HLS token and return s3_prefix."""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        if payload.get("sub") != "hls":
            raise HTTPException(status_code=403, detail="Invalid token type")
        return payload["pfx"]
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def _rewrite_manifest(content: str, s3_prefix: str, manifest_path: str, token: str) -> str:
    """Rewrite URLs in an m3u8 manifest.

    - .m3u8 references -> proxy URLs with token (appended as query param)
    - .ts references -> presigned S3 URLs
    """
    manifest_dir = posixpath.dirname(manifest_path)
    lines = content.split("\n")
    result = []

    for line in lines:
        stripped = line.strip()

        # Pass through comments/tags and empty lines
        if not stripped or stripped.startswith("#"):
            result.append(line)
            continue

        # Resolve segment/playlist path relative to current manifest directory
        if manifest_dir:
            relative_key = f"{manifest_dir}/{stripped}"
        else:
            relative_key = stripped

        if stripped.endswith(".m3u8"):
            # Variant playlist -> proxy URL with token
            result.append(f"{relative_key}?token={token}")
        elif stripped.endswith(".ts"):
            # Segment -> presigned S3 URL (direct to S3, 4-hour expiry)
            s3_key = f"{s3_prefix}/{relative_key}"
            result.append(generate_presigned_get_url(s3_key, expires_in=14400))
        else:
            result.append(line)

    return "\n".join(result)


@router.get("/hls/{path:path}")
def hls_proxy(path: str, token: str = Query(...)):
    """Proxy HLS manifests with URL rewriting for secure streaming."""
    s3_prefix = _verify_hls_token(token)

    # Only proxy m3u8 manifests
    if not path.endswith(".m3u8"):
        raise HTTPException(status_code=400, detail="Only .m3u8 files are proxied")

    # Prevent directory traversal
    normalised = posixpath.normpath(path)
    if normalised.startswith("..") or normalised.startswith("/"):
        raise HTTPException(status_code=400, detail="Invalid path")

    # Defense-in-depth: verify resolved key stays within the token's prefix
    s3_key = f"{s3_prefix}/{normalised}"
    if not s3_key.startswith(s3_prefix + "/"):
        raise HTTPException(status_code=400, detail="Invalid path")

    # Fetch manifest from S3
    s3 = get_s3_client()
    try:
        obj = s3.get_object(Bucket=settings.s3_bucket, Key=s3_key)
        content = obj["Body"].read().decode("utf-8")
    except s3.exceptions.NoSuchKey:
        raise HTTPException(status_code=404, detail="Manifest not found")
    except Exception as e:
        logger.error("Failed to fetch HLS manifest %s: %s", s3_key, e)
        raise HTTPException(status_code=404, detail="Manifest not found")

    rewritten = _rewrite_manifest(content, s3_prefix, normalised, token)

    return Response(
        content=rewritten,
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-cache"},
    )
