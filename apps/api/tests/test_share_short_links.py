"""Regression coverage for secure, public short share URLs."""
import re
from unittest.mock import MagicMock, patch

from apps.api.models.share import generate_share_short_code
from apps.api.services.permissions import validate_share_link


def test_short_share_codes_are_url_safe_and_96_bit():
    code = generate_share_short_code()

    assert len(code) == 16
    assert re.fullmatch(r"[A-Za-z0-9_-]{16}", code)


def test_share_validation_accepts_a_short_code():
    link = MagicMock(is_enabled=True, expires_at=None)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = link

    with patch("apps.api.services.permissions.share_link_target_is_live", return_value=True):
        assert validate_share_link(db, "Jw2D6fX9aQ4mN7pR") is link

    filters = db.query.return_value.filter.call_args.args
    assert "share_links.short_code" in str(filters[0])
    assert "share_links.token" in str(filters[0])
