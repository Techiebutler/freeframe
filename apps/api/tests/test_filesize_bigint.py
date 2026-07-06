"""file_size_bytes columns must be BigInteger.

Postgres INTEGER (int4) tops out at ~2.147 GB, so a file larger than that cannot be
recorded at all — which silently breaks large-media support (and the storage cap that
sums these values). Both file_size_bytes columns must be BigInteger.
"""
from sqlalchemy import BigInteger

from apps.api.models.asset import MediaFile
from apps.api.models.comment import CommentAttachment


def test_media_file_size_bytes_is_bigint():
    assert isinstance(MediaFile.__table__.columns["file_size_bytes"].type, BigInteger)


def test_comment_attachment_file_size_bytes_is_bigint():
    assert isinstance(CommentAttachment.__table__.columns["file_size_bytes"].type, BigInteger)
