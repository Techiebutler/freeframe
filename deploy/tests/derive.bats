#!/usr/bin/env bats
# derive_env (answers -> .env.prod), worker sizing, and the compose file list.

load helpers

setup() {
  common_setup
  F="$BATS_TEST_TMPDIR/.env.prod"
  # Fixed machine size so the worker counts are predictable.
  export FF_CORES=4 FF_RAM_MB=8192
}

# derive with the answers given as NAME=VALUE arguments, in strict mode.
derive() {
  env "$@" FF_CORES="$FF_CORES" FF_RAM_MB="$FF_RAM_MB" \
    bash -c 'set -Eeuo pipefail; source "$1"; derive_env "$2"' ff-derive "$FF_SCRIPT" "$F"
}

@test "own domain + bundled storage" {
  run derive FF_HTTPS=own FF_DOMAIN=review.example.com FF_ACME_EMAIL=ops@example.com \
    FF_STORAGE=bundled FF_IP=203.0.113.7
  [ "$status" -eq 0 ]
  assert_has "$F" "FRONTEND_URL=https://review.example.com"
  assert_has "$F" "DOMAIN=review.example.com"
  assert_has "$F" "ACME_EMAIL=ops@example.com"
  assert_has "$F" "S3_STORAGE=minio"
  assert_has "$F" "S3_ENDPOINT=http://minio:9000"
  assert_has "$F" "S3_PUBLIC_ENDPOINT=https://storage.review.example.com"
  assert_has "$F" "S3_BUCKET=freeframe"
  assert_has "$F" "S3_REGION=us-east-1"
  assert_has "$F" "STORAGE_DOMAIN=storage.review.example.com"
  assert_has "$F" "STORAGE_ROUTED=true"
  assert_has "$F" "STORAGE_PORT_BIND=127.0.0.1:9000"
  assert_has "$F" "FREEFRAME_HTTPS=own"
  assert_has "$F" "FREEFRAME_STORAGE=bundled"
  assert_has "$F" "FREEFRAME_CHANNEL=latest"
  [[ "$(env_get "$F" S3_ACCESS_KEY)" =~ ^[0-9a-f]{32}$ ]]
  [[ "$(env_get "$F" S3_SECRET_KEY)" =~ ^[0-9a-f]{64}$ ]]
}

@test "sslip mode with IP 203.0.113.7" {
  run derive FF_HTTPS=sslip FF_IP=203.0.113.7 FF_ACME_EMAIL=ops@example.com
  [ "$status" -eq 0 ]
  assert_has "$F" "FRONTEND_URL=https://203-0-113-7.sslip.io"
  assert_has "$F" "DOMAIN=203-0-113-7.sslip.io"
  assert_has "$F" "STORAGE_DOMAIN=storage.203-0-113-7.sslip.io"
  assert_has "$F" "S3_PUBLIC_ENDPOINT=https://storage.203-0-113-7.sslip.io"
  assert_has "$F" "STORAGE_ROUTED=true"
  assert_has "$F" "FREEFRAME_HTTPS=sslip"
}

@test "HTTP mode with IP 192.168.1.20" {
  run derive FF_HTTPS=off FF_IP=192.168.1.20
  [ "$status" -eq 0 ]
  assert_has "$F" "FRONTEND_URL=http://192.168.1.20"
  assert_has "$F" "S3_PUBLIC_ENDPOINT=http://192.168.1.20:9000"
  assert_has "$F" "STORAGE_PORT_BIND=0.0.0.0:9000"
  assert_has "$F" "STORAGE_ROUTED=false"
  assert_has "$F" "FREEFRAME_HTTPS=off"
  assert_no_key "$F" STORAGE_DOMAIN
  assert_no_key "$F" DOMAIN
  assert_no_key "$F" ACME_EMAIL
}

