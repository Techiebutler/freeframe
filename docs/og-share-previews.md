# Per-share Open Graph / Twitter preview cards

Implementation of per-share rich link previews (feature: pasting a share link
into Telegram/WhatsApp/Slack unfurls a card of its own). Ships in
**`apps/api` + `apps/web`**, per the upstream maintainer's specification for
the eventual PR: the preview data and the preview image live behind two new
unauthenticated API endpoints with their own strict gate; the web app only
turns a clean preview answer into Next metadata.

## What was added

| File | Role |
| --- | --- |
| `apps/api/routers/share.py` | Preview gate (`_validate_share_link_for_preview`), thumbnail resolver, `GET /share/{token}/preview` + `GET /share/{token}/preview.jpg`, static fallback loader |
| `apps/api/schemas/share.py` | `SharePreviewResponse` — `title`, `description`, `has_image` ONLY (no requires_password/requires_auth markers, no S3 keys) |
| `apps/api/models/instance_settings.py`, `apps/api/schemas/instance_settings.py`, `apps/api/routers/instance_settings.py` | `share_previews_enabled` instance-level thumbnail switch (default on; `None` row = on) read/written via the existing instance-settings endpoints |
| `apps/api/alembic/versions/c9d3e7b2a6f4_add_share_previews_enabled.py` | One migration: adds the boolean column (`nullable=False`, `server_default true`) |
| `apps/api/static/logo-full.png` | Static branded fallback image for gated / thumbnail-less answers (copy of the web `logo-full.png`; change one → change both) |
| `apps/api/tests/test_share_preview_endpoints.py` | Gate matrix + behavior contract (mocked DB and storage) |
| `apps/api/tests/test_instance_settings.py` | Toggle endpoint coverage |
| `apps/web/lib/share-metadata.ts` | Server-side preview fetch (fail-closed), payload parser, origin resolver, `og:image` URL builder, metadata builder |
| `apps/web/app/share/[token]/layout.tsx` | Server metadata boundary: `generateMetadata` runs while server-rendering a share URL; renders nothing itself, interactive page untouched |
| `apps/web/lib/__tests__/share-metadata.test.ts` | Fail-closed matrix, URL-building (absolute, `/api`-prefixed, base-path) and leak-scan tests |
| `apps/web/app/share/[token]/__tests__/layout.test.ts` | End-to-end `generateMetadata` tests (mocked API/branding/headers) |

Dropped relative to the earlier web-only draft: the web `og-image` proxy route
and `public/og-default.png` — the upstream spec gives image serving to the API
so crawlers get one stable, gated URL; `logo-full.png` is the single fallback.

## Why the preview has its own gate

The existing `GET /share/{token}` **cannot** be reused for crawler data: to
render its own password/sign-in prompts it answers **200 with the private
title** for password-protected and login-required (`secure`) links. A preview
must never leak that, so `_validate_share_link_for_preview` re-implements the
share validation strictly server-side.

## API endpoints

### `GET /share/{token}/preview` — card data

Unauthenticated. Answers with `SharePreviewResponse` — nothing but `title`,
`description`, `has_image`. `title` falls back to the folder/project/asset
name; `description` is the share link's description; `has_image` reports
whether a thumbnail key exists and thumbnails are enabled (storage errors can still fall back).

Contract:

- **Gate enforced server-side** (below). *Every* refusing case answers with a
  uniform `404` whose body differs in **no** way — not even the title — so a
  crawler cannot distinguish password-protected from disabled from deleted
  from unknown.
- **Never logs a share "open"**: nothing here touches `ShareLinkActivity`;
  bot unfurls do not pollute view counts.
- **Not subject to the per-IP `share_validate` limiter** (30/60 s): the web
  container resolves metadata server-side from one IP, so a shared bucket
  would 429 the tenant's own link previews. Both preview endpoints sit in
  their own generous bucket — `rate_limit("share_preview", 240, 60)`.

### The gate — one verdict for every refusing case

Rich data is published **ONLY** when all of these hold:

1. token exists and is not soft-deleted,
2. link is enabled,
3. not expired (`expires_at` in the future),
4. not login-required (`visibility != "secure"`),
5. not password-protected (`password_hash` is null),
6. the shared target (asset / folder / project) still exists.

The thumbnail toggle affects images only, not otherwise-public card text.

