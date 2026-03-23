# Share Asset & Folder Feature — Design Spec

## Goal

Implement Frame.io-style sharing for both assets and folders: share link management UI, folder-level sharing, activity tracking, per-link settings (permissions, security, appearance), and a public folder share viewer.

## Current State

### What Exists

**Backend:**

- `ShareLink` model: asset-level public share links with token, permission (view/comment/approve), password, expiry, allow_download
- `AssetShare` model: direct user/team sharing with permission levels
- Endpoints: create/list/validate/revoke share links, direct user/team sharing, guest comments/approvals
- `GuestUser` model for anonymous commenters
- Project branding and watermark settings

**Frontend:**

- Share dialog on asset detail page (link tab + direct tab)
- Public share viewer page (`/share/[token]`) with media playback, guest comments, branding
- Sidebar "Share Links" section exists but is a placeholder
- Full folder system: tree sidebar, folder cards, breadcrumbs, drag-drop, trash/restore

### What's Missing

1. Folder-level share links
2. Share links management view (table with all links)
3. Share link activity tracking (who viewed/commented/when)
4. Share link visibility toggle (enable/disable without deleting)
5. Share link title/description
6. Share link settings panel (permissions, security, appearance)
7. Folder share viewer (public page showing folder contents as grid)
8. Direct folder sharing to user/team

---

## Data Model Changes

### ShareLink Model — New Fields

```python
title: str                  # User-editable name (defaults to asset/folder name)
description: str | None     # Optional description for the share link
is_enabled: bool            # Visibility toggle (True=active, False=disabled). Default True.
folder_id: UUID | None      # FK to folders. NULL=asset share, SET=folder share.
show_versions: bool         # Allow viewer to see all versions. Default True.
show_watermark: bool        # Enable watermark on shared content. Default False.
appearance: dict            # JSON column with defaults:
                            # {
                            #   "layout": "grid",           # "grid" | "list"
                            #   "theme": "dark",            # "dark" | "light"
                            #   "accent_color": null,       # "#hex" or null (inherit project branding)
                            #   "open_in_viewer": true,     # bool
                            #   "sort_by": "created_at"     # "name" | "created_at" | "file_size"
                            # }
```

**Constraint changes:**

- `asset_id` becomes nullable (currently non-null — requires careful Alembic migration)
- CHECK constraint: exactly one of `asset_id` or `folder_id` must be non-null
- `folder_id` has FK to `folders.id`

**Downstream code updates required:**

- `validate_share_link` in `services/permissions.py` must check `is_enabled` (return 403 if False)
- `ShareLinkValidateResponse` in `schemas/share.py` must make `asset_id` Optional and add `folder_id: UUID | None`
- `revoke_share_link` in `routers/share.py` must resolve the project via folder when `asset_id` is null (currently calls `_get_asset(db, link.asset_id)` which will crash for folder shares)
- All callers of `validate_share_link` that access `link.asset_id` must handle the nullable case
- `ShareLinkAppearance` Pydantic schema must validate the appearance JSON (layout enum, theme enum, hex color format, etc.)

### AssetShare Model — New Field

```python
folder_id: UUID | None      # FK to folders. Enables direct folder sharing to user/team.
```

- `asset_id` becomes nullable (currently non-null — same migration pattern as ShareLink)
- CHECK constraint: exactly one of `asset_id` or `folder_id` must be set

### New Table: ShareLinkActivity

```python
ShareLinkActivity:
    id: UUID (PK)
    share_link_id: UUID (FK → ShareLink, indexed)
    action: enum(opened, viewed_asset, commented, approved, rejected, downloaded)
    actor_email: str
    actor_name: str | None
    asset_id: UUID | None       # Which asset was acted on (null for "opened")
    asset_name: str | None      # Denormalized for display
    created_at: datetime (indexed, default now)
```

- Append-only — no `deleted_at`, no soft delete
- Index on `(share_link_id, created_at DESC)` for activity feed queries

---

## Backend API

### Modified Endpoints

**`POST /assets/{asset_id}/share`**

- Request body adds: `title`, `description`, `show_versions`, `show_watermark`, `appearance`
- Response includes all new fields

**`GET /assets/{asset_id}/shares`**

- Response includes new fields + `view_count` (aggregated from activity) + `last_viewed_at`

**`GET /share/{token}`** (public, no auth)

- Extended response includes: `folder_id`, `title`, `description`, `is_enabled`, `show_versions`, `show_watermark`, `appearance`
- `asset_id` is now Optional in response (null for folder shares)
- If `is_enabled=False` → 403 "Link is disabled"
- If folder share → include folder info + paginated asset list with thumbnails, names, types

