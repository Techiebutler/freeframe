#!/usr/bin/env bash
# ============================================================
# The installer's end-to-end run on a GitHub Actions Ubuntu runner
# (.github/workflows/ci.yml, job installer-e2e). Each workflow step runs one
# phase:
#
#   prepare         check the runner, make the admin password (masked)
#   foreign         a FreeFrame set up by hand is refused: exit 3, nothing written
#   build           build both prod images from the checkout, tagged :ci
#   install         freeframe install --yes, HTTP mode, bundled storage
#   api             health, admin sign-in, a first project
#   backup-restore  backup, a second project, restore: only the first is left
#   update          update at the same version: secrets unchanged
#   rerun           install again: "already installed", .env.prod unchanged
#   status          freeframe status exits 0 and reports a healthy install
#   diagnose        on failure: containers, install.log, logs, health
#
# NEVER run this on a workstation: it uses sudo, writes /opt/freeframe and
# /usr/local/bin/freeframe, and starts a compose project named freeframe
# (the name a dev FreeFrame uses too). It refuses to run outside GitHub
# Actions.
#
# The test-only switches of deploy/freeframe it relies on:
#   FREEFRAME_VERSION=ci   the image tag (passed to every freeframe command:
#                          without it compose would resolve the published
#                          release's images and pull them)
#   FF_SKIP_PULL=1         no `docker compose pull`: the :ci images are local
#   FF_FETCH_FROM_DIR=DIR  setup files and the freeframe command are copied
#                          from the checkout instead of downloaded
# Secrets never go on a command line: the admin password reaches the
# installer as FREEFRAME_ADMIN_PASSWORD, and JSON bodies are built by jq from
# the environment.
# ============================================================
set -Eeuo pipefail

ROOT=/opt/freeframe
ENV_FILE=$ROOT/.env.prod
BIN=/usr/local/bin/freeframe
API=http://localhost/api
WEB=http://localhost
API_IMAGE=ghcr.io/techiebutler/freeframe-api:ci
WEB_IMAGE=ghcr.io/techiebutler/freeframe-web:ci
# The secrets install generates (derive_env). Every one must be there.
# The exact line install prints when it finds a finished install.
ALREADY_INSTALLED="FreeFrame is already installed on this server, so nothing was changed."
SECRET_KEYS=(POSTGRES_PASSWORD DATABASE_URL REDIS_PASSWORD REDIS_URL JWT_SECRET S3_ACCESS_KEY S3_SECRET_KEY)

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '::error::%s\n' "$*"
  exit 1
}
pass() { printf 'ok: %s\n' "$*"; }

if [[ ${GITHUB_ACTIONS:-} != true || -z ${RUNNER_TEMP:-} || -z ${GITHUB_WORKSPACE:-} ]]; then
  echo "ci-e2e.sh only runs on a GitHub Actions runner: it uses sudo, writes /opt/freeframe and starts a compose project named freeframe." >&2
  exit 2
fi

# State shared between the steps (project ids, the auth header, outputs).
WORK=$RUNNER_TEMP/ff-e2e
mkdir -p "$WORK"
chmod 700 "$WORK"

# ff ARGS: an installed freeframe command, as root, with only the test-only
# switches in its environment (sudo resets the rest, so no FREEFRAME_* answer
# reaches update, which refuses answers).
ff() {
  sudo env FREEFRAME_VERSION=ci FF_SKIP_PULL=1 FF_FETCH_FROM_DIR="$GITHUB_WORKSPACE" "$BIN" "$@"
}

# run_install SCRIPT: the install command as the e2e runs it: SCRIPT (the
# checkout's deploy/freeframe, or the installed command), the answers in the
# environment (the password never in argv), the address mode and storage as
# options.
run_install() {
  : "${E2E_ADMIN_PASSWORD:?run the prepare phase first}"
  FREEFRAME_VERSION=ci FF_SKIP_PULL=1 FF_FETCH_FROM_DIR=$GITHUB_WORKSPACE \
    FREEFRAME_ADMIN_EMAIL=$E2E_ADMIN_EMAIL FREEFRAME_ADMIN_NAME=CI \
    FREEFRAME_ADMIN_PASSWORD=$E2E_ADMIN_PASSWORD \
    sudo -E "$1" install --yes --https off --storage bundled
}

