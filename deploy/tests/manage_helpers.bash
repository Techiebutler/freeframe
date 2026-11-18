# Shared setup for update.bats, configure.bats and manage.bats: a server
# that `freeframe install` has set up, and a fake repository ($STUB_REMOTE)
# the channel's files are downloaded from. Side effects are stubbed in
# manage_stubs.bash.
#
# shellcheck disable=SC2034,SC2016,SC2154
# (SC2034: the FF_* answers are read by derive_env and BK by the tests;
# SC2016: ${FREEFRAME_VERSION:-...} is written to the file literally;
# SC2154: bats' run sets $output.)

load helpers

manage_setup() {
  common_setup
  export STUB_DIR="$BATS_TEST_TMPDIR"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  : >"$CALLS"
  STUBS="${BATS_TEST_DIRNAME}/manage_stubs.bash"
  ENV="$FF_ROOT/.env.prod"
  BK="$FF_ROOT/backups"
  export FF_BIN_DIR="$BATS_TEST_TMPDIR/bin-dir"
  export FF_SYSTEMD_DIR="$BATS_TEST_TMPDIR/systemd-dir"
  export STUB_REMOTE="$BATS_TEST_TMPDIR/remote"
  export FF_CORES=4 FF_RAM_MB=8192
}

# ff ARGS...: run `freeframe ARGS` with the stubs, under strict mode.
ff() {
  run bash -c 'set -Eeuo pipefail; source "$1"; source "$2"; shift 2; main "$@"' \
    ff-run "$FF_SCRIPT" "$STUBS" "$@"
}

# remote_release VERSION: what the channel's ref holds: the compose files
# (the images file's default is VERSION), the backup units and this script.
remote_release() {
  local v=$1 r=$STUB_REMOTE
  mkdir -p "$r/deploy/systemd"
  printf 'services:\n  api: {}\n' >"$r/docker-compose.prod.yml"
  printf 'services:\n  api:\n    image: ghcr.io/techiebutler/freeframe-api:${FREEFRAME_VERSION:-%s}\n  web:\n    image: ghcr.io/techiebutler/freeframe-web:${FREEFRAME_VERSION:-%s}\n' \
    "$v" "$v" >"$r/docker-compose.images.yml"
  printf 'services: {}\n' >"$r/docker-compose.https.yml"
  printf 'services: {}\n' >"$r/docker-compose.storage.yml"
  printf '[Unit]\nDescription=FreeFrame backup (%s)\n' "$v" >"$r/deploy/systemd/freeframe-backup.service"
  printf '[Timer]\nOnCalendar=*-*-* 03:00\n# %s\n' "$v" >"$r/deploy/systemd/freeframe-backup.timer"
  cp "$FF_SCRIPT" "$r/deploy/freeframe"
}

