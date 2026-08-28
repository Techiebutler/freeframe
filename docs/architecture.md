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
API dispatches Celery task ──▶ Worker downloads from S3
                                   │
                                   ▼
                               FFmpeg processes file
                                   │
                                   ▼
                               Worker uploads outputs to S3
                                   │
                                   ▼
Frontend receives  ◀────────── SSE: transcode_complete
transcode_complete             (or transcode_failed)
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
API saves comment ──▶ Other viewers see it on next fetch (see SSE note)
    │
    ▼
Reviewer approves / rejects ──▶ Approval recorded (see SSE note)
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
   - The ladder is trimmed against the source resolution, so a small source never gets
     upscaled renditions. If every rung is above the source, the smallest is kept.
   - An optional NVENC/VAAPI hardware backend is selected at runtime when available, using
     `-global_quality` in place of `-crf`, and falls back to software on failure. HDR and
     Dolby Vision sources are tone-mapped to Rec.709, with the CRF adjusted either way.
5. One thumbnail generated (`-vf thumbnail`, a single representative frame)
6. All outputs uploaded to S3 under `processed/{project_id}/{asset_id}/{version_id}/`
7. `AssetVersion.processing_status` set to `ready`, `transcode_complete` published

No waveform is produced for video; waveforms are an audio-pipeline output only.

### Audio

1. Raw file (MP3, WAV, FLAC, AAC) uploaded to S3
2. Worker normalizes audio and converts to MP3
3. Waveform JSON generated for visualization
4. Outputs uploaded to S3

### Image

1. Raw file (JPEG, PNG, HEIC, TIFF) uploaded to S3
2. Worker converts to optimized WebP + generates thumbnail

> The `image_carousel` asset type exists in the enum but is not implemented: no upload path
> produces it, each version holds exactly one `MediaFile`, and `CarouselItem` rows are never
> created.

---

## Permission Model

FreeFrame is **single-tenant**: one deployment is one workspace. There is no organization or
team layer. `Project` is the root of the content hierarchy, and all content permissions are
project-scoped or share-scoped.

```
Project
├── owner    ── full control over project
├── editor   ── upload, edit assets
├── reviewer ── comment, approve/reject
└── viewer   ── read-only, and may still comment

Share Link (unauthenticated access, by token)
├── approve  ── may approve/reject
├── comment  ── may add comments
└── view     ── read-only
```

`User.is_superadmin` is a separate, instance-level flag covering user administration only:
invite, deactivate, role change, first-run setup. It grants **no** content access and is not
consulted when resolving asset permissions.

**Asset access** is resolved by `can_access_asset` in `apps/api/services/permissions.py`, which
returns true on the first of these that matches:

1. The user created the asset (`Asset.created_by`)
2. The user is a `ProjectMember` in any role
3. The asset is shared directly with the user (`AssetShare.shared_with_user_id`)
4. The project is public (`Project.is_public`) — any authenticated user may reach it

Anything outside those four paths requires a `ShareLink` token. A share link targets an asset,
a folder, a project, or an explicit set of items, and may be password-protected; folder-scoped
links apply transitively to the folder's contents. Guests commenting through a share link are
recorded in the `GuestUser` table with email and name only, no account required.

> **Note:** `AssetShare.shared_with_team_id` is still written by the two `share/team` endpoints
> but is never read when resolving access, so a team share currently grants access to nobody.
> Tracked separately; do not rely on it.

---

## Real-Time Updates (SSE)

FreeFrame uses **Server-Sent Events** (not WebSockets) for real-time updates. A single SSE
endpoint per project streams all events:

```
GET /events/{project_id}
```

`routers/events.py` serves the stream; `services/event_service.py` subscribes to the Redis
channel `project:{project_id}`, and anything published there reaches the browser.

| Event | Payload | When | Status |
|-------|---------|------|--------|
| `transcode_complete` | `{asset_id, version_id}` | Processing finished | implemented |
| `transcode_failed` | `{asset_id, error}` | Processing failed | implemented |
| `transcode_progress` | `{asset_id, percent}` | During video processing | **not emitted** |
| `new_comment` | `{asset_id, comment_id, author}` | Comment posted | **not emitted** |
| `comment_resolved` | `{comment_id}` | Comment marked resolved | **not emitted** |
| `approval_updated` | `{asset_id, user_id, status}` | Approval status changed | **not emitted** |

> **The last four have no producer.** The frontend subscribes to all six
> (`apps/web/hooks/use-sse.ts`), but no backend code publishes them, so real-time comments,
> comment resolution, approval updates and transcode progress do not currently work. The two
> that do work are published straight to Redis from Celery worker context
> (`tasks/transcode_tasks.py`, `tasks/watermark_tasks.py`) rather than through
> `event_service.publish`, which has no callers. Tracked in #294.

Clients reconnect automatically on disconnect. SSE was chosen over WebSockets because it's
simpler, works through most proxies, and is sufficient for an async review workflow.

---

## Database

**Soft delete is common but not universal.** 13 of the 29 models carry a `deleted_at` column;
16 do not, including `MediaFile`, `Annotation`, `CommentAttachment`, `CommentReaction`,
`Notification` and `ActivityLog`. Nothing filters the column automatically — every query does
it by hand. Soft deletion is also not permanent: `tasks/cleanup_tasks.py` hard-deletes
soft-deleted rows and reclaims their S3 objects after `SOFT_DELETE_RETENTION_DAYS`
(default 30).

Key entity relationships:

```
Projects ──── ProjectMembers
    │
    ├── Folders (nested, max depth 10) ──── Assets
    │
    ├── Assets ──┬── AssetVersions ──── MediaFiles
    │            ├── Comments ──┬── Annotations
    │            │              ├── Attachments
    │            │              └── Reactions
    │            ├── Approvals
    │            ├── AssetMetadata ──── MetadataFields
    │            └── AssetShares
    │
    ├── Collections ──── CollectionShares
    ├── ProjectBranding / WatermarkSettings
    └── ShareLinks ──┬── ShareLinkItems
                     └── ShareLinkActivity

Users (instance-wide; User.is_superadmin) · GuestUsers (share-link commenters)
InstanceBranding · InstanceSettings   (single-row instance configuration)
```

The `organizations`, `org_members`, `teams` and `team_members` tables still exist in any
migrated database. They are created by the initial migration and were never dropped, but they
have no ORM model and no route behind them. Ignore them.

**ORM:** SQLAlchemy 2.0 with Alembic for migrations.