**`DELETE /share/{token}`** — updated to resolve project via folder when `asset_id` is null

### New Endpoints

**`PATCH /share/{token}`** — update share link settings

- Body: any combination of `title`, `description`, `permission`, `is_enabled`, `show_versions`, `show_watermark`, `appearance`, `password`, `expires_at`, `allow_download`
- Auth: link creator or project owner/editor
- Returns updated ShareLink

**`POST /folders/{folder_id}/share`** — create folder share link

- Body: `title`, `description`, `permission`, `expires_at`, `password`, `allow_download`, `show_versions`, `show_watermark`, `appearance`
- Sets `folder_id`, leaves `asset_id` null
- Auth: project member with editor+ role

**`GET /folders/{folder_id}/shares`** — list share links for a specific folder

- Returns all share links where `folder_id` matches
- Auth: project member

**`POST /folders/{folder_id}/share/user`** — direct share folder with user

- Body: `permission`, `user_id` or `email`
- Creates AssetShare with `folder_id` (asset_id null)
- Sends email notification via Celery

**`POST /folders/{folder_id}/share/team`** — direct share folder with team

- Body: `permission`, `team_id`
- Creates AssetShare with `folder_id`

**`DELETE /folders/{folder_id}/shares/{share_id}`** — revoke direct folder share

- Soft-deletes the AssetShare record
- Auth: share creator or project owner/editor

**`GET /projects/{project_id}/share-links`** — list all share links in project

- Returns: title, token, is_enabled, permission, type ("asset"|"folder"), target_name, view_count, last_viewed_at
- Query params: `?search=` (filter by title)
- Auth: project member

**`GET /share/{token}/assets`** — list assets in shared folder (public)

- Query params: `?folder_id=` (subfolder navigation), `?page=`, `?per_page=`
- Returns: paginated assets with id, name, asset_type, thumbnail_url, file_size, created_at
- Also returns subfolders at current level (id, name, item_count)
- Validates share link is enabled and not expired
- All descendants of the shared folder are accessible (recursive — subfolders of subfolders)

**`GET /share/{token}/activity`** — activity log for share link

- Returns: list of ShareLinkActivity events, newest first, paginated
- Auth: link creator or project owner

**`POST /share/{token}/activity`** — log activity event

- Body: `action`, `actor_email`, `actor_name`, `asset_id`, `asset_name`
- Rate-limited (max 1 event per action/actor/asset per minute)
- Security: activity logging is triggered server-side by existing endpoints (comment, approve, stream) rather than relying on a public POST. The only client-side logged event is `opened`, which is validated against the share token's existence and enabled state. This prevents spoofed activity data.

**`GET /share/{token}/stream/{asset_id}`** — stream asset from folder share

- Validates asset belongs to shared folder or any descendant subfolder
- Returns presigned S3 URL
- Logs `viewed_asset` activity server-side

**`GET /share/{token}/thumbnail/{asset_id}`** — thumbnail for asset in folder share

- Same validation as stream endpoint
- Returns presigned thumbnail URL

---

## Frontend — Share Links Management View

### Sidebar Changes

The "Share Links" section in the project page sidebar becomes functional:

- **"All Share Links (N)"** — clickable, switches main content to table view
- Below it: list of individual share links by title
  - Folder shares show folder icon
  - Asset shares show asset thumbnail
  - Clicking one switches main content to that link's detail/settings view

### Table View (main content area, inline like trash view)

Triggered when "All Share Links" is selected in sidebar.

**Search bar**: "Search for Shares" — filters by title

**Table columns:**

| Title | Link | Visibility | Access Type | Last Viewed | Views | Activity |
|-------|------|------------|-------------|-------------|-------|----------|

- **Title**: icon (folder/asset) + editable name
- **Link**: copyable URL chip
- **Visibility**: toggle switch (calls `PATCH /share/{token}` with `is_enabled`)
- **Access Type**: "Public" badge
- **Last Viewed**: relative time from activity data
- **Views**: count from activity (action=opened)
- **Activity**: "View Activity" button → opens activity panel

### Share Link Detail View

When a specific share link is clicked in sidebar:

**Main content area:**

- Editable title (large, top)
- "Add a description..." editable placeholder
- Content preview: grid of asset thumbnails (for folder shares) or single asset preview
- Asset count + total size

**Right settings panel** (similar to Frame.io screenshots):

**Settings / Activity tabs** at top

**Settings tab — collapsible sections:**

1. **Link Visibility**
   - Toggle (enabled/disabled)
   - URL display with copy button + "Public" dropdown badge
   - "Send to name or email" input → calls direct share endpoint

2. **Permissions**
   - Comments toggle
   - Downloads toggle
   - Show all versions toggle

