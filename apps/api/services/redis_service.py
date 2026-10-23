import redis
import secrets
from typing import Optional
from ..config import settings

# Redis client
_redis_client: Optional[redis.Redis] = None


def get_redis() -> redis.Redis:
    """Get Redis client singleton."""
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


# Magic code keys
MAGIC_CODE_PREFIX = "magic_code:"
MAGIC_CODE_ATTEMPTS_PREFIX = "magic_code_attempts:"
MAGIC_CODE_EXPIRY_SECONDS = 600  # 10 minutes
MAX_MAGIC_CODE_ATTEMPTS = 5


def generate_magic_code() -> str:
    """Generate a 6-digit magic code."""
    return str(secrets.randbelow(900000) + 100000)


def store_magic_code(key: str, code: str) -> None:
    """Store magic code in Redis with expiry.

    `key` names the account the code is for. The auth routes pass the user id,
    not the address: two accounts can differ only by case, and an address key
    would let one verify the other's code.
    """
    r = get_redis()
    code_key = f"{MAGIC_CODE_PREFIX}{key.lower()}"
    r.setex(code_key, MAGIC_CODE_EXPIRY_SECONDS, code)
    # Reset attempts counter
    attempts_key = f"{MAGIC_CODE_ATTEMPTS_PREFIX}{key.lower()}"
    r.delete(attempts_key)


def verify_magic_code(key: str, code: str) -> tuple[bool, str]:
    """
    Verify magic code from Redis.
    Returns (success, error_message).
    """
    r = get_redis()
    code_key = f"{MAGIC_CODE_PREFIX}{key.lower()}"
    attempts_key = f"{MAGIC_CODE_ATTEMPTS_PREFIX}{key.lower()}"
    
    # Check attempts
    attempts = r.get(attempts_key)
    if attempts and int(attempts) >= MAX_MAGIC_CODE_ATTEMPTS:
        return False, "Too many attempts. Request a new code."
    
    # Get stored code
    stored_code = r.get(code_key)
    if not stored_code:
        return False, "Code expired or not found"
    
    if stored_code != code:
        # Increment attempts
        r.incr(attempts_key)
        r.expire(attempts_key, MAGIC_CODE_EXPIRY_SECONDS)
        return False, "Invalid code"
    
    # Success - delete the code
    r.delete(code_key)
    r.delete(attempts_key)
    return True, ""


def delete_magic_code(key: str) -> None:
    """Delete magic code from Redis."""
    r = get_redis()
    code_key = f"{MAGIC_CODE_PREFIX}{key.lower()}"
    attempts_key = f"{MAGIC_CODE_ATTEMPTS_PREFIX}{key.lower()}"
    r.delete(code_key)
    r.delete(attempts_key)


# Invite token keys (also in Redis for faster lookup)
INVITE_TOKEN_PREFIX = "invite_token:"
INVITE_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60  # 7 days


def store_invite_token(token: str, user_id: str) -> None:
    """Store invite token -> user_id mapping in Redis."""
    r = get_redis()
    key = f"{INVITE_TOKEN_PREFIX}{token}"
    r.setex(key, INVITE_TOKEN_EXPIRY_SECONDS, user_id)


def get_user_id_from_invite_token(token: str) -> Optional[str]:
    """Get user_id from invite token."""
    r = get_redis()
    key = f"{INVITE_TOKEN_PREFIX}{token}"
    return r.get(key)


def delete_invite_token(token: str) -> None:
    """Delete invite token from Redis."""
    r = get_redis()
    key = f"{INVITE_TOKEN_PREFIX}{token}"
    r.delete(key)


# ── IP-based rate limiting ────────────────────────────────────────────────────

RATE_LIMIT_PREFIX = "rl:"


def check_rate_limit(
    ip: str,
    action: str,
    max_requests: int,
    window_seconds: int,
) -> tuple[bool, int]:
    """
    Check if an IP has exceeded the rate limit for a given action.
    Returns (allowed, remaining_seconds_until_reset).
    Uses a simple counter with TTL in Redis. Fails open if Redis is unavailable.
    """
    try:
        r = get_redis()
        key = f"{RATE_LIMIT_PREFIX}{action}:{ip}"
        current = r.get(key)

        if current is not None and int(current) >= max_requests:
            ttl = r.ttl(key)
            return False, max(ttl, 1)

        pipe = r.pipeline()
        pipe.incr(key)
        pipe.expire(key, window_seconds, nx=True)
        pipe.execute()
        return True, 0
    except Exception:
        # Fail open — allow the request if Redis is unavailable
        return True, 0


# ── Share link password sessions ──────────────────────────────────────────────

SHARE_SESSION_PREFIX = "share_session:"
SHARE_SESSION_EXPIRY_SECONDS = 3600  # 1 hour


def create_share_session(token: str, session_id: str) -> None:
    """Store a session after successful password verification."""
    r = get_redis()
    key = f"{SHARE_SESSION_PREFIX}{token}:{session_id}"
    r.setex(key, SHARE_SESSION_EXPIRY_SECONDS, "1")


def verify_share_session(token: str, session_id: str) -> bool:
    """Check if a valid password session exists for this share link."""
    r = get_redis()
    key = f"{SHARE_SESSION_PREFIX}{token}:{session_id}"
    return r.exists(key) > 0
