"""The share validate response names the upload request whose standing review link this is (embed postMessage)."""
import uuid
from unittest.mock import MagicMock, patch

from apps.api.routers import share


def _link():
    link = MagicMock()
    link.id = uuid.uuid4()
    link.asset_id = None
    link.folder_id = None
    link.project_id = None
    link.visibility = "public"
    link.password_hash = None
    link.title = "t"
    link.description = None
    link.permission = "comment"
    link.allow_download = False
    link.show_versions = True
    link.show_watermark = False
    link.appearance = None
    link.created_by = uuid.uuid4()
    return link


def _validate(found):
    db = MagicMock()
    # Only the request lookup (selecting UploadRequest.id) gets the tuple; every other query keeps the plain mock.
    def query(*cols):
        q = MagicMock()
        if cols and getattr(cols[0], "key", None) == "id" and getattr(cols[0].class_, "__name__", "") == "UploadRequest":
            q.filter.return_value.first.return_value = found
        return q
    db.query.side_effect = query
    with patch.object(share, "validate_share_link", return_value=_link()), patch.object(share.client_view, "creator_name", return_value="Alan"):
        return share.validate_share_link_endpoint("tok", db=db, current_user=None)


def test_validate_returns_request_id_for_a_request_review_link():
    rid = uuid.uuid4()
    assert _validate((rid,)).request_id == rid


def test_validate_has_no_request_id_for_an_ordinary_link():
    assert _validate(None).request_id is None
