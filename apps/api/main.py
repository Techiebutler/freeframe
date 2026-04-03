import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .config import settings
from .routers import auth, users, projects, upload, events, assets, me, comments, approvals, share, metadata, branding, notifications, admin, setup, folders, hls_proxy
from .services.s3_service import ensure_bucket_exists
from .middleware.global_rate_limit import GlobalRateLimitMiddleware

@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_bucket_exists()
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        settings.frontend_url,
        "http://localhost:3000",
        "http://localhost:3001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GlobalRateLimitMiddleware)

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

@app.get("/health")
def health():
    return {"status": "ok"}

