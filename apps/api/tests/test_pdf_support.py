from apps.api.models.asset import AssetType, FileType
from apps.api.schemas.upload import ALLOWED_MIME_TYPES, mime_to_asset_type
from apps.api.schemas.comment import CommentCreate


def test_pdf_is_a_supported_first_class_upload_type():
    assert "application/pdf" in ALLOWED_MIME_TYPES
    assert mime_to_asset_type("application/pdf") is AssetType.pdf
    assert FileType.pdf.value == "pdf"


def test_pdf_comment_page_anchor_must_be_positive():
    comment = CommentCreate(version_id="00000000-0000-0000-0000-000000000001", body="Note", page_number=2)
    assert comment.page_number == 2
