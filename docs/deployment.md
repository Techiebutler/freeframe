# Production Deployment Guide

This guide covers deploying FreeFrame to a production server using Docker Compose.

---

## Hardware Requirements

| | Minimum | Recommended | Heavy Workload |
|---|---|---|---|
| **CPU** | 2 cores | 4 cores | 8+ cores |
| **RAM** | 4 GB | 8 GB | 16+ GB |
| **Storage** | 20 GB SSD | 50 GB SSD | 100+ GB NVMe |
| **Bandwidth** | 100 Mbps | 500 Mbps | 1 Gbps |

- **Minimum** — Small teams (up to 10 users), light video transcoding
- **Recommended** — Medium teams (10-50 users), regular video uploads
- **Heavy Workload** — Large teams (50+ users), frequent 4K video processing

> **Note:** Video transcoding is the most resource-intensive operation. Storage needs depend on your media volume — the actual media files are stored in S3, not on the server.

---

## Deployment Options

FreeFrame runs anywhere Docker is available. Here are common hosting options:

### VPS / Cloud VM (Simplest)

Best for most teams. A single server running Docker Compose.

| Provider | Recommended Plan | Est. Cost/mo |
|----------|-----------------|--------------|
| **Hetzner** | CPX31 (4 vCPU, 8 GB) | ~$15 |
| **DigitalOcean** | Droplet (4 vCPU, 8 GB) | ~$48 |
| **AWS EC2** | t3.medium (4 vCPU, 8 GB) | ~$60 |
| **Google Cloud** | e2-custom (4 vCPU, 8 GB) | ~$75 |
| **Azure** | B4s (4 vCPU, 8 GB) | ~$70 |
| **Hostinger VPS** | KVM 4 (4 vCPU, 16 GB) | ~$16 |

