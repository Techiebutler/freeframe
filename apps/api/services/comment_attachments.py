"""Reference images on a comment (spec 2026-11-07, image in comment + brand reference).

Pure rules only: which files are allowed, and whether a comment's images are all in. A comment that
announced images (attachments_expected) is held out of feedback rounds until they are confirmed;
after PENDING_FOR a missing image turns the comment into images_failed - never a silent drop. Only
the author resolves it: retry, remove the image, or send without it.
"""
from datetime import datetime, timedelta
from typing import Literal, Optional

ALLOWED_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_BYTES = 10 * 1024 * 1024
MAX_PER_COMMENT = 4
PENDING_FOR = timedelta(minutes=15)

State = Literal["ready", "pending", "images_failed"]


def check_file(content_type: str, size: int) -> Optional[str]:
    """None when the file may be attached, else the reason (shown to the person as is)."""
    if (content_type or "").lower() not in ALLOWED_TYPES:
        return "Only PNG, JPEG, WebP or GIF images can be attached."
    if size <= 0 or size > MAX_BYTES:
        return "Images can be up to 10 MB."
    return None


def comment_state(expected: int, uploaded: int, created_at: datetime, now: datetime) -> State:
    if uploaded >= (expected or 0):
        return "ready"
    return "pending" if now - created_at < PENDING_FOR else "images_failed"


if __name__ == "__main__":
    t0 = datetime(2026, 11, 8, 1, 0)
    assert check_file("image/png", 1) is None and check_file("video/mp4", 1) and check_file("image/png", MAX_BYTES + 1)
    assert comment_state(0, 0, t0, t0) == "ready"
    assert comment_state(2, 1, t0, t0 + timedelta(minutes=1)) == "pending"
    assert comment_state(2, 1, t0, t0 + timedelta(minutes=16)) == "images_failed"
    assert comment_state(2, 2, t0, t0 + timedelta(hours=3)) == "ready"  # a late confirmation still counts
    print("ok")
