import logging
import os
import re
import time
from functools import lru_cache
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from ..config import settings

logger = logging.getLogger(__name__)

# Short timeouts for the one-off startup bucket check, so a slow or unreachable
# store can't hang app startup for boto3's default ~60s (deploy-test finding #6).
_STARTUP_S3_CONFIG = Config(connect_timeout=5, read_timeout=10, retries={"max_attempts": 2})

# HeadObject runs on the request path: /upload/complete asks it on every retry and
# /upload/abort on every cancellation, both of which the global rate limiter
# exempts. Boto3's defaults there are ~60s per attempt with five attempts behind
# them, which is minutes of a held threadpool slot and an open transaction for a
# single request, and enough concurrent ones exhaust the connection pool.
#
# The answer is only ever advisory -- every caller has a defined behaviour for
# "could not find out" -- so a check that cannot finish promptly is better
# abandoned than waited on.
_PROBE_S3_CONFIG = Config(connect_timeout=3, read_timeout=5, retries={"max_attempts": 2})

# S3 Content-Type and Cache-Control mappings
CONTENT_TYPE_MAP = {
    ".m3u8": ("application/vnd.apple.mpegurl", "no-cache"),
    ".ts": ("video/mp2t", "max-age=31536000"),
    ".jpg": ("image/jpeg", "max-age=86400"),
    ".jpeg": ("image/jpeg", "max-age=86400"),
    ".webp": ("image/webp", "max-age=86400"),
    ".mp3": ("audio/mpeg", "max-age=86400"),
    ".json": ("application/json", "max-age=86400"),
    ".png": ("image/png", "max-age=86400"),
}

def _is_aws_s3() -> bool:
    """Check if using AWS S3 (vs MinIO/local). Controlled by S3_STORAGE env var."""
    return settings.s3_storage.lower() == "s3"

# SigV4 everywhere. us-east-1 is the only region whose endpoint metadata lists "s3"
# alongside "s3v4", so with no explicit signature_version botocore registers
# _default_s3_presign_to_sigv2 and silently downgrades *presigned* URLs to SigV2 —
# server-side calls stay SigV4, and client.meta.config.signature_version still reads
# "s3v4", which makes it easy to miss. SigV2 breaks presigned PUTs that carry any
# Content-Type, and modern buckets reject it outright.
_SIGV4_CONFIG = Config(signature_version="s3v4")

# Self-hosted S3 backends (Garage, MinIO, …) commonly sit behind a reverse proxy
# without wildcard bucket DNS, so virtual-host addressing can't resolve — and some
# (Garage) reject SigV2 query auth outright. Path-style is layered on top of the
# SigV4 baseline for non-AWS mode.
_NON_AWS_COMPAT_CONFIG = Config(s3={"addressing_style": "path"}, signature_version="s3v4")

def _build_s3_client(config=None):
    """Construct an S3 client. Selection is driven by S3_STORAGE (see _is_aws_s3):
    - "s3"   -> native AWS S3 (no endpoint_url; S3_ENDPOINT is not used)
    - other  -> S3_ENDPOINT for MinIO or another S3-compatible backend
    Pass `config` (a botocore Config) when you need bounded timeouts (startup check).
    """
    kwargs = {
        "aws_access_key_id": settings.s3_access_key,
        "aws_secret_access_key": settings.s3_secret_key,
        "region_name": settings.s3_region,
    }
    baseline = _SIGV4_CONFIG
    if not _is_aws_s3():
        kwargs["endpoint_url"] = settings.s3_endpoint
        baseline = _NON_AWS_COMPAT_CONFIG
    # botocore's Config.merge lets the *argument* win, so merge onto the caller's
    # config to keep the baseline authoritative (a caller can still add
    # non-conflicting options like the startup timeouts).
    config = config.merge(baseline) if config is not None else baseline
    kwargs["config"] = config
    return boto3.client("s3", **kwargs)


@lru_cache(maxsize=1)
def get_s3_client():
    """The shared, cached S3 client for server-side operations (see _build_s3_client)."""
    return _build_s3_client()

