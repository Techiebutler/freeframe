# Changelog

All notable changes to FreeFrame are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