@test "auto mode picks own with a domain, sslip with a public IP, off without" {
  run derive FF_HTTPS=auto FF_DOMAIN=review.example.com FF_IP=203.0.113.7
  assert_has "$F" "FREEFRAME_HTTPS=own"
  rm "$F"
  run derive FF_HTTPS=auto FF_IP=203.0.113.7
  assert_has "$F" "FREEFRAME_HTTPS=sslip"
  rm "$F"
  run derive FF_IP=192.168.1.20
  assert_has "$F" "FREEFRAME_HTTPS=off"
}

@test "own mode without a domain fails and writes nothing" {
  run derive FF_HTTPS=own FF_IP=203.0.113.7
  [ "$status" -ne 0 ]
  [ ! -s "$F" ]
}

@test "external S3 sets the given endpoint, bucket and keys and no STORAGE_*" {
  run derive FF_HTTPS=own FF_DOMAIN=review.example.com FF_ACME_EMAIL=ops@example.com \
    FF_STORAGE=s3 FF_S3_ENDPOINT=https://abc.r2.cloudflarestorage.com FF_S3_BUCKET=media \
    FF_S3_ACCESS_KEY=AKEXAMPLE FF_S3_SECRET_KEY=SKEXAMPLE FF_S3_REGION=auto
  [ "$status" -eq 0 ]
  assert_has "$F" "S3_STORAGE=minio"
  assert_has "$F" "S3_ENDPOINT=https://abc.r2.cloudflarestorage.com"
  assert_has "$F" "S3_BUCKET=media"
  assert_has "$F" "S3_ACCESS_KEY=AKEXAMPLE"
  assert_has "$F" "S3_SECRET_KEY=SKEXAMPLE"
  assert_has "$F" "S3_REGION=auto"
  assert_has "$F" "FREEFRAME_STORAGE=s3"
  assert_no_key "$F" S3_PUBLIC_ENDPOINT
  assert_no_key "$F" STORAGE_DOMAIN
  assert_no_key "$F" STORAGE_ROUTED
  assert_no_key "$F" STORAGE_PORT_BIND
}

@test "external AWS S3 uses native s3 mode" {
  run derive FF_HTTPS=off FF_IP=192.168.1.20 FF_STORAGE=s3 \
    FF_S3_ENDPOINT=https://s3.eu-west-1.amazonaws.com FF_S3_BUCKET=media \
    FF_S3_ACCESS_KEY=AK FF_S3_SECRET_KEY=SK FF_S3_REGION=eu-west-1
  [ "$status" -eq 0 ]
  assert_has "$F" "S3_STORAGE=s3"
  assert_has "$F" "S3_ENDPOINT=https://s3.eu-west-1.amazonaws.com"
  rm "$F"
  run derive FF_HTTPS=off FF_IP=192.168.1.20 FF_STORAGE=s3 FF_S3_BUCKET=media2 \
    FF_S3_ACCESS_KEY=AK FF_S3_SECRET_KEY=SK FF_S3_REGION=eu-west-1
  assert_has "$F" "S3_STORAGE=s3"
  assert_no_key "$F" S3_ENDPOINT
}

@test "DATABASE_URL and REDIS_URL embed the generated passwords" {
  run derive FF_HTTPS=off FF_IP=192.168.1.20
  [ "$status" -eq 0 ]
  pg=$(env_get "$F" POSTGRES_PASSWORD)
  rd=$(env_get "$F" REDIS_PASSWORD)
  [[ "$pg" =~ ^[0-9a-f]{64}$ ]]
  [[ "$rd" =~ ^[0-9a-f]{64}$ ]]
  [[ "$(env_get "$F" JWT_SECRET)" =~ ^[0-9a-f]{128}$ ]]
  assert_has "$F" "POSTGRES_USER=freeframe"
  assert_has "$F" "POSTGRES_DB=freeframe"
  assert_has "$F" "DATABASE_URL=postgresql://freeframe:${pg}@postgres:5432/freeframe"
  assert_has "$F" "REDIS_URL=redis://:${rd}@redis:6379/0"
}