@lru_cache(maxsize=1)
def _get_probe_client():
    """Client for bounded, advisory lookups on the request path (see _PROBE_S3_CONFIG).

    Kept separate from `get_s3_client` because its timeouts would be wrong for the
    calls that legitimately take a long time: CompleteMultipartUpload on a large
    object can sit for minutes while the backend assembles it, and cutting that
    off would turn a working upload into a failure.
    """
    return _build_s3_client(_PROBE_S3_CONFIG)

@lru_cache(maxsize=1)
def _get_presign_client():
    """
    Client for generating presigned URLs. Uses s3_public_endpoint if set,
    so presigned URLs are accessible from the browser (e.g. localhost:9000
    instead of minio:9000 in Docker).
    """
    # AWS S3 mode always uses native presigned URLs; s3_public_endpoint is a
    # MinIO/dev concept (rewrite the internal endpoint to a browser-reachable one)
    # and must never apply to AWS, or presigned URLs would point at the wrong host.
    endpoint = None if _is_aws_s3() else (settings.s3_public_endpoint or settings.s3_endpoint)
    kwargs = {
        "aws_access_key_id": settings.s3_access_key,
        "aws_secret_access_key": settings.s3_secret_key,
        "region_name": settings.s3_region,
    }
    if endpoint:
        kwargs["endpoint_url"] = endpoint
        kwargs["config"] = _NON_AWS_COMPAT_CONFIG
    else:
        kwargs["config"] = _SIGV4_CONFIG
    return boto3.client("s3", **kwargs)

def ensure_bucket_exists():
    """Create the S3 bucket if it does not exist (+ configure CORS/policy on non-AWS).

    Uses a short-timeout client so it fails fast rather than blocking for boto3's
    default ~60s if the store is slow/unreachable. Run via run_startup_bucket_setup()
    off the request path at startup — see main.py.
    """
    s3 = _build_s3_client(config=_STARTUP_S3_CONFIG)
    try:
        s3.head_bucket(Bucket=settings.s3_bucket)
    except ClientError as e:
        error_code = e.response["Error"]["Code"]
        if error_code in ("404", "NoSuchBucket"):
            # For AWS S3 in non-us-east-1 regions, need LocationConstraint
            if _is_aws_s3() and settings.s3_region != "us-east-1":
                s3.create_bucket(
                    Bucket=settings.s3_bucket,
                    CreateBucketConfiguration={"LocationConstraint": settings.s3_region}
                )
            else:
                s3.create_bucket(Bucket=settings.s3_bucket)
        elif error_code == "403":
            # Bucket exists but we don't have access, or using wrong credentials
            # For AWS S3, bucket likely already exists - skip creation
            if _is_aws_s3():
                pass  # Assume bucket exists, will fail on actual operations if not
            else:
                raise
        else:
            raise

    # Set CORS for browser-based uploads (presigned PUT)
    if not _is_aws_s3():
        # Browser Origin headers never include a path, so use the stripped
        # origin from FRONTEND_URL in AllowedOrigins (e.g.
        # https://host/freeframe -> https://host). Mirrors the CORS origin
        # used in main.py.
        _allowed_origins = [o for o in [settings.frontend_origin, "http://localhost:3000"] if o]
        try:
            # One rule per origin: Garage joins a rule's AllowedOrigins into a single
            # comma-separated Access-Control-Allow-Origin response header, which
            # browsers reject — with both origins in one rule, every cross-origin
            # request (HLS segments, presigned uploads) fails CORS in the browser.
            # AWS-style backends echo only the matching origin either way, so
            # per-origin rules behave identically everywhere.
            origins = list(dict.fromkeys(_allowed_origins))
            s3.put_bucket_cors(
                Bucket=settings.s3_bucket,
                CORSConfiguration={
                    "CORSRules": [
                        {
                            # Tighten from ["*"] to only the headers the
                            # browser upload + multipart flows actually send.
                            "AllowedHeaders": [
                                "Content-Type",
                                "Content-MD5",
                                "x-amz-content-sha256",
                                "x-amz-date",
                                "x-amz-decoded-content-length",
                            ],
                            # Drop DELETE: no presigned-DELETE flow exists.
                            "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
                            "AllowedOrigins": [origin],
                            "ExposeHeaders": ["ETag", "Content-Length", "x-amz-request-id"],
                            "MaxAgeSeconds": 3600,
                        }
                        for origin in origins
                    ]
                },
            )
        except ClientError as e:
            # Non-fatal, but surfaced: the browser PUTs each part straight to the
            # bucket, so without CORS allowing this origin no upload can start at
            # all. ExposeHeaders no longer has to include "ETag" -- completion
            # reads the parts from storage rather than from the browser -- but the
            # origin rules still matter, so warn and point at the docs.
            logger.warning(
                "Could not set bucket CORS on %r (%s). Browser uploads PUT directly to "
                "the bucket, so its CORS must allow your FreeFrame origin; configure it "
                "manually on your S3 provider — see docs/deployment.md (External S3 Storage).",
                settings.s3_bucket, e,
            )

        # NOTE: a public-read bucket policy on processed/* used to be set
        # here so HLS sub-playlists and .ts segments could be fetched
        # without presigned URLs. The HLS proxy in routers/hls_proxy.py
        # already rewrites .ts URLs to presigned S3 URLs, so the public
        # policy was dead weight and leaked any processed object to anyone
        # who guessed a key (UUIDs aren't secret — share-link presigned
        # GETs expose them). Removed for defense-in-depth; the bucket can
        # stay fully private.


