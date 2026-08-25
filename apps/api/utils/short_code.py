import secrets
import string

ALPHABET = string.ascii_letters + string.digits
CODE_LENGTH = 4


def generate_short_code(length: int = CODE_LENGTH) -> str:
    """A cryptographically random base62 code for share links.

    4 characters over 62 symbols is ~14.7M combinations — plenty for
    self-hosted instances, and short enough to type from a phone.
    """
    return ''.join(secrets.choice(ALPHABET) for _ in range(length))
