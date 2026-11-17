import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from jose import jwt

from apps.api.config import settings
from apps.api.models.share import SharePermission


@patch("apps.api.routers.comments.validate_asset_in_share")
@patch("apps.api.routers.comments._build_comment_responses_batched")
@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_share_comments_returns_array_for_asset_share(
    mock_validate,
    mock_batched,
    mock_validate_asset,
    client,
    mock_db,
):
    asset_id = uuid.uuid4()
    comment = MagicMock(visibility="public", review_source=None, review_publication_id=None, author_id=None)  # a person's comment (client_view keeps it)
    expected = {
        "id": str(uuid.uuid4()),
        "body": "Looks good",
    }

    link = MagicMock()
    link.asset_id = asset_id
    mock_validate.return_value = link
    asset = MagicMock()
    asset.id = asset_id
    mock_db.first.return_value = asset  # _get_asset lookup
    mock_db.order_by.return_value = mock_db
    mock_db.all.return_value = [comment]
    mock_batched.return_value = [expected]

    response = client.get("/share/some-token/comments")

    assert response.status_code == 200
    assert response.json() == [expected]
    # Batched builder, called once for the whole thread (no per-comment N+1).
    mock_batched.assert_called_once_with(asset_id, [comment], mock_db, exclude_internal=True)


# ── Automated reviewer comments are stored internal (hidden from client shares) ────────────────
#
# The craft reviewer comments through a share link as a guest (review@aditor.ai). Its findings are
# internal notes for the editor, not for the client on the delivered cut. Rather than a second
# hiding rule, its comments are stored visibility="internal" at write time, so the ONE existing
# exclude-internal share filter keeps them off every client-facing timeline while members still see
# them in the app. These pin that decision.

def test_a_configured_automation_guest_comments_internal():
    from apps.api.routers.comments import _guest_comment_visibility

    original = settings.automation_guest_emails
    settings.automation_guest_emails = "review@aditor.ai"
    try:
        # A guest author whose email is the configured automation address -> internal.
        assert _guest_comment_visibility(uuid.uuid4(), "review@aditor.ai") == "internal"
        # Case-insensitive, matching how guest emails are stored.
        assert _guest_comment_visibility(uuid.uuid4(), "Review@Aditor.AI") == "internal"
    finally:
        settings.automation_guest_emails = original


def test_a_human_guest_comments_publicly():
    from apps.api.routers.comments import _guest_comment_visibility

    original = settings.automation_guest_emails
    settings.automation_guest_emails = "review@aditor.ai"
    try:
        # A real client guest is never hidden - their comment stays public.
        assert _guest_comment_visibility(uuid.uuid4(), "client@brand.com") == "public"
    finally:
        settings.automation_guest_emails = original


def test_a_member_comment_is_never_stamped_internal_by_this():
    from apps.api.routers.comments import _guest_comment_visibility

    original = settings.automation_guest_emails
    settings.automation_guest_emails = "review@aditor.ai"
    try:
        # A logged-in member has no guest_author_id; the automation rule must not touch it, even if
        # some email were carried on the body.
        assert _guest_comment_visibility(None, "review@aditor.ai") == "public"
    finally:
        settings.automation_guest_emails = original


def test_nothing_is_internal_when_no_automation_guest_is_configured():
    from apps.api.routers.comments import _guest_comment_visibility

    original = settings.automation_guest_emails
    settings.automation_guest_emails = ""  # the default: the feature is off
    try:
        assert _guest_comment_visibility(uuid.uuid4(), "review@aditor.ai") == "public"
    finally:
        settings.automation_guest_emails = original


@patch("apps.api.routers.comments.validate_asset_in_share")
@patch("apps.api.routers.comments._build_comment_responses_batched")
@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_share_comments_returns_array_for_folder_or_project_share_asset(
    mock_validate,
    mock_batched,
    mock_validate_asset,
    client,
    mock_db,
):
    asset_id = uuid.uuid4()
    comment = MagicMock(visibility="public", review_source=None, review_publication_id=None, author_id=None)  # a person's comment (client_view keeps it)
    expected = {
        "id": str(uuid.uuid4()),
        "body": "Needs one tweak",
    }

    link = MagicMock()
    link.asset_id = None
    mock_validate.return_value = link
    asset = MagicMock()
    asset.id = asset_id
    mock_db.first.return_value = asset  # _get_asset lookup
    mock_db.order_by.return_value = mock_db
    mock_db.all.return_value = [comment]
    mock_batched.return_value = [expected]

    response = client.get(f"/share/some-token/comments?asset_id={asset_id}")

    assert response.status_code == 200
    assert response.json() == [expected]
    mock_batched.assert_called_once_with(asset_id, [comment], mock_db, exclude_internal=True)
    # Regression: the client-supplied asset_id must be checked against the link's scope
    # (GHSA-5x82-5pxm-x2q7), not trusted outright.
    mock_validate_asset.assert_called_once_with(mock_db, link, asset)


