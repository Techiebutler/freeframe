"""What a client sees on a share link (V3, 2026-11-17): people's comments and the videos, never automation.

A client is anyone who is not signed-in Aditor staff, guests included. Automation = Auto Review's
publications, internal notes, and anything an agent user wrote. Filtered here, server-side, never in CSS.
"""
from ..models.user import User
from .brand_loop import is_aditor_staff

CLIENT_CREATOR = "Aditor"  # shown instead of "Claude on behalf of Alan (claude-code)"


def viewer_is_staff(user) -> bool:
    return bool(user) and getattr(user, "kind", "human") != "agent" and is_aditor_staff(getattr(user, "email", None))


def agent_ids(db, user_ids) -> set:
    ids = {u for u in user_ids if u}
    return {i for (i,) in db.query(User.id).filter(User.id.in_(ids), User.kind == "agent").all()} if ids else set()


def client_visible(comment, agents: set) -> bool:
    return (comment.visibility != "internal" and comment.review_publication_id is None
            and comment.review_source is None and comment.author_id not in agents)


def creator_name(user, staff: bool):
    if user is None:
        return None
    return CLIENT_CREATOR if not staff and getattr(user, "kind", "human") == "agent" else user.name
