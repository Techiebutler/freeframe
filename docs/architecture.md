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
| **Maintenance Worker** | Celery worker for scheduled housekeeping: retention GC, stale-upload reaper, orphan sweep |
| **Beat** | Celery scheduler that publishes the periodic maintenance tasks |

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
API dispatches Celery task ──▶ Worker reads S3 through a presigned URL
                                   │
                                   ▼
                               FFmpeg processes file and publishes progress
                                   │
                                   ▼
                               Worker uploads outputs to S3
                                   │
                                   ▼
Frontend receives  ◀────────── Redis-backed SSE: complete or failed
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
API saves comment ──▶ SSE: new_comment ──▶ Affected viewers refetch comments
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
   - 2-second segments with a forced IDR keyframe every `HLS_KEYFRAME_INTERVAL`
     seconds (default 1, range 0.25–2). Players scrub with `fastSeek`, which
     lands on keyframes, so a shorter interval means smoother scrubbing.
   - Rungs above the source resolution are omitted; if all requested rungs are
     larger, the smallest requested rung is retained.
   - An audio-only MP4/MPEG container is retyped and processed through the
     audio pipeline instead of attempting an invalid HLS encode.
5. One representative thumbnail is generated.
6. Outputs upload under `processed/{project_id}/{asset_id}/{version_id}/`.
7. Asset status is set to `ready` and `transcode_complete` is published.

Video processing does not create a waveform; waveform JSON is an audio-pipeline
output only.

### Audio

1. Raw file (MP3, WAV, FLAC, AAC) uploaded to S3
2. Worker normalizes audio and converts to MP3
3. Waveform JSON generated for visualization
4. Outputs uploaded to S3

### Image

1. Raw file (JPEG, PNG, HEIC, TIFF) uploaded to S3
2. Worker converts to optimized WebP + generates thumbnail
3. The `image_carousel` enum value currently follows the image processor; there
   is no multi-file carousel ingestion flow yet.

---

## Permission Model

FreeFrame is single-tenant. Content authorization is project-scoped or
share-scoped; there is no active organization or team layer in the ORM.

```
Project
├── owner    ── full control over project
├── editor   ── upload and edit assets
├── reviewer ── comment and approve/reject
└── viewer   ── read-only

Share link
├── approve  ── may approve/reject
├── comment  ── may add comments
└── view     ── read-only
```

`can_access_asset` grants authenticated access in this order:
1. Asset creator
2. Any project membership
3. Direct `AssetShare` for that user
4. A public project

Anything else requires a scoped share link. Share links may target an asset,
folder, project, or explicit items, can be password-protected, and secure links
also require authentication. Guest commenters use `GuestUser` with name and
email, not a full account.

---

## Real-Time Updates (SSE)

FreeFrame uses **Server-Sent Events** (not WebSockets) for real-time updates. A single SSE endpoint per project streams all events:

```
GET /events/{project_id}
```

`routers/events.py` streams the Redis channel `project:{project_id}` through
`services/event_service.py`. Event types:

| Event | Payload | When |
|-------|---------|------|
| `transcode_progress` | `{asset_id, version_id, percent}` | During video processing |
| `transcode_complete` | `{asset_id, version_id}` | Processing finished |
| `transcode_failed` | `{asset_id, version_id, error}` | Processing failed |
| `new_comment` | `{asset_id, comment_id, author}` | Comment posted |
| `comment_resolved` | `{asset_id, comment_id, resolved}` | Comment resolution toggled |
| `approval_updated` | `{asset_id, user_id, status}` | Approval status changed |
| `watermark_complete` | `{asset_id, key}` | Watermark output uploaded |

Clients reconnect automatically on disconnect. SSE was chosen over WebSockets because it's simpler, works through most proxies, and is sufficient for an async review workflow.

---

## Database

Soft delete is common but not universal: check a model for `deleted_at` before
using it. Queries apply the active-row filter explicitly. Application-level
deletion is normally recoverable, while the maintenance retention GC permanently
removes eligible soft-deleted records and their S3 objects after
`SOFT_DELETE_RETENTION_DAYS` (30 days by default).

Key entity relationships:

```
Projects ──── ProjectMembers
    │
    ├── Folders ──── Assets
    ├── Assets ──┬── AssetVersions ──── MediaFiles
    │            ├── Comments ──┬── Annotations
    │            │              ├── Attachments
    │            │              └── Reactions
    │            ├── Approvals
    │            └── AssetShares
    ├── Collections
    ├── ProjectBranding / WatermarkSettings
    └── ShareLinks ──┬── ShareLinkItems
                     └── ShareLinkActivity
```

**ORM:** SQLAlchemy 2.0 with Alembic for migrations.
