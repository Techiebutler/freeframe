import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional
import boto3
from botocore.exceptions import ClientError
from ..config import settings


def mail_is_configured(s=settings) -> bool:
    """Whether the configured mailer can actually send.

    Email is REQUIRED for login (magic codes) and invites, so the app warns at
    startup when it's not set up. `smtp` needs a host; `ses` may authenticate via
    an IAM role, so we can't reliably detect it and assume it's configured.
    """
    provider = (s.mail_provider or "").lower()
    if provider == "smtp":
        return bool(s.smtp_host)
    return provider == "ses"


class EmailService:
    """
    Email service that supports both AWS SES and standard SMTP.
    Auto-detects based on mail_provider setting in config.
    """
    
    def __init__(self):
        self.provider = settings.mail_provider
        self.from_address = settings.mail_from_address
        self.from_name = settings.mail_from_name
    
    def _get_ses_client(self):
        """Create AWS SES client."""
        return boto3.client(
            "ses",
            aws_access_key_id=settings.aws_mail_access_key_id,
            aws_secret_access_key=settings.aws_mail_secret_access_key,
            region_name=settings.aws_mail_region,
        )
    
    def _send_via_ses(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: Optional[str] = None,
    ) -> bool:
        """Send email via AWS SES."""
        if not settings.aws_mail_access_key_id or not settings.aws_mail_secret_access_key:
            raise ValueError("AWS SES credentials not configured")
        
        ses = self._get_ses_client()
        
        body = {"Html": {"Charset": "UTF-8", "Data": html_body}}
        if text_body:
            body["Text"] = {"Charset": "UTF-8", "Data": text_body}
        
        try:
            ses.send_email(
                Source=f"{self.from_name} <{self.from_address}>",
                Destination={"ToAddresses": [to_email]},
                Message={
                    "Subject": {"Charset": "UTF-8", "Data": subject},
                    "Body": body,
                },
            )
            return True
        except ClientError as e:
            print(f"SES error: {e.response['Error']['Message']}")
            return False
    
    def _send_via_smtp(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: Optional[str] = None,
    ) -> bool:
        """Send email via SMTP server."""
        if not settings.smtp_host:
            raise ValueError("SMTP host not configured")
        
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{self.from_name} <{self.from_address}>"
        msg["To"] = to_email
        
        if text_body:
            msg.attach(MIMEText(text_body, "plain"))
        msg.attach(MIMEText(html_body, "html"))
        
        try:
            if settings.smtp_use_tls:
                server = smtplib.SMTP(settings.smtp_host, settings.smtp_port)
                server.starttls()
            else:
                server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port)
            
            if settings.smtp_user and settings.smtp_password:
                server.login(settings.smtp_user, settings.smtp_password)
            
            server.sendmail(self.from_address, [to_email], msg.as_string())
            server.quit()
            return True
        except Exception as e:
            print(f"SMTP error: {e}")
            return False
    
    def send_email(
        self,
        to_email: str,
        subject: str,
        html_body: str,
        text_body: Optional[str] = None,
    ) -> bool:
        """
        Send email using configured provider (SES or SMTP).
        
        Args:
            to_email: Recipient email address
            subject: Email subject
            html_body: HTML content of the email
            text_body: Optional plain text fallback
            
        Returns:
            True if sent successfully, False otherwise
        """
        if self.provider == "ses":
            return self._send_via_ses(to_email, subject, html_body, text_body)
        elif self.provider == "smtp":
            return self._send_via_smtp(to_email, subject, html_body, text_body)
        else:
            raise ValueError(f"Unknown mail provider: {self.provider}")
    
    def send_invite_email(self, to_email: str, inviter_name: str, org_name: str, invite_link: str) -> bool:
        """Send organization invite email."""
        subject = f"You've been invited to join {org_name} on FreeFrame"
        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2>You're invited!</h2>
            <p><strong>{inviter_name}</strong> has invited you to join <strong>{org_name}</strong> on FreeFrame.</p>
            <p>
                <a href="{invite_link}" 
                   style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; 
                          color: white; text-decoration: none; border-radius: 6px;">
                    Accept Invitation
                </a>
            </p>
            <p style="color: #666; font-size: 14px;">
                If you didn't expect this invitation, you can ignore this email.
            </p>
        </body>
        </html>
        """
        text_body = f"{inviter_name} has invited you to join {org_name} on FreeFrame. Click here to accept: {invite_link}"
        return self.send_email(to_email, subject, html_body, text_body)
    
    def send_comment_notification(
        self, 
        to_email: str, 
        commenter_name: str, 
        asset_name: str, 
        comment_preview: str,
        asset_link: str
    ) -> bool:
        """Send notification when someone comments on an asset."""
        subject = f"New comment on {asset_name}"
        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2>New Comment</h2>
            <p><strong>{commenter_name}</strong> commented on <strong>{asset_name}</strong>:</p>
            <blockquote style="border-left: 3px solid #4F46E5; padding-left: 12px; color: #555;">
                {comment_preview}
            </blockquote>
            <p>
                <a href="{asset_link}" 
                   style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; 
                          color: white; text-decoration: none; border-radius: 6px;">
                    View Comment
                </a>
            </p>
        </body>
        </html>
        """
        text_body = f"{commenter_name} commented on {asset_name}: {comment_preview}\n\nView: {asset_link}"
        return self.send_email(to_email, subject, html_body, text_body)
    
    def send_mention_notification(
        self,
        to_email: str,
        mentioner_name: str,
        asset_name: str,
        comment_preview: str,
        asset_link: str
    ) -> bool:
        """Send notification when someone mentions a user."""
        subject = f"{mentioner_name} mentioned you on {asset_name}"
        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2>You were mentioned</h2>
            <p><strong>{mentioner_name}</strong> mentioned you on <strong>{asset_name}</strong>:</p>
            <blockquote style="border-left: 3px solid #4F46E5; padding-left: 12px; color: #555;">
                {comment_preview}
            </blockquote>
            <p>
                <a href="{asset_link}" 
                   style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; 
                          color: white; text-decoration: none; border-radius: 6px;">
                    View Comment
                </a>
            </p>
        </body>
        </html>
        """
        text_body = f"{mentioner_name} mentioned you on {asset_name}: {comment_preview}\n\nView: {asset_link}"
        return self.send_email(to_email, subject, html_body, text_body)
    
    def send_assignment_notification(
        self,
        to_email: str,
        assigner_name: str,
        asset_name: str,
        due_date: Optional[str],
        asset_link: str
    ) -> bool:
        """Send notification when user is assigned to review an asset."""
        due_text = f" (due {due_date})" if due_date else ""
        subject = f"You've been assigned to review {asset_name}{due_text}"
        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2>New Assignment</h2>
            <p><strong>{assigner_name}</strong> has assigned you to review <strong>{asset_name}</strong>.</p>
            {"<p><strong>Due date:</strong> " + due_date + "</p>" if due_date else ""}
            <p>
                <a href="{asset_link}" 
                   style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; 
                          color: white; text-decoration: none; border-radius: 6px;">
                    Review Asset
                </a>
            </p>
        </body>
        </html>
        """
        text_body = f"{assigner_name} assigned you to review {asset_name}.{' Due: ' + due_date if due_date else ''}\n\nView: {asset_link}"
        return self.send_email(to_email, subject, html_body, text_body)
    
    def send_approval_notification(
        self,
        to_email: str,
        reviewer_name: str,
        asset_name: str,
        status: str,  # "approved" or "rejected"
        note: Optional[str],
        asset_link: str
    ) -> bool:
        """Send notification when an asset is approved or rejected."""
        status_emoji = "✅" if status == "approved" else "❌"
        subject = f"{status_emoji} {asset_name} has been {status}"
        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2>Asset {status.title()}</h2>
            <p><strong>{reviewer_name}</strong> has <strong>{status}</strong> <strong>{asset_name}</strong>.</p>
            {"<p><strong>Note:</strong> " + note + "</p>" if note else ""}
            <p>
                <a href="{asset_link}" 
                   style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; 
                          color: white; text-decoration: none; border-radius: 6px;">
                    View Asset
                </a>
            </p>
        </body>
        </html>
        """
        text_body = f"{reviewer_name} {status} {asset_name}.{' Note: ' + note if note else ''}\n\nView: {asset_link}"
        return self.send_email(to_email, subject, html_body, text_body)


# Singleton instance
email_service = EmailService()
