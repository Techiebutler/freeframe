"""JWT_SECRET and JWT_ALGORITHM are checked when Settings loads.

PyJWT refuses an empty HMAC key with InvalidKeyError, which is not an
InvalidTokenError, so an empty secret used to surface as a 500 on sign-in and
on every request with a bearer token. python-jose accepted it, which let anyone
sign a valid token. The API now refuses to start instead.
"""
import pytest
from pydantic import ValidationError

from apps.api.config import Settings


def _settings(**overrides):
    base = dict(
        database_url="postgresql://u:p@localhost:5432/db",
        redis_url="redis://localhost:6379/0",
        jwt_secret="a-secret-that-is-at-least-32-bytes-long",
    )
    base.update(overrides)
    return Settings(_env_file=None, **base)


@pytest.mark.parametrize("secret", ["", "   ", "\n"])
def test_empty_jwt_secret_is_refused(secret):
    with pytest.raises(ValidationError, match="JWT_SECRET"):
        _settings(jwt_secret=secret)


def test_short_jwt_secret_is_still_accepted():
    # PyJWT only warns below 32 bytes for HS256; existing installs keep working.
    assert _settings(jwt_secret="short").jwt_secret == "short"


@pytest.mark.parametrize("algorithm", ["HS256", "HS384", "HS512"])
def test_hmac_algorithms_are_accepted(algorithm):
    assert _settings(jwt_algorithm=algorithm).jwt_algorithm == algorithm


@pytest.mark.parametrize("algorithm", ["RS256", "ES256", "none", "hs256", "HS256 ", ""])
def test_other_jwt_algorithms_are_refused(algorithm):
    with pytest.raises(ValidationError, match="JWT_ALGORITHM"):
        _settings(jwt_algorithm=algorithm)