# installed_server [MODE] [STORAGE] [VERSION]: a server `freeframe install`
# finished: settings derived the real way, the files of VERSION in place,
# the command installed and the .installed marker written. The remote then
# holds the same release until a test calls remote_release again.
installed_server() {
  local mode=${1:-sslip} storage=${2:-bundled} v=${3:-1.21.0} f
  (
    FF_IP=203.0.113.7 FF_HTTPS=$mode FF_STORAGE=$storage FF_CHANNEL=latest
    FF_ACME_EMAIL=certs@example.com
    if [[ $mode == own ]]; then FF_DOMAIN=review.yourstudio.com; fi
    if [[ $storage == s3 ]]; then
      FF_S3_ENDPOINT=https://acct.r2.cloudflarestorage.com FF_S3_BUCKET=media
      FF_S3_ACCESS_KEY=AKOLD FF_S3_SECRET_KEY=old-secret FF_S3_REGION=auto
    fi
    derive_env "$ENV"
  ) || return 1
  remote_release "$v"
  for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml; do
    cp "$STUB_REMOTE/$f" "$FF_ROOT/$f"
  done
  mkdir -p "$FF_ROOT/systemd" "$FF_BIN_DIR" "$FF_SYSTEMD_DIR"
  cp "$STUB_REMOTE"/deploy/systemd/* "$FF_ROOT/systemd/"
  # In systemd too, as install leaves them.
  cp "$STUB_REMOTE"/deploy/systemd/* "$FF_SYSTEMD_DIR/"
  install -m 755 "$FF_SCRIPT" "$FF_BIN_DIR/freeframe"
  printf 'FreeFrame installed\n' >"$FF_ROOT/.installed"
}

SECRET_KEYS="POSTGRES_PASSWORD REDIS_PASSWORD JWT_SECRET DATABASE_URL REDIS_URL S3_ACCESS_KEY S3_SECRET_KEY"

# assert_secrets_same OLD NEW: every generated secret's line is byte for byte
# the same in both files.
assert_secrets_same() {
  local k
  for k in $SECRET_KEYS; do
    if [[ "$(grep "^$k=" "$1")" != "$(grep "^$k=" "$2")" ]]; then
      echo "secret $k changed"
      return 1
    fi
  done
}

# changed_keys OLD NEW: the keys whose value differs, sorted, space-separated.
changed_keys() {
  local k out=""
  for k in $({ grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$1"; grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$2"; } |
    tr -d = | LC_ALL=C sort -u); do
    if [[ "$(env_get "$1" "$k")" != "$(env_get "$2" "$k")" ]]; then out+="$k "; fi
  done
  printf '%s' "${out% }"
}

assert_order() {
  local last=0 pat n
  for pat in "$@"; do
    n=$(grep -n -F -- "$pat" "$CALLS" | awk -F: -v l="$last" '$1 > l { print $1; exit }')
    if [[ -z $n ]]; then
      echo "not found after line $last: $pat"
      echo "--- calls ---"
      cat "$CALLS"
      return 1
    fi
    last=$n
  done
}

assert_not_called() {
  if grep -q -F -- "$1" "$CALLS"; then
    echo "unexpected call: $1"
    cat "$CALLS"
    return 1
  fi
}

# assert_no_dc_change: no docker compose call other than reading which image
# the api runs (dc ps --format {{.Image}} api), which changes nothing.
assert_no_dc_change() {
  local l
  l=$(grep '^dc ' "$CALLS" | grep -vxF 'dc ps --format {{.Image}} api' || true)
  if [[ -n $l ]]; then
    echo "unexpected docker compose calls:"
    echo "$l"
    return 1
  fi
}

assert_out() {
  if [[ $output != *"$1"* ]]; then
    echo "expected output to contain: $1"
    echo "--- output ---"
    echo "$output"
    return 1
  fi
}

assert_no_out() {
  if [[ $output == *"$1"* ]]; then
    echo "expected output not to contain: $1"
    echo "--- output ---"
    echo "$output"
    return 1
  fi
}

# env_backups: the .env.prod.<stamp> copies, oldest first.
env_backups() { (cd "$FF_ROOT" && LC_ALL=C ls .env.prod.2* 2>/dev/null) || true; }

# ff_signal SIG STEP ARGS...: run `freeframe ARGS` in its own session, wait
# until the stubbed STEP hangs (_stub_hang STEP), then send SIG to the whole
# process group, as Ctrl-C, a closed SSH session or systemctl stop do.
ff_signal() {
  local sig=$1 step=$2 pid n=0
  shift 2
  command -v setsid >/dev/null || skip "no setsid"
  setsid bash -c 'set -Eeuo pipefail; source "$1"; source "$2"; shift 2; main "$@"' \
    ff-run "$FF_SCRIPT" "$STUBS" "$@" >"$BATS_TEST_TMPDIR/out" 2>&1 &
  pid=$!
  while [[ ! -e $STUB_DIR/hanging-$step ]]; do
    sleep 0.1
    n=$((n + 1))
    if ((n > 150)); then
      echo "the step $step never started"
      cat "$BATS_TEST_TMPDIR/out"
      return 1
    fi
  done
  kill -"$sig" -- -"$(cat "$STUB_DIR/pgid")"
  status=0
  wait "$pid" || status=$?
  output=$(cat "$BATS_TEST_TMPDIR/out")
}
