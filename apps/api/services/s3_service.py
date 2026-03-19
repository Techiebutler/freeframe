import boto3
from botocore.exceptions import ClientError
from ..config import settings

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

def get_s3_client():
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
    )

def ensure_bucket_exists():
    """Create the S3 bucket if it does not exist. Called on app startup."""
    s3 = get_s3_client()
    try:
        s3.head_bucket(Bucket=settings.s3_bucket)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchBucket"):
            s3.create_bucket(Bucket=settings.s3_bucket)
        else:
            raise

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
    s3 = get_s3_client()
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

def generate_presigned_get_url(s3_key: str, expires_in: int = 3600) -> str:
    """Generate a presigned GET URL for an object."""
    s3 = get_s3_client()
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.s3_bucket, "Key": s3_key},
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