@test "an existing password is kept and used in the URL" {
  printf 'POSTGRES_PASSWORD=oldpw\nREDIS_PASSWORD=oldredis\n' > "$F"
  run derive FF_HTTPS=off FF_IP=192.168.1.20
  [ "$status" -eq 0 ]
  assert_has "$F" "POSTGRES_PASSWORD=oldpw"
  assert_has "$F" "DATABASE_URL=postgresql://freeframe:oldpw@postgres:5432/freeframe"
  assert_has "$F" "REDIS_URL=redis://:oldredis@redis:6379/0"
}

@test "MAIL_PROVIDER=smtp even with SMTP skipped" {
  run derive FF_HTTPS=off FF_IP=192.168.1.20
  [ "$status" -eq 0 ]
  assert_has "$F" "MAIL_PROVIDER=smtp"
  assert_no_key "$F" SMTP_HOST
  assert_no_key "$F" SMTP_PASSWORD
}

@test "SMTP answers are written, port 587 uses STARTTLS" {
  run derive FF_HTTPS=off FF_IP=192.168.1.20 FF_SMTP_HOST=smtp.example.com \
    FF_SMTP_USER=mailer 'FF_SMTP_PASSWORD=pa$word' FF_SMTP_FROM=review@example.com
  [ "$status" -eq 0 ]
  assert_has "$F" "MAIL_PROVIDER=smtp"
  assert_has "$F" "SMTP_HOST=smtp.example.com"
  assert_has "$F" "SMTP_PORT=587"
  assert_has "$F" "SMTP_USE_TLS=true"
  assert_has "$F" "SMTP_USER=mailer"
  assert_eq "$(env_get "$F" SMTP_PASSWORD)" 'pa$word'
  assert_has "$F" "MAIL_FROM_ADDRESS=review@example.com"
}

@test "SMTP port 465 uses implicit TLS" {
  run derive FF_HTTPS=off FF_IP=192.168.1.20 FF_SMTP_HOST=smtp.example.com FF_SMTP_PORT=465
  [ "$status" -eq 0 ]
  assert_has "$F" "SMTP_PORT=465"
  assert_has "$F" "SMTP_USE_TLS=false"
}

@test "worker counts come from size_workers" {
  run derive FF_HTTPS=off FF_IP=192.168.1.20
  assert_has "$F" "TRANSCODING_CONCURRENCY=2"
  assert_has "$F" "EMAIL_CONCURRENCY=2"
  assert_has "$F" "MAINTENANCE_CONCURRENCY=1"
  assert_has "$F" "API_WORKERS=4"
}

@test "running derive_env twice leaves the file byte-identical" {
  run derive FF_HTTPS=own FF_DOMAIN=review.example.com FF_ACME_EMAIL=ops@example.com \
    FF_SMTP_HOST=smtp.example.com FF_IP=203.0.113.7
  [ "$status" -eq 0 ]
  cp "$F" "$BATS_TEST_TMPDIR/first"
  run derive FF_HTTPS=own FF_DOMAIN=review.example.com FF_ACME_EMAIL=ops@example.com \
    FF_SMTP_HOST=smtp.example.com FF_IP=203.0.113.7
  [ "$status" -eq 0 ]
  cmp "$BATS_TEST_TMPDIR/first" "$F"
}

@test "derive_env never changes an existing key even when the answers differ" {
  run derive FF_HTTPS=sslip FF_IP=203.0.113.7 FF_ACME_EMAIL=ops@example.com
  cp "$F" "$BATS_TEST_TMPDIR/first"
  run derive FF_HTTPS=own FF_DOMAIN=other.example.com FF_ACME_EMAIL=x@example.com \
    FF_IP=203.0.113.7
  [ "$status" -eq 0 ]
  cmp "$BATS_TEST_TMPDIR/first" "$F"
}