| Share state | `GET /share/{token}` | Preview endpoints |
| --- | --- | --- |
| Enabled public asset share, valid, toggle on | 200, full payload | 200 JSON / thumbnail bytes |
| Public share without thumbnail | 200 | 200 JSON (`has_image: false`) / `logo-full.png` |
| Password-protected | 200 + `requires_password: true` (**private title!**) | uniform 404 / `logo-full.png` |
| Login-required (`visibility: secure`) | 200 + `requires_auth: true` (**private title!**) | uniform 404 / `logo-full.png` |
| Disabled (revoked) | 403 | uniform 404 / `logo-full.png` |
| Expired | 410 | uniform 404 / `logo-full.png` |
| Missing / soft-deleted token, or shared target deleted | 404 | uniform 404 / `logo-full.png` |
| `share_previews_enabled` off (row absent = on) | unaffected | public text retained, `has_image: false` / `logo-full.png` |
| Storage hiccup while reading the thumbnail | — | `logo-full.png` (never a 500 a crawler would cache) |
| Missing static asset (broken deployment) | — | bare 404, still no 5xx |

The image endpoint answers **200 + `logo-full.png`** for gated states too —
a crawler never learns link state from the presence or absence of an image;
only the bytes change. (Every gated response is byte-identical across cases,
which the tests assert.)

### `GET /share/{token}/preview.jpg` — the card image

Unauthenticated. Streams the shared target's thumbnail **bytes** straight
from S3 — so the 1-hour presigned `thumbnail_url` never reaches a crawler and
the image does not die when the presign does:

- asset share: latest ready version's `s3_key_thumbnail` (the same rule the
  share page's player follows);
- folder share: newest-first walk of the folder's own assets, then subfolders
  in name order — what a visitor sees first;
- project share: explicitly selected items in share-page order (assets first,
  then selected folders), otherwise project-root assets newest-first then
  root subfolders;
- response headers: `Cache-Control: public, max-age=10800` (3 hours — chosen
  so a crawler-cached image outlives the 1-hour presign TTL, bounded by the
  trade-off that a replaced/revoked state can appear up to 3 h stale on a
  cached unfurl; the HTML card text turns generic immediately);
- content type: the key's `image/*` type (forced to `image/png` otherwise).

## Thumbnail toggle

`share_previews_enabled` on `instance_settings` is the thumbnail switch
("a frame shown in a group chat reaches more people than the link itself"):

- default **on** (`server_default true`), also on when the settings row does
  not exist yet — upgrading instances start unfurling rich previews and one
  settings update suppresses frames;
- with it off, public `/preview` responses retain title/description but report
  `has_image: false`; `/preview.jpg` serves the fallback logo. Restricted
  shares still receive the same uniform 404/generic card as before;
- exposed through the existing `GET/PUT /instance/settings` endpoints
  (`share_previews_enabled` field, optional on PUT so older clients remain
  valid). No dedicated admin-UI element in this change.

## Web behavior (`apps/web`)

`app/share/[token]/page.tsx` stays a client component, untouched (avoids
conflict with the short-URL work in upstream #283 — short links redirect
server-side to `/share/<token>` and pick up this metadata automatically).

`app/share/[token]/layout.tsx` adds `generateMetadata`, which resolves
instance branding and the share metadata in parallel. The library
(`lib/share-metadata.ts`):

- **fetch**: `GET /share/{token}/preview` over `API_INTERNAL_URL`
  (server-to-server), `Accept: application/json`, `cache: 'no-store'`,
  3 s timeout, never throws. The token is URL-encoded.
- **fail closed**: generic card for a non-200 of any kind (uniform gated
  404s, 429s, 5xx), network/timeout errors, non-JSON or malformed payloads,
  and any 200 whose title is missing or empty. The parser only reads
  `title`/`description`; nothing is inherited from the root layout —
  metadata sets `title`, `description`, `openGraph`, `twitter`, `robots`
  explicitly, so a private value cannot sneak in through inheritance.
- **origin**: `NEXT_PUBLIC_APP_URL` (if pinned, host-only) else
  `X-Forwarded-Host`/`Host` (+ forwarded proto, defaulting to `https` when
  no proto header exists), validated against a strict host-shape check;
  `http://localhost:3000` last resort. This becomes `metadataBase` and the
  base of every absolute URL.
- **`og:image`**: always the API's `GET /share/{token}/preview.jpg`,
  absolute: built from `NEXT_PUBLIC_API_URL` (absolute URL in dev — used as
  is; path `/api` in production — resolved against the origin), passed
  through `withBasePath()` so a `NEXT_PUBLIC_BASE_PATH` deployment emits
  base-path-aware absolute URLs.
- **`og:url`**: absolute base-path-aware page URL; **`twitter:card`**:
  `summary_large_image` on both branches; **`robots`**: `noindex, nofollow`
  (preview fetchers read og:/twitter: tags regardless; this only keeps
  capability URLs out of search indexes).
- The generic branded card still shows a real image (the API's gated
  `logo-full.png`) — protected links unfurl as something deliberate, not a
  blank box.

