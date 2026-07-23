# Changelog

All notable changes to FreeFrame are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Sign-in codes are no longer issued to uninvited emails** — `POST /auth/send-magic-code` used to create and, on verification, fully activate an account for any email address, whether or not an admin had invited it. Only an existing user (already active, or already invited via `POST /users/invite`) can now receive a working code; an unrecognized email gets the same generic response, so the endpoint still doesn't reveal which emails are registered.

## [1.7.0] - 2026-07-21

### Upgrade notes
- **AWS S3 users in `us-east-1`: no action needed, but presigned URLs change signature.** They are now SigV4 rather than SigV2. If browser uploads were failing with an opaque 403 (`SignatureDoesNotMatch`), this release fixes it — any workaround you added can be removed.
- **Self-hosted S3 (Garage, MinIO, Ceph, R2/B2/Spaces): path-style addressing and SigV4 are now forced** in non-AWS mode (`S3_STORAGE` ≠ `s3`). This is what makes Garage work out of the box. If you deliberately relied on virtual-host-style addressing against a backend that supports it, be aware the request shape changes.
- **`uvicorn` 0.30.6 → 0.51.0** is a large jump. If you override the server command or its flags in your own compose file or image, re-check them against the upstream changelog. The bundled `apps/api/Dockerfile` invocation is unchanged and verified.

### Added
- **Configurable CORS origins** — a new `CORS_ALLOW_ORIGINS` setting (comma-separated) lets the API allow browser origins beyond the built-in frontend/localhost defaults; set it to `*` to allow any origin (handy when testing over a LAN IP — not recommended in production). The wildcard is served by echoing the request origin, so credentialed requests keep working.

### Changed
- **Dev compose honors the environment for LAN/self-host testing** — `docker-compose.dev.yml` now reads `NEXT_PUBLIC_API_URL`, the S3 storage credentials/bucket/region, `S3_PUBLIC_ENDPOINT`, and `MINIO_CORS_ALLOW_ORIGIN` from the environment (falling back to the previous defaults), so the dev stack can point at a LAN IP or external storage without editing the compose file.
- **Uploads panel now defaults to the Active tab** — opening the panel after an upload shows only in-progress items instead of dumping the full upload history on screen. Switch to the All/Complete/Failed tabs to view history as before.
- **Dependency updates** — uvicorn 0.30.6 → 0.51.0, alembic 1.13.3 → 1.18.5, httpx 0.27.2 → 0.28.1, bcrypt 4.2.0 → 4.3.0, psycopg2-binary 2.9.11 → 2.9.12 (plus frontend/dev: `@types/node`, `@vitejs/plugin-react`, and three `@radix-ui` packages).

