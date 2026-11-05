# Changelog

All notable changes to FreeFrame are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Talk + Draw on desktop: video big on the left, notes in a Feedback column on the right, a Talk / type bar under the video (no more phone-width column). "Classic comments" switches back to normal comments.

### Added
- Comment history for the AutoReview Brand Loop backfill: `GET /internal/review/comments-export` (review bridge secret) pages through every public comment, oldest first (`after` + `after_id` cursor, `limit` up to 1000), in the row shape of feedback-agent's `scripts/brand-loop-backfill.mjs`, with the brand slug, asset, version, timecode, resolved flag and whether the author is a client. Only the author's email domain is returned; internal comments are never included.
- Split upload: the parts of one request and its assembled ads are reviewed side by side (up to
  `ITERATION_PARALLEL_REVIEWS`, default 6) instead of one after another. Iteration and checklist tasks
  can run on their own Celery queue (`ITERATION_QUEUE`); the Coolify stack adds an `iteration_worker`
  for it, so they no longer wait behind video transcodes.
- Hand-in, two-pass review: the held panel puts "Open revision" right under the Must-fix (the worker's
  `revisionUrl` when it is on this FreeFrame, else the hand-in folder) and scrolls into view the moment
  the hold is decided. Guidance notes show once, even when repeated. The asset page re-fetches a fresh
  version's comments every 5 s for its first 10 minutes, so AutoReview notes appear without a reload.
- AutoReview Brand Loop: projects carry an explicit `autoreview_brand_slug` (superadmin sets it via
  `PUT /admin/projects/{id}/autoreview-brand`). Comments on linked projects are sent to
  `AUTOREVIEW_URL/api/brand-loop/comment` in the background, and members get an "AutoReview" sidebar
  entry that opens their brand page signed in (`GET /autoreview/link`, 60 s token). Off unless
  `AUTOREVIEW_URL` and `BRAND_LOOP_SECRET` are both set.
- Outbound hub events for the hand-in lane, replacing the n8n `freeframe-comment-ping`: a signed
  `client_comment` webhook POST fires when a guest reviewer comments on a hand-in version, and a
  signed `revision_submitted` webhook POST fires when a new version completes through the hand-in
  lane (`POST /upload/complete`). The `client_comment` payload includes a `review_url` - the same
  absolute `/r/<token>` editor-facing review link used by the editor-submissions list - omitted
  (never blocking the event) when it can't be resolved. Team comments and auto-review findings
  never trigger either event. Off by default; configured via `HUB_EVENTS_WEBHOOK_URL` /
  `HUB_EVENTS_WEBHOOK_SECRET` (HMAC-SHA256 over the raw body, `X-Aditor-Signature` header), fired
  after commit and never fails the originating comment/upload. FreeFrame stays "dumb" - the hub
  owns the ping/escalation loop.
- Editor-workflow events to the company-DB workflow-events store: a request-lane hand-in
  (`handin.uploaded`, from both `POST /upload/complete` and `POST /r/<token>/upload/complete`),
  a finished request (`handin.finished`), an editor's answer to an open client note
  (`revision.responded`) and a second-or-later version on the same asset (`version.resubmitted`)
  each POST to the company DB's `log_workflow_event` RPC with the request's brand, card
  reference and editor email (the RPC resolves it to a person on the company side; FreeFrame's
  least-privilege role never reads the company directory itself). Best effort, after commit,
  bearer-JWT authenticated (no HMAC); a complete no-op until `COMPANYDB_WORKFLOW_JWT` is set.

### Changed
- A cold, signed-out hit to `/login` now redirects straight to the central gate
  (`/api/auth/oidc/login`) instead of showing an intermediate "Sign in with Aditor" page that
  needed a second click - the gate's own sign-in page is the first thing shown. A gate failure
  (`?error=...`) still shows inline instead of auto-redirecting, so it can't loop.
- Removed the native "Continue with Google" sign-in and the emailed magic-code sign-in entirely
  (routes, services, UI, tests) - the central gate (and, as a break-glass/self-hosted fallback,
  password sign-in) is now the sole way to sign in to FreeFrame.