3. **Security**
   - Passphrase toggle + password input (when enabled)
   - Expiration date picker
   - Watermark toggle

4. **Appearance**
   - Layout selector: Grid | List
   - Theme selector: Dark | Light
   - Accent Color: hex input with color picker
   - Open in viewer toggle

5. **Sort by**
   - Dropdown: Name, Date created, Size
   - Persisted in `appearance.sort_by` field

**Bottom buttons:**

- "Open Share Link" — opens `/share/[token]` in new tab
- "Copy Link" — copies URL to clipboard

**Activity tab:**

- Chronological list of events grouped by date
- Each event: avatar/initials + actor name + asset name + action label + timestamp
- Actions styled: "Viewed Asset", "Commented", "Opened Share Link", "Approved", "Downloaded"

---

## Frontend — Folder Share Viewer (Public Page)

The existing `/share/[token]` page gets a second mode for folder shares.

### Detection

On mount, `GET /share/{token}` returns either `asset_id` (asset mode) or `folder_id` (folder mode). The page renders accordingly.

### Folder Mode Layout

**Header:**

- Share link title
- Description (if set)
- Folder name, asset count + total size
- Project branding (logo, if set)

**Content area:**

- **Subfolder cards** at top (if any subfolders exist)
- **Asset grid/list** below (based on appearance.layout setting)
- Each asset card: thumbnail, name, type icon, file size
- Click behavior controlled by `appearance.open_in_viewer`:
  - ON: navigates to single-asset viewer within the share context
  - OFF: no click-through, grid-only view

**Navigation:**

- Breadcrumb within shared folder hierarchy
- Back navigation for subfolders
- Search within folder contents

**Theming:**

- Dark/light theme from `appearance.theme`
- Accent color from `appearance.accent_color` (fallback to project branding)

**Guest interactions** (based on share link permission):

- `view`: browse only
- `comment`: browse + comment on individual assets (via viewer)
- `approve`: browse + comment + approve/reject

### Asset Mode (Existing — Minor Changes)

- Unchanged core behavior (video/audio/image player, comments, approvals)
- Add `show_versions` check: if false, hide version switcher
- Add `show_watermark` check: if true, apply watermark overlay
- When accessed from folder share context, show "Back to folder" navigation

### Activity Logging (Both Modes)

Activity is logged server-side by the respective endpoints:

- `GET /share/{token}` validation → logs `opened` event (server-side, once per session)
- `GET /share/{token}/stream/{asset_id}` → logs `viewed_asset` (server-side)
- `POST /share/{token}/comment` → logs `commented` (server-side)
- `POST /share/{token}/approve` / `reject` → logs `approved` / `rejected` (server-side)
- Download presign request → logs `downloaded` (server-side)

Guest identity (email + name) stored in localStorage for session continuity.

---

## Out of Scope

- Transcripts/captions permission toggles
- Fields/filter section in share settings
- Card size, aspect ratio, thumbnail scale in appearance
- Reel layout mode
- Per-link branding override (inherits project branding)
- Secure/private access type (enterprise feature in Frame.io)
- Activity table retention/cleanup (acceptable for v1, revisit if growth becomes a concern)
- Frontend `password_hash` cleanup on ShareLink type (pre-existing issue, not introduced here)

---

## File Impact Summary

### Backend (apps/api/)

- **Modify**: `models/share.py` — extend ShareLink (new fields, nullable asset_id), extend AssetShare (folder_id, nullable asset_id), add ShareLinkActivity model
- **Modify**: `schemas/share.py` — new fields on existing schemas, new ShareLinkAppearance validator, new request/response schemas for activity and folder shares
- **Modify**: `routers/share.py` — new endpoints, extend existing, fix project resolution for folder shares
- **Modify**: `services/permissions.py` — update `validate_share_link` to check `is_enabled`
- **New migration**: alter share_links (add columns, make asset_id nullable), alter asset_shares (add folder_id, make asset_id nullable), create share_link_activity table, add CHECK constraints

### Frontend (apps/web/)

- **Modify**: `app/share/[token]/page.tsx` — add folder mode, server-side activity logging integration
- **Modify**: `app/(dashboard)/projects/[id]/page.tsx` — add share links view, share link detail view
- **Modify**: `types/index.ts` — new types for activity, extended ShareLink, ShareLinkAppearance
- **New**: `components/projects/share-links-table.tsx` — table view component
- **New**: `components/projects/share-link-detail.tsx` — detail/settings view with right panel
- **New**: `components/projects/share-link-activity.tsx` — activity panel component
- **New**: `components/share/folder-share-viewer.tsx` — folder grid viewer for public page
- **New**: `hooks/use-share-links.ts` — SWR hooks for share link CRUD + activity
