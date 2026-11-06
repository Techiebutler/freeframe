"""normalize_brand_name: ported from the dispatcher's `_norm`, which named the live workspaces.

A match here means the portal links that workspace instead of creating a second one, so these are
the real edge cases from the live brand list (the dispatcher's own test file, kept identical)."""
from apps.api.services.workspace_names import normalize_brand_name as norm


def test_strips_case_and_non_alphanumerics():
    assert norm("Daily Bio Labs") == "dailybiolabs"
    assert norm("Daily Bio Labs") == norm("DailyBioLabs")


def test_drops_legal_suffixes():
    assert norm("Keller Gesundheit GmbH") == norm("Keller Gesundheit")
    assert norm("Acme UG") == norm("Acme Ltd") == norm("Acme Inc") == norm("Acme LLC") == "acme"
    assert norm("Acme B.V.") != "acme"  # only " bv" is a suffix; a dotted form keeps its letters, as before


def test_plain_brand():
    assert norm("Bitterliebe") == "bitterliebe"


def test_bare_brand_matches_its_dash_workspace_project():
    # The crux: a bare brand must match its auto-backfilled "<Brand> - Workspace" project.
    assert norm("Levide") == norm("Levide - Workspace")
    assert norm("ByNoria") == "bynoria"


def test_parenthetical_owner_is_dropped():
    assert norm("mammaly (Peturo GmbH)") == norm("mammaly - Workspace")


def test_slash_alias_keeps_the_first_name():
    assert norm("Glow25 / DailyRituals") == norm("Glow25")


def test_known_alias_map():
    assert norm("Keller Gesundheitspflege GmbH") == norm("Keller Gesundheit - Workspace") == "kellergesundheit"


def test_a_new_slash_brand_is_not_over_matched():
    assert norm("Beinfit / Swivy") == "beinfit"
    assert norm("Beinfit / Swivy") != norm("Glow25")


def test_suffix_replacement_is_anywhere_like_the_dispatcher():
    # Ported faithfully, quirk included: " co" is removed mid-name too. Both sides go through the
    # same function, so a workspace named by the dispatcher still matches.
    assert norm("Daily Coffee") == "dailyffee"
    assert norm("Daily Coffee") == norm("Daily Coffee - Workspace")


def test_empty_and_none():
    assert norm(None) == ""
    assert norm("") == ""
    assert norm("GmbH") == "gmbh"  # no leading space, so not a suffix
    assert norm("(Peturo GmbH)") == ""
