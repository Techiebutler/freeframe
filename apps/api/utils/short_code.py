import secrets
import string

ALPHABET = string.ascii_letters + string.digits
CODE_LENGTH = 8


def generate_short_code(length: int = CODE_LENGTH) -> str:
    """A cryptographically random base62 code for share links.

    The code is an alias for the share token, so it is a secret in its own
    right: anyone who knows it can reach the link. 8 characters over 62
    symbols is 62^8 ≈ 2.2e14 combinations, which keeps a guess from being
    practical. The retry loop at the call site absorbs the rare collision.
    """
    return "".join(secrets.choice(ALPHABET) for _ in range(length))
