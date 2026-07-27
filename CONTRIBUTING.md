# Contributing to FreeFrame

Thanks for your interest in contributing! See the full guide:

- **[Development Setup & Contributing Guide](docs/contributing.md)** — prerequisites, dev environment, coding standards
- **[Architecture Overview](docs/architecture.md)** — system design, tech stack, data flow
- **[Deployment Guide](docs/deployment.md)** — production setup, Docker, environment variables

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/freeframe.git
cd freeframe
cp .env.example .env
docker compose -f docker-compose.dev.yml up --build
# Open http://localhost:3000
```

## Pull Request Process

1. Fork and create a branch: `git checkout -b feat/my-feature`
2. Make your changes and write tests (see [test gotchas](docs/contributing.md#house-rules--test-gotchas-read-before-writing-tests) — API tests use a mock DB)
3. Run the checks CI runs:
   - API: `docker compose -f docker-compose.dev.yml exec -w /workspace api python -m pytest apps/api/tests/ -q`
   - Web: `pnpm --filter web test && pnpm --filter web lint && pnpm --filter web build`
4. Add a `CHANGELOG.md` entry under `## [Unreleased]` for user-facing changes
5. Open a PR against `main` — we aim to respond within 48 hours

**Not a coder?** Testing releases against your NLE, writing detailed bug reports, and improving docs are first-class contributions too.

## Reporting Issues

- **Bugs**: Use the [bug report template](https://github.com/Techiebutler/freeframe/issues/new?template=bug_report.yml)
- **Features**: Use the [feature request template](https://github.com/Techiebutler/freeframe/issues/new?template=feature_request.yml)
- **Security**: See [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
