import uuid
from unittest.mock import MagicMock, patch


@patch("apps.api.routers.comments._build_comment_responses_batched")
@patch("apps.api.routers.comments.validate_share_link")
def test_share_comments_returns_array_for_asset_share(
    mock_validate,
    mock_batched,
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
    mock_db.order_by.return_value = mock_db
    mock_db.all.return_value = [comment]
    mock_batched.return_value = [expected]

    response = client.get("/share/some-token/comments")

    assert response.status_code == 200
    assert response.json() == [expected]
    # Batched builder, called once for the whole thread (no per-comment N+1).
    mock_batched.assert_called_once_with(asset_id, [comment], mock_db)


@patch("apps.api.routers.comments._build_comment_responses_batched")
@patch("apps.api.routers.comments.validate_share_link")
def test_share_comments_returns_array_for_folder_or_project_share_asset(
    mock_validate,
    mock_batched,
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
    mock_db.order_by.return_value = mock_db
    mock_db.all.return_value = [comment]
    mock_batched.return_value = [expected]

    response = client.get(f"/share/some-token/comments?asset_id={asset_id}")

    assert response.status_code == 200
    assert response.json() == [expected]
    mock_batched.assert_called_once_with(asset_id, [comment], mock_db)


@patch("apps.api.routers.comments.validate_share_link")
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
