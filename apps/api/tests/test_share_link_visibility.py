"""Regression coverage for direct asset-share visibility."""
import uuid
from unittest.mock import MagicMock, patch

from apps.api.models.share import ShareVisibility
from apps.api.schemas.share import ShareLinkCreate


@patch("apps.api.routers.share.require_project_role")
@patch("apps.api.routers.share._get_asset")
def test_direct_asset_share_persists_requested_visibility(
    mock_get_asset,
    mock_require_role,
    mock_db,
    test_user,
):
    """The single-asset dialog must not fall back to a database default."""
    from apps.api.routers.share import create_share_link

    asset_id = uuid.uuid4()
    mock_get_asset.return_value = MagicMock(project_id=uuid.uuid4(), name="Review clip")

    # The mock session never fills in the row's id or timestamps, so building the
    # response is out of scope here; only what was saved is under test.
    with patch("apps.api.routers.share._share_link_response"):
        create_share_link(
            asset_id=asset_id,
            body=ShareLinkCreate(visibility=ShareVisibility.public),
            db=mock_db,
            current_user=test_user,
        )

    saved_link = mock_db.add.call_args_list[0].args[0]
    assert saved_link.asset_id == asset_id
    assert saved_link.visibility == ShareVisibility.public
    mock_require_role.assert_called_once()
