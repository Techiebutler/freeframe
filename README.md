# FreeFrame

**Self-hostable, open-source media review platform. A collaborative alternative to Frame.io.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker)](docker-compose.prod.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](docs/contributing.md)

FreeFrame gives production houses and creative teams a self-hosted platform for reviewing video, image, and audio assets with frame-accurate commenting, annotations, and approval workflows. Your media stays on your infrastructure.

---

## Features

- **Video review** with HLS adaptive streaming and frame-accurate timecoded comments
- **Image and audio review** with annotations and waveform visualization
- **Drawing annotations** on any frame using canvas tools
- **Threaded comments** with mentions, reactions, and attachments
- **Approval workflows** with per-reviewer status tracking
- **Version management** to compare iterations side-by-side
- **Folder organization** within projects
- **Team collaboration** with role-based permissions (org, team, project levels)
- **Share links** for external reviewers (password-protected, expiring)
- **Guest commenting** via share links (no account required)
- **Due date tracking** with email reminders
- **Real-time updates** via Server-Sent Events
- **Self-hosted** with Docker Compose — runs on any server or cloud VM

## Quick Start (Development)

**Prerequisites:** Docker and Docker Compose

```bash
git clone https://github.com/Techiebutler/freeframe.git
cd freeframe
cp .env.example .env
docker compose -f docker-compose.dev.yml up --build
```

Open [http://localhost:3000](http://localhost:3000) to access FreeFrame. The first user to sign up becomes the super admin.

**Services running in dev:**

| Service     | URL                          |
|-------------|------------------------------|
| Frontend    | http://localhost:3000         |
| API         | http://localhost:8000         |
| API Docs    | http://localhost:8000/docs    |
| MinIO Console | http://localhost:9001       |

## Production Deployment

```bash
cp .env.example .env.prod
# Edit .env.prod — set your credentials, S3, email config
# For SSL: also set DOMAIN and ACME_EMAIL (Traefik auto-provisions Let's Encrypt certs)
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

For the full guide including **SSL setup**, **bring-your-own infrastructure** (external database, Redis, S3, SMTP), scaling, and troubleshooting, see:

**[Production Deployment Guide](docs/deployment.md)**

## Architecture

```
                    ┌──────────────┐
                    │   Traefik    │
                    │   :80/:443   │
                    └──────┬───────┘
                           │
               ┌───────────┴───────────┐
               ▼                       ▼
        ┌─────────────┐        ┌─────────────┐
        │   Next.js    │        │   FastAPI    │
        │   Frontend   │        │   Backend    │
        └─────────────┘        └──────┬───────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                  ▼
             ┌───────────┐    ┌───────────┐     ┌───────────────┐
             │ PostgreSQL │    │   Redis    │     │  S3 Storage   │
             │            │    │           │     │ (AWS/R2/MinIO) │
             └───────────┘    └─────┬─────┘     └───────────────┘
                                    │
                         ┌──────────┴──────────┐
                         ▼                     ▼
                  ┌─────────────┐      ┌─────────────┐
                  │   Celery     │      │   Celery     │
                  │  Transcoder  │      │   Email      │
                  └─────────────┘      └─────────────┘
```

## Tech Stack

| Component    | Technology                                       |
|--------------|--------------------------------------------------|
| Frontend     | Next.js 14, React 18, Tailwind CSS, Zustand      |
| Backend      | FastAPI, SQLAlchemy, Pydantic                    |
| Database     | PostgreSQL 15                                     |
| Queue        | Celery + Redis                                    |
| Transcoding  | FFmpeg (multi-bitrate HLS)                        |
| Storage      | Any S3-compatible (AWS, R2, B2, MinIO)           |
| Proxy        | Traefik (auto SSL via Let's Encrypt)              |
| Auth         | JWT + magic code email login                      |

## Documentation

| Guide | Description |
|-------|-------------|
| [Production Deployment](docs/deployment.md) | SSL, bring-your-own infra, scaling, troubleshooting |
| [Architecture](docs/architecture.md) | System design, data flow, media pipeline, permissions |
| [Contributing](docs/contributing.md) | Dev setup, testing, code style, PR process |
| [Environment Variables](.env.example) | Full config reference with comments |

## Contributing

We welcome contributions! Please read our [Contributing Guide](docs/contributing.md) to get started.

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Contact & Support

<div align="center">

**A project by [Techiebutler](https://techiebutler.com)**

Have questions? Need help?

**Email:** [support@techiebutler.com](mailto:support@techiebutler.com)

[![Instagram](https://img.shields.io/badge/Instagram-%23E4405F.svg?style=for-the-badge&logo=Instagram&logoColor=white)](https://www.instagram.com/techie_butler/)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-%230077B5.svg?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/company/techiebutler/)

Star the repo if FreeFrame is useful to you!

</div>
