# AGENTS.md

Operational guide for coding agents and contributors working in the **FreeFrame** repo.
FreeFrame is a self-hostable, open-source alternative to Frame.io — collaborative media
review, annotation, and approval for images, audio, and video.

This file focuses on **how to make a change that passes CI and review here**. For depth:

- **Architecture:** [`docs/architecture.md`](docs/architecture.md)
- **Human setup & standards:** [`docs/contributing.md`](docs/contributing.md)
- **Deployment:** [`docs/deployment.md`](docs/deployment.md)
- **Live API surface:** http://localhost:8000/docs (Swagger) once the stack is up

---

## Quickstart

```bash
git clone https://github.com/YOUR_USERNAME/freeframe.git
cd freeframe
cp .env.example .env
docker compose -f docker-compose.dev.yml up --build
# open http://localhost:3000
```

Ten services start in Docker: postgres, redis, minio, minio-init, api, worker, email_worker,
maintenance_worker, beat, web.

> **Hot reload covers `api` and `web` only.** The four Celery containers have no autoreload, so
> a change under `apps/api/tasks/` (or to anything a task imports) does nothing until you restart
> them:
> ```bash
> docker compose -f docker-compose.dev.yml restart worker email_worker maintenance_worker beat
> ```

> **The dev stack really deletes local data on a schedule.** `maintenance_worker` and `beat` run
> the stale-upload reaper hourly and hard-delete soft-deleted rows at 03:00 UTC, reclaiming S3
> objects. Set `STALE_UPLOAD_TIMEOUT_HOURS=0` and `SOFT_DELETE_RETENTION_DAYS=0` in `.env` to
> switch both off while you work.

### Dev endpoints

| What                | URL / address                | Notes                                   |
|---------------------|------------------------------|-----------------------------------------|
| Frontend (Next.js)  | http://localhost:3000        | hot reload                              |
| API (FastAPI)       | http://localhost:8000        |                                         |
| API docs (Swagger)  | http://localhost:8000/docs   | the fastest way to find an endpoint     |
| MinIO console       | http://localhost:9001        | S3 API is on :9000                      |
| Postgres            | `localhost:5433` (dev only)  | host mapping `5433:5432`; in-container and prod it's `5432` |
| Redis               | `localhost:6379`             |                                         |

---

## Repo layout

```
freeframe/
├── apps/
│   ├── api/                # FastAPI backend
│   │   ├── main.py         # app entry point
│   │   ├── config.py       # env-driven settings
│   │   ├── models/         # SQLAlchemy ORM models
│   │   ├── schemas/        # Pydantic request/response schemas
│   │   ├── routers/        # API route handlers
│   │   ├── services/       # business logic (auth, s3, permissions, …)
│   │   ├── tasks/          # Celery tasks (transcode, email, watermark, reminders,
│   │   │                   #   cleanup — the only code that hard-deletes)
│   │   ├── middleware/     # auth deps, share-link auth, rate limiting, setup guard
│   │   ├── alembic/        # database migrations
│   │   └── tests/          # pytest suite (mock-DB based — see Gotchas)
│   └── web/                # Next.js 14 App Router frontend
│       ├── app/            # routes/pages
│       ├── components/     # React components
│       ├── hooks/          # React hooks
│       ├── lib/            # API client + utilities
│       └── stores/         # Zustand stores
└── packages/
    └── transcoder/         # pluggable transcoder package (FFmpeg default)
```

---

## Run the checks CI runs

A PR is mergeable when these are green. **Run them before you say you're done.** CI
(`.github/workflows/ci.yml`) runs the same commands.

**Backend** (from repo root, or inside the `api` container):

```bash
# local (what CI runs)
python -m pytest apps/api/tests/ -v

# or inside the running dev container
docker compose -f docker-compose.dev.yml exec api python -m pytest apps/api/tests/ -v
```

**Frontend** (workspace filter `web`, run from repo root):

```bash
pnpm --filter web build       # must succeed (CI gate)
pnpm --filter web test
pnpm --filter web exec tsc --noEmit   # type check
pnpm --filter web lint
```

> CI ignores changes limited to `*.md`, `docs/**`, `LICENSE`, and the issue/PR templates,
> so a docs-only PR (like editing this file) will not trigger the test/build jobs.

---

## ⚠️ Gotchas that trip up agents

Read this section before writing backend code or tests.