@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_share_comments_returns_empty_array_without_target_asset(
    mock_validate,
    client,
):
    link = MagicMock()
    link.asset_id = None
    mock_validate.return_value = link

    response = client.get("/share/some-token/comments")

    assert response.status_code == 200
    assert response.json() == []


def test_share_comments_rejects_asset_outside_shared_folder(client, mock_db):
    """GET /share/{token}/comments — a folder-scoped link's asset_id query param is validated
    against the link's actual scope, not trusted outright (GHSA-5x82-5pxm-x2q7). Uses the real
    validate_asset_in_share so the rejection is exercised, not just asserted-called."""
    shared_folder_id = uuid.uuid4()
    other_asset_id = uuid.uuid4()

    link = MagicMock()
    link.asset_id = None
    link.folder_id = shared_folder_id
    link.project_id = None

    other_asset = MagicMock()
    other_asset.id = other_asset_id
    other_asset.folder_id = None  # not in the shared folder, and no parent chain to it

    with patch("apps.api.routers.comments.validate_share_link_with_session", return_value=link), \
         patch("apps.api.routers.comments._get_asset", return_value=other_asset):
        response = client.get(f"/share/some-token/comments?asset_id={other_asset_id}")

    assert response.status_code == 403


def test_guest_comment_single_asset_link_ignores_body_asset_id(client, mock_db):
    """POST /share/{token}/comment — a single-asset share link always comments on its own
    asset; a client-supplied body.asset_id for a different asset is never consulted
    (GHSA-5x82-5pxm-x2q7)."""
    shared_asset_id = uuid.uuid4()
    other_asset_id = uuid.uuid4()

    link = MagicMock()
    link.asset_id = shared_asset_id
    link.folder_id = None
    link.project_id = None
    link.permission = SharePermission.comment

    shared_asset = MagicMock()
    shared_asset.id = shared_asset_id
    shared_asset.folder_id = None
    shared_asset.project_id = uuid.uuid4()

    with patch("apps.api.routers.comments.validate_share_link_with_session", return_value=link), \
         patch("apps.api.routers.comments._get_asset") as mock_get_asset:
        mock_get_asset.return_value = shared_asset
        mock_db.order_by.return_value = mock_db
        mock_db.first.return_value = None  # no ready version -> 400, short-circuits before insert

        response = client.post(
            "/share/some-token/comment",
            json={
                "asset_id": str(other_asset_id),
                "body": "sneaky comment",
                "guest_email": "attacker@example.com",
                "guest_name": "Attacker",
            },
        )

        # _get_asset must have been called with the link's own asset, never the attacker's.
        mock_get_asset.assert_called_once_with(mock_db, shared_asset_id)

    # No ready version for the (correctly-resolved) shared asset -> 400, not a successful post.
    assert response.status_code == 400


def test_guest_comment_rejects_asset_outside_shared_project(client, mock_db):
    """POST /share/{token}/comment — a project-scoped share link can't be redirected to comment
    on an asset from a different, unrelated project (GHSA-5x82-5pxm-x2q7)."""
    shared_project_id = uuid.uuid4()
    other_project_id = uuid.uuid4()
    other_asset_id = uuid.uuid4()

    link = MagicMock()
    link.asset_id = None
    link.folder_id = None
    link.project_id = shared_project_id
    link.id = uuid.uuid4()
    link.permission = SharePermission.comment

    other_asset = MagicMock()
    other_asset.id = other_asset_id
    other_asset.folder_id = None
    other_asset.project_id = other_project_id  # not the shared project

    with patch("apps.api.routers.comments.validate_share_link_with_session", return_value=link), \
         patch("apps.api.routers.comments._get_asset", return_value=other_asset):
        response = client.post(
            "/share/some-token/comment",
            json={
                "asset_id": str(other_asset_id),
                "body": "sneaky comment",
                "guest_email": "attacker@example.com",
                "guest_name": "Attacker",
            },
        )

    assert response.status_code == 403


