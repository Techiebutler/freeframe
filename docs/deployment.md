# Production Deployment Guide

This guide covers deploying FreeFrame to a production server using Docker Compose.

---

## Prerequisites

- A server with **Docker** and **Docker Compose** installed (2+ CPU cores, 4GB+ RAM recommended)
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
2. Remove `postgres` from the `depends_on` of the `api` and `worker` services
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
2. Remove `redis` from the `depends_on` of the `api`, `worker`, `email_worker`, and `beat` services
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

For **non-AWS providers**, also set the endpoint:

| Provider | S3_ENDPOINT |
|----------|-------------|
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` |
| MinIO (self-hosted) | `http://your-minio-host:9000` |

Make sure your bucket has CORS configured to allow requests from your FreeFrame domain.

### External SMTP

Works with: **Mailgun, Postmark, SendGrid, Amazon SES, or any SMTP server.**

Configure in `.env.prod`:

**SMTP (most providers):**
```
MAIL_PROVIDER=smtp
MAIL_FROM_ADDRESS=noreply@your-domain.com
MAIL_FROM_NAME=FreeFrame
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
MAIL_FROM_NAME=FreeFrame
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

### Email Workers

Email sending is I/O-bound and lightweight. The default of `2` is sufficient for most deployments.

---

## Updating

```bash
cd freeframe
git pull origin main
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Database migrations run automatically on API startup. Always check the release notes before updating.

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
