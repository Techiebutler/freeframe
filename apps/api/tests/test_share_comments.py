import uuid
from unittest.mock import MagicMock, patch

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
    comment = MagicMock()
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
    mock_batched.assert_called_once_with(asset_id, [comment], mock_db)


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
    comment = MagicMock()
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
    mock_batched.assert_called_once_with(asset_id, [comment], mock_db)
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