@patch("apps.api.routers.comments.validate_asset_in_share")
@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_expired_bearer_is_anonymous_rather_than_rejected(
    mock_validate, mock_validate_asset, client, mock_db
):
    """A share link is reachable without an account, so an unusable bearer is not
    an error here - the request simply arrives as a guest. That is deliberate,
    and it is also the trap: the caller is never told its session died, so a UI
    that mistakes a stored token for a live one omits the guest identity and
    lands on this 400 with nothing pointing at the real cause. The share client
    must therefore decide "signed in" from the token's expiry, not its presence.
    """
    asset_id = uuid.uuid4()
    link = MagicMock()
    link.permission = SharePermission.comment
    link.asset_id = asset_id
    mock_validate.return_value = link
    asset = MagicMock()
    asset.id = asset_id
    mock_db.first.return_value = asset  # _get_asset lookup

    expired = jwt.encode(
        {
            "sub": str(uuid.uuid4()),
            "type": "access",
            "exp": datetime.now(timezone.utc) - timedelta(minutes=1),
            "ver": 1,
        },
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )

    response = client.post(
        "/share/some-token/comment",
        json={
            "body": "Test",
            "asset_id": str(asset_id),
            "version_id": str(uuid.uuid4()),
        },
        headers={"Authorization": f"Bearer {expired}"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "guest_email and guest_name required for anonymous comments"
    )


# ── DELETE /share/{token}/comment/{id} ───────────────────────────────────────────────────────
#
# An automation commenting through a share link has no account, so until now it could never take
# back a comment: a superseded or wrong automated note stayed on a client-facing timeline until a
# project owner removed it by hand. These tests pin the narrow permission that fixes that, and -
# more importantly - the cases that must stay refused.

def _guest_comment(guest_email="review@aditor.ai"):
    comment = MagicMock(visibility="public", review_source=None, review_publication_id=None, author_id=None)  # a person's comment (client_view keeps it)
    comment.id = uuid.uuid4()
    comment.author_id = None
    comment.guest_author_id = uuid.uuid4()
    comment.asset_id = uuid.uuid4()
    comment.deleted_at = None
    guest = MagicMock()
    guest.id = comment.guest_author_id
    guest.email = guest_email
    return comment, guest


def test_delete_is_refused_when_no_guest_is_configured(client, mock_db):
    settings.share_comment_deletable_guest_emails = ""
    r = client.delete(f"/share/tok/comment/{uuid.uuid4()}?guest_email=review@aditor.ai")
    assert r.status_code == 403


def test_delete_is_refused_for_a_guest_not_on_the_list(client, mock_db):
    settings.share_comment_deletable_guest_emails = "review@aditor.ai"
    r = client.delete(f"/share/tok/comment/{uuid.uuid4()}?guest_email=someone@else.com")
    assert r.status_code == 403


@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_delete_is_refused_on_a_view_only_link(mock_validate, client, mock_db):
    settings.share_comment_deletable_guest_emails = "review@aditor.ai"
    link = MagicMock()
    link.permission = SharePermission.view
    mock_validate.return_value = link
    r = client.delete(f"/share/tok/comment/{uuid.uuid4()}?guest_email=review@aditor.ai")
    assert r.status_code == 403


@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_a_persons_comment_is_never_deletable_this_way(mock_validate, client, mock_db):
    # The whole risk of this endpoint. A comment with an author_id belongs to a human being, and
    # no configuration may make it reachable.
    settings.share_comment_deletable_guest_emails = "review@aditor.ai"
    link = MagicMock()
    link.permission = SharePermission.comment
    mock_validate.return_value = link
    human = MagicMock()
    human.author_id = uuid.uuid4()
    human.guest_author_id = None
    human.deleted_at = None
    mock_db.first.return_value = human
    r = client.delete(f"/share/tok/comment/{uuid.uuid4()}?guest_email=review@aditor.ai")
    assert r.status_code == 403


@patch("apps.api.routers.comments.validate_asset_in_share")
@patch("apps.api.routers.comments.validate_share_link_with_session")
def test_a_guest_deletes_its_own_comment(mock_validate, mock_asset_in_share, client, mock_db):
    settings.share_comment_deletable_guest_emails = "review@aditor.ai"
    link = MagicMock()
    link.permission = SharePermission.comment
    mock_validate.return_value = link
    comment, guest = _guest_comment()
    asset = MagicMock()
    mock_db.first.side_effect = [comment, guest, asset]

    r = client.delete(f"/share/tok/comment/{comment.id}?guest_email=review@aditor.ai")

    assert r.status_code == 204
    assert comment.deleted_at is not None   # soft delete, the row is kept