def run_startup_bucket_setup(attempts: int = 5, base_delay: float = 3.0, _sleep=time.sleep) -> None:
    """App-startup entrypoint for bucket setup that NEVER raises.

    A slow or unreachable object store must not crash or block app startup, so this
    swallows every error and logs a clear warning instead. It retries a transient
    failure a few times with linear backoff, so a store that comes up shortly after
    the app self-heals without a manual restart (that self-heal was previously a
    side effect of the crash-loop that finding #6 intentionally removed). Call it off
    the request path (a daemon thread from the FastAPI lifespan) — see main.py.

    `_sleep` is injectable so tests can run the retry loop without real delays.
    """
    for attempt in range(1, attempts + 1):
        try:
            ensure_bucket_exists()
            return
        except Exception as e:  # noqa: BLE001 - startup must survive any storage failure
            where = "AWS" if _is_aws_s3() else settings.s3_endpoint
            if attempt < attempts:
                delay = base_delay * attempt
                logger.warning(
                    "S3/object-storage setup attempt %d/%d failed (S3_STORAGE=%s, endpoint=%s); "
                    "retrying in %.0fs: %s",
                    attempt, attempts, settings.s3_storage, where, delay, e,
                )
                _sleep(delay)
            else:
                logger.warning(
                    "S3/object-storage setup failed after %d attempts — uploads and streaming "
                    "will not work until storage is reachable and the app is restarted "
                    "(S3_STORAGE=%s, endpoint=%s): %s",
                    attempts, settings.s3_storage, where, e,
                )


def get_content_type(key: str) -> tuple[str, str]:
    """Return (content_type, cache_control) for a given S3 key."""
    import os
    ext = os.path.splitext(key)[1].lower()
    return CONTENT_TYPE_MAP.get(ext, ("application/octet-stream", "no-cache"))

def create_multipart_upload(s3_key: str, content_type: str) -> str:
    """Initiate a multipart upload and return the upload_id."""
    s3 = get_s3_client()
    response = s3.create_multipart_upload(
        Bucket=settings.s3_bucket,
        Key=s3_key,
        ContentType=content_type,
    )
    return response["UploadId"]

def presign_upload_part(s3_key: str, upload_id: str, part_number: int, expires_in: int = 3600) -> str:
    """Return a presigned URL for uploading a single part."""
    s3 = _get_presign_client()
    return s3.generate_presigned_url(
        "upload_part",
        Params={
            "Bucket": settings.s3_bucket,
            "Key": s3_key,
            "UploadId": upload_id,
            "PartNumber": part_number,
        },
        ExpiresIn=expires_in,
    )

