"""A new share link allows commenting and not downloading (#266).

The two defaults have to agree between the API schema and the create dialog, or
a link made through the API keeps the old behaviour while one made in the UI does
not. That is the same bug class as the `visibility` default in #202, which is why
this pins the API side rather than trusting the dialog alone.
"""
import uuid

import pytest

from apps.api.models.share import SharePermission
from apps.api.schemas.share import (
    ShareLinkCreate,
    MultiShareCreate,
    ShareLinkValidateResponse,
    DirectShareCreate,
)


def test_a_new_share_link_allows_commenting():
    """Commenting is the core loop of a review link. A viewer who cannot comment
    needs a deliberately read-only link, which is the niche case."""
    assert ShareLinkCreate().permission == SharePermission.comment


def test_a_new_share_link_does_not_allow_downloading():
    """Commenting affects what happens inside the review page; downloading pulls
    the original out of it, and a share link is the most exposed surface there
    is. Whoever needs it flips one toggle."""
    assert ShareLinkCreate().allow_download is False


def test_a_multi_item_link_matches_the_single_item_one():
    assert MultiShareCreate(item_ids=[uuid.uuid4()]).permission == SharePermission.comment
    assert MultiShareCreate(item_ids=[uuid.uuid4()]).allow_download is False


def test_versions_stay_visible():
    assert ShareLinkCreate().show_versions is True


def test_the_validate_response_fallback_stays_read_only():
    """Not a create default. This is what an unauthenticated caller is told when
    the field is absent, so it must fail closed rather than inherit the new
    permissive create default."""
    assert ShareLinkValidateResponse(
        valid=True, asset_id=uuid.uuid4(), requires_password=False
    ).permission == SharePermission.view


def test_direct_shares_are_untouched():
    """Sharing straight to a user or team is the authenticated path with its own
    access control, not the public link this issue is about."""
    assert DirectShareCreate(user_id=uuid.uuid4()).permission == SharePermission.view
