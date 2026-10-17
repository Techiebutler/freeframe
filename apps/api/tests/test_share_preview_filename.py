"""OG-only filename composition, selection identity and fail-closed privacy."""
from io import BytesIO
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock
import uuid

import pytest
from PIL import Image, ImageFont

from apps.api.routers import share
from apps.api.services import share_preview_image as composition
from apps.api.tests.test_share_preview_endpoints import _link, _queue_first, _logo_bytes


@pytest.fixture(autouse=True)
def _query_order(mock_db):
    mock_db.order_by.return_value = mock_db


def _png(size=(640, 360)):
    out = BytesIO()
    Image.new("RGB", size, "#4180ad").save(out, "PNG")
    return out.getvalue()


def test_composition_has_frame_dark_footer_and_polish_text():
    result = composition.compose_preview_image(_png(), "Zażółć gęślą jaźń — ujęcie 01.mp4")
    assert result is not None
    image = Image.open(BytesIO(result))
    assert image.format == "JPEG"
    assert image.size == (1200, 630)
    assert image.getpixel((600, 250))[2] > 100
    footer = image.crop((0, 554, 1200, 630))
    assert sum(footer.getpixel((1190, 70))) < 120
    assert any(min(pixel) > 180 for pixel in footer.get_flattened_data())
    assert not image.getexif()


def test_label_normalization_and_pixel_ellipsis():
    font = ImageFont.truetype(composition.PREVIEW_FONT_PATH, 32)
    text = composition.fit_preview_label("Zaz\u0307o\u0301łc\u0301\n\u202e" + "bardzo długa nazwa " * 200, font, 240)
    assert text.startswith("Zażółć")
    assert text.endswith("…")
    assert "\n" not in text and "\u202e" not in text
    assert font.getlength(text) <= 240


@pytest.mark.parametrize("data", [b"not an image", b""])
def test_invalid_image_degrades_without_composition(data):
    assert composition.compose_preview_image(data, "clip.mp4") is None


def test_dimension_limit_checked_before_decode(monkeypatch):
    monkeypatch.setattr(composition, "MAX_PREVIEW_PIXELS", 10)
    assert composition.compose_preview_image(_png(), "clip.mp4") is None


def test_font_error_degrades_unchanged(monkeypatch):
    monkeypatch.setattr(composition, "PREVIEW_FONT_PATH", "/missing/font.ttf")
    assert composition.compose_preview_image(_png(), "clip.mp4") is None


@pytest.mark.parametrize("kind", ["asset", "folder", "project", "multi", "multi_folder", "subfolder", "project_subfolder"])
def test_resolution_pairs_name_with_exact_selected_asset(kind, mock_db, monkeypatch):
    first = SimpleNamespace(id=uuid.uuid4(), name="Selected żółć.mp4")
    other = SimpleNamespace(id=uuid.uuid4(), name="Wrong.mp4")
    link = _link()
    mock_db.first.side_effect = lambda: first
    mock_db.all.return_value = [first, other]
    monkeypatch.setattr(share, "_asset_thumbnail_key", lambda db, asset: "key/" + str(asset.id))
    monkeypatch.setattr(share, "_folder_assets_with_thumbnails", lambda db, fid: [first, other])
    if kind == "asset":
        link.asset_id = first.id
    elif kind in ("folder", "subfolder"):
        link.folder_id = uuid.uuid4()
        if kind == "subfolder":
            subfolder = SimpleNamespace(id=uuid.uuid4())
            mock_db.all.return_value = [subfolder]
            monkeypatch.setattr(share, "_folder_assets_with_thumbnails", lambda db, fid: [] if fid == link.folder_id else [first, other])
    elif kind == "multi_folder":
        mock_db.all.return_value = [SimpleNamespace(asset_id=None, folder_id=uuid.uuid4())]
    elif kind == "multi":
        mock_db.all.return_value = [SimpleNamespace(asset_id=first.id, folder_id=None)]
    elif kind == "project_subfolder":
        subfolder = SimpleNamespace(id=uuid.uuid4())
        mock_db.all.side_effect = [[], [], [subfolder]]
    else:
        mock_db.all.side_effect = [[], [first, other]]
    assert share._resolve_share_thumbnail(mock_db, link) == ("key/" + str(first.id), first.name)


def _public_image(mock_db, monkeypatch, data):
    _queue_first(mock_db, [_link(), MagicMock(), None])
    monkeypatch.setattr(share, "_resolve_share_thumbnail", lambda db, link: ("thumb.png", "Zażółć.mp4"))
    s3 = MagicMock()
    body = BytesIO(data)
    s3.get_object.return_value = {"Body": body, "ContentLength": len(data)}
    monkeypatch.setattr(share, "get_s3_client", lambda: s3)
    return body


def test_public_route_composes_image_without_altering_metadata(client, mock_db, monkeypatch):
    body = _public_image(mock_db, monkeypatch, _png())
    response = client.get("/share/public/preview.jpg")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert Image.open(BytesIO(response.content)).size == (1200, 630)
    assert body.closed
    _queue_first(mock_db, [_link(title="Share title remains"), MagicMock(), None])
    monkeypatch.setattr(share, "_resolve_share_thumbnail_key", lambda db, link: "thumb.png")
    assert client.get("/share/public/preview").json()["title"] == "Share title remains"


@pytest.mark.parametrize("reason", ["corrupt", "oversize", "unknown_length_oversize", "font", "composer_error"])
def test_public_route_falls_back_to_original_bytes(reason, client, mock_db, monkeypatch):
    data = b"corrupt" if reason == "corrupt" else _png()
    body = _public_image(mock_db, monkeypatch, data)
    if reason in ("oversize", "unknown_length_oversize"):
        monkeypatch.setattr(share, "MAX_PREVIEW_IMAGE_BYTES", 8)
        if reason == "unknown_length_oversize":
            s3 = share.get_s3_client()
            s3.get_object.return_value.pop("ContentLength")
    if reason == "font":
        monkeypatch.setattr(composition, "PREVIEW_FONT_PATH", "/missing/font.ttf")
    if reason == "composer_error":
        monkeypatch.setattr(share, "compose_preview_image", MagicMock(side_effect=RuntimeError("broken renderer")))
    response = client.get("/share/public/preview.jpg")
    assert response.status_code == 200
    assert response.content == data
    assert response.headers["content-type"] == "image/png"
    assert body.closed


@pytest.mark.parametrize("case", ["password", "secure", "expired", "disabled", "deleted_target", "unknown", "unknown_visibility", "off"])
def test_private_or_disabled_never_resolves_filename_or_frame(case, client, mock_db, monkeypatch):
    link = _link(title="Secret title")
    if case == "password":
        link.password_hash = "hash"
    if case == "secure":
        link.visibility = "secure"
    if case == "unknown_visibility":
        link.visibility = "future-unrecognized-mode"
    if case == "expired":
        link.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
    if case == "disabled":
        link.is_enabled = False
    values = [None] if case == "unknown" else [link, None]
    if case == "off":
        values = [link, MagicMock(), SimpleNamespace(share_previews_enabled=False)]
    _queue_first(mock_db, values)
    resolver, composer, storage = MagicMock(), MagicMock(), MagicMock()
    monkeypatch.setattr(share, "_resolve_share_thumbnail", resolver)
    monkeypatch.setattr(share, "compose_preview_image", composer)
    monkeypatch.setattr(share, "get_s3_client", storage)
    response = client.get("/share/private/preview.jpg")
    assert response.status_code == 200
    assert response.content == _logo_bytes()
    resolver.assert_not_called()
    composer.assert_not_called()
    storage.assert_not_called()
