"""Every email carries the instance's brand, not the product's.

Only the magic-code and invite senders ever passed an org_name, so the other
six rendered the shared header, footer and From line as FreeFrame however the
instance was branded. render_template now resolves the name centrally, and
these tests fail for any template that reintroduces a hardcoded brand.
"""
from pathlib import Path
from unittest.mock import patch

import pytest

TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates" / "email"

# Superset of what the templates reference; unused keys are harmless and Jinja
# renders anything missing as empty, so a template gaining a variable does not
# silently break this.
SAMPLE_CONTEXT = dict(
    subject="Subject",
    code="123456",
    expiry_minutes=10,
    expiry_days=7,
    inviter_name="Dana",
    invite_link="https://example.test/invite",
    team_name="Post",
    mentioner_name="Dana",
    commenter_name="Dana",
    comment_body="Looks good",
    asset_name="scene-01.mp4",
    asset_link="https://example.test/asset",
    assigner_name="Dana",
    due_date="tomorrow",
    sharer_name="Dana",
    share_link="https://example.test/share",
    share_title="Rough cut",
    message="Take a look",
    approver_name="Dana",
    status="approved",
    project_name="Pilot",
    project_link="https://example.test/project",
    adder_name="Dana",
    role="editor",
    recipient_name="Sam",
)

BRAND = "Acme Studio"


def _content_templates():
    return sorted(p.name for p in TEMPLATE_DIR.glob("*.html") if p.name != "base.html")


def test_every_template_is_discovered():
    """Guards the parametrised test below against silently covering nothing."""
    assert len(_content_templates()) >= 8


@pytest.mark.parametrize("template", _content_templates())
def test_template_renders_the_instance_brand(template):
    from apps.api.tasks import email_tasks

    with patch.object(email_tasks, "resolve_org_name", return_value=BRAND):
        html = email_tasks.render_template(f"email/{template}", **SAMPLE_CONTEXT)

    assert BRAND in html, f"{template} never renders the instance name"
    assert "FreeFrame" not in html, f"{template} still hardcodes the product name"


def test_an_explicit_org_name_is_not_overridden():
    """The invite flow passes a name of its own; it must win."""
    from apps.api.tasks import email_tasks

    with patch.object(email_tasks, "resolve_org_name", return_value=BRAND):
        html = email_tasks.render_template(
            "email/invite.html", org_name="Passed In", **SAMPLE_CONTEXT
        )

    assert "Passed In" in html
    assert BRAND not in html


class TestFromLine:
    def test_follows_branding_when_unset(self):
        from apps.api.services import email_service as module

        with patch.object(module.settings, "mail_from_name", ""), patch(
            "apps.api.services.branding_service.resolve_org_name", return_value=BRAND
        ):
            assert module.email_service.from_name == BRAND

    def test_an_operator_setting_wins(self):
        from apps.api.services import email_service as module

        with patch.object(module.settings, "mail_from_name", "Pinned Name"), patch(
            "apps.api.services.branding_service.resolve_org_name", return_value=BRAND
        ):
            assert module.email_service.from_name == "Pinned Name"


class TestOrgNameResolution:
    def test_falls_back_when_the_database_is_unavailable(self):
        """A worker that starts before the database still sends mail."""
        from apps.api.services import branding_service

        branding_service.reset_org_name_cache()
        with patch(
            "apps.api.database.SessionLocal", side_effect=RuntimeError("no db")
        ):
            assert branding_service.resolve_org_name() == "FreeFrame"
        branding_service.reset_org_name_cache()

    def test_cache_can_be_dropped_after_a_rename(self):
        from apps.api.services import branding_service

        branding_service.reset_org_name_cache()
        assert branding_service._cached is None