# capture NAME CMD...: run CMD, show its output live, keep it in
# $WORK/NAME.out, and set RC to its exit code (without stopping on failure).
capture() {
  local name=$1
  shift
  set +e
  "$@" 2>&1 | tee "$WORK/$name.out"
  RC=${PIPESTATUS[0]}
  set -e
  OUT=$(<"$WORK/$name.out")
}

expect_rc() {
  local want=$1 what=$2
  if [[ $RC != "$want" ]]; then
    fail "$what exited $RC, expected $want (its output is above)"
  fi
  pass "$what exited $want"
}

# The output checks match whole lines, never substrings: a loose substring
# can be tripped by a normal line ("Docker is already installed; using it."
# contains "already installed"), or satisfied by the wrong one.

# has_line LINE: LINE is exactly one of the lines of OUT.
has_line() { grep -qxF -- "$1" <<<"$OUT"; }

# has_line_re REGEX: a line of OUT matches the extended REGEX (anchor it).
has_line_re() { grep -qE -- "$1" <<<"$OUT"; }

expect_line() {
  local line=$1 what=$2
  has_line "$line" || fail "$what did not print the line: $line"
  pass "$what printed: $line"
}

expect_line_re() {
  local re=$1 what=$2
  has_line_re "$re" || fail "$what printed no line matching: $re"
  pass "$what printed a line matching: $re"
}

# mask_env_secrets: tell the runner to mask every secret in .env.prod, so a
# later step that prints logs (diagnose) never shows one.
mask_env_secrets() {
  local v
  sudo test -r "$ENV_FILE" || return 0
  while IFS= read -r v; do
    # Masked late (after install), which is fine: throwaway values; phase_install's install.log grep guards regressions.
    printf '::add-mask::%s\n' "$v"
  done < <(secret_values)
}

# secret_values: each secret's value from .env.prod, one per line (empty
# values left out, so the list is safe as grep -F patterns).
secret_values() {
  local key
  for key in "${SECRET_KEYS[@]}"; do sudo sed -n "s/^${key}=\(..*\)\$/\1/p" "$ENV_FILE"; done
}

# secret_lines_hash: SECRETS_HASH, the sha256 of the secret lines of
# .env.prod, after checking that each secret is there exactly once and not
# empty (so the comparison is never between two empty sets). Not run in a
# $(...), so a failure here reaches the log.
secret_lines_hash() {
  local key n pattern
  for key in "${SECRET_KEYS[@]}"; do
    n=$(sudo grep -cE "^${key}=.+" "$ENV_FILE" || true)
    [[ $n == 1 ]] || fail "$ENV_FILE has ${n:-no} non-empty $key lines, expected 1"
  done
  pattern=$(IFS='|' && printf '%s' "${SECRET_KEYS[*]}")
  SECRETS_HASH=$(sudo grep -E "^($pattern)=" "$ENV_FILE" | sha256sum | cut -d' ' -f1)
}

file_hash() { sudo sha256sum "$1" | cut -d' ' -f1; }

# assert_ci_images: every FreeFrame container runs the image built from this
# checkout, never a published one pulled by mistake.
assert_ci_images() {
  local lines svc img state want n=0 bad=0
  lines=$(docker ps --filter label=com.docker.compose.project=freeframe \
    --format '{{.Label "com.docker.compose.service"}} {{.Image}} {{.State}}')
  while read -r svc img state; do
    case $svc in
      api | worker | email_worker | maintenance_worker | beat) want=$API_IMAGE ;;
      web) want=$WEB_IMAGE ;;
      *) continue ;;
    esac
    n=$((n + 1))
    if [[ $img != "$want" || $state != running ]]; then
      say "  $svc runs $img ($state), expected $want (running)"
      bad=1
    fi
  done <<<"$lines"
  if ((bad || n != 6)); then
    docker ps -a --filter label=com.docker.compose.project=freeframe
    fail "expected the 6 FreeFrame app containers running the :ci images, found $n (see above)"
  fi
  pass "the 6 app containers run the :ci images built from this checkout"
}