def complete_multipart_upload(s3_key: str, upload_id: str, parts: list[dict]) -> None:
    """Complete a multipart upload. `parts` is a list of {"PartNumber": int, "ETag": str}."""
    s3 = get_s3_client()
    s3.complete_multipart_upload(
        Bucket=settings.s3_bucket,
        Key=s3_key,
        UploadId=upload_id,
        MultipartUpload={"Parts": parts},
    )

def abort_multipart_upload(s3_key: str, upload_id: str) -> None:
    """Abort a multipart upload and clean up uploaded parts."""
    s3 = get_s3_client()
    s3.abort_multipart_upload(
        Bucket=settings.s3_bucket,
        Key=s3_key,
        UploadId=upload_id,
    )


class MultipartUploadGone(Exception):
    """The multipart upload no longer exists.

    Either it was already completed — the usual cause is a retry after the
    response to the first CompleteMultipartUpload was lost — or the stale-upload
    reaper aborted it. HeadObject on the key tells the two apart.
    """


class ObjectSizeUnavailable(Exception):
    """HeadObject succeeded but reported no size, so nothing can be compared.

    Distinct from "the object is not there": the object may well be complete, we
    simply cannot confirm it. Callers that treat this as absence either delete a
    finished upload or report a missing one as done.
    """


class MultipartListingUnsupported(Exception):
    """The storage backend does not implement ListParts.

    Every backend we test against does, but "S3-compatible" is a wide claim and
    the upload must still complete on one that does not, so callers fall back to
    the parts list the client reported.
    """


# `NoSuchKey` and a bare 404 are here because backends disagree about which one
# an unknown UploadId produces; tusd special-cases the same set for the same reason.
UPLOAD_GONE_CODES = {"NoSuchUpload", "NoSuchKey", "404", "NotFound"}
# Deliberately narrow. A generic 400 such as `InvalidRequest` is not a statement about
# what a backend implements, and treating it as one would quietly downgrade a malformed
# request into trusting a parts list we cannot verify.
_LISTING_UNSUPPORTED_CODES = {"NotImplemented", "MethodNotAllowed"}


def list_upload_parts(s3_key: str, upload_id: str) -> list[dict]:
    """Every part the backend currently holds for an in-progress multipart upload.

    Returns dicts of PartNumber / ETag / Size, ascending by part number, paginated
    to exhaustion. At the 10 MB chunk size one page covers ~9.8 GB on AWS, but
    "no size cap by default" means more is reachable, and page size is a backend
    decision (MinIO defaults to 10000 per page where AWS uses 1000), so the loop
    is not optional.

    Raises MultipartUploadGone or MultipartListingUnsupported; see those docstrings.
    """
    s3 = get_s3_client()
    parts: list[dict] = []
    previous_marker = None
    kwargs = {"Bucket": settings.s3_bucket, "Key": s3_key, "UploadId": upload_id}
    while True:
        try:
            resp = s3.list_parts(**kwargs)
        except ClientError as e:
            code = str(e.response.get("Error", {}).get("Code", ""))
            if code in UPLOAD_GONE_CODES:
                raise MultipartUploadGone(s3_key) from e
            if code in _LISTING_UNSUPPORTED_CODES:
                raise MultipartListingUnsupported(code) from e
            raise
        for p in resp.get("Parts", []):
            parts.append({
                "PartNumber": p["PartNumber"],
                "ETag": p["ETag"],
                "Size": p.get("Size"),
            })
        if not resp.get("IsTruncated"):
            break
        marker = resp.get("NextPartNumberMarker")
        # Only ever echo back the backend's own marker. MinIO resolves a marker
        # naming a part number it does not hold to an empty page rather than to
        # the next part, so a synthesized one silently truncates the listing —
        # and concurrent uploads produce exactly the gaps that would trigger it.
        #
        # The marker must also strictly advance. A backend that keeps setting
        # IsTruncated while handing back the same marker would otherwise spin inside
        # a request handler indefinitely; refusing to stand still costs nothing.
        if marker in (None, "", 0):
            break
        if previous_marker is not None and marker <= previous_marker:
            logger.warning(
                "list_parts for %s stopped early: marker %r did not advance past %r",
                s3_key, marker, previous_marker,
            )
            break
        previous_marker = marker
        kwargs["PartNumberMarker"] = marker
    parts.sort(key=lambda p: p["PartNumber"])
    return parts