### Fixed
- Auto-finish no longer locks an editor out of `/r/<token>`. A new file on a completed request reopens it: the completed page has "Add more files", and when a file lands (`/upload/complete`, also the signed-in route) `completed_at` clears and the normal review and finish flow runs again. Files already finished keep their result, and starting an upload that never lands changes nothing. Each new file reports one upload as before; `handin.finished` is only sent for a request's first finish (`upload_requests.first_completed_at`). Split-upload component batches stay closed once complete.
- Hand-in (`/handin`): cancelling no longer finalises anything still on the way. A cancelled upload stays cancelled even if `/upload/complete` was in flight, a cancelled or failed file stops the whole hand-in (siblings still uploading are cancelled, no review link is requested, the page says which files already arrived), and the pre-upload assignment check (`POST /folders/{id}/editor-request?adopt=false`) no longer adopts files already in a reused card folder. The copy states that every file added goes in one submission.
- `/r/<token>` no longer shows "Review in progress" for a file whose upload never completed. Such a file now reads "Upload not finished" (`review_state: upload_incomplete`) and can be uploaded again or removed (`POST /r/<token>/upload/discard`). The page also has "Add more files" after a first file, and accepts more files while earlier ones wait for the editor's details.
- A signed-in editor's upload into a hand-in folder writes the same submission record as a guest's. Without it `/r/<token>` said "Review unavailable" for good and finish stayed blocked, although the file was there and the review ran.
- Portal hand-ins (`POST /integrations/portal/delivery-folder`) are registered with AutoReview. The endpoint created the folder, share and editor link but no checklist binding, and only a binding registers a hand-in, so the editor page showed "Review unavailable" for good and the hand-in could not be finished. A repeated call for the same card now also repairs a hand-in created before this fix.
- Hand-in upload: a batch no longer stalls on the first file. Files transfer two at a time in the background whether or not the uploader's details are in yet, a transferred file says "Uploaded" instead of "Uploading... 100%", and details submit every waiting file at once. Details the server refuses are asked for again without losing the transferred files.
- Video processing downloads the original before encoding instead of streaming it from storage. A valid MP4 with audio and video stored far apart (some editors' exports) made every seek a new range request: a 9-minute file never finished and failed with "Processing failed"; it now processes in about two minutes. `FFMPEG_INPUT_RW_TIMEOUT_SECONDS` is gone (the download has its own timeout and retries).
- Preserve briefing notes alongside one document link or attachment in requests, setup and brand rules. Read common TXT encodings correctly and reject empty, unreadable or oversized text with clear limits.
- Show failed briefing preparation on request cards and shared-link dialogs, with a retry for the same request; file uploads remain available.
- Accept Word (`.docx`) briefings and brand guidelines up to 10 MB, preserving their text in the review checklist and removing the extension from suggested project names.
- Start Whop customers with one private brand workspace automatically, reuse existing workspaces, and show a single brand as context when requesting files.
- Killed the post-login flash (dashboard → login → dashboard) after a gate sign-in by removing the
  last client-side post-callback navigation (the native Google callback page) in favor of the
  gate's own server-side redirect, and by not painting the login form while an existing session
  cookie or the initial setup/gate check is still resolving.
- `/login` no longer flashes the Autoreview logo/card before bouncing away, in either direction:
  `apps/web/app/(auth)/layout.tsx` server-renders that shell unconditionally, so the earlier
  client-only fix above still painted it for a blink on both a cold signed-out hit and the
  post-gate-callback return. `apps/web/middleware.ts` now does both redirects server-side, before
  any HTML renders - behind the new `NEXT_PUBLIC_OIDC_ENABLED` build flag so an instance without a
  registered gate still shows the password break-glass form instead of 307ing into a 404. The
  client-side checks in `page.tsx` stay as a fallback.
- The server-side `/login` gate bounce above was still suppressed on a real cold hit: it was gated
  behind a setup check that did a server-side `fetch` to the browser-relative `NEXT_PUBLIC_API_URL`
  (`/api`), which is not a resolvable base inside the web container, so the fetch threw and the
  bounce fell through to the Autoreview shell. The `/login` bounce no longer makes any server-side
  call - for a gate-registered instance the gate is the login, so first-time-setup is not a concern
  on this route (genuine needs-setup is still handled for protected routes and by `/setup`). This
  removes the last flash on both the cold hit and the post-Google return.
- Central-gate (OIDC) sign-in: the callback now verifies the id_token's `at_hash` claim (passing
  the access token through to `jose`'s decoder, as the gate's tokens always carry one), fixing the
  `gate_sign_in_failed` error every gate sign-in hit in production. A rejected token's real cause
  is now logged, not just "rejected a token".

