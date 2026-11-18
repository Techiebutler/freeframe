"""Sessions issued before the python-jose -> PyJWT swap must survive it.

The two tokens below were minted by python-jose[cryptography]==3.5.0 with the
exact payload shapes auth_service.create_access_token / the pre-``ver`` refresh
token produced, signed HS256 with conftest's JWT_SECRET and ``exp`` at
2099-01-01T00:00:00Z. They are literals on purpose: re-minting them with the
library under test would only prove PyJWT agrees with itself.
"""
import pytest

from apps.api.config import settings
from apps.api.services.auth_service import decode_token

# conftest only setdefault()s JWT_SECRET, and CI exports its own value, so pin
# the secret these literals were signed with instead of trusting the env.
JOSE_SECRET = "test-jwt-secret-key-for-tests-only"
USER_ID = "5f0c2a8e-6a1b-4c1e-9d3a-2b7e8f9a0c11"
EXP_2099 = 4070908800

JOSE_ACCESS_TOKEN = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJzdWIiOiI1ZjBjMmE4ZS02YTFiLTRjMWUtOWQzYS0yYjdlOGY5YTBjMTEiLCJ0eXBlIjoiYWNjZXNzIiwiZXhwIjo0MDcwOTA4ODAwLCJ2ZXIiOjF9"
    "._DhNMOtpO0sWjJDV26O26fm6Cy9ovmwAztiKTM3kHyk"
)
JOSE_LEGACY_REFRESH_TOKEN = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJzdWIiOiI1ZjBjMmE4ZS02YTFiLTRjMWUtOWQzYS0yYjdlOGY5YTBjMTEiLCJ0eXBlIjoicmVmcmVzaCIsImV4cCI6NDA3MDkwODgwMH0"
    ".RgNX91fTKoK8ZZmyo49YqpVDSI0rGpYfyauLEr8tlNk"
)


@pytest.mark.parametrize(
    "token, expected",
    [
        (JOSE_ACCESS_TOKEN, {"sub": USER_ID, "type": "access", "exp": EXP_2099, "ver": 1}),
        (JOSE_LEGACY_REFRESH_TOKEN, {"sub": USER_ID, "type": "refresh", "exp": EXP_2099}),
    ],
    ids=["access", "legacy-refresh-without-ver"],
)
def test_python_jose_minted_token_still_decodes(monkeypatch, token, expected):
    monkeypatch.setattr(settings, "jwt_secret", JOSE_SECRET)
    monkeypatch.setattr(settings, "jwt_algorithm", "HS256")

    assert decode_token(token) == expected