# wait_health: FreeFrame answers through Traefik on port 80.
wait_health() {
  local i
  for ((i = 0; i < 90; i++)); do
    if curl -fsS --max-time 5 -o /dev/null "$API/health" 2>/dev/null; then
      pass "$API/health answers"
      return 0
    fi
    sleep 2
  done
  curl -sS -i --max-time 5 "$API/health" || true
  fail "$API/health did not answer within 3 minutes"
}

# wait_web: the web UI answers /login with 200 through Traefik. /login, not
# /, because / redirects (to /login or /projects), and a redirect would pass
# curl -f without proving the page renders.
wait_web() {
  local i code=""
  for ((i = 0; i < 90; i++)); do
    code=$(curl -fsS --max-time 10 -o /dev/null -w '%{http_code}' "$WEB/login" 2>/dev/null) || code=""
    if [[ $code == 200 ]]; then
      pass "$WEB/login answers 200"
      return 0
    fi
    sleep 2
  done
  curl -sS -i --max-time 10 "$WEB/login" | head -n 20 || true
  fail "$WEB/login did not answer 200 within 3 minutes (last answer: ${code:-none})"
}

# api_call NAME METHOD PATH [JSON_FILE]: an authenticated request; the body
# goes to $WORK/NAME.json, the status code is checked by the caller.
api_call() {
  local name=$1 method=$2 path=$3 body=${4:-}
  local -a args=(-sS --max-time 30 -o "$WORK/$name.json" -w '%{http_code}' -X "$method"
    -H @"$WORK/auth.hdr" "$API$path")
  if [[ -n $body ]]; then args+=(-H 'Content-Type: application/json' --data-binary @"$body"); fi
  # 000 when curl got no answer at all; curl says why on stderr.
  curl "${args[@]}" || true
}

