from datetime import datetime, timedelta, timezone
from typing import Optional
import uuid
from jose import JWTError, jwt
import bcrypt
from sqlalchemy.orm import Session
from ..config import settings
from ..models.user import User, UserStatus

BCRYPT_MAX_PASSWORD_BYTES = 72

def bcrypt_password_bytes(password: str) -> bytes:
    """Encode a password to the bytes bcrypt will actually hash.

    bcrypt's limit is 72 *bytes*, not characters. Slicing the str first
    (password[:72]) truncates by character, so a password of multi-byte
    characters still hands bcrypt more than 72 bytes and it silently ignores
    the tail — two different passwords sharing a 72-byte prefix then verify
    against the same hash. Encode first, then slice, so the truncation point
    is explicit and matches what bcrypt does internally.
    """
    return password.encode('utf-8')[:BCRYPT_MAX_PASSWORD_BYTES]

def hash_password(password: str) -> str:
    salt = bcrypt.gensalt()
    hashed_bytes = bcrypt.hashpw(bcrypt_password_bytes(password), salt)
    return hashed_bytes.decode('utf-8')

def verify_password(plain: str, hashed: str) -> bool:
    try:
        hashed_bytes = hashed.encode('utf-8')
        return bcrypt.checkpw(bcrypt_password_bytes(plain), hashed_bytes)
    except ValueError:
        return False

def create_access_token(user_id: str, token_version: int = 1) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": str(user_id), "type": "access", "exp": expire, "ver":token_version}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)

def create_refresh_token(user_id: str, token_version: int = 1) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    payload = {"sub": str(user_id), "type": "refresh", "exp": expire, "ver": token_version}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)

def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None

def get_user_by_email(db: Session, email: str) -> Optional[User]:
    return db.query(User).filter(User.email == email, User.deleted_at.is_(None)).first()

def get_user_by_id(db: Session, user_id: uuid.UUID) -> Optional[User]:
    return db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
