"""Give old Auto Review rule comments the rule id they were written from (review_source.requirement_id).

Before the fix, comments posted by the automatic check on unbound reviews lost the rule id, so get_review showed
rule "" and Gen could not offer the founder override. The id is not stored anywhere in FreeFrame, but the comment
body is built from the rule: "[Must fix — ][<rule name>. ]<why> <rule fixMessage>". So a comment is matched to a rule
only when exactly ONE rule's fixMessage appears in the body (or the body starts with the rule's name); anything else
is listed as unrecoverable and left alone. Human comments (not by the Auto Review guest) are never touched.

Rules come from a JSON file (the output of the AutoReview list_rules tool, {"rules": [...]}, global + brand rules of
the affected brands, merged into one list; or a plain list). Fields used: id, name, fixMessage, scope, ruleVersionId, updatedAt.

Targeted run, no rules file: --asset <uuid> limits to one asset (any age/request state); --rule "<rule_id>=<exact name prefix>"
(repeatable) maps by the start of the body.

Usage (inside the api container; copy the rules file in first with `docker cp rules.json freeframe-api-1:/tmp/rules.json`):
    python -m apps.api.scripts.backfill_rule_ids --rules /tmp/rules.json        # dry run: counts + sample + unrecoverable
    python -m apps.api.scripts.backfill_rule_ids --rules /tmp/rules.json --go   # writes review_source
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

BOT_EMAIL = os.environ.get("FREEFRAME_BOT_EMAIL") or "review@aditor.ai"
MIN_FIX_CHARS = 12  # a shorter fixMessage would match by accident


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").replace("—", "-")).strip().lower()


def match_rule(body: str, rules: list[dict]) -> tuple[Optional[dict], str]:
    """(rule, why). rule is None when no or several rules fit; why says which."""
    b = _norm(re.sub(r"^\s*must fix\s*[—-]\s*", "", body or "", flags=re.I))
    hits = []
    for r in rules:
        fix, name = _norm(r.get("fixMessage", "")), _norm(r.get("name", ""))
        if (len(fix) >= MIN_FIX_CHARS and fix in b) or (name and b.startswith(name + ".")):
            hits.append(r)
    for r in rules:
        pre = _norm(r.get("prefix", ""))
        if pre and b.startswith(pre) and r not in hits:
            hits.append(r)
    if len(hits) == 1:
        return hits[0], "ok"
    return None, "no-rule-matches" if not hits else "ambiguous:" + ",".join(sorted(h["id"] for h in hits))


def review_source_for(rule: dict) -> Optional[dict]:
    layer = {"global": "basics", "brand": "brand"}.get(rule.get("scope"))
    if not layer:
        return None
    version = rule.get("ruleVersionId") or (f"kv:{rule['updatedAt']}" if isinstance(rule.get("updatedAt"), int) and rule["updatedAt"] > 0 else "backfill:v1")
    return {"schema_version": "autoreview.comment-source.v1", "requirement_id": rule["id"],
            "sources": [{"layer": layer, "reference_id": rule["id"], "source_version": version}]}


def load_rules(path: str) -> list[dict]:
    data = json.load(open(path))
    rules = data["rules"] if isinstance(data, dict) else data
    return [r for r in rules if r.get("id") and r.get("active", True) is not False and not r.get("archived")]


def parse_inline_rules(specs: list[str], scope: str = "brand") -> list[dict]:
    """--rule "<rule_id>=<exact name prefix>" -> rules matched by the start of the body. Scope from --scope (brand|global,
    default brand: the worker writes layer "brand" for brand rules like aditor-05-…, "basics" only for global ones)."""
    if scope not in ("brand", "global"):
        sys.exit(f"--scope must be brand or global, got {scope!r}")
    out = []
    for sp in specs:
        rid, sep, prefix = sp.partition("=")
        if not sep or not rid.strip() or not prefix.strip():
            sys.exit(f"--rule needs <rule_id>=<name prefix>, got {sp!r}")
        out.append({"id": rid.strip(), "name": "", "prefix": prefix.strip(), "scope": scope})
    return out


def candidates(db, days=14, asset_id=None):
    """Auto Review comments without a source, on any version in an open request, from the last `days` days.
    With asset_id: every such comment on that asset, regardless of request state or age."""
    from apps.api.models.asset import Asset
    from apps.api.models.comment import Comment
    from apps.api.models.user import GuestUser
    from apps.api.models.upload_request import UploadRequest
    q = (
        db.query(Comment.id, Comment.asset_id, Comment.version_id, Comment.body)
        .join(Asset, Asset.id == Comment.asset_id)
        .join(GuestUser, GuestUser.id == Comment.guest_author_id)
        .filter(Comment.review_source.is_(None), Comment.deleted_at.is_(None), Comment.parent_id.is_(None),
                GuestUser.email == BOT_EMAIL, Asset.deleted_at.is_(None))
    )
    if asset_id:
        return q.filter(Comment.asset_id == asset_id).order_by(Comment.created_at).all()
    return (
        q.join(UploadRequest, UploadRequest.folder_id == Asset.folder_id)
        .filter(UploadRequest.completed_at.is_(None), UploadRequest.revoked_at.is_(None),
                Comment.created_at >= datetime.now(timezone.utc) - timedelta(days=days))
        .all()
    )


def plan(rows, rules):
    """(fixes: [(comment_id, review_source, rule_id, body)], unrecoverable: [(comment_id, why, body)])"""
    fixes, lost = [], []
    for cid, _asset, _ver, body in rows:
        rule, why = match_rule(body, rules)
        src = review_source_for(rule) if rule else None
        if src:
            fixes.append((cid, src, rule["id"], body))
        else:
            lost.append((cid, why if not rule else "rule-scope-not-global-or-brand", body))
    return fixes, lost


def _arg(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None


if __name__ == "__main__":
    from apps.api.database import SessionLocal
    from apps.api.models.asset import AssetVersion
    from apps.api.models.comment import Comment
    from apps.api.schemas.comment import ReviewSource
    inline = [sys.argv[i + 1] for i, a in enumerate(sys.argv[:-1]) if a == "--rule"]
    if not inline and "--rules" not in sys.argv:
        sys.exit("--rules <file.json> or --rule <rule_id>=<name prefix> is required (see the docstring)")
    rules = (load_rules(_arg("--rules")) if "--rules" in sys.argv else []) + parse_inline_rules(inline, _arg("--scope") if "--scope" in sys.argv else "brand")
    db = SessionLocal()
    try:
        rows = candidates(db, asset_id=_arg("--asset"))
        vnum = {v.id: v.version_number for v in db.query(AssetVersion).filter(AssetVersion.id.in_({r[2] for r in rows})).all()} if rows else {}
        ver = {r[0]: vnum.get(r[2]) for r in rows}
        fixes, lost = plan(rows, rules)
        print(f"{len(fixes)} comments would get a rule id, {len(lost)} unrecoverable (left unchanged).")
        for cid, _src, rid, body in fixes:
            print(f"  {cid} v{ver.get(cid)} {body[:60]!r} -> {rid}")
        for cid, why, body in lost:
            print(f"  {cid} v{ver.get(cid)} {body[:60]!r} -> unrecoverable [{why}]")
        if "--go" not in sys.argv:
            print("Dry run. Add --go to write.")
        else:
            for cid, src, _rid, _body in fixes:
                db.query(Comment).filter(Comment.id == cid, Comment.review_source.is_(None)).update(
                    {"review_source": ReviewSource.model_validate(src).model_dump(exclude_none=True)})
            db.commit()
            print(f"Wrote {len(fixes)}.")
    finally:
        db.close()
