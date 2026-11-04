import os
from pathlib import Path
from urllib.parse import urlparse
from pydantic import Field, model_validator, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Default S3 endpoint (local MinIO). Shared between the field default and the
# consistency validator so the two can't drift.
DEFAULT_S3_ENDPOINT = "http://minio:9000"


def _is_aws_endpoint(url: str) -> bool:
    """True if `url`'s host is an AWS S3 endpoint (an ``*.amazonaws.com`` host)."""
    host = (urlparse(url).hostname or "").lower()
    return host == "amazonaws.com" or host.endswith(".amazonaws.com")

# Find .env file - check current dir, then project root
# __file__ = apps/api/config.py, so parent.parent = project root
def _find_env_file() -> str:
    project_root = Path(__file__).parent.parent.parent  # freeframe/
    candidates = [
        Path(".env"),
        Path(".env.local"),
        project_root / ".env",
        project_root / ".env.local",
    ]
    for p in candidates:
        if p.exists():
            return str(p.resolve())
    return ".env"

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_find_env_file(),
        env_file_encoding="utf-8",
        extra="ignore"  # Ignore extra env vars not in model
    )

    database_url: str
    redis_url: str
    s3_storage: str = "minio"  # "s3" for AWS S3, "minio" for local MinIO
    s3_bucket: str = "freeframe"
    s3_endpoint: str = DEFAULT_S3_ENDPOINT
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_region: str = "us-east-1"
    s3_public_endpoint: str | None = None  # External URL for presigned URLs (e.g. http://localhost:9000 when S3_ENDPOINT is http://minio:9000)
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    # Two different questions. The access token is the credential on the wire:
    # it rides in Authorization headers and, for EventSource, in a query string
    # that lands in the reverse proxy's access log, so its lifetime is how long
    # a leaked copy keeps working. `token_version` is only checked when
    # refreshing, so this is also the whole revocation window for a live
    # session. Keep it short. The refresh token is the session: it goes to one
    # endpoint, rotates on every use, and is version-checked, so it can be long
    # without the same exposure. Editors staying signed in for a quarter is a
    # question for the second number, never the first.
    access_token_expire_minutes: int = 60
    refresh_token_expire_days: int = 90
    frontend_url: str = "http://localhost:3000"
    # Existing Slack app only; empty token keeps intake working without sending.
    product_feedback_slack_token: str = ""
    product_feedback_slack_channel: str = "C07UL6BAG1Z"
    product_feedback_digest_hour_utc: int = Field(default=0, ge=0, le=23)
    product_feedback_digest_minute_utc: int = Field(default=0, ge=0, le=59)

    # A standing share link for an automation, created with every new project and POSTed to this
    # URL. Empty (the default) means no link is created and nothing is sent.
    #
    # Why: an automation that comments as a guest can only see projects explicitly shared with it,
    # so every project needed a link made by hand. One got one; the rest were simply unwatched -
    # not broken, which is the harder failure to notice.
    automation_share_webhook_url: str = ""
    automation_share_webhook_secret: str = ""
    # Outbound events to the hub when a client asks for changes (a guest comment on a hand-in
    # version) or an editor answers (a new version completed via the hand-in lane). FreeFrame stays
    # "dumb": it only emits these, the hub owns the ping/escalation loop. Empty (the default) means
    # nothing is sent. Separate from automation_share_webhook_* above - different consumer, different
    # payloads.
    hub_events_webhook_url: str = ""
    hub_events_webhook_secret: str = ""
    # Outbound hand-in events to the Aditor PORTAL (app.aditor.ai), separate from the hub above:
    # on every hand-in upload-complete the portal learns the card's FreeFrame folder and its direct
    # editor upload link (/r/<token>), so a later revision deep-links straight to that exact folder -
    # the editor can never file a revision in the wrong place. Empty (default) sends nothing. Signed
    # HMAC-SHA256 over the raw body on `X-Aditor-Signature`, same scheme as the hub events.
    portal_events_webhook_url: str = ""
    portal_events_webhook_secret: str = ""
    # Extra browser origins allowed by CORS, comma-separated (in addition to the
    # frontend + localhost defaults). Set to "*" to allow any origin — handy for
    # testing on a LAN via a machine's IP; do not use "*" in production.
    cors_allow_origins: str = ""
    transcoder_engine: str = "ffmpeg"

    # Require every project's description to carry something - typically a link to the brief in
    # whatever tool the team plans in (Trello, Notion, Asana, a ticket).
    #
    # A regex, matched against the description on create and update. Empty (the default) is off
    # and nothing changes. The hint is what the user is told when it does not match: say what to
    # paste, because "description is invalid" sends people looking for a formatting rule.
    #
    #   REQUIRE_PROJECT_DESCRIPTION_PATTERN=trello\.com/c/
    #   REQUIRE_PROJECT_DESCRIPTION_HINT=Paste the Trello card link for this project.
    #
    # Why an instance would want this: anything reading projects over the API - an automation, a
    # reporting job, a review bot - has no way back to the brief a project was made from unless
    # somebody wrote it down, and asking after the fact never works.
    require_project_description_pattern: str = ""
    require_project_description_hint: str = ""
    # The same rule one level down, for instances that file each hand-in as a FOLDER inside a
    # per-brand project rather than as a project of its own.
    require_folder_description_pattern: str = ""
    require_folder_description_hint: str = ""

    # Guest identities allowed to DELETE their own comments through a share link, comma-separated
    # emails. Empty (the default) means nobody can, which is exactly today's behaviour.
    #
    # Why this exists: an automation that comments through a share link has no account, so it can
    # never clean up after itself - a wrong or superseded run stays on a client-facing timeline
    # until a project owner happens to remove it by hand. That is not a tenable position for a tool
    # that comments automatically.
    #
    # It is deliberately narrow. It permits deleting ONLY comments whose guest author is one of
    # these exact addresses, and only through a share link that already allows commenting. No human
    # comment is reachable through it, and neither is any guest not named here.
    share_comment_deletable_guest_emails: str = ""

    # Comma-separated guest emails that belong to automation, not people - today, the automated
    # craft reviewer that comments through a share link (review@aditor.ai). Empty (the default)
    # means no guest is treated as automation, which is exactly stock behaviour.
    #
    # A comment posted by one of these guests is stored with visibility="internal", so the existing
    # share filter (which already drops internal comments from every public share view) hides it
    # from clients, while members still see it in the app. The reviewer's findings are internal
    # craft notes for the editor who handed the video in, not something a client should read on the
    # cut delivered to them - and this reuses the one internal-visibility mechanism rather than
    # adding a second hiding rule. Identity-scoped: no human guest is ever affected.
    automation_guest_emails: str = ""

    # Maximum size (bytes) for a single uploaded file. 0 = unlimited (no per-file cap).
    # Note: S3 multipart still caps effective size at ~10,000 parts x chunk size.
    max_upload_bytes: int = 0

    # Reaper: uploads stuck in `uploading`/`failed` longer than this are reclaimed. Hours.
    #
    # 24h left a real client's folder showing 10 empty placeholder assets (from retried/failed
    # uploads) for most of a day before this job ever touched them - and even once it runs, it
    # only reclaims the storage under a stuck VERSION, never the Asset row itself, so a consumer
    # listing a project's assets (e.g. our own review integration) keeps seeing the empty
    # placeholder in the folder regardless. A shorter window doesn't fix that second part, but it
    # does shrink how long wasted storage and folder clutter sit around from a failed upload that
    # was never explicitly aborted (POST /upload/abort is a client-side call that never fires if
    # the tab crashes or reloads instead of throwing a catchable JS error).
    stale_upload_timeout_hours: int = 4

    # Watchdog for versions stuck in `processing`. Nothing else ever touches that status: a worker
    # killed mid-transcode loses the task, and a dispatch that never reached the broker is only
    # logged, so either leaves the version "Processing" forever and the editor waiting with no way
    # out. Two limits, both counted from the version row's creation (upload + queue + transcode):
    #  - stuck_processing_lost_minutes: from this age on, the watchdog asks the queue and the workers
    #    whether the job still exists; if nothing knows about it on two checks in a row, the version
    #    is failed. Catches a lost job in minutes without touching one that is merely slow.
    #  - stuck_processing_timeout_minutes: absolute limit; anything still processing is failed.
    # 0 disables the watchdog. Keep the absolute limit below stale_upload_timeout_hours so the
    # failure stays visible before the reaper reclaims it. A genuinely slow job that finishes
    # later still flips the version back to `ready`.
    stuck_processing_lost_minutes: int = 10
    stuck_processing_timeout_minutes: int = 60

    # Retention GC: rows soft-deleted (deleted_at) longer than this are hard-deleted and their
    # S3 objects reclaimed. Days. 0 (or negative) DISABLES the sweep (matches the reaper convention).
    soft_delete_retention_days: int = 30

    # Orphan S3 sweeper (issue #65 follow-up): reclaim bucket keys under raw/ + processed/ that no
    # MediaFile row owns. 0 = disabled. When > 0, only keys whose S3 LastModified is older than this
    # many hours are considered, so in-flight / just-committed uploads are never mistaken for orphans.
    orphan_sweep_grace_hours: int = 0
    # Report-only by default: when False the sweeper only LOGS what it would delete; set True to delete.
    orphan_sweep_delete: bool = False

    # Worker concurrency settings
    transcoding_concurrency: int = 2  # Number of concurrent video transcoding jobs
    email_concurrency: int = 2  # Number of concurrent email sending jobs
    
    # Email settings - supports AWS SES or any SMTP server
    # If mail_provider is "ses", uses AWS SES with aws_mail_* credentials
    # If mail_provider is "smtp", uses standard SMTP with smtp_* settings
    mail_provider: str = "ses"  # "ses" or "smtp"
    mail_from_address: str = "noreply@example.com"
    mail_from_name: str = "FreeFrame"

    # Product name shown inside email subjects and bodies. Self-hosters put their
    # own brand in front of clients, who never need to know what runs underneath.
    brand_name: str = "FreeFrame"

    # Password sign-in. Instances that sign in purely through the central gate
    # (OIDC) turn this off, which hides the password UI *and* closes
    # /auth/login — hiding the form alone would leave the method live.
    password_login_enabled: bool = True

    # Instance-wide project access. On, every account holds `editor` on every
    # project and superadmins hold `owner`, without a membership row existing.
    # It is for the single-team instance where everyone is expected to work on
    # everything and per-project membership is bookkeeping rather than a boundary;
    # it also gives superadmins a way to administer projects a colleague created,
    # which project ownership otherwise makes impossible.
    #
    # Guests who arrive through a share link are unaffected - they are GuestUser
    # rows and never carry a role - so this widens what account holders see and
    # nothing else. Leave it off on any instance where outsiders hold accounts.
    #
    # Off (the default) changes no behaviour.
    instance_wide_project_access: bool = False

    # Whop owner entry is disabled until both are configured. No signing secret is shared.
    suite_url: str = ""
    whop_app_id: str = ""
    # REVIEW_BRIDGE_URL / _SECRET: Auto Review's /api/v1/* contract (review.aditor.ai), called from
    # this server only - the secret never reaches a browser. Unset = requests still work, they are
    # preserved with review unavailable; missing evidence never claims Ready or completion.
    # Comma-separated project UUIDs; applies only to newly inserted assignments.
    bound_review_project_ids: str = ""
    @field_validator('bound_review_project_ids')
    @classmethod
    def valid_bound_projects(cls, value):
        import uuid
        return ','.join(str(uuid.UUID(part.strip())) for part in value.split(',') if part.strip())

    review_bridge_url: str = ""
    # AutoReview Brand Loop (contract: feedback-agent 2026-10-16-brand-loop-CONTRACT.md). Comments on
    # projects with an autoreview_brand_slug are POSTed to AUTOREVIEW_URL, and the sidebar's
    # AutoReview link is a 60 s token signed with BRAND_LOOP_SECRET. Either unset = both off.
    autoreview_url: str = ""
    brand_loop_secret: str = ""
    review_bridge_secret: str = ""
    mixer_iterations_url: str = ""
    mixer_iterations_secret: str = ""
    iterations_enabled: bool = False
    # Split-upload and checklist tasks mostly wait on the review bridge (up to 240 s per call).
    # A dedicated queue keeps them from waiting behind video transcodes; "default" keeps them
    # on the main worker for deployments without an iteration worker.
    iteration_queue: str = "default"
    # Reviews of one request that may run at the same time (1 = one after another).
    iteration_parallel_reviews: int = 6

    # Machine access. A caller presenting SERVICE_API_KEY in X-API-Key is treated
    # as the user named by SERVICE_API_KEY_EMAIL, so every existing per-project
    # permission check still applies - the key is an alternative credential for a
    # real account, not a bypass. Restricted to GET, so it can never write.
    # Unset (the default) disables the mechanism entirely.
    service_api_key: str | None = None
    # Mobile feedback (agent-review platform). Each is optional and its feature is a no-op / 503 without it:
    # GROQ_API_KEY dictation, TELEGRAM_BOT_TOKEN pushes, TELEGRAM_BOT_USERNAME the link, TELEGRAM_WEBHOOK_SECRET the inbound hook.
    groq_api_key: str | None = None
    telegram_bot_token: str | None = None
    telegram_bot_username: str | None = None
    telegram_webhook_secret: str | None = None
    service_api_key_email: str | None = None

    # Directory-backed sign-in. With DIRECTORY_LOOKUP_URL set, the central-gate
    # callback (/auth/oidc/callback) checks the address against an external roster:
    # someone listed there gets an account provisioned on first sign-in, and someone
    # the roster no longer lists as active is refused. Instances whose people already
    # live in another system stop keeping a second copy of them, and nobody is
    # invited by hand.
    #
    # The URL carries an {email} placeholder (URL-encoded on substitution) and must
    # answer with a JSON record, or a list whose first entry is one. Addresses the
    # directory says nothing about are left entirely alone, so operator and service
    # accounts are unaffected by it.
    #
    # Unset (the default) disables the lookup and changes no behaviour.
    # DIRECTORY_ALLOWED_STATUSES is a comma-separated set, not a single value: a
    # roster usually distinguishes "not working right now" from "gone", and only
    # the second should cost someone their sign-in. Getting this wrong locks out
    # people who are merely between assignments.
    directory_lookup_url: str | None = None
    directory_token: str | None = None
    directory_name_field: str = "name"
    directory_status_field: str = "status"
    directory_allowed_statuses: str = "active"
    directory_timeout_seconds: float = 5.0

    # AWS SES settings
    aws_mail_access_key_id: str | None = None
    aws_mail_secret_access_key: str | None = None
    aws_mail_region: str = "ap-south-1"
    
    # SMTP settings (for non-SES providers like SendGrid, Mailgun, self-hosted)
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_use_tls: bool = True

    # Central-gate (OIDC) sign-in for editors/team, terminated in this API rather
    # than a Next.js BFF - see services/oidc_auth.py and docs/deployment.md
    # (Configuration Reference) for the full handshake and env vars. The password
    # endpoint is untouched and keeps working; this is additive.
    # All three empty (the default) disables /auth/oidc/* entirely (404), so an
    # instance that hasn't registered with a gate loses nothing by upgrading.
    oidc_issuer: str = ""
    oidc_client_id: str = "freeframe-web"
    # Named for the gate's own client registration, not this app's usual
    # UPPER_SNAKE(field name) convention, because it was handed over under that
    # exact name (already set in .env.prod).
    oidc_client_secret: str = Field(default="", validation_alias="ADITOR_AUTH_FREEFRAME_CLIENT_SECRET")
    # Extra scope beyond the standard "openid profile email offline_access" every
    # gate login requests.
    oidc_scope: str = "freeframe.read"

    # Outbound editor-workflow events to the owned company-DB store (app.log_workflow_event):
    # hand-in / revision activity, so the hub and portal can join this tool's steps into the
    # cross-tool journey. Modelled on hub_events/portal_events above, but the credential is a
    # scoped JWT bearer (COMPANYDB_WORKFLOW_JWT, role workflow_writer) rather than an HMAC secret -
    # the same app-JWT-over-PostgREST pattern every other company-DB writer uses. COMPANYDB_URL is
    # not a secret (the company DB's own public PostgREST endpoint); COMPANYDB_WORKFLOW_JWT unset
    # (the default) is a complete no-op, so this is safe to deploy before the keystone RPC exists.
    companydb_url: str = "https://db.aditor.ai"
    companydb_workflow_jwt: str = ""

    # Server-to-server hand-in orchestration for the Aditor portal (POST
    # /integrations/portal/delivery-folder): the portal finds-or-creates a hand-in folder without a
    # human behind a browser, so it needs a write-capable machine credential - the read-only
    # SERVICE_API_KEY above deliberately cannot do this. Trust is inbound HMAC-SHA256 over the raw
    # request body on X-Aditor-Signature, the same scheme FreeFrame already uses as the sender of the
    # hub/portal webhooks above, just verified here instead of produced. Unset (the default) fails
    # the endpoint closed - it never falls open.
    portal_freeframe_hmac_secret: str = ""
    # The FreeFrame staff account every portal-created folder, share link and upload request is
    # attributed to - never a human user. Unset (the default) leaves the endpoint answering 503
    # rather than guessing an owner.
    portal_freeframe_service_email: str = ""

    @model_validator(mode="after")
    def _check_s3_endpoint_consistency(self):
        """Fail loud on `S3_STORAGE=s3` + a real custom (non-AWS) `S3_ENDPOINT`.

        In `s3` mode the client talks to native AWS and S3_ENDPOINT is ignored,
        so pairing it with an R2/B2/MinIO URL would silently route to AWS. An
        untouched default and any `*.amazonaws.com` endpoint are harmless and
        allowed; a custom non-AWS endpoint is a misconfiguration.
        """
        if self.s3_storage.lower() == "s3":
            endpoint = (self.s3_endpoint or "").strip()
            if endpoint and endpoint != DEFAULT_S3_ENDPOINT and not _is_aws_endpoint(endpoint):
                raise ValueError(
                    f"S3_STORAGE=s3 selects native AWS S3 and ignores S3_ENDPOINT, but "
                    f"S3_ENDPOINT is set to a non-AWS URL ({endpoint!r}). To use a custom "
                    f"S3-compatible endpoint (MinIO, Cloudflare R2, Backblaze B2, "
                    f"DigitalOcean Spaces), set S3_STORAGE=minio. To use native AWS S3, "
                    f"leave S3_ENDPOINT unset."
                )
        return self

settings = Settings()
