from apps.api.scripts.backfill_rule_ids import match_rule, plan, review_source_for
from apps.api.schemas.comment import ReviewSource

GENMOJI = {"id": "aditor:3244025f", "name": "Alan nur als Genmoji", "fixMessage": "Alan darf nur als Genmoji vorkommen, nie als echtes Gesicht.", "scope": "global", "updatedAt": 5}
SLOP = {"id": "aditor:slop0001", "name": "Kein AI-Slop-HTML", "fixMessage": "Kein generisches AI-Slop-HTML-Design verwenden.", "scope": "global", "ruleVersionId": "rv-9"}
BRAND = {"id": "b1", "name": "Logo sichtbar", "fixMessage": "Das Logo muss am Ende sichtbar sein.", "scope": "brand"}


def test_two_real_examples_recovered_and_valid():
    rows = [("c1", "a", "v", "Must fix — Alan nur als Genmoji. Alan kommt als Gesicht vor. Alan darf nur als Genmoji vorkommen, nie als echtes Gesicht."),
            ("c2", "a", "v", "Must fix — Das Design ist generisch. Kein generisches AI-Slop-HTML-Design verwenden."),
            ("c3", "a", "v", "Der Ton rauscht ein wenig.")]
    fixes, lost = plan(rows, [GENMOJI, SLOP, BRAND])
    assert [(f[0], f[2]) for f in fixes] == [("c1", "aditor:3244025f"), ("c2", "aditor:slop0001")]
    assert [l[:2] for l in lost] == [("c3", "no-rule-matches")]
    for _, src, *_ in fixes:
        assert ReviewSource.model_validate(src).requirement_id == src["requirement_id"]


def test_ambiguous_and_trainee_are_not_guessed():
    twin = {**SLOP, "id": "aditor:twin"}
    assert match_rule("Kein generisches AI-Slop-HTML-Design verwenden.", [SLOP, twin])[0] is None
    assert review_source_for({**SLOP, "scope": "trainee"}) is None
    assert match_rule("x", [{"id": "s", "name": "", "fixMessage": "short"}])[0] is None


def test_inline_rule_prefix_matches_and_validates():
    from apps.api.scripts.backfill_rule_ids import parse_inline_rules
    rules = parse_inline_rules(["aditor-05-alan-only-as-genmoji=Alan nur als Genmoji", "aditor-02-no-ai-slop-html=Kein AI-Slop-HTML"])
    rows = [("c1", "a", "v", "Must fix — Alan nur als Genmoji. Gesicht zu sehen."),
            ("c2", "a", "v", "Kein AI-Slop-HTML: generisch."), ("c3", "a", "v", "Ton rauscht.")]
    fixes, lost = plan(rows, rules)
    assert [(f[0], f[2]) for f in fixes] == [("c1", "aditor-05-alan-only-as-genmoji"), ("c2", "aditor-02-no-ai-slop-html")]
    assert [l[0] for l in lost] == ["c3"]
    assert ReviewSource.model_validate(fixes[0][1]).sources[0].layer == "brand"   # brand rules, as the worker writes them
    assert parse_inline_rules(["x=Y"], "global")[0]["scope"] == "global"


def test_inline_rule_bad_spec_exits():
    import pytest
    from apps.api.scripts.backfill_rule_ids import parse_inline_rules
    with pytest.raises(SystemExit):
        parse_inline_rules(["no-equals-sign"])


def test_asset_filter_drops_request_and_age_limits(monkeypatch):
    import uuid
    from sqlalchemy.orm import Query, Session
    from apps.api.scripts.backfill_rule_ids import candidates
    monkeypatch.setattr(Query, "all", lambda self: str(self))
    one = candidates(Session(), asset_id=uuid.uuid4())
    allq = candidates(Session())
    assert "comments.asset_id =" in one and "upload_requests" not in one and "created_at >=" not in one
    assert "guest_users.email =" in one and "review_source IS NULL" in one
    assert "upload_requests" in allq and "comments.asset_id =" not in allq