def head_object_size(s3_key: str) -> int | None:
    """ContentLength of an object, or None if it does not exist.

    Used to tell an already-completed upload from a reaped one, and to check what
    was assembled against what the client said it was sending. Size is the only
    integrity signal that is portable: the completed object's ETag is a composite
    whose form is not guaranteed off AWS.
    """
    s3 = _get_probe_client()
    try:
        resp = s3.head_object(Bucket=settings.s3_bucket, Key=s3_key)
    except ClientError as e:
        code = str(e.response.get("Error", {}).get("Code", ""))
        if code in UPLOAD_GONE_CODES:
            return None
        raise
    size = resp.get("ContentLength")
    if size is None:
        # HeadObjectOutput has no required members, so botocore simply omits the key
        # when the header is absent -- which happens behind proxies that strip or
        # chunk-encode HEAD responses. Subscripting raised KeyError, which is neither
        # a ClientError nor a BotoCoreError and so escaped every caller's handling as
        # a 500. "The object is there but I cannot size it" is an unanswered question,
        # not a missing object, so it must not collapse into the None above.
        raise ObjectSizeUnavailable(
            f"storage reported no ContentLength for {s3_key}"
        )
    return size

def build_download_filename(display_name: str, source: str | None) -> str:
    """Return display_name with an extension appended from `source` if missing.

    `source` is an original upload filename or an S3 key — whichever is most
    authoritative for the file's real extension. If the display name already
    ends with that extension (case-insensitive), it is returned unchanged.
    """
    if not source:
        return display_name
    ext = os.path.splitext(source)[1]
    if not ext:
        return display_name
    if display_name.lower().endswith(ext.lower()):
        return display_name
    return f"{display_name}{ext}"


MAX_DOWNLOAD_FILENAME_LEN = 200

# Control characters plus the bidirectional overrides. The latter matter here:
# a right-to-left override can visually reverse the tail of a name, so
# "invoice‮gnp.exe" is displayed to the user as "invoice exe.png".
_UNSAFE_FILENAME_CHARS = re.compile(
    r'[\x00-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]'
)


def build_content_disposition(download_filename: str) -> str:
    """Build a Content-Disposition value for a caller-supplied filename.

    The name reaches us unvalidated (a comment attachment's original_filename
    is whatever the uploader sent), so it is stripped of control and bidi
    characters, flattened of path separators and length-capped before use.
    Both forms defined by RFC 6266 are emitted: a quoted ASCII `filename=` that
    every client understands, and `filename*=` for the real UTF-8 name, since a
    non-ASCII name has no representation in the quoted form.
    """
    from urllib.parse import quote

    name = _UNSAFE_FILENAME_CHARS.sub('', download_filename)
    name = name.replace('\\', '_').replace('/', '_').strip()
    name = name[:MAX_DOWNLOAD_FILENAME_LEN].strip() or "download"
    ascii_fallback = name.encode('ascii', 'replace').decode('ascii').replace('"', "'")
    return (
        f'attachment; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{quote(name, safe='')}"
    )


def generate_presigned_put_url(s3_key: str, content_type: str | None = None, expires_in: int = 3600) -> str:
    """Generate a presigned PUT URL for browser-based upload.

    Uses s3_public_endpoint so the URL is reachable from the browser
    (e.g. https://public-host instead of http://localhost:9000).
    """
    s3 = _get_presign_client()
    params: dict = {"Bucket": settings.s3_bucket, "Key": s3_key}
    if content_type:
        params["ContentType"] = content_type
    return s3.generate_presigned_url("put_object", Params=params, ExpiresIn=expires_in)


