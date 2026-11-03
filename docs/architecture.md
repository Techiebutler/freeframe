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
| **Traefik** | Reverse proxy, opt-in SSL via Let's Encrypt (`docker-compose.https.yml`), routes `/api/*` to backend and `/` to frontend |
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

Each upload is cut into parts of one size, chosen at initiate from the instance's part size
setting (automatic sizing aims for about 500 parts) and pinned to the version, so a resume
and a later change to the setting never disagree about where a part's bytes start.

A transfer that stops part-way leaves the multipart upload open and its parts in
the bucket. `AbortMultipartUpload` is only ever called for an explicit user
cancel (or by the stale-upload reaper), so the version stays `uploading` and the
panel offers to resume it. `GET /upload/{version_id}/parts` reports which parts
storage already holds — matched on size, not ETag, which is not portable — plus
the key, the upload id and the chunk size that upload was pinned to, and the
client sends only what is missing. The browser cannot reopen a local file on its
own, so resuming asks the user to select it again.

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
API saves comment ──▶ SSE: new_comment ──▶ Other viewers see it live
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
   - 1080p (CRF 20), 720p (CRF 22), 360p (CRF 26) by default; 2160p (CRF 20) is available
     through `TRANSCODER_QUALITIES` but not built unless configured
   - 2-second segments with forced keyframes
   - The ladder is trimmed against the source resolution, so a small source never gets
     upscaled renditions. If every rung is above the source, the smallest is kept.
   - An optional NVENC/VAAPI hardware backend is selected at runtime when available, using
     `-global_quality` in place of `-crf`, and falls back to software on failure. A source
     the GPU can't decode (ProRes, 4:2:2, 10-bit H.264) is decoded on the CPU and uploaded,
     so the scale and encode stay on the GPU. HDR and
     Dolby Vision sources are tone-mapped to Rec.709, with the CRF adjusted either way.
5. One thumbnail generated (`-vf thumbnail`, a single representative frame), scaled to square
   pixels so anamorphic sources aren't squeezed, and fit within 1280x1280 keeping its shape
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

`User.is_superadmin` is the one instance-level role: the account the first-run setup creates,
shown as **Admin** in the dashboard. It covers user administration (invite, deactivate, role
change), instance settings and branding, the admin panel's Storage tab, where it lists every
project's files by name and size, moves them to the trash, restores them and deletes them
permanently, **and instance-wide project access** — a superadmin may see, open, upload to and
change every live project without being a member of it.

That last part lives in exactly one place, `apps/api/services/permissions.py`, in the three
functions every router goes through:

| Function | What a superadmin gets |
|---|---|
| `require_project_role` | passes every tier (viewer to owner) on any live project |
| `require_project_visible` | visible on any live project, not only a public one |
| `require_asset_access` | reaches any asset whose project is live, and logs it |
| `can_access_asset` | the same answer as a boolean, for filtering a list; never logs |
| `project_events_denial` | may subscribe to any live project's event stream |