@test "derive_env fills only the keys missing from a copied settings file" {
  printf 'JWT_SECRET=moved-from-old-server\nFRONTEND_URL=https://old.example.com\n' > "$F"
  run derive FF_HTTPS=off FF_IP=192.168.1.20
  [ "$status" -eq 0 ]
  assert_has "$F" "JWT_SECRET=moved-from-old-server"
  assert_has "$F" "FRONTEND_URL=https://old.example.com"
  assert_has "$F" "MAIL_PROVIDER=smtp"
}

@test "size_workers rule: transcoding max(1, min(cores/2, ram/2048)), api min(4, cores)" {
  assert_eq "$(size_workers 1 1024)" \
    "TRANSCODING_CONCURRENCY=1 EMAIL_CONCURRENCY=2 MAINTENANCE_CONCURRENCY=1 API_WORKERS=1"
  assert_eq "$(size_workers 2 4096)" \
    "TRANSCODING_CONCURRENCY=1 EMAIL_CONCURRENCY=2 MAINTENANCE_CONCURRENCY=1 API_WORKERS=2"
  assert_eq "$(size_workers 4 8192)" \
    "TRANSCODING_CONCURRENCY=2 EMAIL_CONCURRENCY=2 MAINTENANCE_CONCURRENCY=1 API_WORKERS=4"
  assert_eq "$(size_workers 8 4096)" \
    "TRANSCODING_CONCURRENCY=2 EMAIL_CONCURRENCY=2 MAINTENANCE_CONCURRENCY=1 API_WORKERS=4"
  assert_eq "$(size_workers 16 65536)" \
    "TRANSCODING_CONCURRENCY=8 EMAIL_CONCURRENCY=2 MAINTENANCE_CONCURRENCY=1 API_WORKERS=4"
}

@test "size_workers rejects input that is not a number" {
  run size_workers four 8192
  [ "$status" -ne 0 ]
}

@test "compose: HTTPS own + bundled storage" {
  printf 'FREEFRAME_HTTPS=own\nFREEFRAME_STORAGE=bundled\n' > "$F"
  assert_eq "$(compose_files "$F")" \
    "-f docker-compose.prod.yml -f docker-compose.images.yml -f docker-compose.https.yml -f docker-compose.storage.yml"
}

@test "compose: HTTPS sslip + external S3" {
  printf 'FREEFRAME_HTTPS=sslip\nFREEFRAME_STORAGE=s3\n' > "$F"
  assert_eq "$(compose_files "$F")" \
    "-f docker-compose.prod.yml -f docker-compose.images.yml -f docker-compose.https.yml"
}

@test "compose: HTTP + bundled storage" {
  printf 'FREEFRAME_HTTPS=off\nFREEFRAME_STORAGE=bundled\n' > "$F"
  assert_eq "$(compose_files "$F")" \
    "-f docker-compose.prod.yml -f docker-compose.images.yml -f docker-compose.storage.yml"
}

@test "compose: HTTP + external S3" {
  printf 'FREEFRAME_HTTPS=off\nFREEFRAME_STORAGE=s3\n' > "$F"
  assert_eq "$(compose_files "$F")" \
    "-f docker-compose.prod.yml -f docker-compose.images.yml"
}

@test "dc runs docker compose from FF_ROOT with the project, env file and file list" {
  printf 'FREEFRAME_HTTPS=own\nFREEFRAME_STORAGE=bundled\n' > "$FF_ROOT/.env.prod"
  docker() { echo "cwd=$PWD"; printf '<%s>' "$@"; echo; }
  cd "$BATS_TEST_TMPDIR"
  run dc up -d web
  [ "$status" -eq 0 ]
  assert_eq "${lines[0]}" "cwd=$FF_ROOT"
  assert_eq "${lines[1]}" "<compose><--project-name><freeframe><--env-file><$FF_ROOT/.env.prod><-f><docker-compose.prod.yml><-f><docker-compose.images.yml><-f><docker-compose.https.yml><-f><docker-compose.storage.yml><up><-d><web>"
  assert_eq "$PWD" "$BATS_TEST_TMPDIR"
}

