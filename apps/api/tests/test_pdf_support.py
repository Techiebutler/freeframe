from unittest.mock import MagicMock, patch

from apps.api.models.asset import AssetType, FileType
from apps.api.schemas.upload import ALLOWED_MIME_TYPES, mime_to_asset_type
from apps.api.schemas.comment import CommentCreate
from packages.transcoder.image_processor import process_pdf


def test_pdf_is_a_supported_first_class_upload_type():
    assert "application/pdf" in ALLOWED_MIME_TYPES
    assert mime_to_asset_type("application/pdf") is AssetType.pdf
    assert FileType.pdf.value == "pdf"


def test_pdf_comment_page_anchor_must_be_positive():
    comment = CommentCreate(version_id="00000000-0000-0000-0000-000000000001", body="Note", page_number=2)
    assert comment.page_number == 2


def test_pdf_processor_renders_first_page_thumbnail():
    s3 = MagicMock()

    with patch("packages.transcoder.image_processor.subprocess.run") as run:
        result = process_pdf(s3, "media", "raw/document.pdf", "processed/p/a/v")

    s3.download_file.assert_called_once()
    command = run.call_args.args[0]
    assert command[0] == "pdftoppm"
    assert command[command.index("-f") + 1] == "1"
    assert command[command.index("-l") + 1] == "1"
    assert command[command.index("-scale-to") + 1] == "400"
    assert run.call_args.kwargs["timeout"] == 120
    assert result == {"thumbnail_key": "processed/p/a/v/thumbnail.jpg"}
    assert s3.upload_file.call_args.args[1:] == (
        "media",
        "processed/p/a/v/thumbnail.jpg",
    )
    assert s3.upload_file.call_args.kwargs["ExtraArgs"]["ContentType"] == "image/jpeg"


def test_pdf_processing_persists_thumbnail_key():
    from apps.api.tasks.transcode_tasks import _process_pdf

    db = MagicMock()
    media_file = MagicMock(s3_key_raw="raw/document.pdf")
    with patch(
        "packages.transcoder.image_processor.process_pdf",
        return_value={"thumbnail_key": "processed/p/a/v/thumbnail.jpg"},
    ):
        _process_pdf(db, MagicMock(), MagicMock(), media_file, MagicMock(), "processed/p/a/v")

    assert media_file.s3_key_thumbnail == "processed/p/a/v/thumbnail.jpg"
    db.flush.assert_called_once_with()
