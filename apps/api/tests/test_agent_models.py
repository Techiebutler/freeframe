"""Agent-review platform data model: migrations ap01/ap02 on a single head."""
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory


def test_user_kind_and_project_flag_columns():
    from apps.api.models.project import Project
    from apps.api.models.user import User
    assert User.__table__.c.kind.nullable is False
    assert User.__table__.c.kind.server_default.arg == "human"
    assert Project.__table__.c.agents_may_approve.nullable is False


def test_agent_tables_and_dedup_key():
    from apps.api.models.agent import AgentKey, AgentPairingCode, FeedbackRound
    cols = {c.name for c in AgentKey.__table__.c}
    assert {"user_id", "project_id", "program", "agent_name", "key_hash", "last_used_at", "revoked_at"} <= cols
    assert AgentKey.__table__.c.key_hash.unique
    uniques = [sorted(c.name for c in u.columns) for u in AgentKey.__table__.constraints if u.__class__.__name__ == "UniqueConstraint"]
    assert ["agent_name", "program", "project_id"] in uniques
    assert AgentPairingCode.__table__.c.code_hash.unique
    assert {"request_id", "opened_at", "closed_at", "closed_by", "last_activity_at", "acked_at", "rule_suggestions"} <= {c.name for c in FeedbackRound.__table__.c}


def test_single_alembic_head_is_ap03():
    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    assert ScriptDirectory.from_config(cfg).get_heads() == ["ap03_comment_idempotency_key"]
