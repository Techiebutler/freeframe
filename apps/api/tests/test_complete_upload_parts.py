"""Tests for deriving and validating a CompleteMultipartUpload parts list server-side.

The behaviour under test exists because completing with a gap is *not* an error on
most S3 backends -- MinIO, Garage and SeaweedFS assemble whatever they were handed
and return success -- so an under-reported parts list silently truncates a master.
"""
import pytest
from unittest.mock import MagicMock
from botocore.exceptions import ClientError

from apps.api.services import s3_service
from apps.api.routers.upload import _parts_from_listing

MB = 1024 * 1024


def _client_error(code: str):
    return ClientError({"Error": {"Code": code, "Message": code}}, "ListParts")


def _parts(*sizes: int) -> list[dict]:
    return [
        {"PartNumber": i, "ETag": f'"etag-{i}"', "Size": size}
        for i, size in enumerate(sizes, start=1)
    ]


# --------------------------------------------------------------- validation

def test_accepts_a_complete_contiguous_set():
    stored = _parts(10 * MB, 10 * MB, 3 * MB)
    assert _parts_from_listing(stored, 23 * MB) == [
        {"PartNumber": 1, "ETag": '"etag-1"'},
        {"PartNumber": 2, "ETag": '"etag-2"'},
        {"PartNumber": 3, "ETag": '"etag-3"'},
    ]


def test_accepts_a_single_part_upload():
    assert _parts_from_listing(_parts(1234), 1234) == [{"PartNumber": 1, "ETag": '"etag-1"'}]


def test_rejects_a_hole_rather_than_truncating():
    # Parts 1 and 3 present, 2 missing: S3 would happily assemble a 2-part object.
    stored = [
        {"PartNumber": 1, "ETag": '"a"', "Size": 10 * MB},
        {"PartNumber": 3, "ETag": '"c"', "Size": 3 * MB},
    ]
    with pytest.raises(ValueError, match="part 2"):
        _parts_from_listing(stored, 23 * MB)


def test_rejects_a_short_set_that_is_internally_consistent():
    # No hole, every part the right size, but the last chunk was never uploaded.
    with pytest.raises(ValueError, match="declared"):
        _parts_from_listing(_parts(10 * MB, 10 * MB), 23 * MB)


def test_rejects_an_empty_listing():
    with pytest.raises(ValueError, match="No uploaded parts"):
        _parts_from_listing([], 10 * MB)


def test_rejects_unequal_non_final_parts():
    # R2 refuses these outright; everywhere else they mean the client changed its
    # chunk size mid-upload, so the part-to-offset mapping is no longer sound.
    with pytest.raises(ValueError, match="every part before the last"):
        _parts_from_listing(_parts(10 * MB, 8 * MB, 3 * MB), 21 * MB)


def test_rejects_a_final_part_larger_than_the_others():
    with pytest.raises(ValueError, match="final part is larger"):
        _parts_from_listing(_parts(10 * MB, 12 * MB), 22 * MB)


def test_rejects_a_duplicated_part_number_instead_of_guessing():
    stored = [
        {"PartNumber": 1, "ETag": '"old"', "Size": 10 * MB},
        {"PartNumber": 1, "ETag": '"new"', "Size": 10 * MB},
        {"PartNumber": 2, "ETag": '"b"', "Size": 3 * MB},
    ]
    with pytest.raises(ValueError, match="more than once"):
        _parts_from_listing(stored, 13 * MB)


def test_rejects_a_listing_with_no_sizes():
    stored = [{"PartNumber": 1, "ETag": '"a"', "Size": None}]
    with pytest.raises(ValueError, match="did not report part sizes"):
        _parts_from_listing(stored, 10 * MB)


# ------------------------------------------------------------- list_upload_parts

def test_list_upload_parts_paginates_and_echoes_the_servers_marker(monkeypatch):
    fake = MagicMock()
    fake.list_parts.side_effect = [
        {"Parts": [{"PartNumber": 1, "ETag": '"a"', "Size": 10}], "IsTruncated": True,
         "NextPartNumberMarker": 1},
        {"Parts": [{"PartNumber": 2, "ETag": '"b"', "Size": 5}], "IsTruncated": False},
    ]
    monkeypatch.setattr(s3_service, "get_s3_client", lambda: fake)

    parts = s3_service.list_upload_parts("raw/k", "u1")

    assert [p["PartNumber"] for p in parts] == [1, 2]
    # The second call must reuse the marker the backend returned, never a computed one:
    # MinIO resolves a marker naming an absent part number to an empty page.
    assert fake.list_parts.call_args_list[1].kwargs["PartNumberMarker"] == 1


