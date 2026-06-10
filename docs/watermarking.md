# Watermarking

FreeFrame can stamp viewer-identifying watermarks over video and image
playback, and burn them into downloaded files. This page covers day-to-day
usage for producers and coordinators first, then the full API.

---

## How it works (30 seconds)

- **Playback** — the watermark is drawn as a live overlay in the player. It
  shows session details (viewer email, IP, date, …) and costs nothing: no
  re-encoding, no waiting.
- **Downloads** — when a watermark applies, the file is re-rendered with the
  watermark burned in by FFmpeg. The first download of a file shows
  "Preparing…" for a moment; after that the watermarked copy is cached and
  downloads are instant.
- **Exemptions** — project roles you trust (owners and editors by default)
  never see internal watermarks and always download clean originals.

A watermark is defined by a **template**: one or more text blocks, each with a
field (viewer email, viewer name, IP address, date, share name, or custom
text), a position, size, color, opacity, rotation, and optional shadow,
scrolling, and tiling.

### Which settings win

Settings resolve in priority order — the most specific wins:

```
Share link override  >  Project policy  >  Instance defaults
```

---

## For producers & coordinators

### Turn watermarking on for a project

1. Open the project → **Settings** → **Watermark** tab.
2. Flip the policies you need:
   - **Require on shares** — every share link from this project gets a
     watermark. The toggle in share dialogs is locked on.
   - **Apply to team playback & downloads** — members see watermarks inside
     the app too (except exempt roles).
3. Pick which roles are **exempt** (default: owner and editor).
4. Pick a **default template**. Three ready-made templates ship out of the
   box, so you never have to design one:
   - *Viewer email — centered*
   - *Viewer name — tiled*
   - *Confidential — corner*

### Design your own template

In the same tab, **Template manager → New template**:

- Add blocks and choose what each one shows (viewer email, name, IP, date,
  share name, or custom text such as "CONFIDENTIAL").
- Drag blocks in the live preview to position them.
- Adjust size, opacity, rotation, and color; toggle shadow, tiled (repeats
  across the frame), or scroll (drifts across video).

Project templates are visible only inside the project. Instance-wide
templates (managed by a superadmin) are available everywhere.

### Watermark a single share link

In the share dialog, flip **Watermark** on and optionally pick a template. If
the project policy requires watermarks on shares, the toggle is already on
and locked. Anonymous viewers can't be identified by email, so name/email
blocks fall back to the share's title and the creator's email.

### Downloads

When a watermarked viewer downloads a file, the API prepares a burned-in copy
(`202 Accepted` while rendering, then the file). The UI handles this
automatically with a "Preparing watermarked download…" state. Copies are
cached per file + template + viewer, so repeat downloads are instant.
Watermarked share downloads are recorded in the share's activity log.

---

## For administrators

Superadmins manage **instance-wide defaults** that apply to projects without
their own policy, plus shared templates:

- `GET/PUT /settings/watermark` — instance policy
- `GET/POST /watermark-templates` — instance template library

Projects inherit the instance policy when they have no policy of their own;
the first edit of a project's Watermark tab snapshots the instance defaults.

---

## API reference

Everything below is also in the OpenAPI spec (`/docs` on your API host).

### Templates

A template's `blocks` is a list of:

| Field | Type | Notes |
|---|---|---|
| `field` | string | `custom_text`, `name`, `email`, `ip`, `date`, `share_name` |
| `custom_text` | string\|null | required when `field` is `custom_text` |
| `x`, `y` | number | center position, percent of frame (0–100) |
| `size` | number | text height, percent of frame height |
| `color` | string | hex, e.g. `#FFFFFF` |
| `opacity` | number | 0–1 |
| `rotation` | number | degrees, -180–180 |
| `shadow` | bool | drop shadow for readability |
| `scroll` | bool | drift horizontally across video |
| `tiled` | bool | repeat in a grid across the frame |

```bash
# List templates available to a project (project + instance scoped)
curl -H "Authorization: Bearer $TOKEN" \
  "$API/projects/$PROJECT_ID/watermark-templates"

# Create a project template
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$API/projects/$PROJECT_ID/watermark-templates" -d '{
    "name": "Client screener",
    "blocks": [
      {"field": "email", "x": 50, "y": 50, "size": 4,
       "color": "#FFFFFF", "opacity": 0.3, "rotation": -30,
       "shadow": true, "scroll": false, "tiled": true},
      {"field": "custom_text", "custom_text": "DO NOT DISTRIBUTE",
       "x": 50, "y": 90, "size": 3, "color": "#FF4444", "opacity": 0.5,
       "rotation": 0, "shadow": true, "scroll": false, "tiled": false}
    ]
  }'

# Update / delete
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$API/watermark-templates/$TEMPLATE_ID" -d '{"name": "Renamed"}'
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$API/watermark-templates/$TEMPLATE_ID"
```

Instance-level template CRUD (`/watermark-templates`) requires superadmin;
project templates require the editor role.

### Project policy

```bash
# Read / update a project's watermark policy
curl -H "Authorization: Bearer $TOKEN" "$API/projects/$PROJECT_ID/watermark"

curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$API/projects/$PROJECT_ID/watermark" -d '{
    "require_shares": true,
    "require_internal": false,
    "template_id": "'$TEMPLATE_ID'",
    "exempt_roles": ["owner", "editor"]
  }'
```

### Share links

```bash
# Create a share with a watermark and a specific template
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$API/assets/$ASSET_ID/share" -d '{
    "show_watermark": true,
    "watermark_template_id": "'$TEMPLATE_ID'"
  }'
```

Share responses include `watermark_required` — when `true`, the project or
instance policy forces the watermark and `show_watermark` cannot be turned
off (the API rejects the update with `400`).

### Streaming & downloads

Stream endpoints return the resolved watermark alongside the URL. The client
renders exactly what the server resolved — it never decides watermark content:

```bash
curl -H "Authorization: Bearer $TOKEN" "$API/assets/$ASSET_ID/stream"
# {
#   "url": "/stream/hls/master.m3u8?token=…",
#   "asset_type": "video",
#   "watermark": {
#     "enabled": true,
#     "blocks": [ {"text": "viewer@example.com", "x": 50, "y": 50, …} ]
#   }
# }
```

Watermarked downloads (`?download=true`) return `202 {"status": "preparing",
"retry_after": 3}` while the burn-in renders. Poll until you receive `200`
with the final URL. The same contract applies to the public share endpoint
`GET /share/{token}/stream/{asset_id}?download=true`.

---

## Notes & limits

- Burn-in applies to **video and still images**. Audio files and other types
  download as originals (the playback overlay still applies to images/video
  only).
- Burned-in video downloads are re-encoded to H.264/AAC MP4.
- The viewer IP shown in watermarks comes from the `X-Real-Ip` header set by
  the reverse proxy.
- Watermarked copies are cached in S3 under `watermarked/{asset}/{version}/
  {signature}.{ext}`; the signature covers the rendered text and styling, so
  date-based watermarks roll over daily.

## Future work: forensic watermarking

Visible watermarks deter leaks; forensic (invisible) watermarks survive
cropping and re-encoding and can identify a leaker from a pirated copy. This
is deferred for now. The recommended open-source path is
[Meta VideoSeal](https://github.com/facebookresearch/videoseal), which embeds
imperceptible, recoverable payloads in video. A future phase could embed a
per-viewer payload during the existing burn-in render step.