### Changed
- "Sign in with Aditor" (the central gate) is once again the only visible sign-in method on
  AutoReview's `/login`, styled in the gate's blue; the native "Continue with Google" button is
  removed from the page (Google still works at auth.aditor.ai itself). Password sign-in remains
  wired up server-side and is reachable only as a break-glass, behind the off-by-default
  `NEXT_PUBLIC_LEGACY_LOGIN_ENABLED` build flag, or automatically on a self-hosted instance that
  has not configured a gate.
- Shared AutoReview links now explicitly provide the blue-check image for link previews.
- AutoReview now uses a crisp blue, two-piece Aditor-inspired check across its app logo, favicon and Apple touch icon.

### Added
- Central-gate (OIDC) sign-in for editors/team: `/auth/oidc/{login,callback,logout}` in the FastAPI API let a reviewer sign in through `auth.aditor.ai` and reach the existing FreeFrame session; "Sign in with Aditor" is the primary option on `/login`. The gate is additive and off by default (no `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`ADITOR_AUTH_FREEFRAME_CLIENT_SECRET` configured); password sign-in remains available as a break-glass fallback.

### Changed
- Simplify AutoReview setup copy and brand selection: a single brand is shown directly, multiple brands use the styled picker, and briefing inputs retain only essential guidance.
- AutoReview onboarding prioritizes pasted briefing links, tucks text behind a compact alternative, and suggests project names from briefing files and supported document links without overwriting manual edits.

### Added
- Staff workspace owners can explicitly confirm a brand from a verified Trello board. Future assignments retain this identity across workspace renames; existing briefs stay frozen and conflicting reuse requires a new request.
- AutoReview customer onboarding in Whop and standalone: optional brand guidelines with explicit rule approval, first briefing, editor upload link, and resumable setup. New customers enter setup automatically; existing work and editor links keep their current flow.

### Added
- Server-controlled project opt-in for bound AutoReview on new assignments, with frozen review selection and unchanged legacy defaults.

### Fixed
- Staff hand-ins verify the folder's assignment before uploading, including during optional checklist outages. Unknown or conflicting brand/briefing scope stops before any file transfer; existing reviews remain readable.
- New AutoReview analyses wait safely during timing-authority outages and resume automatically without spending analysis retries; completed reviews remain available.
- AutoReview timing tests permanently disqualify the exact video version from natural calibration, even after test mode is disabled or caches are stale.
- Review timing provenance now freezes at confirmed submission in PostgreSQL; later operator attestations and stale cache reads cannot promote historical unknown versions.
- Private AutoReview timing context identifies the exact upload request that supplied a version’s submission clock and omits ambiguous sources; guest responses retain no private order identity.
- Production API containers receive shutdown signals directly and have time to finish Gunicorn's graceful shutdown, avoiding forced termination during deployment. Database migrations still complete before the API starts.
- Deleted request folders disappear from the owner overview without hiding active deliveries. Public share links respect deleted targets and projects; restoring a folder preserves its original request and share links.
- The trial notice uses a calm blue style and can be dismissed per account/campaign in this browser. Feedback remains accessible and trial expiry still applies.
- Parts reviews reuse the assignment's saved briefing, brand context and rules, including after restarts. Retry preserves the original hand-in identity, and private original downloads retain their filename and video container.
- Explicit legacy editor-link migrations retain their assignment and revocation state when the redirect cache is lost; unavailable verification stops the redirect safely.
- Staff file requests with Trello briefings verify their canonical card before freezing review inputs; preparation retries preserve the original request and frozen context.
- Preserve saved AutoReview source labels in the editor request workspace alongside the existing timeline markers.
- Link-sharing dialogs focus on copying/sending the link; review checklists and logo editing no longer appear there. Logo editing remains in Brand rules.
- Parts and final-ad review views now show confirmed version-specific waiting state, preserve source upload elapsed time across reloads, and stop activity during status outages. Insufficient calibration history does not prevent review or invent a time estimate.
- Review waiting time survives reloads from the committed submission clock. Offline and failed reviews stop activity while retaining the source frame; time ranges distinguish analysis from total wait and calibrated remaining time.
- Whop sign-in returns a valid Hub hand-in link to the selected card instead of Home.
- Revalidate current paid membership before allowing expired campaign guest links; a previously saved upgrade no longer outlives cancellation.
- The review timeline now supports native touch dragging and keyboard seeking, with a larger hit area, visible thumb and spaced second labels.
- Mobile share reviews keep the video preview and transport visible above comments, including collection asset viewers. Comment toggles now expose accessible names and larger touch targets.


### Added
- Internal complete-ad hand-ins open the native editor review alongside the customer share link, reusing the existing folder and exact uploaded versions.
- A service-authenticated read exposes the saved review context only for the matching assignment, project, asset and media version, so review integrations can reuse frozen inputs without exposing private rule text to guests.
- Verified AutoReview requirement sources appear as small Basics, Brand and Briefing labels beside comments, including the private editor review. Trusted sources survive reload and CSV export; editing the text removes the source labels.
- Saved review plans for file requests and Trello hand-ins, with one frozen briefing/rule snapshot shared across versions and a private checklist in Handin. Share dialogs stay focused on copying/sending links. Optional Engine preparation can be unavailable while upload links remain usable.
- Hub current-card links prefill Handin and preserve the selected Trello card through sign-in.
- Telehealth October preview with server-attested campaign identity, one brand per preview owner, a fixed November 1 Eastern cutoff and a recoverable plan-selection screen. Existing paid AutoReview access remains separate.
- Durable product feedback with saved receipts, a staff queue and an optional daily Slack digest; draft edits and retries preserve their own submission identity.
- Plan recommendations based on distinct successfully reviewed preview ads, with Team highlighted from 20 ads.
- Review step progress, elapsed time and measured analysis-duration ranges for comparable videos. The introductory scan parks after one cycle, with subtle status motion and explicit longer-than-usual handling.
- Editor requests now support explicit asset revisions, version-specific media and feedback, and durable completion tied to the reviewed versions.
- Optional parts-based hand-in: upload hooks and bodies once, review each exact version, and assemble, check and deliver final ads in the background. Existing complete-ad uploads remain available.
- Private reusable originals in the workspace owner's account, separate from editor attribution.

### Fixed
- Keep invited editors in the real review state while their first version is queued or analysed, and retain upload access on review-service outages.
- File-request uploads complete successfully when the editor supplies their name and email at submission, instead of failing before processing starts.
- Parts uploads now complete when editors add their name and email after the transfer has started.
- Editor navigation and direct management routes now show submission work instead of owner tools; brand-rule APIs require workspace ownership.
- Dashboard root toolbars show the app name instead of duplicating the page heading; overview and brand rules use direct copy without decorative slogans.
- Customer Projects uses file requests and lists all accessible brand projects; customer folders no longer require or announce an internal Trello card. Staff hand-in behavior is unchanged.
- Production containers provide the non-root user home required by Gunicorn's control socket.
- Ready status now requires successful review of every current submitted version; outages, malformed evidence and failed revisions retain file access without claiming a pass.
- Retention cleanup removes request records before reclaiming their folders and assets, and preserves failed delivery evidence until normal retention applies.
- Editors can replace failed processing attempts; canceled uploads no longer hold a clean request open.
- Whop sign-in explains missing member entry, denied access and account conflicts with an appropriate recovery action.

### Added
- **`n8n_feedback_events` names the card of each event** - three columns are appended after the unchanged `freeframe-feedback.v1` contract: `folder_id`, `folder_name` and `trello_card_id` (the Trello short link from the folder description). A consumer that follows up on review comments could only match a new round to the commented asset by file name, so a round uploaded into another project with the same generic names (`Hook 1`, `Hook 2`, …) looked like nothing had been delivered. The card is the identity that survives a move between projects. `n8n_read` still reads only the two views.
- Optional Whop owner sign-in through Aditor Suite, with isolated customer accounts, continuing membership checks and a recoverable in-app entry screen. Disabled until configured; existing staff sign-in stays unchanged.
- Brand playbook with numbered rule rows and labeled review checks, must-follow filters, full-text reading sheets and a separate suggestion approval area. Failed imports retain their text; switching brands isolates unfinished actions.
- Project Kanban with automatic review-stage movement, subtle review/correction animations, a motion pause control, and horizontally scrollable phone columns.
- Brand logo upload for owners in Brand rules and newly created requests, with automatic WebP conversion and a saved preview.
- Editor accuracy ranking with reviewed/total video counts, small-sample labels, average versions and open must-fixes; unreviewed editors remain unranked.
- Owner overview with request search and status filters, editor first-try results, estimated time saved, and a clear sharing sheet. Blue glass surfaces add depth, with “Ready to go” emphasized on the right on desktop and first on mobile.
- Accessible paper-frame waiting animation with pause and reduced-motion support, plus mobile bottom navigation.
- **Hand in a video from one page (`/handin`)** - an editor used to upload to FreeFrame and then hand the same file to the craft reviewer separately. This route does both: paste a Trello card link, pick the file, and get back the share link to post with the review underneath it. The card supplies the project name and the brand, so neither is typed and neither can be misfiled by a typo, and the card's URL is written to the project description because that is how the brand is resolved downstream. The share link is created in code with `permission: comment` and `allow_download: true` - without commenting the review cannot be posted, and without downloads only the streaming copy exists and cannot be analysed, so neither is left for an editor to find in a dialog. Purely additive: the existing upload route is unchanged, and the page appears only on a build with `NEXT_PUBLIC_REVIEW_GATE_URL` set. **The share link appears the moment it exists, whatever the review says, and never below the findings** - no branch reads a score, a severity or a count to decide whether the editor gets their link. The tool advises; the editor delivers.

### Fixed
- Whop workspaces retain their authenticated session when the app proxy removes the Authorization header; the older `/o` entry opens the Whop sign-in flow.
- Production API containers create the non-root user's home directory so Gunicorn's control socket starts without permission errors.
- Customer accounts cannot list assets or folders of public staff projects without membership; delayed authenticated retries cannot replay an earlier owner’s action as a newly signed-in owner.
- Review statuses and editor statistics include every batch instead of silently truncating at 50 requests or 200 assets.
- Sharing uploaded deliveries now opens the backend view/download link instead of sending recipients to the editor upload page; ready cards expose Preview and Share actions.
- Request cards open their own delivery folder; local preview project folders and playable demo files no longer crash with “assets is not iterable”.
- Brand logo updates reject storage keys outside the current project; customer workspaces no longer require an internal team briefing link.
- **Signed-in staff can comment on share links again** - a share link asks an anonymous viewer for a name and email, but skips that when somebody is already signed in. It decided "signed in" from the presence of an access token in `localStorage`, not from whether that token was still valid. Access tokens lived 15 minutes and nothing on the share path refreshes them (the refresh-and-retry logic sits in `lib/api.ts`, which the share components don't use), so a staff member who signed in more than 15 minutes earlier was never asked who they were, and the request carried neither a usable session nor a guest identity. The share endpoints treat an unusable bearer as anonymous instead of answering 401, so this surfaced as a flat `400` on every attempt. Anything on a share link that asks "is somebody signed in" now reads the token's `exp`, and falls back to the guest prompt when the session has lapsed. Guests were never affected.
- **A failed share comment now says why** - the share path threw a hardcoded "Failed to post comment" and discarded the API's explanation, which is the reason the above took a log dig to identify. It now shows the server's `detail`.
- **The realtime event stream now renews its token instead of retrying a dead one** - `EventSource` cannot send an `Authorization` header, so the token rides in the query string, and `/events/{project_id}` answers an expired one with 403. Nothing in the reconnect loop renewed it, so a lapsed session turned into an open-ended 403 retry: production logs showed hours of reconnects all carrying a token that had expired that morning. Each attempt now renews first, and gives up after a few consecutive failures rather than reconnecting forever with nothing to authenticate.

### Changed
- Center external parts submissions with more side space, aligned contact and Submit, and a stronger title; show a short brief preview with access to the actual stored full text or source link.
- Parts hand-in now shows upload, part checks and final delivery as clearly labeled phases, with guidance for hooks and reusable bodies.
- Parts hand-in matches the existing AutoReview identity and folder upload design, with a branded customer request and consistent internal setup form.
- Parts upload targets use AdMixer's compact raised panels, upload symbols and heading count badges.
- Parts hand-in uses aligned upload targets, compact progress and centered optional-part controls. Guest contact saves on field blur and submission, without a separate save step.
- Optional parts follow assembly order in Hand-in: Hook, Bridge, Body, then CTA, for both add controls and expanded fields.
- External submissions follow system appearance, show the title above briefing, use compact contact and visual progress, and follow the configured request format without an editor switch; generated ads appear when available.
- Compact brand rules are grouped into alphabetically sorted Must follow and Guidance columns, with subtle definition access and one quiet quick-input focus indicator.
- Video cards default to 9:16 fit thumbnails; card grids adapt to the available panel width. Existing appearance preferences remain available.
- Autoreview app identity with a dedicated icon and subtle Aditor footer; brand quick rules regain the playbook artwork and use a brand-specific logo example. Existing custom branding is preserved.
- Quick rules use an inline text composer on the rules page; infrequent PDF import is a secondary action. Suggestions still require owner approval.
- Editor leaderboard uses compact expandable rows with initials and a first-place crown; the brand-guidelines reminder has a miniature playbook treatment.
- Finished deliveries appear first in the project board; the overview's ready shortcut shows only ready requests.
- Editor leaderboard now uses ordered rows with expandable details and a file-request invitation action; the brand-guidelines reminder is compact.
- Request briefings expose links and text alongside PDF, Markdown and text-file uploads, with a keyboard-accessible brand picker.
- Kanban decorative animations play once instead of looping; the motion control is compact.
- Overview now shows one average editor first-try pass rate, with a notification count and ranking markers for substantially higher or lower results when enough reviewed videos are available.
- File-request uploads send up to three parts concurrently with byte-based progress, ordered completion, and safe failure cleanup.
- Review progress no longer displays a full upload bar while the review is still running.

- **The n8n feedback and share-link database views are now migration-owned** - Alembic reproduces the existing automation contracts, appends immutable comment identifiers and cursor metadata, exposes non-public tombstones for supported comment deletions, sends notifications for supported creates, updates, and soft deletions, and conditionally grants the existing `n8n_read` role read access to the views only.
- **Aditor production now processes two video uploads concurrently** - the transcoding worker runs two Celery child processes on the upgraded 16-vCPU host, with a 12-vCPU and 8-GB container ceiling that preserves capacity for the other applications sharing the server.
- **Pinned `starlette` and `botocore` so self-hosted Docker builds are reproducible** — both were floating transitives, so rebuilding the same commit on a different day could silently install different versions with no diff and no PR. FastAPI declares `starlette>=0.46.0` with no upper bound, meaning builds were free to cross a Starlette major (the ASGI layer under the SSE endpoint and the middleware stack); `botocore` is where S3 request signing lives, and unreviewed moves there have broken S3 compatibility before. Both are pinned to the versions already resolving, so no installed version changes.
- **Share-create dialog now shows the copyable share link immediately after creation** — clicking "Create" used to close the dialog, leaving the reporter to go find the new link in a separate panel. It now stays open and switches to the existing "link created" screen with the full URL and a Copy button.
- **Access tokens now last 60 minutes and sessions 90 days** (were 15 minutes and 7 days) - two dials that are easy to confuse. The access token is the credential on the wire: it rides in `Authorization` headers and, for `EventSource`, in a query string the reverse proxy writes to its access log, and because `token_version` is only checked when refreshing, its lifetime is also the whole revocation window for a live session. The refresh token is the session: one endpoint, rotated on use, version-checked. Keeping people signed in for months is a question for the second number, so that is the one that moved furthest; the first moved only enough to cut refresh chatter.

## [1.7.5] - 2026-07-23

### Fixed
- **Version switch clears active comment annotation** — switching versions in the single-asset review view now clears the focused comment and active drawing overlay, preventing drawings from previous versions from lingering on top of the newly selected version. (#198 by @Vrindakr3300)
- **HLS renditions no longer upscale past the source resolution** — `force_original_aspect_ratio=decrease` preserved aspect ratio but not scale, so a 640×360 source was still producing padded, blurry 1080p/720p renditions. The quality ladder is now filtered against the actual source height (ffprobe'd before transcoding), falling back to the smallest requested rendition rather than an empty ladder if the source is smaller than everything requested. (#204 by @siddharthgoyal00)
- Server-side password length validation on change-password endpoint. (#179 by @An-Array)

### Changed
- Password changes now revoke all other sessions by incrementing token version; current session receives fresh tokens to stay logged in. (#179 by @An-Array)

### Contributors
Thanks to @An-Array, @Vrindakr3300, @siddharthgoyal00, and @solankimeet518 for contributing to this release! (@solankimeet518's #199 hardened the `matchMedia` test stub — no user-facing entry above, but very much appreciated.)

## [1.7.4] - 2026-07-23

### Fixed
- **A superadmin can no longer delete or deactivate their own account and get irrecoverably locked out** — `DELETE /users/{id}` gained the same self-protection `PATCH /admin/users/{id}/deactivate` already had. Removed two duplicate, unused endpoints (`/users/{id}/deactivate`, `/users/{id}/reactivate`) that had no such guard and no frontend caller — the admin dashboard already uses the correctly-guarded `/admin/users/{id}/...` versions.
- **`/auth/login` is now rate-limited** (10 attempts / 10 minutes per IP) — previously only the generic global write limiter (300/minute) backed password login.
- **`/auth/verify-magic-code` no longer reveals whether an email is registered or deactivated** — an unknown email, a deactivated account, and a wrong code now all return the same generic 401, matching how `/auth/login` already avoids this.
- **Internal-visibility comments no longer reach public share links** — a comment (or reply, at any thread depth) marked "internal" is team-only by design, but the guest share endpoints didn't filter on visibility at all.
- **`@mention`ing a user in a comment now requires that user to actually have access to the asset** — previously any mentioned user id (or parsed `@email`) got a real notification and email with the asset name and a comment preview, regardless of whether they could see the asset at all.
- **Replying to a comment now checks the parent comment belongs to the same asset** — `POST /assets/{id}/comments/{comment_id}/replies` looked up the parent by id alone, so a comment id from an unrelated asset (including one the caller has no access to) would be accepted, letting a caller both probe whether an arbitrary comment id exists and inject a reply into a thread on an asset they can't see.
- **`POST /assets/{id}/comments` now validates that `version_id` actually belongs to the asset** — previously accepted unchecked, which could create a comment whose `asset_id` and `version_id` referred to two different assets.

## [1.7.3] - 2026-07-23

### Fixed
- **Public share-link comments can no longer read or write outside the shared scope** — both `GET /share/{token}/comments` and `POST /share/{token}/comment` trusted a client-supplied `asset_id` for folder/project-scoped links (and, for the write endpoint, even for a single-asset link — a request body could name a different asset entirely) with no check that the asset was actually within the link's scope. A holder of any comment/approve-permission share link could read or post comments on assets never shared with them. Both endpoints now validate the resolved asset against the share link the same way every other public share endpoint already does.
- **Password-protected share links now actually gate comments** — the two comment endpoints were the only public share routes that skipped password/session verification, so a password-protected link's comments were fully readable and writable with just the token.

## [1.7.2] - 2026-07-23

### Fixed
- **`GET /users` and `GET /users/search` no longer expose pending invite tokens** — both endpoints reused the same response shape as the admin user list, which includes a pending invitee's live `invite_token`. Since either endpoint only required being logged in (not an admin), any authenticated user could look up a pending invitee and read their token, then complete the invite themselves via `/auth/accept-invite` before the real invitee did. The token is now only ever returned by the admin-gated `GET /admin/users` and `POST /users/invite` responses.
- **Removed the legacy `POST /auth/register` endpoint** — it created an immediately-active, loginable account for any email with no auth and no invite check, bypassing the invite-only model this platform is built around. It had no frontend caller; account creation now only happens via an admin invite (`/users/invite` → `/auth/accept-invite`), first-time setup (`/setup/create-superadmin`), or a sign-in code sent to an already-known email (`/auth/send-magic-code`).

## [1.7.1] - 2026-07-23

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