No router repeats the rule, so a new endpoint that calls one of these inherits it rather than
having to remember it. `routers/comments.py` was the last router with a membership query of its
own (editing and deleting someone else's comment, and deleting an attachment); it now goes
through `require_project_role` as well, with the refusal wording those routes always gave.
The membership a superadmin is answered with is a **transient**
`ProjectMember` that is never added to the session: the project's member list, its member count
and its emails keep saying they are not a member.

What this deliberately does **not** change:

- **Project roles.** owner > editor > reviewer > viewer behaves exactly as before, and a
  project owner still has no access to a project they are not in.
- **Share links and the customer-facing viewer.** Share-link validation reads nothing off a
  signed-in user, so the flag cannot change which links resolve or what a guest sees.
- **A deleted project.** Still 404 for everyone, superadmin included.

**Auditing.** Every path past membership is logged, reads included: an `ActivityLog` row with
`action="admin_project_access"` and a payload naming `via: "superadmin"`, the role they actually
held (`membership`, or `"none"`), the `scope` that let them in and the `required_role` where the
scope is a tier. `scope` is a role tier for the project gate, `"asset"` for the asset, version,
comment and attachment path, and `"events"` for the live stream at connect.

**One row per request and project, not one per object.** A listing runs the gate for every item
it returns and `GET /events/{project_id}` re-checks for as long as the stream stays open;
`activity_logs` is never pruned, so a row per check would turn one open tab into unbounded rows.
The bookkeeping lives in `Session.info`, which is the request scope, and a heavier access later
in the same request rewrites the row instead of adding one. `can_access_asset` therefore has no
audit hook at all: it is also read per item to resolve mentions and filter comments.

The row is added to the session and carried by the request's own commit, so a write that ends in
a rollback leaves nothing behind. A read-only request commits nothing of its own, so `get_db`
commits the row on its way out, and only ever when those rows are the whole of the pending work
(`permissions.persist_admin_access_audit`).

**Asset access** is resolved by `asset_access_reason` in `apps/api/services/permissions.py`,
which returns why the caller may reach the asset, on the first of these that matches:

1. The user created the asset (`Asset.created_by`)
2. The user is a `ProjectMember` in any role
3. The asset is shared directly with the user (`AssetShare.shared_with_user_id`)
4. The project is public (`Project.is_public`) — any authenticated user may reach it
5. The user is an instance superadmin (`User.is_superadmin`)

Anything outside those five paths requires a `ShareLink` token. A share link targets an asset,
a folder, a project, or an explicit set of items, and may be password-protected; folder-scoped
links apply transitively to the folder's contents. Guests commenting through a share link are
recorded in the `GuestUser` table with email and name only, no account required.

**Everything requires a live project.** A deleted project (one with `deleted_at` set) is treated as gone on every path: `require_project_role` and the project listings answer 404 *Project not found*, `can_access_asset` refuses its assets, and a share link resolves only while its project, its asset or folder, and every folder above that are live, answering 404 *Share link not found* like an unknown token otherwise. Deleting a folder or asset leaves its share links in place, so restoring it brings them back. See [GHSA-w8vh-2j74-m3hw](https://github.com/Techiebutler/freeframe/security/advisories/GHSA-w8vh-2j74-m3hw).

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

| Event | Payload | When |
|-------|---------|------|
| `transcode_progress` | `{asset_id, percent}` | Whole-percent advances during video processing |
| `transcode_complete` | `{asset_id, version_id}` | Processing finished |
| `transcode_failed` | `{asset_id, error}` | Processing failed |
| `new_comment` | `{asset_id, comment_id, author}` | Comment posted, including replies and guest comments |
| `comment_resolved` | `{comment_id, resolved}` | Comment resolved or unresolved (the endpoint toggles) |
| `approval_updated` | `{asset_id, user_id, status}` | Approval status changed |

All six are published through `event_service.publish_sync`, which is the single emit path. It
is best-effort: every call site publishes after its commit, and a broker that is down or slow
degrades to "no live update" rather than failing the request that produced it.

Access is checked when a stream connects and again for as long as it stays open, with the same
rule both times: an active, undeleted account, an unexpired access token whose `ver` matches
`users.token_version`, and a live project the user is a member of or that is public. An open
stream re-checks before it delivers an event once its last check is older than
`SSE_AUTH_MAX_AGE_SECONDS` (default 1), and every `SSE_AUTH_RECHECK_SECONDS` (default 15) while
idle. Token expiry is exact rather than gated: the token's `exp` is compared before every write,
and an idle stream wakes at `exp` to close. An idle stream is sent a keepalive at the recheck
interval or every 30 seconds, whichever is shorter. Each check is one indexed query on its own
short-lived session, so an open stream holds no database connection. When a check fails, the
stream sends a final `revoked` event with `{reason}` (`access_revoked`, `token_expired` or
`token_revoked`) and closes; a connection that fails the check is refused with 403.

Clients reconnect automatically on disconnect. After `revoked`, `hooks/use-sse.ts` refreshes the
token and reconnects for the two token reasons, and stops for `access_revoked`. SSE was chosen
over WebSockets because it's simpler, works through most proxies, and is sufficient for an async
review workflow.

---

## Database

**Soft delete is common but not universal.** 13 of the 29 models carry a `deleted_at` column;
16 do not, including `MediaFile`, `Annotation`, `CommentAttachment`, `CommentReaction`,
`Notification` and `ActivityLog`. Nothing filters the column automatically — every query does
it by hand. Soft deletion is also not permanent: `tasks/cleanup_tasks.py` hard-deletes
soft-deleted rows and reclaims their S3 objects after `SOFT_DELETE_RETENTION_DAYS`
(default 30), and an admin can do the same earlier for chosen items from the trash
(`POST /admin/trash/purge`).

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

---

## Storage Accounting

Two columns on `media_files` hold everything the storage figures are built from, so no code
path has to list the object store to answer "how big is this":

| Column | Holds | Written by |
|---|---|---|
| `file_size_bytes` | the uploaded original | `POST /upload/initiate`, reconciled at `/upload/complete` |
| `derived_size_bytes` | everything the transcode produced for that version | the transcode job |

`derived_size_bytes` is measured once, when a job finishes, with a single listing of its own
output prefix (`processed/{project_id}/{asset_id}/{version_id}`). That prefix covers the HLS
renditions, the single-file MP4/MP3/WebP, the poster thumbnail and the audio waveform, which is
why it is measured as a prefix rather than key by key.

**NULL means "not measured", never "nothing derived."** Every row written before the column
existed is NULL until `backfill_media_derived_size` (`apps/api/tasks/storage_tasks.py`,
maintenance queue, idempotent and resumable) has summed its prefix. Reports count those rows
and say how many there are instead of summing NULL as zero, which would claim a total the
bucket does not hold. A prefix that holds nothing is recorded as `0`, so a later run does not
list it again.

**Nothing runs the backfill on its own.** There is no beat entry and no button in this change:
a measurement raises the figure the cap is enforced against, so it happens when an administrator
asks for it (`POST /admin/storage/backfill`, or the command in the upgrade notes), not on a timer
behind their back. New uploads need none of it, because the transcode measures its own output.
A transcode whose bookkeeping listing failed therefore stays unmeasured until a backfill is run;
`unmeasured_files` is how that shows.

The backfill selects exactly the rows the figures count (`committed_media` with the NULL filter
on it), the trash included, so after a complete run `unmeasured_files` really is zero and a
restored asset does not come back unmeasured. It works in keyset batches of `BATCH_SIZE`, so an
instance with a hundred thousand unmeasured files costs the worker the same memory as one with
two hundred, and the keyset carries `(created_at, id)` because a row whose listing failed stays
NULL and paging on the NULL filter alone would hand it out forever. Each write is conditional
(`UPDATE ... WHERE derived_size_bytes IS NULL`), so a transcode that finishes inside a batch
keeps its own figure and a row purged mid-batch is a no-op. It takes a Postgres advisory lock on
a connection of its own, so a second call to `POST /admin/storage/backfill` returns instead of
paying for the same listings again and the per-batch commits cannot move the lock to another
backend. Listings use a bounded S3 client, and `MAX_CONSECUTIVE_LISTING_FAILURES` failures in a
row end the run rather than spending one request per remaining row on a store that is down. It
pauses between batches to leave S3 request budget for the people working on the instance.

`derived_size_bytes` is measured for a *version's* output prefix but stored per media file, and
`uq_media_files_version_id` holds the one row per version that makes those two the same thing. A
version that has to carry several files is then a decision, with the total moving to
`asset_versions`, rather than a silently doubled figure.

**What "used storage" means** is defined once, in `apps/api/services/storage.py`
(`committed_media` with `_USED_SUM` on it): every byte the bucket still holds for a media file
whose version is in `processing` or `ready` — the original (`file_size_bytes`) plus whatever the
transcode wrote for it (`derived_size_bytes`). An `uploading` or `failed` version is not counted,
because its bytes are not (reliably) in the bucket. **The trash is counted**, because deleting is
not freeing: a soft-deleted project, asset or version keeps its objects until the retention
collector removes them, or until an admin deletes it permanently from the trash
(`POST /admin/trash/purge`). The admin overview, the member indicator on `GET /instance/settings`,
the per-project figures and the upload guard are all that one sum, so no surface can report
space as free that the next upload is refused for.

Two scoped views refine it with a single filter each, `live_media` and `trashed_media`, so no
second query can drift from it. The per-project rows, the asset tree and a project's own figure
are `live_media`: those are lists of things somebody can still open. `trash_bytes` in the
overview is `trashed_media`, the part of used that emptying the trash would free, which is why
it reads "of which" and not "plus" — the live rows plus that figure add up to used.

**The overview returns a bounded list.** `GET /admin/storage` answers with the largest
`limit` projects (default 200, maximum 1000) and `project_count` for how many there are; the
byte totals in the summary are always instance-wide, so a truncated list says so rather than
looking complete.

**The storage cap is enforced against that same figure** (`instance_storage_used_bytes`, which
is `instance_storage_totals()["used_bytes"]`, read by `storage_cap_error`). Derived bytes are in
it because the bucket holds them: a cap that ignored the renditions would be a cap on a fraction
of the storage it is set against, and a header that counted them while the cap did not reported
"0 B free" over an upload that still went through. The price is that an instance which has only
just measured its renditions reads fuller than it did the day before on an unchanged bucket;
`derived_size_bytes IS NULL` is "not measured yet" and counts as nothing until it is measured,
`unmeasured_files` says how many of those are left, and the upgrade note tells an administrator
to re-check the cap once the backfill has finished.

**Not counted anywhere**, because no row records their size: project posters, instance branding
logos, user avatars, the `watermarked/` renders `apply_watermark` writes, and any object in the
bucket that no live row points at (the orphan sweep's job). Comment attachments are the one
exception that does record a size (`comment_attachments.file_size_bytes`) and is
still left out on purpose: this figure is media, and pulling a second table into it would make
the one definition two. Objects whose rows are in the trash **are** counted, as above; what is
missing is only what no row owns. The figure is therefore the media the database knows the size
of, not the bucket's total, and should not be read as one.

**The cap is soft by exactly one transcode.** `storage_cap_error` is given the incoming original
only (`services/storage.py`), because the renditions that upload will produce do not exist yet.
An instance can therefore finish an upload a little over its cap, after which the next upload is
refused.