def generate_presigned_get_url(s3_key: str, expires_in: int = 3600, download_filename: str | None = None) -> str:
    """Generate a presigned GET URL for an object.

    Args:
        s3_key: The S3 object key.
        expires_in: URL expiry in seconds.
        download_filename: If set, adds Content-Disposition: attachment header
                          so the browser downloads with this filename.
    """
    s3 = _get_presign_client()
    params: dict = {"Bucket": settings.s3_bucket, "Key": s3_key}
    if download_filename:
        params["ResponseContentDisposition"] = build_content_disposition(download_filename)
    return s3.generate_presigned_url(
        "get_object",
        Params=params,
        ExpiresIn=expires_in,
    )

def put_object(s3_key: str, body: bytes, content_type: str | None = None, cache_control: str | None = None) -> None:
    """Upload a small object directly (for processed files like thumbnails)."""
    s3 = get_s3_client()
    kwargs = {"Bucket": settings.s3_bucket, "Key": s3_key, "Body": body}
    if content_type:
        kwargs["ContentType"] = content_type
    if cache_control:
        kwargs["CacheControl"] = cache_control
    s3.put_object(**kwargs)

def delete_object(s3_key: str) -> None:
    s3 = get_s3_client()
    s3.delete_object(Bucket=settings.s3_bucket, Key=s3_key)


def list_stale_multipart_uploads(cutoff):
    """Return (key, upload_id) for in-progress multipart uploads initiated before `cutoff`."""
    s3 = get_s3_client()
    stale = []
    kwargs = {"Bucket": settings.s3_bucket}
    while True:
        resp = s3.list_multipart_uploads(**kwargs)
        for up in resp.get("Uploads", []):
            if up["Initiated"] < cutoff:
                stale.append((up["Key"], up["UploadId"]))
        if resp.get("IsTruncated"):
            kwargs["KeyMarker"] = resp.get("NextKeyMarker")
            kwargs["UploadIdMarker"] = resp.get("NextUploadIdMarker")
        else:
            break
    return stale


def list_keys(prefix: str):
    """Yield (key, last_modified, size) for every object under `prefix`, paginated."""
    s3 = get_s3_client()
    kwargs = {"Bucket": settings.s3_bucket, "Prefix": prefix}
    while True:
        resp = s3.list_objects_v2(**kwargs)
        for o in resp.get("Contents", []):
            yield o["Key"], o["LastModified"], o["Size"]
        if resp.get("IsTruncated"):
            kwargs["ContinuationToken"] = resp.get("NextContinuationToken")
        else:
            break


def delete_prefix(prefix: str) -> None:
    """Delete every object whose key starts with `prefix` (works for a single key too —
    a key is its own prefix). Used to reclaim HLS folders and single processed keys."""
    s3 = get_s3_client()
    kwargs = {"Bucket": settings.s3_bucket, "Prefix": prefix}
    while True:
        resp = s3.list_objects_v2(**kwargs)
        objects = [{"Key": o["Key"]} for o in resp.get("Contents", [])]
        if objects:
            try:
                s3.delete_objects(Bucket=settings.s3_bucket, Delete={"Objects": objects})
            except ClientError as e:
                # botocore >=1.36 sends a CRC32 data-integrity checksum on batch DeleteObjects
                # instead of the legacy Content-MD5 header. S3-compatible backends that predate
                # AWS flexible checksums (older MinIO/Ceph/etc.) reject it with MissingContentMD5.
                # Fall back to per-key deletes, which require no checksum, so cleanup still works.
                err = e.response.get("Error", {})
                if err.get("Code") == "MissingContentMD5" or "content-md5" in err.get("Message", "").lower():
                    for obj in objects:
                        s3.delete_object(Bucket=settings.s3_bucket, Key=obj["Key"])
                else:
                    raise
        if resp.get("IsTruncated"):
            kwargs["ContinuationToken"] = resp.get("NextContinuationToken")
        else:
            break