### Fixed
- **First-time sign-in no longer breaks at the set-password step** — after verifying a magic code, a brand-new user (one who hasn't set a password yet) was advanced to the "set password" screen but the tokens issued by `verify-magic-code` were discarded, so the follow-up `POST /auth/set-password` (which requires an authenticated user) returned 401 and bounced the user back to the login screen — never able to finish onboarding. The tokens are now persisted before the set-password step. The password-login form also validates the email format client-side, so a malformed address shows a friendly "Enter a valid email address" instead of surfacing the raw backend validation message.
- **"Copy invite link" works over plain HTTP / LAN** — the admin users page called the browser Clipboard API directly, which only exists in a secure context (HTTPS or `localhost`); on a plain-HTTP LAN address the button threw. It now uses the shared clipboard helper (with an `execCommand` fallback) and only shows "Copied" on success.
- **Presigned URLs are correct in AWS S3 mode** — with `S3_STORAGE=s3`, a configured `S3_PUBLIC_ENDPOINT` (a MinIO/dev-only concept) would override the AWS host and point presigned upload/download URLs at the wrong endpoint. AWS mode now always uses native presigned URLs and ignores `S3_PUBLIC_ENDPOINT`.
- **Public share links are usable on phones** — the comment panel defaulted to open at every screen size and was a fixed column (360px / 320px) that refused to shrink, so opening a share link on a phone showed the panel first with the main content squeezed to a sliver — and tapping the toggle to leave a comment did it again. Below the `md` breakpoint (768px) the panel now starts closed and opens as a full-width sheet over the content instead of competing for width; at `md` and above the side-by-side layout is unchanged. Applies to the single-asset viewer, folder asset viewer, and folder grid view.
- **Garage and other self-hosted S3 backends work out of the box** — non-AWS mode (`S3_STORAGE` ≠ `s3`) now forces **path-style addressing** and **SigV4** on both the server-side and presign S3 clients. Without this, boto3 could emit virtual-host-style URLs (which fail when the store sits behind a reverse proxy without wildcard bucket DNS) and SigV2 presigned URLs (which Garage rejects with `Received an unknown query parameter: 'AWSAccessKeyId'`). AWS mode is unchanged.
- **Startup bucket CORS is applied as one rule per origin** — both allowed origins used to share a single CORS rule; Garage answers such a rule by joining all its `AllowedOrigins` into one comma-separated `Access-Control-Allow-Origin` header, which browsers hard-reject, so every cross-origin request (HLS segment fetches, presigned uploads) failed CORS with e.g. `HLS error: networkError`. Per-origin rules behave identically on AWS-style backends, which echo only the matching origin either way.
- **Presigned URLs use SigV4 on AWS S3 in `us-east-1`** — `us-east-1` is the only region whose endpoint metadata still advertises SigV2, so with no explicit signature version botocore silently downgraded *presigned* URLs (uploads and playback) to SigV2 there, while server-side calls and the reported client config both still looked like SigV4. SigV2 presigned PUTs fail as soon as the browser sends a `Content-Type`, and buckets created after June 2020 reject SigV2 outright — so an operator on the default `S3_STORAGE=s3` + `S3_REGION=us-east-1` could see uploads fail with an opaque 403. SigV4 is now pinned in every mode; other regions were already unaffected.
- **Profile avatar uploads work when `S3_PUBLIC_ENDPOINT` is set** — the upload URL was presigned against the *internal* S3 endpoint, so on the usual MinIO/reverse-proxy setup the browser could not reach it. Avatars are now also stored as an S3 key instead of a long-lived presigned URL (a persisted URL started returning 403 once it expired), with a fresh short-lived URL generated per response, and the confirm step rejects keys outside the caller's own avatar prefix.

## [1.6.0] - 2026-07-14

### Added
- **Version compare** — a fullscreen split view for any two versions of an asset: synced side-by-side playback with per-side frame-accurate offset trim for video, wipe slider + side-by-side with shared zoom/pan for images, and a version-scoped comment panel on each side (comments land on the correct version at the correct frame). Deep-linkable via URL. Per-side audio control keeps one side audible at a time; each side's comments appear as markers with hover previews on the shared scrubber, and clicking one seeks to the frame, opens that side's panel with the comment focused, and shows the comment's drawing over that pane (video, side-by-side, and wipe). You can also **draw new annotations** while comparing — the pencil in either side's composer draws over that pane (video and image side-by-side; one side at a time), and the markup attaches to that version's comment.

### Fixed
- **Faster comment saving** — posting a comment no longer blocks on a full re-fetch of every comment on the asset; the new comment appears immediately (optimistic insert) while the list reconciles in the background. The comment-list endpoints (both the signed-in review view and public share links) also no longer issue a per-comment query cascade (N+1) — each now builds the whole thread in a fixed handful of queries — so loading and saving stay fast as a thread grows.
- **Settings is now reachable for non-admin users** — the sidebar "Settings" menu item and the `/settings` index both routed everyone to the admin-only `/settings/admin`, which bounced normal users back to the home page. Non-admins now land on Appearance (their first accessible settings page); superadmins still land on the admin dashboard.
- **Comments made at 0:00 keep their timecode** — the composer silently dropped the timecode when the playhead sat at the very start of a video/audio file (the badge showed `00:00:00:00` but the comment saved without it, sinking to the bottom of the timeline-ordered panel); drawings on video now always carry the frame's timecode, even with the clock toggle detached. Comment sort labels are now honest: the default is labeled "Timecode" (behavior unchanged) and "Oldest" now genuinely sorts by creation time.

## [1.5.0] - 2026-07-13

### Upgrade notes
- **Run the media-metadata backfill once after upgrading** — `docker exec freeframe-api-1 python -m apps.api.scripts.backfill_media_metadata` populates duration/resolution/fps for files uploaded before this release. Without it, older videos will ask for a frame rate when exporting comments to the NLE formats (the export still works — you just pick the fps by hand).

### Added
- **Export comments as NLE timeline markers** ([#84](https://github.com/Techiebutler/freeframe/issues/84)) — `GET /assets/{id}/comments/export?format=edl|fcpxml|premiere_xml|csv` turns a version's timecoded comments into importable markers for DaVinci Resolve (marker EDL — import via Timelines → Import → Timeline Markers from EDL, matching the timeline start TC, default 01:00:00:00), Final Cut Pro (FCPXML), and Premiere Pro (FCP7 XML — Premiere cannot import FCPXML), plus CSV. Uses the stored frame rate (see #124) with a `?fps=` override. Note: variable-frame-rate sources may land markers ±1 frame.
- **Export comments menu in the review panel** ([#84](https://github.com/Techiebutler/freeframe/issues/84)) — download markers for Resolve/Final Cut/Premiere/CSV from the comment panel toolbar; prompts for frame rate when the video predates the metadata backfill.

### Fixed
- **Transcode pipeline now persists media metadata** ([#124](https://github.com/Techiebutler/freeframe/issues/124)) — `duration_seconds`, `width`, `height`, and `fps` are stored on every new video/audio transcode (previously always NULL, breaking duration display). Existing files: run the one-off backfill — `docker exec freeframe-api-1 python -m apps.api.scripts.backfill_media_metadata`.

## [1.4.1] - 2026-07-09

### Fixed
- **Celery workers no longer report `unhealthy`** — the prod image no longer bakes an API-only `HEALTHCHECK` (`curl :8000/health`); it now lives on the `api` service in `docker-compose.prod.yml`, so `worker`/`beat`/`email_worker` (which don't serve HTTP) report their real state instead of perpetually unhealthy.
- **A slow or unreachable object store no longer blocks app startup** — the startup S3 bucket check now runs off the request path (background thread) with bounded timeouts and never crashes/hangs the app (previously a slow S3 could block startup ~60s+). It retries a transient failure with backoff, so a store that comes up shortly after start self-heals without a manual restart; a persistent failure logs a clear warning.
- **Email is documented as required for login, with a startup warning** — FreeFrame signs users in via emailed magic codes, so without a working mailer nobody can log in. The app now logs a clear warning at startup when email isn't configured, and `docs/deployment.md` + `.env.example` call it out.

## [1.4.0] - 2026-07-09

### Upgrade notes
- **S3 misconfiguration now fails fast.** If you set `S3_STORAGE=s3` (native AWS) together with a non-AWS `S3_ENDPOINT`, the app refuses to start with a clear error — use `S3_STORAGE=minio` (or any non-`s3` value) for R2/B2/Spaces/MinIO. Valid setups are unaffected.
- **boto3 1.35 → 1.43 + older S3-compatible backends.** boto3 now sends CRC32 checksums on batch deletes; MinIO/Ceph older than ~2025 reject them. `delete_prefix` falls back to per-key deletes automatically and the bundled dev MinIO is bumped — but for the fast path, upgrade an external older store.
- **Browser uploads need bucket CORS `ExposeHeaders: ["ETag"]`** (especially Hetzner, where CORS is API/CLI-only). See `docs/deployment.md`.
- **Release channels:** production self-hosters should now `git clone -b stable` instead of `main`.

### Added
- **`stable` / `latest` release channels** ([#140](https://github.com/Techiebutler/freeframe/pull/140)) — moving branch pointers on top of the immutable `vX.Y.Z` tags. `stable` = last validated release (production default), `latest` = newest release; a bad release is never promoted. See the README "Release channels" table and `docs/RELEASING.md`.

### Changed
- **Faster review playback for long videos** ([#132](https://github.com/Techiebutler/freeframe/issues/132)) — the HLS proxy no longer rebuilds a boto3 client per segment when rewriting a VOD manifest (previously ~7s of blocking overhead for a ~55-minute video); clients are now cached.
- **Dependency updates** — FastAPI 0.115 → 0.139, boto3 1.35 → 1.43, python-multipart 0.0.12 → 0.0.32, kombu 5.4 → 5.6, hls.js 1.6.15 → 1.6.16, wavesurfer.js 7.12.5 → 7.12.10 (plus dev/CI: vitest, pytest-asyncio, actions/checkout v7). The frontend now uses pnpm as the single lockfile.

### Fixed
- **S3 prefix cleanup stays compatible with older S3-compatible storage** ([#97](https://github.com/Techiebutler/freeframe/pull/97)) — boto3/botocore ≥ 1.36 send a CRC32 data-integrity checksum on batch `DeleteObjects` instead of the legacy `Content-MD5` header; S3-compatible backends predating AWS flexible checksums (MinIO older than ~2025, older Ceph/RGW, etc.) reject it with `MissingContentMD5`, which would break HLS/prefix cleanup (`delete_prefix`). `delete_prefix` now falls back to per-key deletes when a backend rejects the batch delete, and the bundled dev MinIO image is bumped to a release that supports the new checksums. `put_object`/multipart uploads are unaffected.
- **Misconfigured S3 storage fails fast instead of silently routing to AWS** ([#137](https://github.com/Techiebutler/freeframe/pull/137)) — with `S3_STORAGE=s3` (native AWS), `S3_ENDPOINT` is ignored, so pairing it with a non-AWS endpoint (Cloudflare R2, Backblaze B2, self-hosted MinIO, …) used to silently send traffic to AWS. Startup now raises a clear error naming the offending endpoint and pointing to `S3_STORAGE=minio`.
- **Browser multipart uploads: required bucket CORS `ETag` documented + surfaced** ([#131](https://github.com/Techiebutler/freeframe/issues/131)) — uploads read each part's `ETag` response header, which browsers expose only when the bucket CORS `ExposeHeaders` includes it; documented in `docs/deployment.md` (with Hetzner/AWS notes), and the previously-silent `put_bucket_cors` failure now logs a warning.

## [1.3.1] - 2026-07-08

### Added
- **Version-aware public share player** ([#120](https://github.com/Techiebutler/freeframe/issues/120)) — on folder/project/multi-share links with **Show all versions** enabled, the shared asset viewer now shows a version switcher; selecting a version swaps the streamed media and scopes comments to that version. Previously only the latest version played and comments from every version were shown regardless of the selection. The folder/grid preview (which has no version picker) now scopes its comment list — and each asset card's comment count — to the latest ready version instead of counting/showing every version's comments. New guest endpoint `GET /share/{token}/assets/{asset_id}/versions` (exposes all ready versions only when the link enables version history, otherwise just the latest); `GET /share/{token}/stream/{asset_id}` and `GET /share/{token}/comments` now accept an optional `version_id` (comments also accept `latest_only`). The separate single-asset custom-player path is tracked in [#123](https://github.com/Techiebutler/freeframe/issues/123).
- **Share preview cards show a version-count badge and duration chip** — each asset card in the folder/grid share preview now shows a "⧉ N" badge when the asset has multiple ready versions, and the multi-share preview path now passes through media duration and file size (the duration chip renders once media duration is populated — currently blocked by [#124](https://github.com/Techiebutler/freeframe/issues/124)).

### Fixed
- **Passphrase-protected share previews no longer show "No content yet"** ([#119](https://github.com/Techiebutler/freeframe/issues/119)) — the public `/share/{token}/assets` and `/share/{token}/thumbnail/{asset_id}` endpoints now honor the authenticated link creator's passphrase bypass (matching `/share/{token}/stream/{asset_id}`), so the dashboard settings preview loads a password-protected link's assets instead of rendering an empty state.
- **Video version switcher now plays the selected version's stream** ([#66](https://github.com/Techiebutler/freeframe/issues/66)) — the review player fetched `/assets/{id}/stream` without a `version_id`, so switching versions updated the dropdown but the `<video>` kept playing the latest version's stream. The player now pins the stream to the selected version and re-fetches (resetting playback) when the version changes.
- **New asset versions appear without a hard refresh, with an in-progress indicator** ([#118](https://github.com/Techiebutler/freeframe/issues/118)) — the review screen now revalidates the version list from transcode SSE events instead of a single best-effort timer, so a freshly uploaded version shows up and advances through uploading → processing → ready on its own. The version switcher trigger now surfaces a spinner/label while a new version is still uploading or processing (previously that status was only visible inside the dropdown).

## [1.3.0] - 2026-07-07

### Upgrade notes

New garbage-collection features for [#65](https://github.com/Techiebutler/freeframe/issues/65), all with safe defaults — nothing runs unless you run `celery beat`, and the destructive parts are opt-in:

- **Retention GC activates if you run `celery beat`.** A daily `cleanup_soft_deleted` job hard-deletes rows soft-deleted longer than `SOFT_DELETE_RETENTION_DAYS` (default `30`) and deletes their S3 objects, cascading the full project→folder→asset→version→media/comment/share tree. Set `SOFT_DELETE_RETENTION_DAYS=0` to disable.
- **The S3 orphan sweeper is off and report-only by default.** It runs only when `ORPHAN_SWEEP_GRACE_HOURS > 0`, and even then only *reports* bucket objects with no DB row — it deletes only if you also set `ORPHAN_SWEEP_DELETE=true`. Review its report-only logs before enabling deletion.
- **No migration required** — the GC reuses the existing `deleted_at` columns.
- **New optional env vars, all safe-by-default:** `SOFT_DELETE_RETENTION_DAYS=30`, `ORPHAN_SWEEP_GRACE_HOURS=0` (disabled), `ORPHAN_SWEEP_DELETE=false` (report-only).

### Added
- **Retention-window garbage collection** ([#65](https://github.com/Techiebutler/freeframe/issues/65)) — a daily `cleanup_soft_deleted` job hard-deletes rows soft-deleted longer than `SOFT_DELETE_RETENTION_DAYS` (default 30, `0` disables) and reclaims their S3 objects, cascading through projects, folders, assets, versions, media, comments, approvals, and share links. Long-expired share links are swept into soft-delete first. No effect unless you run `celery beat`.
- **S3 orphan sweeper** ([#65](https://github.com/Techiebutler/freeframe/issues/65)) — an opt-in weekly `sweep_orphan_s3` job reclaims bucket objects under `raw/`/`processed/` that no `MediaFile` row references. **Off and report-only by default**: set `ORPHAN_SWEEP_GRACE_HOURS` > 0 to enable (only keys older than that window are considered, so active uploads are never touched) and `ORPHAN_SWEEP_DELETE=true` to actually delete (otherwise it just logs what it would reclaim). No effect unless you run `celery beat`.
- **Manual `POST /admin/purge` endpoint** — superadmin-only; triggers the retention collector to run in the background (returns `202`); reclaimed counts are logged by the worker.

### Changed
- **`POST /assets/{id}/restore` and `/folders/{id}/restore` now return `409`** when the item's project has been deleted — a deleted project has no restore path, so there is nothing to restore into.

## [1.2.0] - 2026-07-07

### Upgrade notes

Upgrading from v1.1.6 is non-breaking by default (the new storage cap and per-file limit both default to unlimited), but note:

- **Run `alembic upgrade head`.** This adds the `instance_settings` table and widens `MediaFile.file_size_bytes` / `CommentAttachment.file_size_bytes` to `BigInteger`. ⚠️ The bigint change **rewrites the `media_files` and `comment_attachments` tables under an `ACCESS EXCLUSIVE` lock** (int4→int8 is not an in-place change in PostgreSQL), blocking reads and writes for the duration of the rewrite. Negligible on small installs; on a large `media_files` table, **run it during a low-traffic maintenance window.**
- **The upload reaper activates if you run `celery beat`.** An hourly job aborts stale, still-open S3 multipart uploads and soft-deletes `uploading`/`failed` versions older than `STALE_UPLOAD_TIMEOUT_HOURS` (default `24`), deleting their S3 objects. Raise the value to be more conservative, or set it to `0` to disable. No effect if you don't run `celery beat`.
- **New optional env vars, both with safe defaults:** `MAX_UPLOAD_BYTES=0` (unlimited per-file size) and `STALE_UPLOAD_TIMEOUT_HOURS=24`.
- **No behavior change until you opt in** — set an instance storage cap via the admin **Instance settings** tab (or `PUT /instance/settings`) when you want to enforce one.

### Added
- **Storage cap admin UI + sidebar indicator** ([#102](https://github.com/Techiebutler/freeframe/pull/102)) — the global sidebar shows instance storage `used / limit` with a meter (amber ≥80%, red ≥90%); admins set the cap in GB (`0` = unlimited) in a new **Instance settings** sub-tab on the admin settings page. Frontend for the #98 storage cap.
- **Automatic reclamation of stuck/failed upload storage** ([#101](https://github.com/Techiebutler/freeframe/pull/101)) — a scoped slice of #65: an hourly job aborts stale, still-open S3 multipart uploads and soft-deletes `uploading`/`failed` versions older than `STALE_UPLOAD_TIMEOUT_HOURS` (default 24), reclaiming their S3 objects. Prevents unbounded storage leak from interrupted/failed uploads that the committed-only cap doesn't count.
- **Instance settings + instance-wide storage cap** ([#98](https://github.com/Techiebutler/freeframe/pull/98)) — new admin-editable `instance_settings` singleton table (the home for deployment-level settings on this single-tenant instance), with an instance-wide total-storage cap as its first setting. `GET /instance/settings` (any member) returns `storage_limit_bytes` + current `storage_used_bytes`; `PUT /instance/settings` (admin) sets the limit (`0` = unlimited). The cap is enforced at upload initiate alongside the per-file `MAX_UPLOAD_BYTES` check; usage counts committed (processing/ready), non-deleted media. Backend only — admin UI + storage indicator to follow.
- **Configurable per-file upload limit** ([#64](https://github.com/Techiebutler/freeframe/issues/64)) — new `MAX_UPLOAD_BYTES` env var caps the size of a single uploaded file (`0` = unlimited, the new default). Replaces the hardcoded 10GB ceiling that self-hosters running their own S3/MinIO had no way to change or remove. Enforced at both upload-initiation points (`POST /upload/initiate` and new-version upload) with an error that reports the configured cap instead of a hardcoded "10GB". Effective size is still structurally bounded by S3 multipart (10,000 parts × 10MB chunk ≈ 97GB).

### Fixed
- **Per-project storage figure now matches the instance cap accounting** ([#100](https://github.com/Techiebutler/freeframe/pull/100)) — the per-project storage number on the project page now counts only committed (`processing`/`ready`), non-deleted media — excluding in-progress/failed/deleted uploads — consistent with the instance-wide storage cap (#98).
- **Files larger than ~2.1 GB could not be recorded** ([#99](https://github.com/Techiebutler/freeframe/pull/99)) — `MediaFile.file_size_bytes` and `CommentAttachment.file_size_bytes` were `INTEGER` (int4, ~2.1 GB ceiling), so a file above that size overflowed on insert despite per-file uploads being nominally unlimited ([#64]). Both columns are now `BigInteger`.
- **Misleading "Storage X / 10 GB" indicator on the project page** ([#64](https://github.com/Techiebutler/freeframe/issues/64)) — the project sidebar rendered a hardcoded 10 GB denominator with 80%/90% color warnings, implying a per-project quota that never existed as a real, configurable concept. It now shows only storage used — no fake denominator, no progress bar.

---

## [1.1.6] - 2026-07-06

### Fixed
- **HLS video playback on the public share page in Chrome/Firefox** ([#68](https://github.com/Techiebutler/freeframe/issues/68)) — `ShareMediaViewer` used a plain `<video src={streamUrl}>`, which only plays HLS (`.m3u8`) natively in Safari and failed in Chrome/Firefox. It now uses hls.js (already a project dependency) for MediaSource-capable browsers, falling back to native playback for Safari and direct media files; the same pattern was applied to the audio branch. ([#76](https://github.com/Techiebutler/freeframe/pull/76))
- **Public share comments response shape** ([#67](https://github.com/Techiebutler/freeframe/issues/67), [#72](https://github.com/Techiebutler/freeframe/issues/72)) — `GET /share/{token}/comments` now returns a consistent bare array on the no-target fallback path, and the single-asset share page handles the response robustly (aligned with the folder share viewer). Adds backend regression coverage for asset-share, folder/project-share, and no-target fallback paths. ([#70](https://github.com/Techiebutler/freeframe/pull/70), [#73](https://github.com/Techiebutler/freeframe/pull/73))

### Dependencies
- Bump `redis` (apps/api) from 5.1.0 to 5.3.1 ([#30](https://github.com/Techiebutler/freeframe/pull/30))
- Bump `pnpm/action-setup` from 5 to 6 (CI) ([#58](https://github.com/Techiebutler/freeframe/pull/58))

---

## [1.1.5] - 2026-04-14

### Security
- **HLS video streams now route through the API proxy so S3 objects can stay private** ([#51](https://github.com/Techiebutler/freeframe/issues/51)) — the `/stream/hls/{path}` proxy router was already built and registered in `main.py` but was never actually called. `GET /assets/{id}/stream`, `GET /share/{token}`, and `GET /share/{token}/stream/{asset_id}` all previously handed out a direct presigned URL to `master.m3u8`, which forced the HLS player to fetch variant playlists and `.ts` segments as unsigned requests — only working on buckets with public-read ACL. Non-AWS providers (Exoscale SOS, Cloudflare R2, etc.) do not inherit bucket-level ACL on new objects, so processed files returned 403 Forbidden. The three stream endpoints now mint a short-lived HLS JWT scoped to the asset's S3 prefix and return `/stream/hls/master.m3u8?token=…`; the proxy rewrites variant playlist URLs to stay inside the proxy (with the same token) and rewrites segment URLs to freshly-presigned S3 URLs. Result: the bucket can stay fully private on every S3-compatible provider, captured segment URLs expire in 24h instead of living forever via public-read, and a leaked master URL can't be replayed after its token expires. Token and segment presign TTLs both bumped from 4h to 24h so pause-and-resume works without refresh logic. Includes regression tests for the assets, share asset detail, and share stream endpoints.

---

## [1.1.4] - 2026-04-13

### Fixed
- **Share endpoint returned folder path instead of master.m3u8 for video stream URLs** ([#45](https://github.com/Techiebutler/freeframe/issues/45)) — `GET /share/{token}` was building video stream URLs from `MediaFile.s3_key_processed` (the HLS folder prefix) without appending `/master.m3u8`, so share viewers received a folder URL instead of the playlist. Mirrors the existing fix already applied in `get_share_stream_url` and `assets.py`. Includes regression tests for both the video and image paths.
- **Dashboard crash on upload with relative `NEXT_PUBLIC_API_URL`** ([#46](https://github.com/Techiebutler/freeframe/issues/46)) — `useSSE` called `new URL(`${API_URL}/events/${projectId}`)` without a base. When `NEXT_PUBLIC_API_URL` was set to a relative path like `/api` (typical for nginx-proxied deployments), the URL constructor threw `TypeError: Failed to construct 'URL': Invalid URL` the moment `UploadSSEBridge` opened its first SSE connection — crashing the dashboard immediately after any upload. Now passes `window.location.origin` as the base URL so relative paths resolve. Includes a regression test.

---

## [1.1.3] - 2026-04-11

### Fixed
- **Missing file extensions on download** ([#41](https://github.com/Techiebutler/freeframe/issues/41)) — downloaded assets were saving without an extension (e.g. `Video_Title` instead of `Video_Title.mp4`). The API now derives the extension from `MediaFile.original_filename` (authoritative) or the S3 key and appends it to `asset.name` when missing, for both `/assets/{id}/stream` and `/share/{token}/stream/{asset_id}`. The dashboard Download button now uses `?download=true` + a hidden iframe, and the share viewer no longer overrides `a.download`, so the browser honors the server's `Content-Disposition` filename.

---

## [1.1.2] - 2026-04-10

### Fixed
- **Asset downloads** ([#35](https://github.com/Techiebutler/freeframe/issues/35)) — download buttons were serving HLS `.m3u8` playlist files instead of the original media. Stream endpoints now accept `?download=true` and return a presigned URL to the raw file (or the processed file for images/audio) with `Content-Disposition: attachment` so the browser saves it with the correct filename.
- **Share link "Download All"** now recursively walks the share folder tree and downloads assets from all subfolders — previously only downloaded assets at the current level.
- **Bulk download in project view** — the Download button in the bulk actions bar now appears when only folders are selected, and selecting folders recursively downloads their assets.
- **Share link download permission** — the stream endpoint now enforces `allow_download` and logs `downloaded` activity separately from `viewed_asset`.
- **Upload dialog file list** — selecting multiple files now shows a clean per-file list with individual sizes (KB/MB) instead of a single concatenated string.
- **Dev environment** — `docker-compose.dev.yml` web service bumped from `node:18-alpine` to `node:20-alpine` (required by current frontend dependencies).

---

## [1.1.1] - 2026-04-04

### Security
- **Setup guard middleware** — all API routes return 503 and frontend redirects to `/setup` until initial superadmin is created. Exempt: `/setup/*`, `/health`, `/docs`, `/share/*`. Cached after first check for zero overhead.

### Fixed
- Branch protection `lock_branch` was preventing PR merges — unlocked while keeping review requirement

---

## [1.1.0] - 2026-04-03

### Security
- **Global rate limiting** — 600 read / 300 write requests per minute per user/IP with Redis sliding window
- **Per-endpoint rate limits** on sensitive routes: magic code (5/10min), verify (10/10min), share validation (30/min), setup (3/10min)
- **Secure HLS streaming proxy** — token-authenticated manifest rewriting with directory traversal prevention
- **Cryptographic magic codes** — replaced `random.randint` with `secrets.randbelow`
- **Upload authorization hardening** — presign-part, complete, and abort endpoints now verify `created_by` ownership
- **SSE event auth** — token query param support + project membership validation (previously had no access control)
- **Share link password sessions** — 1-hour Redis sessions after password verification so users don't re-enter passwords
- **Multi-share scope enforcement** — share links only expose specifically selected items, not the entire project
- **Rate limiters fail open** — graceful degradation when Redis is unavailable (no 500 errors)
- **CI tamper guards** — minimum test count, critical file checks, and route count assertions prevent PRs that delete tests from passing

### Added
- **Multi-item share links** — select multiple assets/folders and create a single share link (`ShareLinkItem` model + `POST /projects/{id}/share/multi` endpoint)
- **Add asset to existing share link** — `POST /share/{token}/add-asset/{asset_id}` endpoint with dropdown UI in the asset viewer
- **Viewer share button redesign** — dropdown with "New Share Link" + list of existing project share links
- **Inline comment editing** — edit button in comment menu opens textarea, saves via `PATCH /comments/{id}`
- **Copy comment link** — builds URL with `?commentId=` param; opens viewer and highlights the comment
- **Guest user comment flow** — name/email prompt for non-authenticated users on share links, persisted to localStorage
- **Storage indicator** — progress bar in project sidebar showing used / 10 GB with color warnings (amber 80%+, red 90%+)
- **SSE typed events** — `event: type\ndata: payload` format enabling frontend filtering via `EventSource.addEventListener`
- **SSE connection pooling** — Redis `ConnectionPool` prevents connection exhaustion under load
- **Non-blocking Celery dispatch** — background daemon thread so API never blocks on broker connections
- **Token refresh deduplication** — concurrent 401s share a single refresh call, preventing logout races
- **GitHub Actions CI** — 4 parallel jobs: backend tests, frontend build, lint, Docker build
- **CI tamper-proof guards** — minimum test file count (5), minimum passing tests (40), critical file existence checks, route count assertions
- **Docker build CI** — all 4 Dockerfiles (api dev/prod, web dev/prod) built and verified on every PR
- **Dependabot** — automated weekly dependency updates for pip, npm, GitHub Actions, Docker (major versions ignored)
- **Community files** — CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, issue templates, PR template
- **GitHub Discussions** enabled
- **10 repo topics** — media-review, frame-io-alternative, self-hosted, fastapi, nextjs, etc.

### Fixed
- Share link viewer 403 errors — share token now flows through `ReviewProvider` → `ImageViewer` / `AudioPlayer` for stream URL fetching
- Password-protected share links — `share_session` threaded through all API calls (assets, stream, comments, thumbnails)
- Share link preview in project page showed all project assets instead of only shared items
- Comment author showing "User" instead of real name in share link sidebar
- Annotation drawing not working on shared assets (missing `AnnotationCanvas` render)
- Canvas annotations not scaling correctly — `_canvasWidth`/`_canvasHeight` stored in JSON for proper coordinate scaling
- Fabric.js not initializing on late-mounted canvas elements — re-bootstrap on drawing mode toggle
- Stale annotations persisting after comment submission — canvas and overlay now cleared
- Video player showing old video while new one loads — `streamUrl` reset to null on asset change
- Relative HLS proxy paths not resolving — API URL prepended for `/stream/hls/` paths
- Image viewer not filling container — `w-full h-full` instead of `inline-flex`
- Stub buttons wired up: Share + Download in fields panel, Assets `+` for new folder
- Right panel toggle hidden on projects listing page (not useful there)
- Main header hidden on asset viewer page (viewer has its own top bar)
- Removed non-functional "More" button from comment panel header
- Settings menu redirects to `/settings/admin` instead of `/settings/profile`
- Existing project members filtered from "Add member" suggestions
- Sidebar overflow in collapsed mode — `overflow-hidden` + `overflow-x-hidden`
- Back to Dashboard redirects to `/projects` instead of `/`
- Project detail endpoint now calculates `storage_bytes`, `asset_count`, `member_count`
- Backend `guest_comment` activity log crash when authenticated user comments via share link
- Pre-existing test failures in `test_auth` and `test_projects` (missing mock fields)
- `playheadTime` and `seekTarget` reset on asset change in review store
- Web Dockerfiles updated to use pnpm + Node 20 (were using npm + Node 18)
- TypeScript annotation errors in test mocks (missing `preferences`, `asset_name`, etc.)

### Changed
- `review-store`: added `setIsDrawingMode()` for explicit control (not just toggle)
- Dependabot configured to skip major version bumps (manual migration only)
- Branch protection: force push disabled on main

### Dependencies Updated
- next 14.2.29 → 14.2.35
- sqlalchemy 2.0.35 → 2.0.49
- pytest 8.3.3 → 8.4.2
- python-jose 3.3.0 → 3.5.0
- email-validator 2.2.0 → 2.3.0
- psycopg2-binary 2.9.9 → 2.9.11
- jinja2 3.1.4 → 3.1.6
- wavesurfer.js 7.12.4 → 7.12.5
- vitest 4.1.0 → 4.1.2
- @types/node 22.19.15 → 22.19.17
- actions/checkout v4 → v6
- actions/setup-python v5 → v6
- actions/setup-node v4 → v6
- pnpm/action-setup v4 → v5

## [1.0.0] - 2026-03-27

Initial release — backend-only v1 with:
- FastAPI backend with JWT authentication and magic code login
- Org → Team → Project hierarchy with role-based permissions
- Asset upload (multipart S3), versioning, and media processing (FFmpeg → HLS, WebP, MP3)
- Comments with threading, timecode ranges, annotations (Fabric.js), and guest comments
- Approvals, sharing (links + direct), metadata fields, collections
- Branding, watermarks, notifications, SSE events
- Next.js 14 frontend with review interface, share viewer, admin panel
