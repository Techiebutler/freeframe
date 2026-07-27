import logging
import os
import threading
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .config import settings
from .routers import auth, users, projects, upload, events, assets, me, comments, approvals, share, metadata, branding, notifications, admin, setup, folders, hls_proxy, instance_settings
from .services.s3_service import run_startup_bucket_setup
from .services.email_service import mail_is_configured
from .middleware.global_rate_limit import GlobalRateLimitMiddleware
from .middleware.setup_guard import SetupGuardMiddleware

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Run bucket setup off the request path (daemon thread) so a slow or unreachable
    # object store can't block app startup (deploy-test finding #6).
    threading.Thread(target=run_startup_bucket_setup, name="s3-bucket-setup", daemon=True).start()
    if not mail_is_configured():
        logging.getLogger("apps.api.startup").warning(
            "Email is not configured (MAIL_PROVIDER=%s) — magic-code login and invites "
            "will FAIL until you configure SMTP or SES. See docs/deployment.md.",
            settings.mail_provider,
        )
    yield

_disable_docs = os.getenv("DISABLE_DOCS", "").lower() in ("true", "1", "yes")

app = FastAPI(
    title="FreeFrame API",
    description="Media review platform API",
    version="1.0.0",
    lifespan=lifespan,
    contact={"name": "FreeFrame", "url": "https://github.com/Techiebutler/freeframe"},
    license_info={"name": "MIT"},
    docs_url=None if _disable_docs else "/docs",
    redoc_url=None if _disable_docs else "/redoc",
    openapi_url=None if _disable_docs else "/openapi.json",
)

_cors_extra = [o.strip() for o in settings.cors_allow_origins.split(",") if o.strip()]
if "*" in _cors_extra:
    # Allow any origin. A literal "*" can't be combined with allow_credentials,
    # so echo the request origin via regex instead (keeps credentialed requests working).
    _cors_origin_kwargs = {"allow_origin_regex": ".*"}
else:
    _cors_origin_kwargs = {
        "allow_origins": [
            settings.frontend_url,
            "http://localhost:3000",
            "http://localhost:3001",
            *_cors_extra,
        ]
    }

app.add_middleware(
    CORSMiddleware,
    **_cors_origin_kwargs,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)
app.add_middleware(GlobalRateLimitMiddleware)
app.add_middleware(SetupGuardMiddleware)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(projects.router)
app.include_router(upload.router)
app.include_router(events.router)
app.include_router(assets.router)
app.include_router(me.router)
app.include_router(comments.router)
app.include_router(approvals.router)
app.include_router(share.router)
app.include_router(metadata.router)
app.include_router(branding.router)
app.include_router(notifications.router)
app.include_router(admin.router)
app.include_router(setup.router)
app.include_router(folders.router)
app.include_router(hls_proxy.router)
app.include_router(instance_settings.router)

@app.get("/health")
def health():
    return {"status": "ok"}