- **Backend tests run against a fully *mocked* database.** `apps/api/tests/conftest.py`
  provides a `MagicMock` `Session` (the models use Postgres-specific UUID types that are
  incompatible with SQLite), so there is **no real DB in tests**. Don't write tests that
  expect real persistence. Instead patch the query/service layer and drive behavior through
  the `client` + `mock_db` fixtures. See `apps/api/tests/test_share_session.py` for the
  pattern (patch `validate_share_link`, exercise the real logic on top). Use the `real_db`
  fixture only for code paths explicitly designed for a live transactional Postgres.

- **CI has floor guards — never delete or gut tests/core files.** The pipeline fails if:
  fewer than 5 test files exist, fewer than 40 tests pass, the FastAPI app exposes fewer
  than 30 routes, or any file on its critical-files allowlist (e.g. `apps/api/main.py`,
  `routers/share.py`, `services/permissions.py`, key `apps/web` files) goes missing. If a
  test is genuinely obsolete, replace it — don't remove coverage.

- **Soft delete is common but not universal, and it is not automatic.** 13 of the 29 models
  carry a `deleted_at` column; 16 do not, including `MediaFile`, `Annotation`,
  `CommentAttachment`, `CommentReaction`, `Notification` and `ActivityLog`. Check the model
  before assuming. Where the column exists, prefer setting it over deleting the row, and
  filter `deleted_at.is_(None)` **by hand in every query** — nothing filters it for you
  (`middleware/soft_delete.py` exports a helper with zero call sites). Soft deletion is not
  permanent either: `tasks/cleanup_tasks.py` hard-deletes soft-deleted rows and reclaims their
  S3 objects after `SOFT_DELETE_RETENTION_DAYS` (default 30).

- **Model change ⇒ Alembic migration.** After editing a SQLAlchemy model:
  ```bash
  docker compose -f docker-compose.dev.yml exec api sh -c "cd apps/api && alembic revision --autogenerate -m 'describe change'"
  ```
  **Review the generated migration** before committing — autogenerate is not always right.

- **Config is env-driven** (`apps/api/config.py`, `.env.example`). Add new settings there
  with safe defaults; don't hardcode secrets, endpoints, or limits.

---

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) style —
  `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, optional scope (`fix(share): …`).
- **One focused change per PR.** Target the `main` branch. Branch names: `feat/<slug>`,
  `fix/<slug>`.
- **Tests required** for new behavior or bug fixes (a fix should ship a regression test that
  fails before and passes after).
- **CHANGELOG:** add user-facing changes to `CHANGELOG.md` under the **`[Unreleased]`**
  heading (Keep a Changelog format: `Added` / `Changed` / `Fixed`). Don't invent or cut a
  version — releases are handled separately.
- **UI changes:** include before/after screenshots in the PR (see
  `.github/PULL_REQUEST_TEMPLATE.md`).
- **Docs:** update `docs/` or user-facing text when you change behavior.

---

## Releases & branches

FreeFrame ships **moving branch pointers** on top of immutable `vX.Y.Z` tags. Know which is which:

- **`main`** — active development. PRs target `main`; it may be ahead of any release.
- **`stable`** — the last **validated** release. **This is what production self-hosters run** (`git clone -b stable`). Never tell users to run `main` in production, and don't point install/deploy docs at `main` — point them at `stable`.
- **`latest`** — the newest published release (auto-moved by `.github/workflows/release-pointers.yml`). For early adopters.
- **`vX.Y.Z`** — immutable release tags; never move or delete them.

Rules for agents:

- **Don't create, move, or force-push `stable` / `latest`** — they are moved only by the release workflows (`release-pointers.yml` on release publish; `promote-stable.yml` manually, which gates on green CI). See [`docs/RELEASING.md`](docs/RELEASING.md).
- **Don't cut releases or tags** unless explicitly asked — releases are manual and CHANGELOG-driven.
- Default user-facing install/deploy instructions to `stable` (see the README "Release channels" table).

---

## Finding things & getting help

- **An endpoint or schema:** browse http://localhost:8000/docs, or grep `apps/api/routers/`.
- **Report a bug / request a feature:** use the
  [issue templates](https://github.com/Techiebutler/freeframe/issues/new/choose).
- **Security issues:** follow [`SECURITY.md`](SECURITY.md) — do not open a public issue.
- **License:** contributions are MIT-licensed ([`LICENSE`](LICENSE)).
```
