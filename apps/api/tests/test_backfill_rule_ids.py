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