**Setup:** SSH into your server, install Docker, clone the repo, and follow the [Quick Setup](#quick-setup) below.

### Cloud with Managed Services

For teams that want managed databases and less maintenance. Use external PostgreSQL, Redis, and S3 instead of the Docker-included ones. See [Bring Your Own Infrastructure](#bring-your-own-infrastructure).

| Component | AWS | GCP | Azure |
|-----------|-----|-----|-------|
| Server | EC2 / ECS | Compute Engine / Cloud Run | VM / Container Apps |
| Database | RDS PostgreSQL | Cloud SQL | Azure Database for PostgreSQL |
| Redis | ElastiCache | Memorystore | Azure Cache for Redis |
| Storage | S3 | Cloud Storage | Blob Storage (via S3 API) |
| Email | SES | (use SMTP) | (use SMTP) |

### Bare Metal / On-Premise

FreeFrame is fully self-contained. Install Docker on any Linux server (Ubuntu 22.04+ recommended) and follow the Quick Setup. Ideal for organizations that require media to stay on their own hardware.

---

## Prerequisites

- A server meeting the [hardware requirements](#hardware-requirements) with **Docker** and **Docker Compose** installed
- A **domain name** pointed to your server's IP (for SSL — optional for testing)
- An **S3-compatible storage** bucket (AWS S3, Cloudflare R2, Backblaze B2, etc.)
- An **SMTP server** or AWS SES for sending emails

## Quick Setup

```bash
# 1. Clone the repository
git clone https://github.com/Techiebutler/freeframe.git
cd freeframe

# 2. Create your production environment file
cp .env.example .env.prod

# 3. Edit .env.prod with your actual credentials
#    At minimum: change passwords, configure S3, email, and JWT_SECRET
nano .env.prod

# 4. Build and start all services
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build

# 5. Check that everything is running
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
```

FreeFrame is now running on **port 80**. The first user to sign up becomes the super admin via the setup wizard.

---

## SSL / TLS Setup

FreeFrame uses **Traefik** as its reverse proxy, which can automatically provision and renew **Let's Encrypt** SSL certificates with zero manual setup.

### Enabling SSL

Set these two variables in your `.env.prod`:

```
DOMAIN=your-domain.com
ACME_EMAIL=admin@your-domain.com
FRONTEND_URL=https://your-domain.com
```

Then start (or restart) the services:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

That's it. Traefik will:
- Automatically obtain SSL certificates from Let's Encrypt
- Serve your site over HTTPS on port 443
- Auto-renew certificates before they expire

> **Requirements:** Your domain's DNS A record must point to your server, and ports 80 + 443 must be open. Traefik needs port 80 for the ACME HTTP challenge even when serving HTTPS.

### Without SSL (HTTP only)

If you don't set `DOMAIN` and `ACME_EMAIL`, FreeFrame runs on **HTTP port 80** only. This is fine for:
- Local testing of the production build
- Running behind an external reverse proxy that handles SSL

### Behind an External Reverse Proxy (Cloudflare, Caddy, etc.)

If FreeFrame sits behind another proxy that already handles SSL:

1. Don't set `DOMAIN` / `ACME_EMAIL` — let Traefik run in HTTP mode
2. Point your external proxy to FreeFrame's port 80
3. Ensure the proxy forwards these headers: `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`
4. For **Cloudflare**: set SSL mode to "Full"
5. Set `FRONTEND_URL` in `.env.prod` to your `https://` URL

---

## Bring Your Own Infrastructure

FreeFrame's Docker Compose includes PostgreSQL and Redis by default, but you can use external managed services instead.

### External Database (PostgreSQL)

Works with: **AWS RDS, Google Cloud SQL, Supabase, Neon, DigitalOcean Managed DB, or any PostgreSQL 15+ instance.**

1. Remove the `postgres` service and `pgdata` volume from `docker-compose.prod.yml`
2. Remove `postgres` from the `depends_on` of the `api`, `worker`, and `maintenance_worker` services
3. In `.env.prod`, set `DATABASE_URL` to your external database:
   ```
   DATABASE_URL=postgresql://user:password@your-db-host:5432/freeframe
   ```
4. Run migrations once manually on first deploy:
   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm api sh -c "cd /workspace/apps/api && alembic upgrade head"
   ```

### External Redis / Valkey

Works with: **AWS ElastiCache, Upstash, Redis Cloud, DigitalOcean Managed Redis, or any Redis 7+ / Valkey instance.** Valkey is a drop-in Redis replacement and works out of the box.

1. Remove the `redis` service and `redisdata` volume from `docker-compose.prod.yml`
2. Remove `redis` from the `depends_on` of the `api`, `worker`, `email_worker`, `maintenance_worker`, and `beat` services
3. In `.env.prod`, set `REDIS_URL` to your external instance:
   ```
   REDIS_URL=redis://:password@your-redis-host:6379/0
   ```

### External S3 Storage

Works with: **AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO, or any S3-compatible service.**

There's no S3 service in the production compose — you always provide your own. Configure in `.env.prod`:

```
S3_STORAGE=s3
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY=YOUR_ACCESS_KEY
S3_SECRET_KEY=YOUR_SECRET_KEY
S3_REGION=us-east-1
```

For **non-AWS S3-compatible providers** (R2, B2, Spaces, MinIO, Hetzner, …), set `S3_STORAGE` to a non-`s3` value (e.g. `minio`) so `S3_ENDPOINT` is used — with `S3_STORAGE=s3` the client talks to native AWS and the endpoint is **ignored** (FreeFrame refuses to start if `s3` is combined with a non-AWS endpoint). Then set the endpoint:

| Provider | S3_ENDPOINT |
|----------|-------------|
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` |
| MinIO (self-hosted) | `http://your-minio-host:9000` |
| Garage (self-hosted) | `http://your-garage-host:3900` (or your reverse-proxy URL) |

In non-AWS mode FreeFrame always uses **path-style addressing** (`endpoint/bucket/key`) with **SigV4** signatures — the compatibility baseline every S3-compatible provider accepts. No wildcard bucket DNS is needed in front of a self-hosted store.

#### Bucket CORS — required for uploads

Uploads go **directly from the browser to your bucket** via presigned URLs, so the bucket's CORS must allow your FreeFrame origin.

`ExposeHeaders: ["ETag"]` is still recommended and is included below, but it is no longer required on any backend that supports `ListParts`, which is all of the ones above: the server reads an upload's parts from storage when completing it rather than relying on the browser having read each part's `ETag` response header. It is only used as a fallback on a backend that cannot list parts at all, and that case is logged as a warning. If you are debugging an upload that fails partway, `ETag` exposure is no longer the first thing to suspect.

```json
{
  "CORSRules": [{
    "AllowedOrigins": ["https://your-freeframe-domain.example"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedHeaders": ["Content-Type", "Content-MD5", "x-amz-content-sha256", "x-amz-date", "x-amz-decoded-content-length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
}
```

`DELETE` is intentionally absent — FreeFrame has no presigned-DELETE flow, and the browser never needs it against the bucket. The `AllowedHeaders` list above is exactly what browser uploads and HLS segment fetches send; `["*"]` also works on most backends, but the list is sufficient and is what FreeFrame's automatic startup config now applies.

If you allow **more than one origin**, give each origin its own rule rather than listing them all in one. Some backends (Garage) answer a multi-origin rule by joining every entry into a single comma-separated `Access-Control-Allow-Origin` header, which browsers reject — every upload and HLS segment fetch then fails CORS. FreeFrame's automatic startup config already emits one rule per origin.

FreeFrame applies this automatically to **non-AWS** buckets at startup when it has permission (and logs a warning if it can't). Set it yourself for **AWS S3**, or wherever FreeFrame lacks CORS permission. **Hetzner Object Storage** exposes CORS only via API/CLI (not the Console UI), so it's easy to miss — apply the JSON above with `aws s3api put-bucket-cors`.

### External SMTP

> **⚠️ Email is required for login.** FreeFrame authenticates with emailed **magic codes**, and also sends invites/notifications. If email isn't configured, users **cannot log in** — the send fails and the app logs a warning at startup. Configure SMTP or SES before going live.

Works with: **Mailgun, Postmark, SendGrid, Amazon SES, or any SMTP server.**

Configure in `.env.prod`:

**SMTP (most providers):**
```
MAIL_PROVIDER=smtp
MAIL_FROM_ADDRESS=noreply@your-domain.com
# Blank follows the instance branding name; set it to pin a fixed one.
MAIL_FROM_NAME=
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_USE_TLS=true
```

**AWS SES:**
```
MAIL_PROVIDER=ses
MAIL_FROM_ADDRESS=noreply@your-domain.com
# Blank follows the instance branding name; set it to pin a fixed one.
MAIL_FROM_NAME=
AWS_MAIL_ACCESS_KEY_ID=YOUR_KEY
AWS_MAIL_SECRET_ACCESS_KEY=YOUR_SECRET
AWS_MAIL_REGION=us-east-1
```

---

## Configuration Reference

All environment variables are documented in [`.env.example`](../.env.example). Key settings:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | (required) |
| `REDIS_URL` | Redis connection string | (required) |
| `S3_STORAGE` | `s3` for any S3-compatible provider | `minio` |
| `S3_BUCKET` | S3 bucket name | (required) |
| `S3_ENDPOINT` | Custom S3 endpoint (non-AWS) | (empty = AWS) |
| `JWT_SECRET` | Auth token signing key | (required, generate with `openssl rand -hex 64`) |
| `FRONTEND_URL` | Your FreeFrame URL (with https://) | (required) |
| `DOMAIN` | Your domain for auto SSL | (optional) |
| `ACME_EMAIL` | Email for Let's Encrypt notifications | (optional) |
| `MAIL_PROVIDER` | `smtp` or `ses` | `smtp` |
| `API_WORKERS` | Gunicorn worker processes | `4` |
| `TRANSCODING_CONCURRENCY` | Parallel transcoding jobs | `2` |
| `EMAIL_CONCURRENCY` | Parallel email jobs | `2` |
| `MAINTENANCE_CONCURRENCY` | Parallel housekeeping jobs | `1` |
| `NEXT_PUBLIC_UPLOAD_CONCURRENCY` | Upload parts in flight per file (browser) | `5` |
| `TRANSCODER_PIPELINE` | GPU backend: `Auto`, `NVIDIA`, `Intel`, or `Software` | `Auto` |
| `TRANSCODER_OUTPUT` | Output codec: `h264_8` (broad compatibility) or `h265_10` (HEVC 10-bit) | `h264_8` |
| `TRANSCODER_HDR` | `convert` (tone-map HDR to SDR) or `preserve` (keep HDR tags) | `convert` |

---

## Scaling

### API Workers

The `API_WORKERS` env var controls how many gunicorn worker processes handle API requests. A good starting point:

```
API_WORKERS = (2 x CPU cores) + 1
```

### Transcoding Workers

Video transcoding is CPU-intensive. Adjust `TRANSCODING_CONCURRENCY` based on your server:

| Server | Recommended |
|--------|-------------|
| 2 cores | 1-2 |
| 4 cores | 2-3 |
| 8+ cores | 4-6 |

### Hardware-Accelerated Transcoding (optional)

FreeFrame can use an NVIDIA (NVENC) or Intel (VAAPI) GPU to transcode faster, and
automatically falls back to software (CPU) transcoding if no GPU is present or a
hardware attempt fails at runtime. This is entirely opt-in — the default build and
default runtime behavior are unchanged.

To enable it:
1. Build the API image with `--build-arg ENABLE_HWACCEL=true` (Intel/VAAPI only —
   NVENC needs no extra packages in the image, just the host driver).
2. Give the `worker` service access to the GPU: pass through `/dev/dri` for VAAPI,
   or install `nvidia-container-toolkit` and add a GPU reservation for NVENC.
3. Set `TRANSCODER_PIPELINE` to `NVIDIA`, `Intel`, or leave it as `Auto` to detect
   automatically.

> Compose-file examples for GPU device passthrough aren't included yet — that's a
> known follow-up.

### Email Workers

Email sending is I/O-bound and lightweight. The default of `2` is sufficient for most deployments.

### Maintenance Workers

Housekeeping is I/O-bound but can run long: `cleanup_soft_deleted` deletes S3
objects one at a time and `sweep_orphan_s3` lists the whole bucket. The default
of `1` is right for most deployments, since these tasks are scheduled hourly at
most and none of them is latency-sensitive. Raising it mainly helps if you have
a large backlog of soft-deleted media to reclaim.

---

## Monitoring

### Health Check

The API exposes a health endpoint:

```
GET /health → { "status": "ok" }
```

Use this for uptime monitoring (UptimeRobot, Healthchecks.io, etc.) or Docker health checks.

### Logs

```bash
# Follow all service logs
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f

# Follow a specific service
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f api

# Last 100 lines
docker compose --env-file .env.prod -f docker-compose.prod.yml logs --tail 100 api
```

### Key Metrics to Watch

| Metric | How to Check | Warning Sign |
|--------|-------------|--------------|
| Disk space | `df -h` | > 80% used |
| Memory | `free -m` | Swap in use |
| API response | `curl -s localhost/health` | Non-200 response |
| Queue depth | `docker compose --env-file .env.prod -f docker-compose.prod.yml exec redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning LLEN transcoding'` (repeat for `email_high`, `email_low`, `maintenance`, `default`) | Any queue growing steadily; **any depth at all on `default`** |
| Busy workers | `docker compose --env-file .env.prod -f docker-compose.prod.yml exec api celery -A apps.api.tasks.celery_app inspect active` | Tasks stuck for hours |
| Database connections | `docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres psql -U freeframe -c "SELECT count(*) FROM pg_stat_activity;"` | > 80% of max |

Check depth with `LLEN`, not `inspect active`. `inspect active` reports what
connected workers are executing right now, so a queue that no worker subscribes
to shows up as nothing at all: the workers are genuinely idle while the backlog
grows unseen. That is exactly how [#240](https://github.com/Techiebutler/freeframe/issues/240)
went unnoticed.

`REDIS_PASSWORD` lives in `.env.prod`, which is not exported into your shell,
so it has to expand inside the container. That is why the command above is
wrapped in `sh -c '...'` with single quotes rather than passing `-a "$REDIS_PASSWORD"`
directly, which would authenticate with an empty password.

`default` should always be empty. Every task is routed explicitly, so anything
landing there is a task that was added without a route and that no worker will
ever run.

### Queue Topology

Each worker subscribes to an explicit `-Q` list, so a task whose queue has no
subscriber is silently never executed. The shipped topology is:

| Queue | Consumed by | Carries |
|-------|-------------|---------|
| `transcoding` | `worker` | Video/audio/image processing, metadata backfill, watermarking |
| `email_high` | `email_worker` | Magic codes, invites |
| `email_low` | `email_worker` | Mentions, comments, approvals, share notices |
| `maintenance` | `maintenance_worker` | Retention GC, stale-upload reaper, orphan sweep |
| `default` | nobody, by design | Should always be empty |

If you add a task, route it in `apps/api/tasks/celery_app.py` to one of the
consumed queues. `apps/api/tests/test_celery_queue_topology.py` fails if a
registered task routes somewhere no compose worker consumes.

---

## Backups

### Database Backup

```bash
# One-time backup
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  pg_dump -U freeframe freeframe | gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz

# Restore from backup
gunzip -c backup_20260403_120000.sql.gz | \
  docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
  psql -U freeframe freeframe
```

### Automated Daily Backups

Add a cron job on your server:

```bash
# Edit crontab
crontab -e

# Add this line (runs daily at 2 AM, keeps 30 days)
0 2 * * * cd /path/to/freeframe && docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres pg_dump -U freeframe freeframe | gzip > /path/to/backups/freeframe_$(date +\%Y\%m\%d).sql.gz && find /path/to/backups -name "freeframe_*.sql.gz" -mtime +30 -delete
```

### S3 Media Backup

Your media files are already in S3. For redundancy:

- **AWS S3**: Enable [versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html) and [cross-region replication](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html)
- **Cloudflare R2**: Use [Sippy](https://developers.cloudflare.com/r2/data-migration/sippy/) for incremental migration/backup
- **Self-hosted MinIO**: Use [`mc mirror`](https://min.io/docs/minio/linux/reference/minio-mc/mc-mirror.html) to replicate to a second location

### What to Back Up

| Data | Location | Priority |
|------|----------|----------|
| Database | PostgreSQL | **Critical** — all users, projects, comments, share links |
| Media files | S3 bucket | **Important** — uploaded assets and transcoded files |
| Environment config | `.env.prod` | **Important** — save a copy outside the server |
| SSL certificates | `letsencrypt/` volume | Low — Traefik auto-renews them |

---

## Updating

```bash
cd freeframe
git pull origin main
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Database migrations run automatically on API startup. Always check the [CHANGELOG](../CHANGELOG.md) before updating.

### Upgrading past the maintenance-queue fix ([#240](https://github.com/Techiebutler/freeframe/issues/240))

Before this fix, no worker consumed the `default` queue, so the retention GC,
the stale-upload reaper, the orphan sweeper, due-date reminders and
`apply_watermark` were published and never executed. This release adds a
`maintenance_worker` service, so **`docker compose up -d --build` alone is not
enough: you must be using the updated compose file** for the new service to
exist.

Two things to do once, in this order.

**1. Check what the first garbage-collection run will delete.** The GC has never
run on your instance, so its first pass reclaims everything already past the
retention window, all at once. Count it first, substituting your own
`SOFT_DELETE_RETENTION_DAYS` for the `30` below:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec postgres \
  psql -U freeframe -c "
WITH cutoff AS (SELECT now() - interval '30 days' AS t)
SELECT 'projects'        AS root, count(*) FROM projects,        cutoff WHERE deleted_at < t
UNION ALL SELECT 'folders',        count(*) FROM folders,        cutoff WHERE deleted_at < t
UNION ALL SELECT 'assets',         count(*) FROM assets,         cutoff WHERE deleted_at < t
UNION ALL SELECT 'asset_versions', count(*) FROM asset_versions, cutoff WHERE deleted_at < t
UNION ALL SELECT 'comments',       count(*) FROM comments,       cutoff WHERE deleted_at < t
UNION ALL SELECT 'share_links',    count(*) FROM share_links,    cutoff WHERE deleted_at < t
UNION ALL SELECT 'live assets swept in with a deleted project/folder',
       count(*) FROM assets a, cutoff
       WHERE a.deleted_at IS NULL AND (
         a.project_id IN (SELECT id FROM projects WHERE deleted_at < cutoff.t)
         OR a.folder_id IN (SELECT id FROM folders WHERE deleted_at < cutoff.t));"
```

That last row is the one that surprises people. Deleting a project sets
`deleted_at` on the project row only, and does **not** cascade to its assets, but
the purge removes every asset belonging to a purged project or folder regardless
of the asset's own `deleted_at`. So a project you trashed months ago still counts
its live assets here even though they look untouched.

If any of these numbers is larger than you expect, raise
`SOFT_DELETE_RETENTION_DAYS` (or set it to `0` to keep the GC off) before
starting the new worker, and lower it once you have reviewed what would go. The
deletion is a hard delete with S3 reclaim and is not recoverable.

**2. Drop the stale `default` backlog.** Instances that ran `beat` accumulated
roughly 49 orphaned messages a day. The new worker consumes `maintenance`, not
`default`, so the backlog is inert and safe to leave, but it wastes Redis
memory:

```bash
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" LLEN default
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" RENAME default default-old-240
```

`RENAME` rather than `DEL` so the messages can be inspected or restored. Delete
`default-old-240` once the new worker is running and `LLEN maintenance` is
draining normally.

### Upgrading past the media-metadata fix ([#124](https://github.com/Techiebutler/freeframe/issues/124))

If you're upgrading past the media-metadata fix ([#124](https://github.com/Techiebutler/freeframe/issues/124)), backfill missing `duration_seconds`/`width`/`height`/`fps` on already-processed files with: `docker exec freeframe-api-1 python -m apps.api.scripts.backfill_media_metadata`. The backfill runs as a Celery task on the `transcoding` queue, so it occupies one worker slot and can run long on large libraries (up to ~300s per file); new uploads keep transcoding normally on the remaining slots.

### Update Checklist

1. **Read the changelog** — check for breaking changes or new env vars
2. **Backup the database** — `pg_dump` before updating (see [Backups](#backups))
3. **Pull and rebuild** — `git pull && docker compose up -d --build`
4. **Verify** — check `/health`, test login, spot-check a share link
5. **Rollback if needed** — `git checkout v1.x.x && docker compose up -d --build`

---

## Troubleshooting

### Services not starting

```bash
# Check logs for a specific service
docker compose --env-file .env.prod -f docker-compose.prod.yml logs api
docker compose --env-file .env.prod -f docker-compose.prod.yml logs worker
docker compose --env-file .env.prod -f docker-compose.prod.yml logs web
docker compose --env-file .env.prod -f docker-compose.prod.yml logs traefik

# Check all service statuses
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
```

### Database migration failures

```bash
# Run migrations manually
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm api sh -c "cd /workspace/apps/api && alembic upgrade head"

# Check migration status
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm api sh -c "cd /workspace/apps/api && alembic current"
```

### SSL certificate not working

- Verify `DOMAIN` and `ACME_EMAIL` are set in `.env.prod`
- Check that DNS A record points to your server: `dig your-domain.com`
- Ensure ports 80 and 443 are open: `sudo ufw allow 80,443/tcp`
- Check Traefik logs: `docker compose --env-file .env.prod -f docker-compose.prod.yml logs traefik`
- Let's Encrypt has rate limits — if you hit them, wait an hour and retry

### S3 connection issues

- Verify your credentials are correct in `.env.prod`
- Ensure your bucket exists and has proper CORS configuration
- For non-AWS providers, double-check the `S3_ENDPOINT` URL

### Port 80/443 already in use

```bash
# Find what's using the port
sudo lsof -i :80
# Stop that service or change the port mapping in docker-compose.prod.yml
```

### Large file uploads failing

Large media files are uploaded directly to S3 via presigned URLs (bypassing Traefik), so proxy limits don't apply to file data. If uploads still fail:
- Check that your S3 bucket doesn't have a size limit
- Verify your server has enough `/tmp` space for transcoding
- Check worker logs for processing errors
