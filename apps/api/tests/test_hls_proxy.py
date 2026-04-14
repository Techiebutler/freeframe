"""Tests for HLS streaming proxy."""
import pytest
from unittest.mock import MagicMock, patch
from jose import jwt


class TestCreateHlsToken:
    """Tests for HLS token generation."""

    def test_creates_valid_jwt(self):
        from apps.api.routers.hls_proxy import create_hls_token
        from apps.api.config import settings

        token = create_hls_token("hls/project-1/version-1")
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])

        assert payload["sub"] == "hls"
        assert payload["pfx"] == "hls/project-1/version-1"
        assert "exp" in payload


class TestVerifyHlsToken:
    """Tests for HLS token verification."""

    def test_valid_token(self):
        from apps.api.routers.hls_proxy import create_hls_token, _verify_hls_token

        token = create_hls_token("hls/proj/ver")
        prefix = _verify_hls_token(token)
        assert prefix == "hls/proj/ver"

    def test_invalid_token_raises(self):
        from apps.api.routers.hls_proxy import _verify_hls_token

        with pytest.raises(Exception) as exc_info:
            _verify_hls_token("garbage-token")
        assert exc_info.value.status_code == 401

    def test_wrong_sub_raises(self):
        from apps.api.routers.hls_proxy import _verify_hls_token
        from apps.api.config import settings

        token = jwt.encode(
            {"sub": "not-hls", "pfx": "some/path"},
            settings.jwt_secret,
            algorithm=settings.jwt_algorithm,
        )
        with pytest.raises(Exception) as exc_info:
            _verify_hls_token(token)
        assert exc_info.value.status_code == 403


class TestRewriteManifest:
    """Tests for m3u8 manifest URL rewriting."""

    @patch("apps.api.routers.hls_proxy.generate_presigned_get_url")
    def test_rewrites_ts_to_presigned(self, mock_presign):
        mock_presign.return_value = "https://s3.example.com/presigned-segment.ts"

        from apps.api.routers.hls_proxy import _rewrite_manifest

        content = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.000,\nsegment0.ts\n#EXT-X-ENDLIST"
        result = _rewrite_manifest(content, "hls/proj/ver", "720p/index.m3u8", "tok123")

        assert "https://s3.example.com/presigned-segment.ts" in result
        mock_presign.assert_called_once_with("hls/proj/ver/720p/segment0.ts", expires_in=86400)

    @patch("apps.api.routers.hls_proxy.generate_presigned_get_url")
    def test_rewrites_m3u8_to_proxy_url(self, mock_presign):
        from apps.api.routers.hls_proxy import _rewrite_manifest

        content = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p/index.m3u8"
        result = _rewrite_manifest(content, "hls/proj/ver", "master.m3u8", "tok123")

        assert "720p/index.m3u8?token=tok123" in result
        mock_presign.assert_not_called()

    @patch("apps.api.routers.hls_proxy.generate_presigned_get_url")
    def test_preserves_comments_and_tags(self, mock_presign):
        from apps.api.routers.hls_proxy import _rewrite_manifest

        content = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST"
        result = _rewrite_manifest(content, "hls/proj/ver", "index.m3u8", "tok123")

        assert result == content


class TestHlsProxyEndpoint:
    """Tests for directory traversal prevention."""

    def test_rejects_non_m3u8(self):
        from apps.api.routers.hls_proxy import hls_proxy, create_hls_token

        token = create_hls_token("hls/proj/ver")
        with pytest.raises(Exception) as exc_info:
            hls_proxy("segment0.ts", token=token)
        assert exc_info.value.status_code == 400

    def test_rejects_directory_traversal(self):
        from apps.api.routers.hls_proxy import hls_proxy, create_hls_token

        token = create_hls_token("hls/proj/ver")
        with pytest.raises(Exception) as exc_info:
            hls_proxy("../../etc/passwd.m3u8", token=token)
        assert exc_info.value.status_code == 400

    def test_rejects_absolute_path(self):
        from apps.api.routers.hls_proxy import hls_proxy, create_hls_token

        token = create_hls_token("hls/proj/ver")
        with pytest.raises(Exception) as exc_info:
            hls_proxy("/etc/passwd.m3u8", token=token)
        assert exc_info.value.status_code == 400
