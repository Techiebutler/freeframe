"""
Celery tasks for sending emails asynchronously.

Queues:
- email_high: Magic codes, invites (immediate)
- email_low: Mentions, comments, shares (can be slightly delayed)
"""
from datetime import datetime
from pathlib import Path
from typing import Optional
from celery import shared_task
from jinja2 import Environment, FileSystemLoader

# Setup Jinja2 template environment
TEMPLATE_DIR = Path(__file__).parent.parent / "templates"
jinja_env = Environment(
    loader=FileSystemLoader(str(TEMPLATE_DIR)),
    autoescape=True,
)


def render_template(template_name: str, **context) -> str:
    """Render an email template with context."""
    context.setdefault("year", datetime.now().year)
    template = jinja_env.get_template(template_name)
    return template.render(**context)


def _send_email(to_email: str, subject: str, html_body: str, text_body: Optional[str] = None) -> bool:
    """Send email using the email service."""
    # Import here to avoid circular imports
    from ..services.email_service import email_service
    return email_service.send_email(to_email, subject, html_body, text_body)


# ============================================================================
# HIGH PRIORITY EMAILS (email_high queue)
# ============================================================================

@shared_task(bind=True, queue="email_high", max_retries=3, default_retry_delay=30)
def send_magic_code_email(self, to_email: str, code: str, expiry_minutes: int = 10, org_name: Optional[str] = None):
    """Send magic code email - high priority, immediate delivery."""
    label = org_name or "FreeFrame"
    try:
        subject = f"Your {label} login code: {code}"
        html_body = render_template(
            "email/magic_code.html",
            subject=subject,
            code=code,
            expiry_minutes=expiry_minutes,
            org_name=label,
        )
        text_body = f"Your {label} login code is: {code}. This code expires in {expiry_minutes} minutes."
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_high", max_retries=3, default_retry_delay=60)
def send_invite_email(
    self,
    to_email: str,
    inviter_name: str,
    org_name: str,
    invite_link: str,
    team_name: Optional[str] = None,
    expiry_days: int = 7,
):
    """Send organization/team invite email - high priority."""
    try:
        subject = f"You've been invited to join {org_name}"
        html_body = render_template(
            "email/invite.html",
            subject=subject,
            inviter_name=inviter_name,
            org_name=org_name,
            team_name=team_name,
            invite_link=invite_link,
            expiry_days=expiry_days,
        )
        text_body = f"{inviter_name} has invited you to join {org_name}. Accept here: {invite_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


# ============================================================================
# MEDIUM PRIORITY EMAILS (email_low queue)
# ============================================================================

@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_mention_email(
    self,
    to_email: str,
    mentioner_name: str,
    asset_name: str,
    comment_preview: str,
    asset_link: str,
):
    """Send mention notification email."""
    try:
        subject = f"{mentioner_name} mentioned you on {asset_name}"
        html_body = render_template(
            "email/mention.html",
            subject=subject,
            mentioner_name=mentioner_name,
            asset_name=asset_name,
            comment_preview=comment_preview,
            asset_link=asset_link,
        )
        text_body = f"{mentioner_name} mentioned you on {asset_name}: {comment_preview}\n\nView: {asset_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_comment_email(
    self,
    to_email: str,
    commenter_name: str,
    asset_name: str,
    comment_preview: str,
    asset_link: str,
):
    """Send new comment notification email."""
    try:
        subject = f"New comment on {asset_name}"
        html_body = render_template(
            "email/comment.html",
            subject=subject,
            commenter_name=commenter_name,
            asset_name=asset_name,
            comment_preview=comment_preview,
            asset_link=asset_link,
        )
        text_body = f"{commenter_name} commented on {asset_name}: {comment_preview}\n\nView: {asset_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_assignment_email(
    self,
    to_email: str,
    assigner_name: str,
    asset_name: str,
    asset_link: str,
    due_date: Optional[str] = None,
    project_name: Optional[str] = None,
):
    """Send assignment notification email."""
    try:
        due_text = f" (due {due_date})" if due_date else ""
        subject = f"You've been assigned to review {asset_name}{due_text}"
        html_body = render_template(
            "email/assignment.html",
            subject=subject,
            assigner_name=assigner_name,
            asset_name=asset_name,
            asset_link=asset_link,
            due_date=due_date,
            project_name=project_name,
        )
        text_body = f"{assigner_name} assigned you to review {asset_name}.{' Due: ' + due_date if due_date else ''}\n\nView: {asset_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_share_email(
    self,
    to_email: str,
    sharer_name: str,
    asset_name: str,
    asset_link: str,
    permission: Optional[str] = None,
    message: Optional[str] = None,
):
    """Send asset shared notification email."""
    try:
        subject = f"{sharer_name} shared {asset_name} with you"
        html_body = render_template(
            "email/share.html",
            subject=subject,
            sharer_name=sharer_name,
            asset_name=asset_name,
            asset_link=asset_link,
            permission=permission,
            message=message,
        )
        text_body = f"{sharer_name} shared {asset_name} with you.\n\nView: {asset_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_approval_email(
    self,
    to_email: str,
    reviewer_name: str,
    asset_name: str,
    status: str,  # "approved" or "rejected"
    asset_link: str,
    note: Optional[str] = None,
):
    """Send approval/rejection notification email."""
    try:
        status_emoji = "✅" if status == "approved" else "❌"
        subject = f"{status_emoji} {asset_name} has been {status}"
        html_body = render_template(
            "email/approval.html",
            subject=subject,
            reviewer_name=reviewer_name,
            asset_name=asset_name,
            status=status,
            asset_link=asset_link,
            note=note,
        )
        text_body = f"{reviewer_name} {status} {asset_name}.{' Note: ' + note if note else ''}\n\nView: {asset_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)


@shared_task(bind=True, queue="email_low", max_retries=3, default_retry_delay=120)
def send_project_added_email(
    self,
    to_email: str,
    adder_name: str,
    project_name: str,
    project_link: str,
    org_name: Optional[str] = None,
    role: Optional[str] = None,
):
    """Send project added notification email."""
    try:
        subject = f"You've been added to {project_name}"
        html_body = render_template(
            "email/project_added.html",
            subject=subject,
            adder_name=adder_name,
            project_name=project_name,
            project_link=project_link,
            org_name=org_name,
            role=role,
        )
        text_body = f"{adder_name} added you to {project_name}.\n\nView: {project_link}"
        
        success = _send_email(to_email, subject, html_body, text_body)
        if not success:
            raise Exception("Email sending failed")
        return {"status": "sent", "to": to_email}
    except Exception as exc:
        self.retry(exc=exc)