@test "derive_env with no answers on a complete file changes nothing (update path)" {
  run derive FF_HTTPS=sslip FF_IP=203.0.113.7 FF_ACME_EMAIL=ops@example.com
  [ "$status" -eq 0 ]
  cp "$F" "$BATS_TEST_TMPDIR/first"
  run derive
  [ "$status" -eq 0 ]
  cmp "$BATS_TEST_TMPDIR/first" "$F"
}

@test "derive_env fills a new key from the settings already in the file, not from new answers" {
  run derive FF_HTTPS=sslip FF_IP=203.0.113.7 FF_ACME_EMAIL=ops@example.com
  grep -v '^STORAGE_DOMAIN=' "$F" > "$BATS_TEST_TMPDIR/trimmed"
  cp "$BATS_TEST_TMPDIR/trimmed" "$F"
  run derive FF_HTTPS=own FF_DOMAIN=other.example.com
  [ "$status" -eq 0 ]
  assert_has "$F" "STORAGE_DOMAIN=storage.203-0-113-7.sslip.io"
}

@test "an existing REDIS_URL without a password keeps redis passwordless" {
  printf 'REDIS_PASSWORD=\nREDIS_URL=redis://redis:6379/0\n' > "$F"
  run derive FF_HTTPS=off FF_IP=192.168.1.20
  [ "$status" -eq 0 ]
  assert_has "$F" "REDIS_PASSWORD="
  assert_has "$F" "REDIS_URL=redis://redis:6379/0"
}

@test "external S3 without keys fails before writing anything" {
  run derive FF_HTTPS=off FF_IP=192.168.1.20 FF_STORAGE=s3 FF_S3_BUCKET=media
  [ "$status" -ne 0 ]
  [[ "$output" == *FREEFRAME_S3_ACCESS_KEY* ]]
  [ ! -s "$F" ]
}

@test "the settings file starts with a short explanation" {
  run derive FF_HTTPS=off FF_IP=192.168.1.20
  [[ "$(head -n 1 "$F")" == "# FreeFrame settings"* ]]
  run ls -l "$F"
  [[ "$output" == -rw-------* ]]
}

@test "a copied 644 settings file becomes 600 after derive_env" {
  printf 'JWT_SECRET=moved\n' > "$F"
  chmod 644 "$F"
  run derive FF_HTTPS=off FF_IP=192.168.1.20
  [ "$status" -eq 0 ]
  run ls -l "$F"
  [[ "$output" == -rw-------* ]]
}

@test "an empty 644 settings file becomes 600 after derive_env" {
  : > "$F"
  chmod 644 "$F"
  run derive FF_HTTPS=off FF_IP=192.168.1.20
  [ "$status" -eq 0 ]
  run ls -l "$F"
  [[ "$output" == -rw-------* ]]
}

# derive_with_secret STUB: derive_env with gen_secret replaced by STUB.
derive_with_secret() {
  env FF_HTTPS=off FF_IP=192.168.1.20 FF_CORES="$FF_CORES" FF_RAM_MB="$FF_RAM_MB" \
    bash -c 'set -Eeuo pipefail; source "$1"; eval "$3"; derive_env "$2"' \
    ff-derive "$FF_SCRIPT" "$F" "$1"
}

@test "a failing gen_secret stops derive_env loudly and no URL gets an empty password" {
  run derive_with_secret 'gen_secret() { return 1; }'
  [ "$status" -ne 0 ]
  [[ "$output" == *"Could not generate a random POSTGRES_PASSWORD"* ]]
  assert_no_key "$F" DATABASE_URL
  assert_no_key "$F" POSTGRES_PASSWORD
}

