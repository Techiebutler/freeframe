# Architecture Overview

This document explains how FreeFrame's components work together.

---

## System Overview

FreeFrame is a monorepo with two main applications and supporting infrastructure:

```
                         ┌──────────────┐
           Users ──────▶ │   Traefik    │
                         │   :80/:443   │
                         └──────┬───────┘
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
             ┌─────────────┐        ┌─────────────┐
             │   Next.js    │        │   FastAPI    │──── SSE ──▶ Clients
             │   Frontend   │        │   Backend    │
             └─────────────┘        └──────┬───────┘
                                           │
                     ┌─────────────────────┼────────────────────┐
                     ▼                     ▼                    ▼
              ┌───────────┐         ┌───────────┐       ┌──────────────┐
              │ PostgreSQL │         │   Redis    │       │  S3 Storage   │
              │            │         │           │       │              │
              └───────────┘         └─────┬─────┘       └──────────────┘
                                          │
                               ┌──────────┴──────────┐
                               ▼                     ▼
                        ┌─────────────┐       ┌─────────────┐
                        │  Transcoding │       │    Email     │
                        │   Workers    │       │   Workers    │
                        └─────────────┘       └─────────────┘
```

| Component | Role |
|-----------|------|
| **Traefik** | Reverse proxy, automatic SSL via Let's Encrypt, routes `/api/*` to backend and `/` to frontend |
| **Next.js** | Server-rendered frontend, handles UI, auth cookies, client-side media playback |
| **FastAPI** | REST API, auth, business logic, SSE events, S3 presigned URLs |
| **PostgreSQL** | Primary datastore for all entities (users, projects, assets, comments, etc.) |
| **Redis** | Message broker for Celery task queues, magic code TTL storage |
| **S3 Storage** | Stores all media files (originals, transcoded outputs, thumbnails) |
| **Transcoding Workers** | Celery workers that process video/audio/image files via FFmpeg |
| **Email Workers** | Celery workers that send transactional emails (invites, magic codes, notifications) |

---

## Data Flow

### Upload and Processing

```
User uploads file
    │
    ▼
Frontend initiates multipart upload
    │
    ▼
API creates presigned URLs ──▶ Frontend uploads chunks directly to S3
    │
    ▼
Frontend calls /upload/complete
    │
    ▼
API dispatches Celery task ──▶ Worker downloads from S3
    │                              │
    ▼                              ▼
API sends SSE: transcode_progress  FFmpeg processes file
    │                              │
    ▼                              ▼
API sends SSE: transcode_complete  Worker uploads outputs to S3
```

### Review and Approval

```
Reviewer opens asset
    │
    ▼
Frontend loads HLS stream (video) / WebP (image) / MP3 (audio)
    │
    ▼
Reviewer adds comment (with optional timecode + drawing annotation)
    │
    ▼
API saves comment ──▶ SSE: new_comment ──▶ Other viewers see it instantly
    │
    ▼
Reviewer approves / rejects ──▶ SSE: approval_updated
```

---

## Media Processing Pipeline

### Video

1. Raw file uploaded to S3 via presigned multipart upload
2. Celery worker reads directly from S3 presigned URL (no full download)
3. `ffprobe` extracts metadata (duration, resolution, FPS)
4. FFmpeg generates multi-bitrate HLS:
   - 1080p (CRF 20), 720p (CRF 22), 360p (CRF 26)
   - 2-second segments with forced keyframes
5. Thumbnails generated (1 per 10 seconds)
6. Waveform JSON generated for audio track
7. All outputs uploaded to S3 at `hls/{project_id}/{version_id}/`
8. Asset status set to `ready`, SSE event fired

### Audio

1. Raw file (MP3, WAV, FLAC, AAC) uploaded to S3
2. Worker normalizes audio and converts to MP3
3. Waveform JSON generated for visualization
4. Outputs uploaded to S3

### Image

1. Raw file (JPEG, PNG, HEIC, TIFF) uploaded to S3
2. Worker converts to optimized WebP + generates thumbnail
3. For **carousels**: each image processed independently with sequence ordering

---

## Permission Model

Permissions are layered. Each level inherits downward:

```
Organization
├── owner    ── full control
├── admin    ── manage members, teams, projects
└── member   ── access assigned projects
    │
    Team
    ├── lead    ── manage team members
    └── member  ── access team projects
        │
        Project
        ├── owner    ── full control over project
        ├── editor   ── upload, edit assets
        ├── reviewer ── comment, approve/reject
        └── viewer   ── read-only access
            │
            Share Link
            ├── approve  ── can approve/reject
            ├── comment  ── can add comments
            └── view     ── read-only
```

**Asset access is checked in this order:**
1. Is the user the asset creator?
2. Is the user a project member (any role)?
3. Was the asset shared directly with the user (`AssetShare`)?
4. Was the asset shared with the user's team?
5. Is the user an org admin?

Guest users (via share links) use the `GuestUser` table — they provide email + name only, no account required.

---

## Real-Time Updates (SSE)

FreeFrame uses **Server-Sent Events** (not WebSockets) for real-time updates. A single SSE endpoint per project streams all events:

```
GET /events/{project_id}
```

Event types:

| Event | Payload | When |
|-------|---------|------|
| `transcode_progress` | `{asset_id, percent}` | During video processing |
| `transcode_complete` | `{asset_id, version_id}` | Processing finished |
| `transcode_failed` | `{asset_id, error}` | Processing failed |
| `new_comment` | `{asset_id, comment_id, author}` | Comment posted |
| `comment_resolved` | `{comment_id}` | Comment marked resolved |
| `approval_updated` | `{asset_id, user_id, status}` | Approval status changed |

Clients reconnect automatically on disconnect. SSE was chosen over WebSockets because it's simpler, works through most proxies, and is sufficient for an async review workflow.

---

## Database

All tables use **soft delete** (`deleted_at` column). Records are never hard-deleted in application code.

Key entity relationships:

```
Organization ──┬── Teams ──── TeamMembers
               └── OrgMembers
                     │
                     ▼
               Projects ──── ProjectMembers
                     │
                     ├── Folders
                     ├── Assets ──┬── AssetVersions ──── MediaFiles
                     │            ├── Comments ──┬── Annotations
                     │            │              ├── Attachments
                     │            │              └── Reactions
                     │            ├── Approvals
                     │            └── AssetShares
                     └── Collections
```

**ORM:** SQLAlchemy 2.0 with Alembic for migrations.
