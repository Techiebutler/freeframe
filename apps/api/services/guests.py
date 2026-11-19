"""Share-link guests: who a typed name and email are.

A guest has no account. The email they type is the whole of their identity: it
picks the GuestUser row, and so which comments and which verdict are theirs.
Every route that takes a guest identity resolves it here, so the comment path and
the verdict path cannot drift apart and turn one person into two rows.
"""
from typing import Optional

from sqlalchemy.orm import Session

from ..models.user import GuestUser


def normalize_guest_email(email: Optional[str]) -> str:
    """The key a typed email is stored and looked up under: trimmed and lowercased.
    Empty when nothing usable was typed."""
    return (email or "").strip().lower()


def find_guest(db: Session, email: Optional[str]) -> Optional[GuestUser]:
    """The guest a typed email resolves to, or None. Never creates one."""
    key = normalize_guest_email(email)
    if not key:
        return None
    return db.query(GuestUser).filter(GuestUser.email == key).first()


def resolve_guest(db: Session, email: Optional[str], name: Optional[str]) -> Optional[GuestUser]:
    """Find or create the guest for a typed email and name.

    None when either is blank (a name of only spaces is blank); each route answers
    that with its own 400. An existing guest keeps the name they first gave.
    """
    key = normalize_guest_email(email)
    clean_name = (name or "").strip()
    if not key or not clean_name:
        return None
    guest = find_guest(db, key)
    if guest is None:
        guest = GuestUser(email=key, name=clean_name)
        db.add(guest)
        db.flush()
    return guest
