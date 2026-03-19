from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .config import settings
from .routers import auth, users, organizations, teams, projects, upload
from .services.s3_service import ensure_bucket_exists

app = FastAPI(
    title="FreeFrame API",
    description="Media review platform API",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(organizations.router)
app.include_router(teams.router)
app.include_router(projects.router)
app.include_router(upload.router)

@app.on_event("startup")
def startup_event():
    ensure_bucket_exists()

@app.get("/health")
def health():
    return {"status": "ok"}