# login: sign in as the admin; the token is masked and kept in a header file,
# so it is never on a command line either.
login() {
  local code token
  jq -n '{email: env.E2E_ADMIN_EMAIL, password: env.E2E_ADMIN_PASSWORD}' >"$WORK/login-body.json"
  code=$(curl -sS --max-time 30 -o "$WORK/login.json" -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' --data-binary @"$WORK/login-body.json" "$API/auth/login") || true
  rm -f "$WORK/login-body.json"
  if [[ $code != 200 ]]; then
    say "POST /api/auth/login answered $code:"
    jq -c 'del(.access_token, .refresh_token)' "$WORK/login.json" 2>/dev/null || cat "$WORK/login.json"
    fail "the admin could not sign in (HTTP $code)"
  fi
  token=$(jq -r '.access_token // empty' "$WORK/login.json")
  [[ -n $token ]] || fail "the login answer has no access_token"
  printf '::add-mask::%s\n' "$token"
  printf '::add-mask::%s\n' "$(jq -r '.refresh_token // empty' "$WORK/login.json")"
  (umask 077 && printf 'Authorization: Bearer %s\n' "$token" >"$WORK/auth.hdr")
  rm -f "$WORK/login.json"
  pass "the admin signed in through POST /api/auth/login"
}

# create_project NAME: create it, keep its id in $WORK/NAME.id.
create_project() {
  local name=$1 code id
  NAME=$name jq -n '{name: env.NAME}' >"$WORK/project-body.json"
  code=$(api_call "create-$name" POST /projects "$WORK/project-body.json")
  if [[ $code != 201 ]]; then
    cat "$WORK/create-$name.json"
    fail "creating project $name answered HTTP $code, expected 201"
  fi
  id=$(jq -r '.id // empty' "$WORK/create-$name.json")
  [[ -n $id ]] || fail "the answer for project $name has no id"
  printf '%s\n' "$id" >"$WORK/$name.id"
  pass "created project $name ($id)"
}

# list_projects: GET /api/projects; the names, one per line, go to
# $WORK/projects.txt and are shown.
list_projects() {
  local code
  code=$(api_call projects GET /projects)
  if [[ $code != 200 ]]; then
    cat "$WORK/projects.json"
    fail "GET /api/projects answered HTTP $code"
  fi
  jq -r '.[].name' "$WORK/projects.json" >"$WORK/projects.txt"
  sed 's/^/  project: /' "$WORK/projects.txt"
}

# has_project NAME: NAME is in the last list_projects.
has_project() { grep -qxF -- "$1" "$WORK/projects.txt"; }

# ------------------------------------------------------------
# Phases
# ------------------------------------------------------------

phase_prepare() {
  local pw v
  step "The runner"
  grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
  say "kernel $(uname -r), $(nproc) cores, $(awk '/MemTotal/ { print int($2 / 1024) " MB" }' /proc/meminfo)"
  df -h / | tail -n 1
  v=$(docker version --format '{{.Server.Version}}')
  say "docker $v, $(docker compose version)"
  ((10#${v%%.*} >= 24)) || fail "the runner has Docker $v; the e2e expects Docker 24 or newer, so the installer would try to install Docker"
  command -v jq >/dev/null || fail "jq is missing on the runner"
  if sudo test -e "$ROOT"; then fail "$ROOT exists before the e2e started"; fi
  if [[ -e $BIN ]]; then fail "$BIN exists before the e2e started"; fi
  if sudo ss -Hltn '( sport = :80 or sport = :443 or sport = :9000 )' | grep -q .; then
    sudo ss -ltnp
    fail "port 80, 443 or 9000 is already in use on the runner"
  fi
  pass "ports 80, 443 and 9000 are free"

  step "The admin password"
  pw=$(openssl rand -hex 16)
  printf '::add-mask::%s\n' "$pw"
  printf 'E2E_ADMIN_PASSWORD=%s\n' "$pw" >>"$GITHUB_ENV"
  pass "made a random admin password (masked) for the later steps"
}

phase_foreign() {
  local dir rc
  step "A compose project named freeframe, set up by hand elsewhere, with a freeframe_pgdata volume"
  dir=$(mktemp -d)
  cat >"$dir/compose.yml" <<'EOF'
services:
  postgres:
    image: busybox:1.36
    command: ["sleep", "3600"]
    volumes:
      - pgdata:/data
volumes:
  pgdata:
EOF
  docker compose --project-name freeframe -f "$dir/compose.yml" up -d --quiet-pull
  docker volume inspect freeframe_pgdata --format 'volume {{.Name}} (project {{index .Labels "com.docker.compose.project"}})'

  step "freeframe install must refuse it"
  capture foreign run_install "$GITHUB_WORKSPACE/deploy/freeframe"
  rc=$RC
  # Cleaned up before any assertion can stop the step: the real install
  # would take a leftover freeframe_pgdata for a foreign install too.
  docker compose --project-name freeframe -f "$dir/compose.yml" down -v --remove-orphans
  rm -rf "$dir"
  RC=$rc
  expect_rc 3 "install next to a FreeFrame set up by hand"
  expect_line "This server already runs FreeFrame that was set up by hand, not with this installer. The installer will not touch it, so nothing was changed." "install"
  if sudo test -e "$ENV_FILE"; then fail "the refused install wrote $ENV_FILE"; fi
  if sudo test -e "$ROOT/install.log"; then fail "the refused install wrote $ROOT/install.log"; fi
  if [[ -e $BIN ]]; then fail "the refused install installed $BIN"; fi
  pass "no $ENV_FILE, no install.log and no freeframe command were written"
  if docker volume inspect freeframe_pgdata >/dev/null 2>&1; then fail "the foreign freeframe_pgdata volume is still there"; fi
  pass "the foreign project is removed again"
}

phase_build() {
  step "API image ($API_IMAGE)"
  docker build --progress=plain -t "$API_IMAGE" -f apps/api/Dockerfile.prod .
  step "Web image ($WEB_IMAGE)"
  # No build args, as the release workflow builds it (NEXT_PUBLIC_API_URL=/api).
  docker build --progress=plain -t "$WEB_IMAGE" -f apps/web/Dockerfile.prod apps/web
  docker image ls 'ghcr.io/techiebutler/*'
}

phase_install() {
  local n
  step "sudo -E ./deploy/freeframe install --yes --https off --storage bundled"
  capture install run_install "$GITHUB_WORKSPACE/deploy/freeframe"
  expect_rc 0 "install"
  mask_env_secrets
  if has_line "$ALREADY_INSTALLED"; then fail "a first install said: $ALREADY_INSTALLED"; fi
  expect_line_re '^FreeFrame is ready: http://[^ ]+$' "install"
  sudo test -f "$ROOT/.installed" || fail "install did not write $ROOT/.installed"
  [[ $(sudo stat -c %a "$ENV_FILE") == 600 ]] || fail "$ENV_FILE is mode $(sudo stat -c %a "$ENV_FILE"), expected 600"
  pass "$ENV_FILE is mode 600 and the install is marked finished"
  [[ -x $BIN ]] || fail "install did not install $BIN"
  pass "the freeframe command is installed at $BIN"
  say "address: $(sudo sed -n 's/^FRONTEND_URL=//p' "$ENV_FILE")"
  assert_ci_images
  wait_web
  # Neither the admin password nor a generated secret is in install.log.
  # grep -c reads the whole log, so no SIGPIPE can turn a match into a miss.
  sudo test -s "$ROOT/install.log" || fail "install did not write $ROOT/install.log"
  (umask 077 && { printf '%s\n' "$E2E_ADMIN_PASSWORD" && secret_values; } >"$WORK/secrets.txt")
  n=$(sudo cat "$ROOT/install.log" | grep -cF -f "$WORK/secrets.txt" || true)
  rm -f "$WORK/secrets.txt"
  [[ $n == 0 ]] || fail "install.log has $n lines with the admin password or a secret from .env.prod"
  pass "install.log holds no secret"
}

phase_api() {
  step "curl -fsS $API/health"
  curl -fsS --max-time 10 "$API/health"
  echo
  step "Sign in and create a project"
  login
  create_project ci-first
  list_projects
  has_project ci-first || fail "GET /api/projects does not list ci-first"
  pass "GET /api/projects lists ci-first"
}

phase_backup_restore() {
  local dump
  step "sudo freeframe backup"
  capture backup ff backup
  expect_rc 0 "backup"
  dump=$(sed -n 's/^Saved a backup of the database: \(.*\.dump\) (.*$/\1/p' <<<"$OUT" | tail -n 1)
  [[ -n $dump ]] || fail "backup did not name the file it saved"
  sudo test -s "$dump" || fail "the backup $dump is missing or empty"
  pass "backup saved $dump"

  step "A second project, made after the backup"
  login
  create_project ci-second
  list_projects
  has_project ci-second || fail "GET /api/projects does not list ci-second"
  pass "GET /api/projects lists ci-second"

  step "sudo freeframe restore --yes $dump"
  capture restore ff restore --yes "$dump"
  expect_rc 0 "restore"
  wait_health
  wait_web
  assert_ci_images

  step "Only the project from before the backup is left"
  login
  list_projects
  has_project ci-first || fail "after the restore, ci-first (made before the backup) is gone"
  pass "ci-first is there"
  if has_project ci-second; then fail "after the restore, ci-second (made after the backup) is still there"; fi
  pass "ci-second is gone"
  [[ $(jq -r --arg n ci-first '.[] | select(.name == $n) | .id' "$WORK/projects.json") == "$(<"$WORK/ci-first.id")" ]] ||
    fail "ci-first has another id after the restore"
  pass "ci-first keeps its id"
}

phase_update() {
  local before after
  step "sudo freeframe update at the same version"
  secret_lines_hash
  before=$SECRETS_HASH
  capture update ff update
  expect_rc 0 "update"
  expect_line_re '^FreeFrame is already on the newest release of the latest channel \([^)]+\); its setup files and images were refreshed\.$' "update"
  secret_lines_hash
  after=$SECRETS_HASH
  [[ $before == "$after" ]] || fail "update changed a secret in $ENV_FILE (sha256 of the ${#SECRET_KEYS[@]} secret lines differs)"
  pass "the ${#SECRET_KEYS[@]} secret lines of $ENV_FILE are unchanged (sha256 $before)"
  wait_health
  assert_ci_images
  login
  list_projects
  has_project ci-first || fail "after the update, ci-first is gone"
  pass "ci-first is still there after the update"
}

phase_rerun() {
  local before after
  step "The same install command again"
  before=$(file_hash "$ENV_FILE")
  capture rerun run_install "$BIN"
  expect_rc 0 "a second install"
  expect_line "$ALREADY_INSTALLED" "a second install"
  expect_line "To move to the newest release, run: sudo freeframe update" "a second install"
  after=$(file_hash "$ENV_FILE")
  [[ $before == "$after" ]] || fail "a second install changed $ENV_FILE"
  pass "$ENV_FILE is byte-identical (sha256 $before)"
}

phase_status() {
  step "sudo freeframe status"
  capture status ff status
  expect_rc 0 "status"
  expect_line "  Health:       FreeFrame answers at its web address" "status"
  # A part row is "  <service padded> not created".
  if has_line_re '^  [A-Za-z0-9_-]+ +not created$'; then fail "status lists a part of FreeFrame as not created"; fi
  pass "status lists every part as created"
}

# Everything here may fail on its own; it never stops the rest.
phase_diagnose() {
  set +e
  mask_env_secrets
  if [[ -n ${E2E_ADMIN_PASSWORD:-} ]]; then printf '::add-mask::%s\n' "$E2E_ADMIN_PASSWORD"; fi
  echo "::group::docker ps -a"
  docker ps -a
  echo "::endgroup::"
  echo "::group::$ROOT"
  sudo ls -la "$ROOT" "$ROOT/backups"
  echo "::endgroup::"
  echo "::group::$ROOT/install.log (last 400 lines)"
  sudo tail -n 400 "$ROOT/install.log"
  echo "::endgroup::"
  echo "::group::freeframe logs (last 200 lines of each part)"
  if [[ -x $BIN ]] && sudo test -f "$ENV_FILE"; then
    # freeframe logs follows; timeout ends it once the tails are out.
    timeout 60 sudo env FREEFRAME_VERSION=ci "$BIN" logs
  else
    for c in $(docker ps -aq); do
      echo "--- $(docker inspect --format '{{.Name}} {{.Config.Image}}' "$c")"
      docker logs --tail 200 "$c" 2>&1
    done
  fi
  echo "::endgroup::"
  echo "::group::freeframe status"
  [[ -x $BIN ]] && timeout 120 sudo env FREEFRAME_VERSION=ci "$BIN" status
  echo "::endgroup::"
  echo "::group::GET $API/health"
  curl -sS -i --max-time 10 "$API/health"
  echo
  echo "::endgroup::"
  echo "::group::listening ports"
  sudo ss -ltnp
  echo "::endgroup::"
  return 0
}

case ${1:-} in
  prepare) phase_prepare ;;
  foreign) phase_foreign ;;
  build) phase_build ;;
  install) phase_install ;;
  api) phase_api ;;
  backup-restore) phase_backup_restore ;;
  update) phase_update ;;
  rerun) phase_rerun ;;
  status) phase_status ;;
  diagnose) phase_diagnose ;;
  *)
    echo "usage: ci-e2e.sh prepare|foreign|build|install|api|backup-restore|update|rerun|status|diagnose" >&2
    exit 2
    ;;
esac
