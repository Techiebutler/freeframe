# Contributing to FreeFrame

Thanks for your interest in contributing! This guide will help you get set up for development.

---

## Development Setup

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [Git](https://git-scm.com/)
- [Node.js 18+](https://nodejs.org/) (optional, for running frontend outside Docker)
- [Python 3.11+](https://python.org/) (optional, for running backend outside Docker)

### Getting Started

```bash
# 1. Fork the repository on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/freeframe.git
cd freeframe

# 2. Copy the example environment file
cp .env.example .env

# 3. Start the development environment
docker compose -f docker-compose.dev.yml up --build

# 4. Open FreeFrame
open http://localhost:3000
```

All services start automatically: PostgreSQL, Redis, MinIO (S3), API, Celery workers, and the Next.js frontend.

### Dev Services

| Service        | URL                        | Description          |
|----------------|----------------------------|----------------------|
| Frontend       | http://localhost:3000       | Next.js (hot reload) |
| API            | http://localhost:8000       | FastAPI              |
| API Docs       | http://localhost:8000/docs  | Swagger UI           |
| MinIO Console  | http://localhost:9001       | S3 storage UI        |
| PostgreSQL     | localhost:5433              | Database             |

---

## Project Structure

```
freeframe/
├── apps/
│   ├── api/                # FastAPI backend
│   │   ├── main.py         # App entry point
│   │   ├── config.py       # Environment settings
│   │   ├── models/         # SQLAlchemy ORM models
│   │   ├── schemas/        # Pydantic request/response schemas
│   │   ├── routers/        # API route handlers
│   │   ├── services/       # Business logic
│   │   ├── tasks/          # Celery async tasks
│   │   └── alembic/        # Database migrations
│   └── web/                # Next.js frontend
│       ├── app/            # Next.js app router pages
│       ├── components/     # React components
│       ├── lib/            # Utilities and API client
│       └── stores/         # Zustand state stores
├── packages/
│   └── transcoder/         # Video/audio transcoding package
├── docs/                   # Documentation
├── docker-compose.dev.yml  # Development environment
└── docker-compose.prod.yml # Production environment
```

---

## Running Tests

### Backend (Python)

Run pytest **from the `/workspace` directory inside the api container** (the repo root is mounted there; running bare `pytest` from the container's default directory misses the repo's `pytest.ini`):

```bash
# Run all tests
docker compose -f docker-compose.dev.yml exec -w /workspace api python -m pytest apps/api/tests/ -q

# Run with verbose output
docker compose -f docker-compose.dev.yml exec -w /workspace api python -m pytest apps/api/tests/ -v

# Run a specific test file
docker compose -f docker-compose.dev.yml exec -w /workspace api python -m pytest apps/api/tests/test_auth.py -v
```

### Frontend (TypeScript)

The frontend uses **pnpm** (single lockfile for the repo — same as CI). If you have pnpm locally, run from the repo root:

```bash
# Run all tests
pnpm --filter web test

# Watch mode
pnpm --filter web test:watch

# Lint and type-checking build (what CI runs)
pnpm --filter web lint
pnpm --filter web build
```

Or inside the container: `docker compose -f docker-compose.dev.yml exec web pnpm test`

### House rules & test gotchas (read before writing tests)

- **API tests use a mock DB, not a real database.** The models use PostgreSQL-specific types, so `apps/api/tests/conftest.py` provides a `mock_db` MagicMock fixture and a `client` fixture with dependency overrides — script sequential lookups with `mock_db.first.side_effect = [asset, version, ...]`. Look at `apps/api/tests/test_assets_stream_url.py` as a template. Conventional "insert a row and query it" tests won't work; for code that genuinely needs Postgres, use the `real_db` fixture (transaction always rolled back).
- **CI has floor guards** — it fails if the suite collects too few test files or passing tests, so never delete or skip tests to get green.
- **CI skips entirely for docs-only changes** (`*.md`, `docs/**` are path-ignored) — that's expected, not broken.
- **Every user-facing change needs a `CHANGELOG.md` entry under `## [Unreleased]`** in the matching section (`### Added` / `### Changed` / `### Fixed`). Never create a new version heading — releases are cut by maintainers (see `docs/RELEASING.md`).

---

## Database Migrations

When you change SQLAlchemy models, create a migration:

```bash
# Generate a new migration
docker compose -f docker-compose.dev.yml exec api sh -c "cd apps/api && alembic revision --autogenerate -m 'describe your change'"

# Apply migrations
docker compose -f docker-compose.dev.yml exec api sh -c "cd apps/api && alembic upgrade head"

# Rollback one migration
docker compose -f docker-compose.dev.yml exec api sh -c "cd apps/api && alembic downgrade -1"
```

Always review auto-generated migrations before committing.

---

## Code Style

### Backend (Python)
- Follow FastAPI conventions for routers and dependency injection
- Use Pydantic models for all request/response schemas
- Use SQLAlchemy models for database entities
- All entities use soft delete (`deleted_at` column)

### Frontend (TypeScript)
- Follow Next.js App Router conventions
- Use Tailwind CSS for styling
- Use Zustand for client state, SWR for server state
- Run linting: `npm run lint`

---

## Pull Request Process

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** with clear, focused commits

3. **Test your changes** — run both backend and frontend tests

4. **Push to your fork** and open a Pull Request against `main`

5. **Describe your changes** — explain what and why, not just what files changed

### PR Guidelines

- Keep PRs focused — one feature or fix per PR
- Include screenshots for UI changes
- Add tests for new features
- Update documentation if you're changing user-facing behavior
- Add a `CHANGELOG.md` entry under `## [Unreleased]` for anything user-facing

We aim to give every new PR a first response **within 48 hours**. If yours has been quiet longer than that, ping it with a comment — it's welcome, not rude.

---

## Reporting Issues

When opening an issue, please include:

- **Steps to reproduce** the problem
- **Expected behavior** vs actual behavior
- **Environment details** (OS, Docker version, browser)
- **Logs** if applicable (`docker compose logs <service>`)

For feature requests, describe the use case and why it would be valuable.

---

## Need Help?

- Check existing [issues](https://github.com/Techiebutler/freeframe/issues) for similar questions
- Open a new issue with the "question" label
