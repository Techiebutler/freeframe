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

```bash
# Run all tests
docker compose -f docker-compose.dev.yml exec api pytest

# Run with verbose output
docker compose -f docker-compose.dev.yml exec api pytest -v

# Run a specific test file
docker compose -f docker-compose.dev.yml exec api pytest apps/api/tests/test_auth.py
```

### Frontend (TypeScript)

```bash
# Run all tests
docker compose -f docker-compose.dev.yml exec web npm test

# Run in watch mode
docker compose -f docker-compose.dev.yml exec web npm run test:watch
```

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
