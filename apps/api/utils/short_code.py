import secrets
import string

ALPHABET = string.ascii_letters + string.digits
CODE_LENGTH = 4

# Root-level route segments the web app serves. A generated code must never
# take one of these names, or a future `/docs` or `/help` page would silently
# shadow share links that got the same code. `test_share_short_codes.py` scans
# `apps/web/app/` and fails when a root route is added without being reserved
# here.
RESERVED_CODES = frozenset({
    # Current root routes
    "login",
    "setup",
    "invite",
    "share",
    "projects",
    "assets",
    "settings",
    "notifications",
    # Plausible future root routes — cheap insurance
    "docs",
    "help",
    "about",
    "admin",
    "home",
    "auth",
})

_MAX_RESERVED_ATTEMPTS = 100


def generate_short_code(length: int = CODE_LENGTH) -> str:
    """A cryptographically random base62 code for share links.

    4 characters over 62 symbols is ~14.7M combinations — plenty for
    self-hosted instances, and short enough to type from a phone. The
    birthday bound puts a 1% chance of *some* collision at roughly 17k
    links; the retry loop at the call site absorbs collisions, and going
    to 5 characters (62^5 = 916M) is the answer beyond that.

    Codes from `RESERVED_CODES` are skipped so a code can never collide
    with a route the web app serves at its root.
    """
    for _ in range(_MAX_RESERVED_ATTEMPTS):
        code = ''.join(secrets.choice(ALPHABET) for _ in range(length))
        if code not in RESERVED_CODES:
            return code
    raise RuntimeError(
        f"No unreserved short code found after {_MAX_RESERVED_ATTEMPTS} attempts"
    )
