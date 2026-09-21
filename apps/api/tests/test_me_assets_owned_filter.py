"""`GET /me/assets?filter=owned` is what the uploads panel now asks for (#374).

The panel labels its history "Uploads". Unfiltered, this endpoint answers with
every asset in every project the caller is a member of, in whatever role, plus
anything merely shared with or assigned to them, so the panel listed other
people's files. The fix is one query-string token, and its meaning lives
entirely in a server-side branch: nothing on either side of the wire tied
`"owned"` in the store to `"owned"` in the router, and changing the router's
literal to a typo fell through to the unfiltered branch, undid the fix
completely, and reddened nothing.

The second test is the tradeoff rather than the fix. `filter=owned` is
`Asset.created_by`, which is the creator of the ASSET, while each upload's
authorship lives on `AssetVersion.created_by`. A new version uploaded onto a
colleague's asset is genuinely the caller's upload and is not `owned`. Issue
#374 names this as the known cost of the narrow fix over an
`AssetVersion.created_by` filter, so it is pinned here as behaviour rather than
left to be rediscovered as a bug.
"""
import uuid


def _seed(real_db):
    """Two users in one project: the caller, and a colleague who owns an asset."""
    from apps.api.models.user import User
    from apps.api.models.project import Project, ProjectType, ProjectMember, ProjectRole
    from apps.api.models.asset import Asset, AssetType, AssetVersion, ProcessingStatus

    caller = User(email=f"owned-a-{uuid.uuid4()}@t.local", name="caller")
    colleague = User(email=f"owned-b-{uuid.uuid4()}@t.local", name="colleague")
    real_db.add_all([caller, colleague]); real_db.flush()

    project = Project(name="t", project_type=ProjectType.personal, created_by=colleague.id)
    real_db.add(project); real_db.flush()
    real_db.add_all([
        ProjectMember(project_id=project.id, user_id=colleague.id, role=ProjectRole.owner),
        ProjectMember(project_id=project.id, user_id=caller.id, role=ProjectRole.editor),
    ])
    real_db.flush()

    def asset(owner, name):
        a = Asset(project_id=project.id, name=name, asset_type=AssetType.video,
                  created_by=owner.id)
        real_db.add(a); real_db.flush()
        v = AssetVersion(asset_id=a.id, version_number=1,
                         processing_status=ProcessingStatus.ready, created_by=owner.id)
        real_db.add(v); real_db.flush()
        return a

    return caller, colleague, project, asset


def _names(rows):
    return sorted(r.name for r in rows)


def test_owned_returns_only_what_the_caller_created(real_db):
    """The bug itself: unfiltered, a member sees the whole project."""
    from apps.api.routers.me import list_my_assets

    caller, colleague, _project, asset = _seed(real_db)
    asset(caller, "mine")
    asset(colleague, "theirs")

    owned = list_my_assets(filter="owned", q=None, skip=0, limit=20,
                           db=real_db, current_user=caller)
    everything = list_my_assets(filter=None, q=None, skip=0, limit=20,
                                db=real_db, current_user=caller)

    assert _names(owned) == ["mine"]
    # The contrast is the point: without the token the colleague's file is
    # there, which is what the panel was showing under "Uploads".
    assert "theirs" in _names(everything)


def test_owned_leaves_out_a_version_the_caller_uploaded_onto_someone_elses_asset(real_db):
    """The documented cost of filtering on the asset rather than the version.

    `Asset.created_by` is written once, when the asset is created, and
    `POST /assets/{id}/versions` never touches it. So this row is the caller's
    upload by every meaning the word has, and `filter=owned` does not return
    it. Pinned so that changing the filter to `AssetVersion.created_by` (the
    other option in #374) is a visible decision rather than a silent one.
    """
    from apps.api.models.asset import AssetVersion, ProcessingStatus
    from apps.api.routers.me import list_my_assets

    caller, colleague, _project, asset = _seed(real_db)
    theirs = asset(colleague, "theirs")
    real_db.add(AssetVersion(asset_id=theirs.id, version_number=2,
                             processing_status=ProcessingStatus.ready,
                             created_by=caller.id))
    real_db.flush()

    owned = list_my_assets(filter="owned", q=None, skip=0, limit=20,
                           db=real_db, current_user=caller)

    assert _names(owned) == []
    assert theirs.created_by == colleague.id