@test "an empty gen_secret result stops derive_env loudly" {
  run derive_with_secret 'gen_secret() { :; }'
  [ "$status" -ne 0 ]
  [[ "$output" == *"Could not generate a random POSTGRES_PASSWORD"* ]]
  assert_no_key "$F" DATABASE_URL
}

@test "a short gen_secret result stops derive_env loudly" {
  run derive_with_secret 'gen_secret() { echo abc; }'
  [ "$status" -ne 0 ]
  assert_no_key "$F" DATABASE_URL
}

@test "derive_env stops at the first failed write, even when called inside if" {
  run env FF_HTTPS=off FF_IP=192.168.1.20 FF_CORES=4 FF_RAM_MB=8192 bash -c 'source "$1"
    gen_secret() { return 1; }
    if derive_env "$2"; then echo "derive said ok"; else echo "derive failed"; fi' \
    ff-derive "$FF_SCRIPT" "$F"
  [[ "$output" == *"Could not generate a random POSTGRES_PASSWORD"* ]]
  [[ "$output" == *"derive failed"* ]]
  assert_no_key "$F" DATABASE_URL
}

@test "derive_env keeps an export-prefixed JWT_SECRET from a copied file and adds no second one" {
  printf 'export JWT_SECRET=x\n' > "$F"
  run derive FF_HTTPS=off FF_IP=192.168.1.20
  [ "$status" -eq 0 ]
  assert_eq "$(grep -c 'JWT_SECRET' "$F")" "1"
  assert_has "$F" "export JWT_SECRET=x"
}

@test "derive_env refuses a web address that is not a plain host name, naming it" {
  local long d
  long=$(printf 'a%.0s' {1..63}).$(printf 'b%.0s' {1..63}).$(printf 'c%.0s' {1..63}).$(printf 'd%.0s' {1..62})
  [ "${#long}" -eq 254 ]
  for d in https://review.example.com review.example.com:8443 review.example.com/x \
    'review example.com' 'a`b.example.com' -bad.example.com bad-.example.com a..b \
    review.example.com. 'review.example.com ' "$long" 'r_v.example.com' 'review.exa$mple.com'; do
    rm -f "$F"
    run derive FF_HTTPS=own FF_DOMAIN="$d" FF_ACME_EMAIL=ops@example.com FF_IP=203.0.113.7
    if [ "$status" -eq 0 ] || [[ "$output" != *"'$d'"* ]] || [ -s "$F" ]; then
      echo "accepted or not named: [$d] status=$status output=$output"
      return 1
    fi
  done
}

@test "derive_env accepts plain host names" {
  local ok
  ok=$(printf 'a%.0s' {1..63}).$(printf 'b%.0s' {1..63}).$(printf 'c%.0s' {1..63}).$(printf 'd%.0s' {1..61})
  [ "${#ok}" -eq 253 ]
  for d in Review-1.Example.com nas "$ok" xn--bcher-kva.example; do
    rm -f "$F"
    run derive FF_HTTPS=own FF_DOMAIN="$d" FF_ACME_EMAIL=ops@example.com FF_IP=203.0.113.7
    [ "$status" -eq 0 ] || { echo "rejected: $d: $output"; return 1; }
  done
}

@test "HTTP mode checks a typed host name too" {
  run derive FF_HTTPS=off FF_DOMAIN='http://nas.local'
  [ "$status" -ne 0 ]
  [[ "$output" == *"'http://nas.local'"* ]]
}

@test "sslip mode needs a public IPv4 and names the address it got" {
  run derive FF_HTTPS=sslip FF_IP=192.168.1.20
  [ "$status" -ne 0 ]
  [[ "$output" == *"'192.168.1.20'"* ]]
  [ ! -s "$F" ]
  run derive FF_HTTPS=sslip FF_IP=999.1.1.1
  [ "$status" -ne 0 ]
  [[ "$output" == *"'999.1.1.1'"* ]]
}