## Cache behavior

| Surface | Policy | Reason |
| --- | --- | --- |
| Share page HTML | Dynamic; metadata re-resolved per request | no caching layer between layout and request |
| Metadata fetch | `cache: 'no-store'`, 3 s timeout | a share that gets password-protected, disabled or deleted stops producing rich metadata immediately |
| `preview.jpg` | `public, max-age=10800` | stable crawlable URL outliving the 1 h presign; worst case a revoked share's thumbnail stays crawlable ≤3 h |

Residual, unavoidable staleness lives on the crawler side: platforms cache
unfurls independently of HTTP headers. Telegram caches until refreshed (the
known mechanism is forwarding the link to `@WebpageBot`); WhatsApp/Slack have
their own windows. That is outside this codebase's control.

## Absolute URLs / origin resolution

`metadataBase` and every emitted URL are absolute. The origin is resolved in
this order:

1. `NEXT_PUBLIC_APP_URL` (optional — pin it if a proxy mangles forwarded
   headers);
2. `X-Forwarded-Host` + `X-Forwarded-Proto` (leftmost value of stacked lists),
   validated against a strict host shape;
3. `Host` header, assuming `https` when no proto header exists (every
   crawler-facing deployment terminates TLS at a proxy);
4. `http://localhost:3000` last resort (non-crawler setups).

All paths go through `withBasePath()`, so base-path deployments
(`NEXT_PUBLIC_BASE_PATH`) emit correct absolute URLs. The production compose
already sets `API_INTERNAL_URL=http://api:8000`; no new required env vars.

## Tests

API (`apps/api/tests/test_share_preview_endpoints.py`, mocked DB):

- endpoints registered under the preview (not share_validate) rate bucket
  (`share_preview`, 240/60), for JSON and image paths alike;
- gate matrix: password / secure / disabled / expired / unknown + deleted /
  deleted target → one uniform 404; public share → title + description +
  `has_image`;
- title falls back to folder/project/asset names; missing toggle row = on;
- toggle off suppresses images while retaining otherwise-public text;
- **no share "open" is ever logged** by either endpoint;
- image endpoint: thumbnail streamed from storage (content-type handling),
  fallback logo for every gated/no-thumbnail case and on storage errors,
  byte-identical gated responses, `Cache-Control: max-age=10800` on every
  answer, the presigned URL never leaks into any response;
- thumbnail resolver order for asset / folder / multi-item / project-root
  shares, including the empty-folder subfolder walk.

Web (`share-metadata.test.ts`, `layout.test.ts`): fail-closed matrix
(including a JSON leak-scan over every restricted state), absolute /api- and
base-path-aware image and page URLs, generic card on API errors/timeouts, no
`og-default` reference, unauthenticated uncached fetch shape.

Quality gates run on STUDIOCRAFTERZ, never the Hermes VM. On Linux Docker
(Python 3.12, PostgreSQL 15 with all migrations): the full API suite reports
**1108 passed, 3 skipped**, exit 0. The three upstream skips are intentional
fixture exclusions (two deliberately truncated samples and one audio-only
sample); none of the preview tests are skipped. Windows Node 20.20.2 /
pnpm 10.15.0 reports **92 files / 780 tests passed**, with typecheck and lint
exit 0. The Linux Docker rerun also reports **92 files / 780 tests passed**
with two workers, and the standalone production build exits **0** with
`NEXT_PUBLIC_API_URL=/api`. Resource settings are process/container-local:
CPU affinity 0–3, `CIRCLE_NODE_TOTAL=2`, `NODE_OPTIONS=--max-old-space-size=1536`.
An earlier unbounded run lost a worker, and the first Linux build worker
segfaulted; the bounded reruns pass without application/config changes.
Native Windows cannot produce Next's standalone symlinks without extra
privileges, so the production-build gate uses Linux Docker on that same
workstation, not a modified Next configuration.

## Deployment prerequisites

1. One migration adds `instance_settings.share_previews_enabled`
   (runs on API container start or `alembic upgrade head`).
2. Rebuild **both** images from this tree: the API image must ship
   `apps/api/static/logo-full.png`, the web image the share-metadata layout.
   Standard compose build; no S3/Garage or compose changes.
3. `NEXT_PUBLIC_API_URL` stays `/api` in production (Traefik strips the
   prefix); `API_INTERNAL_URL` stays the compose-internal API address.
4. Optional: pin `NEXT_PUBLIC_APP_URL=https://review.foundersmind.ai` in the
   web service env when forwarded headers are untrusted.
5. After deploy: curl a public share URL (og:/twitter: tags present without
   JavaScript) and a protected share (generic card only); refresh crawlers'
   caches via `@WebpageBot` where needed.