def test_list_upload_parts_returns_ascending_order(monkeypatch):
    fake = MagicMock()
    fake.list_parts.return_value = {
        "Parts": [
            {"PartNumber": 3, "ETag": '"c"', "Size": 5},
            {"PartNumber": 1, "ETag": '"a"', "Size": 10},
        ],
        "IsTruncated": False,
    }
    monkeypatch.setattr(s3_service, "get_s3_client", lambda: fake)
    assert [p["PartNumber"] for p in s3_service.list_upload_parts("raw/k", "u1")] == [1, 3]


def test_list_upload_parts_stops_when_truncated_without_a_marker(monkeypatch):
    """A backend that sets IsTruncated but returns no marker must not loop forever."""
    fake = MagicMock()
    fake.list_parts.return_value = {
        "Parts": [{"PartNumber": 1, "ETag": '"a"', "Size": 10}],
        "IsTruncated": True,
    }
    monkeypatch.setattr(s3_service, "get_s3_client", lambda: fake)

    assert len(s3_service.list_upload_parts("raw/k", "u1")) == 1
    assert fake.list_parts.call_count == 1


@pytest.mark.parametrize("code", ["NoSuchUpload", "NoSuchKey", "404", "NotFound"])
def test_list_upload_parts_maps_a_gone_upload(monkeypatch, code):
    fake = MagicMock()
    fake.list_parts.side_effect = _client_error(code)
    monkeypatch.setattr(s3_service, "get_s3_client", lambda: fake)
    with pytest.raises(s3_service.MultipartUploadGone):
        s3_service.list_upload_parts("raw/k", "u1")


@pytest.mark.parametrize("code", ["NotImplemented", "MethodNotAllowed"])
def test_list_upload_parts_maps_an_unsupported_backend(monkeypatch, code):
    fake = MagicMock()
    fake.list_parts.side_effect = _client_error(code)
    monkeypatch.setattr(s3_service, "get_s3_client", lambda: fake)
    with pytest.raises(s3_service.MultipartListingUnsupported):
        s3_service.list_upload_parts("raw/k", "u1")


@pytest.mark.parametrize("code", ["AccessDenied", "InvalidRequest", "InvalidArgument", "SlowDown"])
def test_list_upload_parts_reraises_anything_else(monkeypatch, code):
    """A generic 4xx must not be read as "this backend has no ListParts".

    Doing so would fail open: the request would fall back to the client's
    unverifiable parts list, which is the behaviour this whole change exists to
    stop. `InvalidRequest` in particular is a generic MinIO 400, not a capability
    statement.
    """
    fake = MagicMock()
    fake.list_parts.side_effect = _client_error(code)
    monkeypatch.setattr(s3_service, "get_s3_client", lambda: fake)
    with pytest.raises(ClientError):
        s3_service.list_upload_parts("raw/k", "u1")


def test_list_upload_parts_stops_when_the_marker_does_not_advance(monkeypatch):
    """A backend that pages forever must not spin inside the request handler."""
    fake = MagicMock()
    fake.list_parts.return_value = {
        "Parts": [{"PartNumber": 1, "ETag": '"a"', "Size": 10}],
        "IsTruncated": True,
        "NextPartNumberMarker": 1,
    }
    monkeypatch.setattr(s3_service, "get_s3_client", lambda: fake)

    s3_service.list_upload_parts("raw/k", "u1")

    # First page, then one more that returns the same marker, then stop.
    assert fake.list_parts.call_count == 2


# ------------------------------------------------------------- head_object_size

def test_head_object_size_returns_content_length(monkeypatch):
    fake = MagicMock()
    fake.head_object.return_value = {"ContentLength": 4096}
    monkeypatch.setattr(s3_service, "_get_probe_client", lambda: fake)
    assert s3_service.head_object_size("raw/k") == 4096


def test_head_object_size_returns_none_when_absent(monkeypatch):
    fake = MagicMock()
    fake.head_object.side_effect = _client_error("404")
    monkeypatch.setattr(s3_service, "_get_probe_client", lambda: fake)
    assert s3_service.head_object_size("raw/k") is None


def test_head_object_size_refuses_to_guess_when_no_size_is_reported(monkeypatch):
    """A 200 carrying no ContentLength is an unanswered question, not a missing object.

    HeadObjectOutput has no required members, so botocore omits the key when the
    header is absent -- which happens behind proxies that strip or chunk-encode HEAD
    responses. Subscripting raised KeyError, which is neither a ClientError nor a
    BotoCoreError and so escaped every caller's handling as a 500.
    """
    fake = MagicMock()
    fake.head_object.return_value = {"ETag": '"abc"'}
    monkeypatch.setattr(s3_service, "_get_probe_client", lambda: fake)

    with pytest.raises(s3_service.ObjectSizeUnavailable):
        s3_service.head_object_size("raw/k")
