"""Tests for HLS streaming proxy."""
import pytest
from unittest.mock import MagicMock, patch
import jwt


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


class TestSegmentUrlLifetime:
    """A segment URL never outlives the token that the playlist was fetched with.

    The proxy checks only the token's signature and expiry, never the asset, so
    the token's lifetime is the bound on how long a player can keep fetching
    video after access to it ended. Segment URLs signed for a fixed 24 hours at
    each playlist fetch stretched that to about 48 hours from the token's issue.
    """

    def _token(self, seconds_left):
        from apps.api.config import settings
        from datetime import datetime, timedelta, timezone
        return jwt.encode(
            {"sub": "hls", "pfx": "hls/proj/ver",
             "exp": datetime.now(timezone.utc) + timedelta(seconds=seconds_left)},
            settings.jwt_secret, algorithm=settings.jwt_algorithm,
        )

    def _signed_expiries(self, token):
        """Fetch a variant playlist through the proxy with real URL signing, and
        return each segment URL's X-Amz-Expires."""
        from urllib.parse import parse_qs, urlparse
        from apps.api.routers.hls_proxy import hls_proxy

        body = b"#EXTM3U\n#EXTINF:2.000,\nseg0.ts\n#EXTINF:2.000,\nseg1.ts\n#EXT-X-ENDLIST"
        s3 = MagicMock()
        s3.get_object.return_value = {"Body": MagicMock(read=MagicMock(return_value=body))}
        with patch("apps.api.routers.hls_proxy.get_s3_client", return_value=s3):
            response = hls_proxy("720p/index.m3u8", token=token)
        urls = [l for l in response.body.decode().split("\n") if l.startswith("http")]
        assert len(urls) == 2
        return [int(parse_qs(urlparse(u).query)["X-Amz-Expires"][0]) for u in urls]

    def test_a_token_near_its_end_signs_segments_only_for_what_is_left(self):
        for expires in self._signed_expiries(self._token(60)):
            assert 1 <= expires <= 60

    def test_a_fresh_token_signs_segments_for_its_full_lifetime(self):
        from apps.api.routers.hls_proxy import create_hls_token
        for expires in self._signed_expiries(create_hls_token("hls/proj/ver")):
            assert 86400 - 60 <= expires <= 86400

    def test_an_expired_token_signs_nothing(self):
        from apps.api.routers.hls_proxy import hls_proxy
        with pytest.raises(Exception) as exc_info:
            hls_proxy("720p/index.m3u8", token=self._token(-5))
        assert exc_info.value.status_code == 401
