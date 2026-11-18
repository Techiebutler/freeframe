#!/usr/bin/env bats
# `freeframe install` end to end, with every side effect stubbed
# (install_stubs.bash), and the install.sh bootstrap.
#
# The flow runs in a fresh bash under the script's own strict mode, exactly
# as `sudo freeframe install` would, with the stubs sourced on top. Answers
# come from FREEFRAME_* variables, flags or a fake terminal file (FF_TTY).

load helpers

setup() {
  common_setup
  export STUB_DIR="$BATS_TEST_TMPDIR"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  : >"$CALLS"
  STUBS="${BATS_TEST_DIRNAME}/install_stubs.bash"
  export FF_OS_RELEASE="$BATS_TEST_TMPDIR/os-release"
  os_release ubuntu 24.04 noble
  export FF_CORES=4 FF_RAM_MB=8192
  # Where `install` puts the freeframe command (never the real /usr/local/bin).
  export FF_BIN_DIR="$BATS_TEST_TMPDIR/bin-dir"
  ENV="$FF_ROOT/.env.prod"
}

os_release() {
  printf 'PRETTY_NAME="%s %s"\nID=%s\nVERSION_ID="%s"\nVERSION_CODENAME=%s\n' \
    "$1" "$2" "$1" "$2" "$3" >"$FF_OS_RELEASE"
}

# ff_install ARGS...: run `freeframe install ARGS` with the stubs.
ff_install() {
  run bash -c 'set -Eeuo pipefail; source "$1"; source "$2"; shift 2; main "$@"' \
    ff-install "$FF_SCRIPT" "$STUBS" install "$@"
}

# The answers of a typical unattended run (plain HTTP, bundled storage).
plain_answers() {
  export FREEFRAME_HTTPS=off
  export FREEFRAME_ADMIN_NAME="Ada Admin"
  export FREEFRAME_ADMIN_EMAIL=admin@example.com
  export FREEFRAME_ADMIN_PASSWORD=s3cret-pass
}

# assert_order PATTERN...: each fixed string appears in $CALLS, each on a
# later line than the previous one.
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

# FF_ROOT holds nothing at all.
assert_root_untouched() {
  local left
  left=$(ls -A "$FF_ROOT")
  if [[ -n $left ]]; then
    echo "expected $FF_ROOT to be empty, found: $left"
    return 1
  fi
}

# ---------------------------------------------------------------- happy path

@test "install: a fresh run does every step in order" {
  plain_answers
  ff_install --yes --channel latest
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order detect_foreign_install docker_status "net_reachable https://ghcr.io" \
    "net_reachable https://download.docker.com" install_docker \
    "fetch latest docker-compose.prod.yml" "fetch latest docker-compose.images.yml" \
    "fetch latest docker-compose.https.yml" "fetch latest docker-compose.storage.yml" \
    "fetch latest deploy/systemd/freeframe-backup.service" "fetch latest deploy/systemd/freeframe-backup.timer" \
    derive_env "dc pull" "dc config --services" "dc up -d" \
    "localhost:8000/health" "localhost:8000/setup/create-superadmin" \
    "dc up -d --no-build traefik" "probe_health off 203.0.113.7" backup_timer_on
  [ -f "$ENV" ]
  assert_has "$ENV" "FRONTEND_URL=http://203.0.113.7"
  assert_has "$ENV" "FREEFRAME_CHANNEL=latest"
  assert_out "FreeFrame is ready: http://203.0.113.7"
  assert_out "Sign in as admin@example.com"
}

@test "install: starting FreeFrame cancels an unfinished uninstall's marker, and says so" {
  plain_answers
  printf 'saved=/root/freeframe-removed-20261020-101010\nfinal=\n' >"$FF_ROOT/.uninstall-saved"
  ff_install --yes --channel latest
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ ! -e "$FF_ROOT/.uninstall-saved" ]
  assert_out "An earlier freeframe uninstall that did not finish is cancelled"
}

@test "install: the first start leaves traefik out, and starts every other service" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  local first
  first=$(grep -m1 '^dc up -d' "$CALLS")
  [[ " $first " != *" traefik "* ]] || { echo "$first"; false; }
  local s
  for s in postgres redis api worker email_worker maintenance_worker beat web minio minio-init; do
    [[ " $first " == *" $s "* ]] || { echo "missing $s in: $first"; false; }
  done
}

@test "install: traefik starts only after the admin account is created" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ]
  local admin traefik
  admin=$(grep -n create-superadmin "$CALLS" | cut -d: -f1)
  traefik=$(grep -n '^dc up -d --no-build traefik$' "$CALLS" | cut -d: -f1)
  [ -n "$admin" ] && [ -n "$traefik" ]
  ((traefik > admin))
}

@test "install: fails closed when the setup files have no api service" {
  plain_answers
  export STUB_SERVICES="traefik postgres redis web"
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "do not describe FreeFrame as expected"
  assert_not_called "dc up -d"
  assert_not_called create-superadmin
}

@test "install: fails closed when the setup files list no services" {
  plain_answers
  export STUB_SERVICES=""
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_not_called "dc up -d"
}

@test "install: a traefik left running by an earlier attempt is stopped before the admin call" {
  plain_answers
  export STUB_HEALTH_FAIL=1 FF_HEALTH_WAIT=10
  ff_install --yes
  [ "$status" -eq 1 ]
  unset STUB_HEALTH_FAIL
  : >"$CALLS"
  export STUB_OURS_RUNNING=1
  export STUB_SS='LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=4242,fd=7))'
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "dc up -d --no-build postgres" "dc ps -q traefik" "dc stop traefik" "dc ps -q traefik" \
    create-superadmin "dc up -d --no-build traefik"
}

@test "install: a traefik that will not stop stops the install before the admin call" {
  plain_answers
  export STUB_OURS_RUNNING=1 STUB_TRAEFIK_STUCK=1
  ff_install --yes
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "keep the setup page private"
  assert_not_called create-superadmin
}

@test "install: the admin answers go to the setup endpoint as JSON on stdin" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ]
  assert_eq "$(cat "$BATS_TEST_TMPDIR/superadmin.json")" \
    '{"email":"admin@example.com","name":"Ada Admin","password":"s3cret-pass"}'
  # The password never appears in a command line.
  assert_not_called "s3cret-pass"
  grep -q -- "dc exec -T api curl" "$CALLS"
}

@test "install: names and passwords with quotes and backslashes are escaped in the JSON" {
  plain_answers
  export FREEFRAME_ADMIN_NAME='Ada "The" Admin'
  export FREEFRAME_ADMIN_PASSWORD='pa\ss"word'
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(cat "$BATS_TEST_TMPDIR/superadmin.json")" \
    '{"email":"admin@example.com","name":"Ada \"The\" Admin","password":"pa\\ss\"word"}'
}

@test "install: docker 24 or newer with compose is used as is" {
  plain_answers
  export STUB_DOCKER=ok
  ff_install --yes
  [ "$status" -eq 0 ]
  assert_not_called install_docker
  assert_not_called "net_reachable https://download.docker.com"
}

@test "install: FF_SKIP_PULL=1 skips dc pull" {
  plain_answers
  export FF_SKIP_PULL=1
  ff_install --yes
  [ "$status" -eq 0 ]
  assert_not_called "dc pull"
  grep -q '^dc up -d' "$CALLS"
}

@test "install: the channel defaults to latest, the ref install.sh uses by default" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ]
  grep -q '^fetch latest docker-compose.prod.yml$' "$CALLS"
  assert_has "$ENV" "FREEFRAME_CHANNEL=latest"
}

@test "install: a re-run with --channel takes the setup files from it and saves it, after a backup" {
  plain_answers
  ff_install --yes --channel latest
  [ "$status" -eq 0 ]
  # Settings from an earlier attempt that say stable.
  rm -f "$FF_ROOT/.installed"
  env_set "$ENV" FREEFRAME_CHANNEL stable
  cp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  rm -f "$ENV".2*
  : >"$CALLS"
  # install.sh downloaded this script from latest and passes --channel latest.
  ff_install --yes --channel latest
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx 'fetch latest docker-compose.prod.yml' "$CALLS"
  assert_not_called "fetch stable"
  assert_has "$ENV" "FREEFRAME_CHANNEL=latest"
  local b
  b=$(ls "$ENV".2*)
  cmp "$b" "$BATS_TEST_TMPDIR/env.before"
}

@test "install: a re-run without --channel keeps the settings file's channel" {
  plain_answers
  ff_install --yes --channel stable
  [ "$status" -eq 0 ]
  rm -f "$FF_ROOT/.installed"
  : >"$CALLS"
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx 'fetch stable docker-compose.prod.yml' "$CALLS"
  assert_has "$ENV" "FREEFRAME_CHANNEL=stable"
}

@test "install: install.log is private and never holds the password or the tokens" {
  plain_answers
  unset FREEFRAME_ADMIN_PASSWORD
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  local log="$FF_ROOT/install.log" pw
  [ -f "$log" ]
  [ "$(stat -c %a "$log" 2>/dev/null || stat -f %Lp "$log")" = 600 ]
  pw=$(sed -n 's/.*"password":"\([^"]*\)".*/\1/p' "$BATS_TEST_TMPDIR/superadmin.json")
  [[ $pw =~ ^[0-9a-f]{24}$ ]] || { echo "generated: $pw"; false; }
  # Shown once on the terminal...
  assert_out "$pw"
  # ...but not in the log.
  # (A bare `! grep` never fails a bats test, so these are spelled out.)
  if grep -q -F "$pw" "$log"; then echo "password in the log"; false; fi
  if grep -q -F "tok-SECRET" "$log"; then echo "token in the log"; false; fi
  grep -q "FreeFrame is ready" "$log"
}

@test "install: the nightly backup timer is set up once FreeFrame answers, before the summary" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "localhost:8000/setup/create-superadmin" "dc up -d --no-build traefik" \
    "probe_health off" backup_timer_on
  [ "$(grep -c '^backup_timer_on$' "$CALLS")" -eq 1 ]
  # The units and their one daemon-reload come before FreeFrame starts
  # (the reload would take the GPU from a running worker).
  assert_order backup_units_install "systemctl daemon-reload" "dc up -d --no-build"
  [ "$(grep -c '^systemctl daemon-reload$' "$CALLS")" -eq 1 ]
  [[ $output == *"nightly"*"FreeFrame is ready"* ]] || { echo "$output"; false; }
}

@test "install: the summary says the backups stay on this server and are nightly" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ]
  assert_out "every night at 3:00"
  assert_out "on this server only"
  assert_out "do not survive losing it"
}

@test "install: a backup timer that cannot be set up stops before marking the install complete" {
  plain_answers
  export STUB_TIMER_FAIL=1
  ff_install --yes
  [ "$status" -eq 1 ]
  [ ! -e "$FF_ROOT/.installed" ]
  assert_out "nightly database backups could not be set up"
  assert_out "FreeFrame is running"
  assert_out "install.log"
  # A re-run finishes the job.
  unset STUB_TIMER_FAIL
  ff_install --yes
  [ "$status" -eq 0 ]
  [ -f "$FF_ROOT/.installed" ]
}

@test "install: the backup units are downloaded into the systemd folder of the install" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ]
  [ -f "$FF_ROOT/systemd/freeframe-backup.service" ]
  [ -f "$FF_ROOT/systemd/freeframe-backup.timer" ]
}

@test "install: marks the install complete only at the end" {
  plain_answers
  export STUB_HEALTH_FAIL=1 FF_HEALTH_WAIT=10
  ff_install --yes
  [ "$status" -eq 1 ]
  [ ! -e "$FF_ROOT/.installed" ]
  unset STUB_HEALTH_FAIL
  ff_install --yes
  [ "$status" -eq 0 ]
  [ -f "$FF_ROOT/.installed" ]
}

@test "install: an unexpected failure says so in plain words and names the log" {
  plain_answers
  # The completion marker cannot be written: a folder is in its way.
  mkdir "$FF_ROOT/.installed"
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "stopped unexpectedly"
  assert_out "install.log"
  assert_out "sudo freeframe install again"
}

@test "install: installs the freeframe command (mode 755) once it goes ahead" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ]
  cmp "$FF_SCRIPT" "$FF_BIN_DIR/freeframe"
  [ "$(stat -c %a "$FF_BIN_DIR/freeframe" 2>/dev/null || stat -f %Lp "$FF_BIN_DIR/freeframe")" = 755 ]
}

@test "install: refused, cancelled and already-installed runs leave the command alone" {
  plain_answers
  os_release debian 11 bullseye
  ff_install --yes
  [ "$status" -eq 3 ]
  [ ! -e "$FF_BIN_DIR/freeframe" ]

  os_release ubuntu 24.04 noble
  export FF_RAM_MB=1024
  ff_install --yes
  [ "$status" -eq 3 ]
  [ ! -e "$FF_BIN_DIR/freeframe" ]
  export FF_RAM_MB=8192

  unset FREEFRAME_ADMIN_EMAIL
  ff_install --yes
  [ "$status" -eq 2 ]
  [ ! -e "$FF_BIN_DIR/freeframe" ]
  export FREEFRAME_ADMIN_EMAIL=admin@example.com

  unset FREEFRAME_HTTPS FREEFRAME_ADMIN_NAME FREEFRAME_ADMIN_EMAIL FREEFRAME_ADMIN_PASSWORD
  printf '%s\n' "" "certs@example.com" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-1" "n" >"$BATS_TEST_TMPDIR/tty"
  FF_TTY="$BATS_TEST_TMPDIR/tty" ff_install
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "Install cancelled"
  [ ! -e "$FF_BIN_DIR/freeframe" ]

  plain_answers
  mkdir -p "$FF_BIN_DIR"
  printf 'old copy\n' >"$FF_BIN_DIR/freeframe"
  : >"$ENV"
  : >"$FF_ROOT/.installed"
  ff_install --yes
  [ "$status" -eq 0 ]
  assert_eq "$(cat "$FF_BIN_DIR/freeframe")" "old copy"
}

# ---------------------------------------------------------------- re-runs

@test "install: a second run changes nothing and points at freeframe update" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ]
  cp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  : >"$CALLS"
  ff_install --yes --domain other.example.com --https own
  [ "$status" -eq 0 ]
  cmp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  assert_out "already installed"
  assert_out "sudo freeframe update"
  assert_not_called fetch
  assert_not_called derive_env
  assert_not_called "dc "
}

@test "install: settings copied from another server are kept byte for byte" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ]
  # A new server: only the settings file came across.
  rm -f "$FF_ROOT/.installed" "$FF_ROOT"/docker-compose.*.yml "$FF_ROOT/install.log"
  cp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  : >"$CALLS"
  export FREEFRAME_HTTPS=sslip
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  cmp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  grep -q derive_env "$CALLS"
  grep -q create-superadmin "$CALLS"
  assert_out "from the existing settings"
}

@test "install: a complete settings file copied in as 644 ends up 600" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ]
  rm -f "$FF_ROOT/.installed"
  chmod 644 "$ENV"
  cp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  cmp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  [ "$(stat -c %a "$ENV" 2>/dev/null || stat -f %Lp "$ENV")" = 600 ]
}

@test "install: an admin that already exists is not an error" {
  plain_answers
  export STUB_ADMIN_CODE=403 STUB_ADMIN_BODY='{"detail":"Setup already completed. Superadmin already exists."}'
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "An admin account already exists"
  grep -q "dc up -d --no-build traefik" "$CALLS"
}

@test "install: a refused admin account stops before traefik with the reason" {
  plain_answers
  export STUB_ADMIN_CODE=422 STUB_ADMIN_BODY='{"detail":[{"msg":"value is not a valid email address"}]}'
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "value is not a valid email address"
  assert_not_called "dc up -d --no-build traefik"
}

@test "install: a generated password reaches the terminal even when a later step fails" {
  plain_answers
  unset FREEFRAME_ADMIN_PASSWORD
  export STUB_TRAEFIK_FAIL=1
  ff_install --yes
  [ "$status" -eq 1 ]
  local pw log="$FF_ROOT/install.log"
  pw=$(sed -n 's/.*"password":"\([^"]*\)".*/\1/p' "$BATS_TEST_TMPDIR/superadmin.json")
  [[ $pw =~ ^[0-9a-f]{24}$ ]] || { echo "generated: $pw"; false; }
  assert_out "Traefik"
  # Shown right after the account was made, and again with the failure.
  [ "$(grep -c -F "$pw" <<<"$output")" -ge 2 ] || { echo "$output"; false; }
  if grep -q -F "$pw" "$log"; then echo "password in the log"; false; fi
}

@test "install: a typed password is never echoed back when a later step fails" {
  plain_answers
  export STUB_TRAEFIK_FAIL=1
  ff_install --yes
  [ "$status" -eq 1 ]
  if grep -q -F "s3cret-pass" <<<"$output"; then echo "$output"; false; fi
}

@test "install: the API not reachable for the admin call says so, not a bad password" {
  plain_answers
  export STUB_ADMIN_EXEC_FAIL=1
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "API could not be reached"
  assert_out "install.log"
  if grep -q "email and password" <<<"$output"; then echo "$output"; false; fi
  assert_not_called "dc up -d --no-build traefik"
}

@test "install: too many admin tries (429) says to wait 10 minutes" {
  plain_answers
  export STUB_ADMIN_CODE=429 STUB_ADMIN_BODY='{"detail":"Too many requests"}'
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "wait 10 minutes"
  assert_not_called "dc up -d --no-build traefik"
}

@test "install: the API never answering stops before the admin and traefik" {
  plain_answers
  export STUB_API_DOWN=1 FF_API_WAIT=20
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_not_called create-superadmin
  assert_not_called "dc up -d --no-build traefik"
  assert_out "install.log"
  assert_out "sudo freeframe install"
}

# ---------------------------------------------------------------- refusals

@test "install: not root exits 2 and changes nothing" {
  plain_answers
  export STUB_NOT_ROOT=1
  ff_install --yes
  [ "$status" -eq 2 ]
  assert_out "as root"
  assert_root_untouched
  [ ! -s "$CALLS" ]
}

@test "install: an unsupported OS exits 3 before any change" {
  plain_answers
  os_release debian 11 bullseye
  ff_install --yes
  [ "$status" -eq 3 ]
  assert_out "not supported yet"
  assert_out "debian 11"
  assert_root_untouched
  [ ! -s "$CALLS" ]
}

@test "install: no os-release at all is unsupported" {
  plain_answers
  rm -f "$FF_OS_RELEASE"
  ff_install --yes
  [ "$status" -eq 3 ]
  assert_root_untouched
  assert_out "a Linux system the installer cannot identify (it has no /etc/os-release)"
  if [[ $output == *"( )"* ]]; then echo "$output"; false; fi
}

@test "install: on a Mac it says the installer is for Linux servers and points at the manual setup" {
  plain_answers
  rm -f "$FF_OS_RELEASE"
  export STUB_KERNEL=Darwin
  ff_install --yes
  [ "$status" -eq 3 ]
  assert_out "This computer runs macOS, and the installer is for Linux servers only, so nothing was changed."
  assert_out "Ubuntu 22.04, 24.04 or 26.04, or Debian 12 or 13, on amd64 or arm64"
  assert_out "Docker Desktop"
  assert_out "deployment.md#quick-setup"
  assert_root_untouched
}

@test "install: an unsupported processor exits 3 before any change" {
  plain_answers
  export STUB_ARCH=armv7l
  ff_install --yes
  [ "$status" -eq 3 ]
  assert_out "armv7l"
  assert_root_untouched
  [ ! -s "$CALLS" ]
}

@test "install: a foreign install exits 3 before any fetch and writes nothing" {
  plain_answers
  export STUB_FOREIGN=0
  ff_install --yes
  [ "$status" -eq 3 ]
  assert_out "set up by hand"
  assert_out "will not touch it"
  assert_not_called fetch
  assert_not_called install_docker
  assert_root_untouched
}

@test "install: docker not answering is a failure, never read as no FreeFrame" {
  plain_answers
  export STUB_FOREIGN=2
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_not_called fetch
  assert_root_untouched
}

@test "install: snap docker is refused with instructions" {
  plain_answers
  export STUB_DOCKER=snap
  ff_install --yes
  [ "$status" -eq 3 ]
  assert_out "snap"
  assert_not_called install_docker
  assert_not_called fetch
}

@test "install: an old docker is refused" {
  plain_answers
  export STUB_DOCKER="old 20.10.24"
  ff_install --yes
  [ "$status" -eq 3 ]
  assert_out "20.10.24"
  assert_not_called install_docker
}

@test "install: too little memory is refused, 2 to 4 GB only warns" {
  plain_answers
  export FF_RAM_MB=1024
  ff_install --yes
  [ "$status" -eq 3 ]
  assert_out "memory"
  assert_not_called install_docker

  export FF_RAM_MB=3900
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "4 GB"
}

@test "install: no outbound access to ghcr.io stops before any change" {
  plain_answers
  export STUB_NET_DOWN=ghcr.io
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "ghcr.io"
  assert_not_called install_docker
  assert_not_called fetch
}

@test "install: low disk space warns" {
  plain_answers
  export STUB_FREE_MB=10000
  ff_install --yes
  [ "$status" -eq 0 ]
  assert_out "free disk space"
}

@test "install: a refusal after the log exists names the log and does not claim nothing changed" {
  plain_answers
  export FF_RAM_MB=1024
  ff_install --yes
  [ "$status" -eq 3 ]
  assert_out "$FF_ROOT/install.log"
  if grep -qi "nothing was changed" <<<"$output"; then echo "$output"; false; fi
}

@test "install: an answer error after the log exists names the log" {
  plain_answers
  unset FREEFRAME_ADMIN_EMAIL
  ff_install --yes
  [ "$status" -eq 2 ]
  assert_out "$FF_ROOT/install.log"
  assert_out "set FREEFRAME_ADMIN_EMAIL (the admin account's email)"
}

@test "install: a missing answer is named without the prompt's indent" {
  plain_answers
  export FREEFRAME_STORAGE=s3 FREEFRAME_S3_ACCESS_KEY=a FREEFRAME_S3_SECRET_KEY=b
  ff_install --yes
  [ "$status" -eq 2 ]
  assert_out "Missing answer: set FREEFRAME_S3_BUCKET (Bucket name)"
}

@test "install: the endpoint message matches what is accepted" {
  plain_answers
  export FREEFRAME_STORAGE=s3 FREEFRAME_S3_BUCKET=footage FREEFRAME_S3_ACCESS_KEY=a \
    FREEFRAME_S3_SECRET_KEY=b FREEFRAME_S3_ENDPOINT=s3.example.com
  ff_install --yes
  [ "$status" -eq 2 ]
  assert_out "starting with https:// (or http://"
  export FREEFRAME_S3_ENDPOINT=http://nas.local:9000
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
}

@test "install: cancelling after stopping a program says which one, and how to start it again" {
  printf '%s\n' "y" "" "certs@example.com" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-1" "n" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  export STUB_SS='LISTEN 0 511 [::]:443 [::]:* users:(("apache2",pid=900,fd=4))'
  export STUB_UNIT=apache2.service STUB_SS_CLEARS=1
  ff_install
  [ "$status" -eq 1 ]
  assert_out "Install cancelled. Nothing was installed."
  assert_out "stopped apache2"
  assert_out "sudo systemctl enable --now apache2.service"
  assert_out "install.log"
}

@test "install: an existing stricter FreeFrame folder keeps its mode; a new one is 755" {
  plain_answers
  chmod 700 "$FF_ROOT"
  ff_install --yes
  [ "$status" -eq 0 ]
  [ "$(stat -c %a "$FF_ROOT" 2>/dev/null || stat -f %Lp "$FF_ROOT")" = 700 ]

  export FF_ROOT="$BATS_TEST_TMPDIR/fresh/freeframe"
  ff_install --yes
  [ "$status" -eq 0 ]
  [ "$(stat -c %a "$FF_ROOT" 2>/dev/null || stat -f %Lp "$FF_ROOT")" = 755 ]
}

# ---------------------------------------------------------------- answers

@test "install: with no terminal and no --yes it stops and names --yes" {
  plain_answers
  ff_install
  [ "$status" -eq 2 ]
  assert_out "--yes"
  assert_not_called install_docker
  assert_not_called fetch
}

@test "install: with no terminal a missing admin email names the variable" {
  plain_answers
  unset FREEFRAME_ADMIN_EMAIL
  ff_install --yes
  [ "$status" -eq 2 ]
  assert_out "FREEFRAME_ADMIN_EMAIL"
  assert_not_called install_docker
  assert_not_called fetch
  [ ! -e "$ENV" ]
}

@test "install: a bad web address given ahead of time exits 2 before any change" {
  plain_answers
  unset FREEFRAME_HTTPS
  ff_install --yes --domain 'https://review.example.com:8443/x y'
  [ "$status" -eq 2 ]
  assert_not_called install_docker
  [ ! -e "$ENV" ]
}

@test "install: a pasted https:// and trailing slash are forgiven" {
  plain_answers
  unset FREEFRAME_HTTPS
  export FREEFRAME_ACME_EMAIL=certs@example.com
  ff_install --yes --domain 'https://Review.Example.com/'
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=https://review.example.com"
}

@test "install: a too-short admin password given ahead of time exits 2" {
  plain_answers
  export FREEFRAME_ADMIN_PASSWORD=short
  ff_install --yes
  [ "$status" -eq 2 ]
  assert_out "8"
  assert_not_called install_docker
}

@test "install: HTTPS needs a certificate email; the admin email is the default" {
  plain_answers
  unset FREEFRAME_HTTPS
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_HTTPS=sslip"
  assert_has "$ENV" "ACME_EMAIL=admin@example.com"
}

@test "install: own S3 bucket answers from the environment" {
  plain_answers
  export FREEFRAME_STORAGE=s3 FREEFRAME_S3_BUCKET=footage FREEFRAME_S3_ACCESS_KEY=AKIAX \
    FREEFRAME_S3_SECRET_KEY='se$cret' FREEFRAME_S3_REGION=eu-west-1
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "S3_STORAGE=s3"
  assert_eq "$(env_get "$ENV" S3_SECRET_KEY)" 'se$cret'
  # AWS does not get CORS set automatically: the rules are printed.
  assert_out "AllowedOrigins"
  assert_out "http://203.0.113.7"
  local first
  first=$(grep -m1 '^dc up -d' "$CALLS")
  [[ " $first " != *" minio "* ]]
}

@test "install: skipping email says plainly what does not work" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ]
  assert_out "forgotten password"
  assert_has "$ENV" "MAIL_PROVIDER=smtp"
}

@test "install: interactive answers, hidden passwords typed twice" {
  # Enter (automatic address), certificate email, storage 1, skip email,
  # name, email, password twice, then confirm.
  printf '%s\n' "" "certs@example.com" "1" "" "Grace Hopper" "grace@example.com" \
    "long-password-1" "long-password-1" "y" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=https://203-0-113-7.sslip.io"
  assert_has "$ENV" "ACME_EMAIL=certs@example.com"
  assert_has "$ENV" "FREEFRAME_STORAGE=bundled"
  assert_eq "$(cat "$BATS_TEST_TMPDIR/superadmin.json")" \
    '{"email":"grace@example.com","name":"Grace Hopper","password":"long-password-1"}'
  assert_out "temporary"
  assert_out "Install now?"
}

@test "install: interactive passwords that differ are asked again" {
  printf '%s\n' "" "certs@example.com" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-2" "long-password-3" "long-password-3" "y" \
    >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "did not match"
  grep -q '"password":"long-password-3"' "$BATS_TEST_TMPDIR/superadmin.json"
}

@test "install: interactive Enter at the password makes one up" {
  printf '%s\n' "" "certs@example.com" "1" "" "Grace" "grace@example.com" "" "y" \
    >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -Eq '"password":"[0-9a-f]{24}"' "$BATS_TEST_TMPDIR/superadmin.json"
  assert_out "write it down"
}

@test "install: answering no at Install now changes nothing" {
  printf '%s\n' "" "certs@example.com" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-1" "n" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  ff_install
  [ "$status" -eq 1 ]
  assert_out "Nothing was installed"
  assert_not_called install_docker
  assert_not_called fetch
  [ ! -e "$ENV" ]
}

@test "install: interactive SMTP answers" {
  printf '%s\n' "" "certs@example.com" "1" "smtp.example.com" "465" "mailer@example.com" \
    "mail-pass" "" "Grace" "grace@example.com" "long-password-1" "long-password-1" "y" \
    >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "SMTP_HOST=smtp.example.com"
  assert_has "$ENV" "SMTP_PORT=465"
  assert_has "$ENV" "SMTP_USE_TLS=false"
  assert_has "$ENV" "SMTP_PASSWORD=mail-pass"
  assert_has "$ENV" "MAIL_FROM_ADDRESS=mailer@example.com"
}

@test "install: typing the server's IP at the address question means plain HTTP" {
  printf '%s\n' "10.0.0.5" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-1" "y" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty" STUB_LOCAL_IP=10.0.0.5
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=http://10.0.0.5"
  assert_has "$ENV" "FREEFRAME_HTTPS=off"
  assert_has "$ENV" "S3_PUBLIC_ENDPOINT=http://10.0.0.5:9000"
}

@test "install: no public IP means plain HTTP on the server's address" {
  plain_answers
  unset FREEFRAME_HTTPS
  export STUB_PUBLIC_IP="" STUB_LOCAL_IP=192.168.1.20
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=http://192.168.1.20"
  assert_has "$ENV" "FREEFRAME_HTTPS=off"
}

@test "NAT ruling: a public VPS uses the automatic address, asked or unattended" {
  printf '%s\n' "" "certs@example.com" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-1" "y" >"$BATS_TEST_TMPDIR/tty"
  FF_TTY="$BATS_TEST_TMPDIR/tty" ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=https://203-0-113-7.sslip.io"
  if grep -q "private address" <<<"$output"; then echo "$output"; false; fi

  rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
  plain_answers
  unset FREEFRAME_HTTPS
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=https://203-0-113-7.sslip.io"
}

@test "NAT ruling: behind NAT, Enter still means the automatic address, with a note" {
  printf '%s\n' "" "certs@example.com" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-1" "y" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty" STUB_LOCAL_IP=10.0.0.5
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "This network only, plain HTTP"
  assert_out "http://10.0.0.5"
  assert_out "Behind a router, so only people on this network can reach it."
  assert_has "$ENV" "FRONTEND_URL=https://203-0-113-7.sslip.io"
}

@test "NAT ruling: behind NAT, 'this network only' means HTTP on the interface address" {
  printf '%s\n' "local" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-1" "y" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty" STUB_LOCAL_IP=10.0.0.5
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=http://10.0.0.5"
  assert_has "$ENV" "FREEFRAME_HTTPS=off"
  assert_has "$ENV" "S3_PUBLIC_ENDPOINT=http://10.0.0.5:9000"
  assert_out "FreeFrame is ready: http://10.0.0.5"
}

@test "NAT ruling: without NAT the address question has no router note" {
  printf '%s\n' "" "certs@example.com" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-1" "y" >"$BATS_TEST_TMPDIR/tty"
  FF_TTY="$BATS_TEST_TMPDIR/tty" ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  if grep -q "Behind a router" <<<"$output"; then echo "$output"; false; fi
}

@test "NAT ruling: behind NAT and unattended, the default is still the automatic address" {
  plain_answers
  unset FREEFRAME_HTTPS
  export STUB_LOCAL_IP=10.0.0.5
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=https://203-0-113-7.sslip.io"
  assert_has "$ENV" "FREEFRAME_HTTPS=sslip"
}

@test "NAT ruling: behind NAT, an sslip certificate timeout falls back to HTTP on the interface address" {
  plain_answers
  unset FREEFRAME_HTTPS
  export STUB_LOCAL_IP=10.0.0.5 STUB_CERT_FAIL=1 FF_CERT_WAIT=10
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_HTTPS=off"
  assert_has "$ENV" "FRONTEND_URL=http://10.0.0.5"
  assert_has "$ENV" "S3_PUBLIC_ENDPOINT=http://10.0.0.5:9000"
  assert_out "the server's own network address, http://10.0.0.5"
  assert_out "FreeFrame is ready: http://10.0.0.5"
  grep -q "probe_health off 10.0.0.5" "$CALLS"
}

@test "NAT ruling: explicit choices win behind NAT" {
  plain_answers
  export STUB_LOCAL_IP=10.0.0.5
  # plain_answers sets FREEFRAME_HTTPS=off: plain HTTP on the interface address.
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=http://10.0.0.5"

  rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
  ff_install --yes --https sslip
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=https://203-0-113-7.sslip.io"

  rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
  unset FREEFRAME_HTTPS
  export FREEFRAME_ACME_EMAIL=certs@example.com
  ff_install --yes --domain review.yourstudio.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=https://review.yourstudio.com"
  # The DNS records point at the public address, not the private one.
  grep -q "dns_points_here review.yourstudio.com 203.0.113.7" "$CALLS"
}

@test "NAT ruling: without NAT the sslip fallback stays on the public address" {
  plain_answers
  export FREEFRAME_HTTPS=sslip STUB_CERT_FAIL=1 FF_CERT_WAIT=10
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=http://203.0.113.7"
}

# ---------------------------------------------------------------- first-run screens

# tty_answers LINE...: the lines typed at the terminal, in order.
tty_answers() {
  printf '%s\n' "$@" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
}

# The rest of a typical interactive run after the web address step:
# storage 1, skip email, name, email, password twice, confirm.
REST=(1 "" "Grace" "grace@example.com" "long-password-1" "long-password-1" "y")

# step_headers: the "Step N of M" headers shown, one per line, as "N/M Title".
step_headers() {
  sed -nE 's/^.*Step ([0-9]+) of ([0-9]+) [^A-Za-z]+ ([A-Za-z][A-Za-z ]*[A-Za-z]).*$/\1\/\2 \3/p' <<<"$output"
}

@test "screens: an interactive install shows the banner and welcome first, then checks the server" {
  tty_answers "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out " | _| '_/ -_) -_) _| '_/ _\` | '  \/ -_)"
  assert_out "Self-hosted review for your team's video, images and audio"
  assert_out "Welcome! This sets up FreeFrame on this server."
  assert_out "Four short questions. Press Enter to take the suggestion in [brackets]"
  assert_out "Nothing is installed until you confirm. Press Ctrl+C any time to stop."
  [[ $output == *"Welcome!"*"Checking this server ... ok"*"Step 1 of 4"* ]] || { echo "$output"; false; }
  # Printed once, and the banner stays out of install.log.
  [ "$(grep -c "Self-hosted review" <<<"$output")" -eq 1 ]
  if grep -q "Welcome!" "$FF_ROOT/install.log"; then cat "$FF_ROOT/install.log"; false; fi
}

@test "screens: an unattended install prints a one-line header instead of the banner" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "FreeFrame installer"
  if [[ $output == *"Welcome!"* || $output == *"Self-hosted review"* || $output == *"Step 1"* ]]; then echo "$output"; false; fi
}

@test "screens: no banner when FreeFrame is already installed, or for help" {
  plain_answers
  : >"$ENV"
  : >"$FF_ROOT/.installed"
  tty_answers ""
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "already installed"
  if [[ $output == *"Self-hosted review"* ]]; then echo "$output"; false; fi
  run bash "$FF_SCRIPT" help
  if [[ $output == *"Self-hosted review"* ]]; then echo "$output"; false; fi
}

@test "screens: the server check is one line with what was found" {
  unset LC_ALL LC_CTYPE
  export LANG=C.UTF-8 FF_CORES=20 FF_RAM_MB=15800 STUB_FREE_MB=976000
  os_release ubuntu 26.04 resolute
  tty_answers "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qxF " Checking this server ... ok  (ubuntu 26.04 · 20 cores · 15 GB memory · 953 GB free)" <<<"$output" ||
    { echo "$output"; false; }
}

@test "screens: warnings from the server check come after its line" {
  export FF_RAM_MB=3000
  tty_answers "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [[ $output == *"Checking this server ... ok"*"about 3 GB of memory"*"Step 1 of 4"* ]] || { echo "$output"; false; }
}

@test "screens: a refusal during the server check ends the check line first" {
  export STUB_NET_DOWN=ghcr.io
  tty_answers "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 1 ]
  grep -qxF " Checking this server ... stopped" <<<"$output" || { echo "$output"; false; }
  assert_out "cannot reach ghcr.io"
}

@test "screens: HTTPS answers give four consecutive steps, with the certificate email inside step 1" {
  unset LC_ALL LC_CTYPE
  export LANG=C.UTF-8
  tty_answers "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(step_headers)" "$(printf '%s\n' "1/4 Web address" "2/4 Storage" "3/4 Email" "4/4 Admin account")"
  assert_out "Step 1 of 4 · Web address"
  assert_out "Email for certificate notices"
}

@test "screens: plain HTTP answers also give four consecutive steps" {
  unset LC_ALL LC_CTYPE
  export LANG=C
  tty_answers 3 "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(step_headers)" "$(printf '%s\n' "1/4 Web address" "2/4 Storage" "3/4 Email" "4/4 Admin account")"
  if [[ $output == *"certificate notices"* ]]; then echo "$output"; false; fi
  # Without a UTF-8 locale the separator is plain.
  assert_out "Step 1 of 4 - Web address"
}

@test "screens: only the questions asked are counted" {
  export FREEFRAME_ADMIN_NAME=Grace FREEFRAME_ADMIN_EMAIL=grace@example.com FREEFRAME_ADMIN_PASSWORD=long-password-1
  tty_answers 3 1 "" "y"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(step_headers)" "$(printf '%s\n' "1/3 Web address" "2/3 Storage" "3/3 Email")"
  assert_out "Three short questions"
}

@test "screens: a domain given ahead of time leaves the certificate email as its own step 1" {
  export FREEFRAME_DOMAIN=review.example.com
  tty_answers "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(step_headers)" "$(printf '%s\n' "1/4 Certificate email" "2/4 Storage" "3/4 Email" "4/4 Admin account")"
  assert_has "$ENV" "ACME_EMAIL=certs@example.com"
}

@test "screens: the web address menu with a public IP offers three choices, the temporary address first" {
  tty_answers "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "How will your team open FreeFrame in the browser?"
  assert_out "   1) Free temporary address, with HTTPS   203-0-113-7.sslip.io"
  assert_out "   2) Your own domain                      for example review.yourstudio.com"
  assert_out "   3) Plain HTTP on this server's address  http://203.0.113.7"
  assert_out " Choose 1, 2 or 3 [1]: "
  assert_has "$ENV" "FRONTEND_URL=https://203-0-113-7.sslip.io"
}

@test "screens: menu 1 is the temporary address, 2 asks for the domain, 3 is plain HTTP" {
  tty_answers 1 "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_HTTPS=sslip"

  rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
  tty_answers 2 "review.example.com" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out " Domain: "
  assert_has "$ENV" "FRONTEND_URL=https://review.example.com"

  rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
  tty_answers 3 "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=http://203.0.113.7"
  assert_has "$ENV" "FREEFRAME_HTTPS=off"
}

@test "screens: at the menu a typed domain means option 2, and local means option 3" {
  tty_answers "Review.Example.com" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=https://review.example.com"
  if [[ $output == *" Domain: "* ]]; then echo "$output"; false; fi

  local word
  for word in local "this network only"; do
    rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
    tty_answers "$word" "${REST[@]}"
    export STUB_LOCAL_IP=10.0.0.5
    ff_install
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    assert_has "$ENV" "FRONTEND_URL=http://10.0.0.5"
  done
}

@test "screens: a menu answer that is not a choice is asked again" {
  tty_answers 7 "http://x y" "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Type 1, 2 or 3, or a domain such as review.yourstudio.com."
  assert_has "$ENV" "FREEFRAME_HTTPS=sslip"
}

@test "screens: without a public IP the menu is this network or your own domain, this network first" {
  export STUB_PUBLIC_IP="" STUB_LOCAL_IP=192.168.1.20
  tty_answers "" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "   1) This network only, plain HTTP        http://192.168.1.20"
  assert_out "   2) Your own domain"
  assert_out " Choose 1 or 2 [1]: "
  if [[ $output == *"temporary"*"Choose"* ]]; then echo "$output"; false; fi
  assert_has "$ENV" "FRONTEND_URL=http://192.168.1.20"

  rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
  tty_answers 2 "review.example.com" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=https://review.example.com"
}

@test "screens: storage and email are numbered menus with defaults" {
  tty_answers "" "certs@example.com" 2 "" footage AKIAX "se-cret" "" 2 "smtp.example.com" "" "mailer@example.com" \
    "mail-pass" "" "Grace" "grace@example.com" "long-password-1" "long-password-1" "y"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Where should uploaded footage be kept?"
  assert_out "   1) On this server"
  assert_out "   2) In an S3 bucket you already have"
  assert_out "   1) Skip for now, and add it later"
  assert_out "   2) Set up a mail server now"
  assert_out " Mail server: "
  assert_has "$ENV" "S3_BUCKET=footage"
  assert_has "$ENV" "SMTP_HOST=smtp.example.com"
  assert_has "$ENV" "SMTP_PORT=587"
}

@test "screens: the summary is a block of rows before Install now" {
  tty_answers "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [[ $output == *"Ready to install"*"   Web address   https://203-0-113-7.sslip.io (a free temporary address)"*"   Admin         Grace <grace@example.com>"*"Install now? [Y/n]"* ]] ||
    { echo "$output"; false; }
}

@test "screens: at a narrow width descriptive text wraps between words" {
  export COLUMNS=40 STUB_LOCAL_IP=10.0.0.5
  tty_answers "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  local line long="" shown
  # The fake terminal does not echo the answers, so each question would run
  # into the next line: end every question there.
  shown=$(sed -E 's/(Your name|Your email|Password|Type it again|Choose [0-9, or]+ \[[0-9]\]|Email for certificate notices( \[[^]]*\])?|Install now\? \[Y\/n\]): /\1:\n/g' <<<"$output")
  while IFS= read -r line; do
    # Whole by design: the machine-read ready line, paths and commands.
    case $line in *"FreeFrame is ready: "* | *"/"* | *"sudo "* | *"====="*) continue ;; esac
    if ((${#line} > 39)); then long+="$line"$'\n'; fi
  done <<<"$shown"
  [ -z "$long" ] || { echo "lines over 39 columns:"; echo "$long"; false; }
  # A long sentence comes back whole when its lines are joined.
  local flat
  flat=$(tr '\n' ' ' <<<"$output" | tr -s ' ')
  [[ $flat == *"Nothing is installed until you confirm. Press Ctrl+C any time to stop."* ]] || { echo "$output"; false; }
  [[ $flat == *"Behind a router, so only people on this network can reach it."* ]] || { echo "$output"; false; }
}

@test "screens: without a terminal or COLUMNS, nothing is wrapped" {
  tty_answers "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out " Nothing is installed until you confirm. Press Ctrl+C any time to stop."
}

@test "screens: with colour on, install.log gets no escape codes" {
  export FF_FORCE_COLOR=1 TERM=xterm
  tty_answers "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [[ $output == *$'\e['* ]] || { echo "no colour on the screen"; false; }
  if grep -q $'\e' "$FF_ROOT/install.log"; then echo "escape codes in install.log:"; grep -n $'\e' "$FF_ROOT/install.log" | cat -v; false; fi
  grep -q "Checking this server ... ok" "$FF_ROOT/install.log"
  grep -q "FreeFrame is ready: https://203-0-113-7.sslip.io" "$FF_ROOT/install.log"
}

@test "screens: NO_COLOR and TERM=dumb turn the colour off" {
  export FF_FORCE_COLOR=1 NO_COLOR=1 TERM=xterm
  tty_answers "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  if [[ $output == *$'\e'* ]]; then echo "$output" | cat -v; false; fi
  rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
  unset NO_COLOR
  export TERM=dumb
  tty_answers "" "certs@example.com" "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  if [[ $output == *$'\e'* ]]; then echo "$output" | cat -v; false; fi
}

@test "screens: the ready screen keeps the lines scripts read" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qxF "FreeFrame is ready: http://203.0.113.7" <<<"$output" || { echo "$output"; false; }
  ff_install --yes
  grep -qxF "FreeFrame is already installed on this server, so nothing was changed." <<<"$output" || { echo "$output"; false; }
  grep -qxF "To move to the newest release, run: sudo freeframe update" <<<"$output" || { echo "$output"; false; }
}

# ---------------------------------------------------------------- server fixes

@test "install: adds swap only when memory is under 4 GB and there is none" {
  plain_answers
  export FF_RAM_MB=3900
  ff_install --yes
  [ "$status" -eq 0 ]
  grep -q '^add_swap$' "$CALLS"

  : >"$CALLS"
  rm -f "$FF_ROOT/.installed"
  export STUB_SWAP=1
  ff_install --yes
  assert_not_called add_swap

  : >"$CALLS"
  rm -f "$FF_ROOT/.installed"
  unset STUB_SWAP
  export FF_RAM_MB=8192
  ff_install --yes
  assert_not_called add_swap
}

@test "install: ufw gets allow rules only when it is active" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ]
  assert_not_called "ufw "

  : >"$CALLS"
  rm -f "$FF_ROOT/.installed"
  export STUB_UFW_ACTIVE=1
  ff_install --yes
  [ "$status" -eq 0 ]
  grep -q '^ufw allow 80/tcp$' "$CALLS"
  grep -q '^ufw allow 443/tcp$' "$CALLS"
  assert_not_called "ufw enable"
}

@test "install: a program on port 80 is named, and --yes does not stop it" {
  plain_answers
  export STUB_SS='LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6),("nginx",pid=813,fd=6))'
  export STUB_UNIT=nginx.service
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "Port 80 is used by nginx"
  assert_not_called "systemctl disable"
  assert_not_called install_docker
}

@test "install: interactive yes stops the program holding port 443" {
  printf '%s\n' "y" "" "certs@example.com" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-1" "y" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  export STUB_SS='LISTEN 0 511 [::]:443 [::]:* users:(("apache2",pid=900,fd=4))'
  export STUB_UNIT=apache2.service STUB_SS_CLEARS=1
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -q '^systemctl disable --now apache2.service$' "$CALLS"
}

@test "install: our own traefik on 80 from an earlier attempt is not in the way" {
  plain_answers
  export STUB_HEALTH_FAIL=1 FF_HEALTH_WAIT=10
  ff_install --yes
  [ "$status" -eq 1 ]
  unset STUB_HEALTH_FAIL
  export STUB_SS='LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=4242,fd=7))'
  export STUB_OURS_RUNNING=1
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
}

@test "install: another Docker app on port 80 stops the install" {
  plain_answers
  export STUB_SS='LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=4242,fd=7))'
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "Docker"
}

# ---------------------------------------------------------------- DNS and HTTPS

@test "install: own domain prints the records and waits until they point here" {
  plain_answers
  unset FREEFRAME_HTTPS
  export FREEFRAME_ACME_EMAIL=certs@example.com STUB_DNS_FAILS=3
  ff_install --yes --domain review.yourstudio.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "A record"
  assert_out "review.yourstudio.com"
  assert_out "storage.review.yourstudio.com"
  assert_out "203.0.113.7"
  assert_order "dns_points_here review.yourstudio.com 203.0.113.7" "sleep 15" \
    "dns_points_here review.yourstudio.com 203.0.113.7" "fetch latest docker-compose.prod.yml"
  assert_has "$ENV" "FRONTEND_URL=https://review.yourstudio.com"
  assert_has "$ENV" "FREEFRAME_HTTPS=own"
  grep -q "cert_issued review.yourstudio.com" "$CALLS"
  grep -q "cert_issued storage.review.yourstudio.com" "$CALLS"
}

@test "install: DNS that never points here stops an unattended run before any fetch" {
  plain_answers
  unset FREEFRAME_HTTPS
  export FREEFRAME_ACME_EMAIL=certs@example.com STUB_DNS_FAILS=1000 FF_DNS_WAIT=60
  ff_install --yes --domain review.yourstudio.com
  [ "$status" -eq 1 ]
  assert_out "FREEFRAME_HTTPS=sslip"
  assert_not_called fetch
}

@test "install: at the DNS wait, s switches to the automatic address" {
  printf '%s\n' "review.yourstudio.com" "certs@example.com" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-1" "y" "s" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty" STUB_DNS_FAILS=1000
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=https://203-0-113-7.sslip.io"
  assert_has "$ENV" "FREEFRAME_HTTPS=sslip"
}

@test "install: at the DNS wait, c continues anyway with the own domain" {
  printf '%s\n' "review.yourstudio.com" "certs@example.com" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-1" "y" "c" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty" STUB_DNS_FAILS=1000
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=https://review.yourstudio.com"
}

@test "install: sslip certificate that never arrives falls back to plain HTTP" {
  plain_answers
  export FREEFRAME_HTTPS=sslip STUB_CERT_FAIL=1 FF_CERT_WAIT=30
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_HTTPS=off"
  assert_has "$ENV" "FRONTEND_URL=http://203.0.113.7"
  assert_has "$ENV" "S3_PUBLIC_ENDPOINT=http://203.0.113.7:9000"
  assert_has "$ENV" "STORAGE_ROUTED=false"
  assert_has "$ENV" "STORAGE_PORT_BIND=0.0.0.0:9000"
  assert_out "plain HTTP"
  assert_out "FreeFrame is ready: http://203.0.113.7"
  # The old file was backed up, and no secret changed.
  local backup
  backup=$(ls "$ENV".2* | head -1)
  [ -f "$backup" ]
  local k
  for k in POSTGRES_PASSWORD REDIS_PASSWORD JWT_SECRET S3_ACCESS_KEY S3_SECRET_KEY DATABASE_URL; do
    assert_eq "$(env_get "$ENV" "$k")" "$(env_get "$backup" "$k")"
  done
  grep -q -- "--force-recreate" "$CALLS"
  assert_order "cert_issued 203-0-113-7.sslip.io" "dc up -d --no-build --force-recreate" "probe_health off 203.0.113.7"
}

@test "install: sslip certificate issued keeps HTTPS" {
  plain_answers
  export FREEFRAME_HTTPS=sslip
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_HTTPS=sslip"
  assert_out "FreeFrame is ready: https://203-0-113-7.sslip.io"
  assert_out "temporary"
}

@test "install: own domain certificate that does not arrive is reported, not hidden" {
  plain_answers
  unset FREEFRAME_HTTPS
  export FREEFRAME_ACME_EMAIL=certs@example.com STUB_CERT_FAIL=1 FF_CERT_WAIT=30
  ff_install --yes --domain review.yourstudio.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_HTTPS=own"
  assert_out "certificate"
  assert_out "has not arrived"
}

@test "install: sslip mode without a public IP exits 2" {
  plain_answers
  export FREEFRAME_HTTPS=sslip STUB_PUBLIC_IP="" STUB_LOCAL_IP=192.168.1.20
  ff_install --yes
  [ "$status" -eq 2 ]
  assert_not_called install_docker
}

@test "install: a failed download names the file and stops before derive" {
  plain_answers
  export STUB_FETCH_FAIL=docker-compose.https.yml
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "docker-compose.https.yml"
  assert_not_called derive_env
}

@test "install: a failed download on latest does not suggest latest; on another channel it does" {
  plain_answers
  export STUB_FETCH_FAIL=docker-compose.https.yml
  ff_install --yes --channel latest
  [ "$status" -eq 1 ]
  assert_out "a release after v1.21.0"
  if [[ $output == *"try --channel latest"* ]]; then echo "$output"; false; fi
  ff_install --yes --channel stable
  [ "$status" -eq 1 ]
  assert_out "try --channel latest"
}

# ---------------------------------------------------------------- real helpers

@test "fetch copies from FF_FETCH_FROM_DIR instead of downloading" {
  mkdir -p "$BATS_TEST_TMPDIR/src"
  printf 'services:\n  api: {}\n' >"$BATS_TEST_TMPDIR/src/docker-compose.prod.yml"
  FF_FETCH_FROM_DIR="$BATS_TEST_TMPDIR/src"
  curl() { echo "curl must not run" >&2; return 99; }
  fetch latest docker-compose.prod.yml "$FF_ROOT/docker-compose.prod.yml"
  cmp "$BATS_TEST_TMPDIR/src/docker-compose.prod.yml" "$FF_ROOT/docker-compose.prod.yml"
}

@test "fetch downloads the file from the ref on GitHub" {
  curl() {
    local out="" a
    while (($#)); do
      a=$1
      shift
      case $a in
        -o) out=$1; shift ;;
        https://*) printf '%s\n' "$a" >"$BATS_TEST_TMPDIR/url" ;;
      esac
    done
    printf 'downloaded\n' >"$out"
  }
  fetch latest deploy/freeframe "$FF_ROOT/x"
  assert_eq "$(cat "$BATS_TEST_TMPDIR/url")" \
    "https://raw.githubusercontent.com/Techiebutler/freeframe/latest/deploy/freeframe"
  assert_eq "$(cat "$FF_ROOT/x")" "downloaded"
}

@test "fetch that fails leaves the old file in place" {
  printf 'old\n' >"$FF_ROOT/x"
  curl() { return 22; }
  run fetch latest docker-compose.prod.yml "$FF_ROOT/x"
  [ "$status" -ne 0 ]
  assert_eq "$(cat "$FF_ROOT/x")" "old"
  [ -z "$(ls "$FF_ROOT" | grep -v '^x$')" ]
}

@test "fetch: a file the ref does not have (HTTP 404) is told apart from other failures" {
  printf 'old\n' >"$FF_ROOT/x"
  curl() { printf '404'; return 22; }
  run fetch v1.22.0 docker-compose.gpu.yml "$FF_ROOT/x"
  [ "$status" -eq 4 ]
  assert_eq "$(cat "$FF_ROOT/x")" "old"
  curl() { printf '503'; return 22; }
  run fetch v1.22.0 docker-compose.gpu.yml "$FF_ROOT/x"
  [ "$status" -eq 1 ]
  curl() { printf '000'; return 6; }
  run fetch v1.22.0 docker-compose.gpu.yml "$FF_ROOT/x"
  [ "$status" -eq 1 ]
  [ -z "$(ls "$FF_ROOT" | grep -v '^x$')" ]
}

@test "fetch: a file missing from FF_FETCH_FROM_DIR counts as not in the ref" {
  mkdir -p "$BATS_TEST_TMPDIR/src"
  FF_FETCH_FROM_DIR="$BATS_TEST_TMPDIR/src"
  run fetch latest docker-compose.gpu.yml "$FF_ROOT/docker-compose.gpu.yml"
  [ "$status" -eq 4 ]
  [ ! -e "$FF_ROOT/docker-compose.gpu.yml" ]
  [ -z "$(ls -A "$FF_ROOT")" ]
}

@test "install: the GPU compose file is downloaded with the other setup files" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "fetch latest docker-compose.storage.yml" "fetch latest docker-compose.gpu.yml" \
    "fetch latest deploy/systemd/freeframe-backup.service"
  [ -f "$FF_ROOT/docker-compose.gpu.yml" ]
}

@test "port_holder names the program and its pid" {
  ss() { printf '%s\n' 'LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("other",pid=1,fd=3))' \
    'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))'; }
  assert_eq "$(port_holder 80)" "nginx 812"
  assert_eq "$(port_holder 443)" ""
}

@test "port_holder matches IPv6 and wildcard listeners but not a longer port" {
  ss() { printf '%s\n' 'LISTEN 0 511 [::]:4430 [::]:* users:(("a",pid=1,fd=3))' \
    'LISTEN 0 511 *:443 *:* users:(("caddy",pid=77,fd=3))'; }
  assert_eq "$(port_holder 443)" "caddy 77"
}

@test "docker_status reads the server version and the compose plugin" {
  docker() {
    case "$1" in
      version) echo "${V:-27.3.1}" ;;
      compose) [[ -z ${NOCOMPOSE:-} ]] ;;
    esac
  }
  assert_eq "$(docker_status)" "ok"
  V=23.0.6
  assert_eq "$(docker_status)" "old 23.0.6"
  V=24.0.0 NOCOMPOSE=1
  assert_eq "$(docker_status)" "nocompose"
}

@test "docker_status says none without docker" {
  PATH="$BATS_TEST_TMPDIR/empty" run docker_status
  assert_eq "$output" "none"
}

@test "switch_to_http_mode changes only the address keys and restarts" {
  FF_IP=203.0.113.7 FF_HTTPS=sslip FF_ACME_EMAIL=c@example.com derive_env "$ENV"
  cp "$ENV" "$BATS_TEST_TMPDIR/before"
  dc() { printf 'dc %s\n' "$*" >>"$CALLS"; }
  probe_health() { :; }
  run switch_to_http_mode "$ENV" 203.0.113.7
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -q -- "dc up -d --no-build --force-recreate" "$CALLS"
  # Exactly these keys changed; everything else is byte for byte the same.
  diff <(grep -vE '^(FREEFRAME_HTTPS|FRONTEND_URL|DOMAIN|S3_PUBLIC_ENDPOINT|STORAGE_DOMAIN|STORAGE_ROUTED|STORAGE_PORT_BIND)=' "$BATS_TEST_TMPDIR/before") \
    <(grep -vE '^(FREEFRAME_HTTPS|FRONTEND_URL|DOMAIN|S3_PUBLIC_ENDPOINT|STORAGE_DOMAIN|STORAGE_ROUTED|STORAGE_PORT_BIND)=' "$ENV")
  assert_has "$ENV" "FREEFRAME_HTTPS=off"
  assert_has "$ENV" "FRONTEND_URL=http://203.0.113.7"
  assert_has "$ENV" "DOMAIN="
  assert_has "$ENV" "STORAGE_DOMAIN="
  assert_has "$ENV" "ACME_EMAIL=c@example.com"
  assert_eq "$(compose_files "$ENV")" "-f docker-compose.prod.yml -f docker-compose.images.yml -f docker-compose.storage.yml"
  [ "$(ls "$ENV".2* | wc -l)" -eq 1 ]
}

@test "_ff_json_str escapes every control character as \\u00XX" {
  local in
  in=$(printf 'a\tb\001c\037d"e\\f')
  in+=$'\n'"g"$'\r'
  assert_eq "$(_ff_json_str "$in")" '"a\u0009b\u0001c\u001fd\"e\\f\u000ag\u000d"'
  assert_eq "$(_ff_json_str 'plain')" '"plain"'
}

@test "ufw_active reads ufw in the C locale" {
  ufw() {
    if [[ ${LC_ALL:-} == C ]]; then echo "Status: active"; else echo "Statut : actif"; fi
  }
  LC_ALL=fr_FR.UTF-8 ufw_active
}

@test "help steers passwords to FREEFRAME_ variables and warns that flags show in ps" {
  run bash "$FF_SCRIPT" help
  [ "$status" -eq 0 ]
  assert_out "FREEFRAME_ADMIN_PASSWORD"
  assert_out "ps"
}

# ---------------------------------------------------------------- install.sh

bootstrap_setup() {
  BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$BIN" "$BATS_TEST_TMPDIR/tmp"
  # Where mktemp puts the download, so a test can see it is cleaned up.
  export TMPDIR="$BATS_TEST_TMPDIR/tmp"
  # The script curl "downloads": it reports how it was run.
  export DOWNLOAD="$BATS_TEST_TMPDIR/download"
  printf '%s\n' '#!/usr/bin/env bash' 'echo "ran: $*"' 'exit "${FAKE_RC:-0}"' >"$DOWNLOAD"
  cat >"$BIN/curl" <<'EOF'
#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift ;;
    https://*) echo "$1" >>"$CALLS" ;;
  esac
  shift
done
[ -n "${CURL_FAIL:-}" ] && exit 22
cp "$DOWNLOAD" "$out"
EOF
  # A Docker with nothing on it, for runs of the real script.
  printf '%s\n' '#!/bin/sh' 'exit 0' >"$BIN/docker"
  # Root, as under sudo, whoever runs the suite (CI runs it as a normal
  # user). The not-root test replaces this with a normal user's id.
  printf '%s\n' '#!/bin/sh' "if [ \"\$1\" = -u ]; then echo 0; else exec $(command -v id) \"\$@\"; fi" >"$BIN/id"
  # The parent process's program, as /proc/<pid>/exe names it: STUB_PARENT_EXE
  # (sudo-rs is /usr/lib/cargo/bin/sudo), or unreadable with STUB_NO_PROC.
  # Any other readlink is the real one.
  cat >"$BIN/readlink" <<EOF
#!/bin/sh
case "\$1" in
  /proc/*/exe)
    [ -z "\${STUB_NO_PROC:-}" ] || exit 1
    if [ -n "\${STUB_PARENT_EXE:-}" ]; then echo "\$STUB_PARENT_EXE"; exit 0; fi ;;
esac
exec $(command -v readlink) "\$@"
EOF
  # sudo --version, for when /proc cannot be read.
  printf '%s\n' '#!/bin/sh' 'echo "${STUB_SUDO_VERSION:-Sudo version 1.9.16}"' >"$BIN/sudo"
  chmod +x "$BIN/curl" "$BIN/docker" "$BIN/id" "$BIN/readlink" "$BIN/sudo"
  # Not started by sudo unless a test says so.
  unset SUDO_USER
}

run_bootstrap() {
  run env PATH="$BIN:$PATH" sh "${BATS_TEST_DIRNAME}/../../install.sh" "$@" </dev/null
}

# under_sudo_rs: what sudo-rs gives the piped script: a parent that is
# sudo-rs and the user who ran sudo.
under_sudo_rs() {
  export SUDO_USER=ada STUB_PARENT_EXE=/usr/lib/cargo/bin/sudo
}

# The working interactive command for a ref.
SUDO_C_LATEST='sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/latest/install.sh)"'

@test "install.sh: runs the downloaded install on the latest channel and writes nothing" {
  bootstrap_setup
  run_bootstrap --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(cat "$CALLS")" \
    "https://raw.githubusercontent.com/Techiebutler/freeframe/latest/deploy/freeframe"
  assert_out "ran: install --channel latest --yes"
  [ ! -e "$FF_BIN_DIR/freeframe" ]
  # The temporary download is gone afterwards.
  [ -z "$(ls -A "$TMPDIR")" ]
}

@test "install.sh: passes on the exit code of freeframe install" {
  bootstrap_setup
  export FAKE_RC=3
  run_bootstrap --yes
  [ "$status" -eq 3 ]
  [ -z "$(ls -A "$TMPDIR")" ]
}

@test "install.sh: FREEFRAME_CHANNEL picks the ref" {
  bootstrap_setup
  export FREEFRAME_CHANNEL=stable
  run_bootstrap
  [ "$status" -eq 0 ]
  grep -q '/stable/deploy/freeframe$' "$CALLS"
  assert_out "ran: install --channel stable"
}

@test "install.sh: --channel picks the ref the script is downloaded from" {
  bootstrap_setup
  export FREEFRAME_CHANNEL=stable
  run_bootstrap --yes --channel v1.22.0
  [ "$status" -eq 0 ]
  grep -q '/v1.22.0/deploy/freeframe$' "$CALLS"
  assert_out "ran: install --channel v1.22.0 --yes --channel v1.22.0"
  : >"$CALLS"
  run_bootstrap --channel=latest
  [ "$status" -eq 0 ]
  grep -q '/latest/deploy/freeframe$' "$CALLS"
}

@test "install.sh: a download that is not the script is refused" {
  bootstrap_setup
  printf '%s\n' '<html>404</html>' >"$DOWNLOAD"
  run_bootstrap
  [ "$status" -eq 1 ]
  assert_out "What to try"
  # Already on latest: no circular "try latest".
  if [[ $output == *"FREEFRAME_CHANNEL=latest"* ]]; then echo "$output"; false; fi
  assert_out "a release after v1.21.0"
  [ -z "$(ls -A "$TMPDIR")" ]
  FREEFRAME_CHANNEL=stable run_bootstrap
  [ "$status" -eq 1 ]
  assert_out "sudo FREEFRAME_CHANNEL=latest bash"
}

@test "install.sh: a cut-off download (bash -n fails) is refused and not run" {
  bootstrap_setup
  printf '%s\n' '#!/usr/bin/env bash' 'echo "ran: $*"' 'main() {' '  if true; then' >"$DOWNLOAD"
  run_bootstrap
  [ "$status" -eq 1 ]
  if grep -q "ran:" <<<"$output"; then echo "$output"; false; fi
  assert_out "not a complete freeframe command"
}

@test "install.sh: a failed download says so" {
  bootstrap_setup
  export CURL_FAIL=1
  run_bootstrap
  [ "$status" -eq 1 ]
  assert_out "Could not download the freeframe command"
  if [[ $output == *"FREEFRAME_CHANNEL=latest"* ]]; then echo "$output"; false; fi
  assert_out "a release after v1.21.0"
  FREEFRAME_CHANNEL=stable run_bootstrap
  [ "$status" -eq 1 ]
  assert_out "sudo FREEFRAME_CHANNEL=latest bash"
}

@test "install.sh: on a Mac or Windows it stops before downloading and names the supported systems" {
  bootstrap_setup
  printf '%s\n' '#!/bin/sh' 'echo "${STUB_KERNEL:-Linux}"' >"$BIN/uname"
  chmod +x "$BIN/uname"
  STUB_KERNEL=Darwin run_bootstrap
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "The FreeFrame installer is for Linux servers: Ubuntu 22.04, 24.04 or 26.04, or Debian 12 or 13, on amd64 or arm64."
  assert_out "This computer runs macOS, so nothing was changed."
  assert_out "Docker Desktop"
  [ ! -s "$CALLS" ]
  STUB_KERNEL=MINGW64_NT-10.0-26100 run_bootstrap
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "This computer runs Windows"
  assert_out "WSL2"
  [ ! -s "$CALLS" ]
  STUB_KERNEL=Linux run_bootstrap --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
}

@test "install.sh: a bad channel name exits 2" {
  bootstrap_setup
  export FREEFRAME_CHANNEL='x;rm'
  run_bootstrap
  [ "$status" -eq 2 ]
  [ ! -s "$CALLS" ]
}

@test "install.sh: not root exits 2 and shows the sudo form that keeps the channel" {
  bootstrap_setup
  printf '%s\n' '#!/bin/sh' 'echo 1000' >"$BIN/id"
  chmod +x "$BIN/id"
  run_bootstrap
  [ "$status" -eq 2 ]
  assert_out "$SUDO_C_LATEST"
  [ ! -s "$CALLS" ]
  FREEFRAME_CHANNEL=stable run_bootstrap
  [ "$status" -eq 2 ]
  assert_out 'sudo FREEFRAME_CHANNEL=stable bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/stable/install.sh)"'
  if [[ $output == *"| sudo"* ]]; then echo "$output"; false; fi
}

@test "install.sh with the real script: a refused run leaves no freeframe command" {
  bootstrap_setup
  cp "$FF_SCRIPT" "$DOWNLOAD"
  os_release debian 11 bullseye
  run_bootstrap --yes
  [ "$status" -eq 3 ] || { echo "$output"; false; }
  assert_out "not supported yet"
  [ ! -e "$FF_BIN_DIR/freeframe" ]
  assert_root_untouched
}

@test "install.sh with the real script: an installed server keeps its freeframe command" {
  bootstrap_setup
  cp "$FF_SCRIPT" "$DOWNLOAD"
  mkdir -p "$FF_BIN_DIR"
  printf '%s\n' '#!/usr/bin/env bash' '# the installed copy' >"$FF_BIN_DIR/freeframe"
  cp "$FF_BIN_DIR/freeframe" "$BATS_TEST_TMPDIR/bin.before"
  : >"$ENV"
  : >"$FF_ROOT/.installed"
  run_bootstrap --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "already installed"
  cmp "$FF_BIN_DIR/freeframe" "$BATS_TEST_TMPDIR/bin.before"
}

# ---------------------------------------------------------------- install.sh under sudo-rs

@test "install.sh: piped under sudo-rs and interactive, it stops before downloading and shows the command that works" {
  bootstrap_setup
  under_sudo_rs
  run_bootstrap
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "sudo-rs"
  assert_out "cannot pass the keyboard to a script that arrives through a pipe"
  assert_out "Nothing was changed."
  grep -qxF -- "  $SUDO_C_LATEST" <<<"$output" || { echo "$output"; false; }
  # Nothing was downloaded.
  [ ! -s "$CALLS" ]
  [ -z "$(ls -A "$TMPDIR")" ]
}

@test "install.sh: under sudo-rs the command shown keeps the channel and the answers given" {
  bootstrap_setup
  under_sudo_rs
  FREEFRAME_CHANNEL=stable run_bootstrap --domain review.example.com --admin-name "Ada Lovelace"
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  grep -qxF -- '  sudo FREEFRAME_CHANNEL=stable bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/stable/install.sh)" install --domain review.example.com --admin-name '"'"'Ada Lovelace'"'"'' <<<"$output" ||
    { echo "$output"; false; }
  [ ! -s "$CALLS" ]
}

@test "install.sh: under sudo-rs a run with --yes, -y or FREEFRAME_YES goes ahead" {
  bootstrap_setup
  under_sudo_rs
  run_bootstrap --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "ran: install --channel latest --yes"
  run_bootstrap -y
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  FREEFRAME_YES=1 run_bootstrap
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "ran: install --channel latest"
  # help asks nothing either.
  run_bootstrap --help
  [ "$status" -eq 0 ] || { echo "$output"; false; }
}

@test "install.sh: classic sudo, and root without sudo, are never stopped" {
  bootstrap_setup
  export SUDO_USER=ada STUB_PARENT_EXE=/usr/bin/sudo.ws
  run_bootstrap
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "ran: install --channel latest"
  export STUB_PARENT_EXE=/usr/bin/sudo
  run_bootstrap
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  # Root's own shell, even on a server whose sudo is sudo-rs.
  unset SUDO_USER
  export STUB_PARENT_EXE=/usr/bin/bash STUB_SUDO_VERSION="sudo-rs 0.2.13"
  run_bootstrap
  [ "$status" -eq 0 ] || { echo "$output"; false; }
}

@test "install.sh: when /proc cannot be read, sudo --version decides" {
  bootstrap_setup
  export SUDO_USER=ada STUB_NO_PROC=1 STUB_SUDO_VERSION="sudo-rs 0.2.13-0ubuntu1.2"
  run_bootstrap
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "$SUDO_C_LATEST"
  export STUB_SUDO_VERSION="Sudo version 1.9.16p2"
  run_bootstrap
  [ "$status" -eq 0 ] || { echo "$output"; false; }
}

@test "install.sh: the guard's decision: only piped, interactive and sudo-rs together stop" {
  local lib="${BATS_TEST_DIRNAME}/../../install.sh"
  # sourced without running main; the three inputs stubbed.
  check() {
    sh -c '
      FREEFRAME_INSTALL_SH_NO_MAIN=1 . "$1"; shift
      stdin_is_terminal() { [ "$T" = 1 ]; }
      started_by_sudo_rs() { [ "$R" = 1 ]; }
      if sudo_rs_would_freeze "$@"; then echo stop; else echo go; fi
    ' check "$lib" "$@"
  }
  assert_eq "$(T=0 R=1 check)" stop
  assert_eq "$(T=1 R=1 check)" go
  assert_eq "$(T=0 R=0 check)" go
  assert_eq "$(T=0 R=1 check --yes)" go
  assert_eq "$(T=0 R=1 check --domain x.example.com -y)" go
  assert_eq "$(T=0 R=1 FREEFRAME_YES=true check)" go
  assert_eq "$(T=0 R=1 FREEFRAME_YES=0 check)" stop
  assert_eq "$(T=0 R=1 check -h)" go
  assert_eq "$(T=0 R=1 check --domain x.example.com)" stop
}

@test "install.sh: run as bash -c, a leading install word is dropped and a lost first option is kept" {
  bootstrap_setup
  local script
  script=$(cat "${BATS_TEST_DIRNAME}/../../install.sh")
  # The documented form: the word after the script is $0.
  run env PATH="$BIN:$PATH" bash -c "$script" install --yes --domain review.example.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "ran: install --channel latest --yes --domain review.example.com"
  # The install word typed twice, or after --.
  run env PATH="$BIN:$PATH" bash -c "$script" -- install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "ran: install --channel latest --yes"
  if [[ $output == *"--yes install"* || $output == *"latest install"* ]]; then echo "$output"; false; fi
  # The install word left out: the first option would be $0 and lost.
  run env PATH="$BIN:$PATH" bash -c "$script" --yes --channel stable
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "ran: install --channel stable --yes --channel stable"
  # The piped form with an install word.
  run_bootstrap install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "ran: install --channel latest --yes"
}

# ---------------------------------------------------------------- fix round 1

@test "install.sh: under sudo-rs the suggested command never repeats a password or secret key" {
  bootstrap_setup
  under_sudo_rs
  local opt form
  for opt in --admin-password --s3-secret-key --smtp-password; do
    for form in split joined; do
      if [[ $form == split ]]; then
        run_bootstrap --domain review.example.com "$opt" 'hunter22-secret'
      else
        run_bootstrap --domain review.example.com "$opt=hunter22-secret"
      fi
      [ "$status" -eq 1 ] || { echo "$output"; false; }
      if [[ $output == *hunter22* ]]; then echo "$opt ($form) was echoed:"; echo "$output"; false; fi
      if grep -F -- "  sudo " <<<"$output" | grep -qF -- "$opt"; then echo "$opt ($form) left in the command:"; echo "$output"; false; fi
      # The rest of the answers are kept, and the left-out option is named.
      assert_out 'install.sh)" install --domain review.example.com'
      assert_out "Passwords and keys are left out of that command: type $opt again yourself, or give it as FREEFRAME_"
      [ ! -s "$CALLS" ]
    done
  done
}

@test "install.sh: under sudo-rs several secrets left out are named on one line" {
  bootstrap_setup
  under_sudo_rs
  run_bootstrap --admin-password=one-secret --smtp-password two-secret --s3-secret-key=three-secret
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  [ "$(grep -c "left out of that command" <<<"$output")" -eq 1 ] || { echo "$output"; false; }
  assert_out "Passwords and keys are left out of that command: type --admin-password, --smtp-password and --s3-secret-key again yourself, or give them as FREEFRAME_ADMIN_PASSWORD, FREEFRAME_SMTP_PASSWORD and FREEFRAME_S3_SECRET_KEY after sudo"
  if [[ $output == *one-secret* || $output == *two-secret* || $output == *three-secret* ]]; then echo "$output"; false; fi
}

@test "install.sh: under sudo-rs a sudo started further up (sudo sh -c 'curl | bash') is not stopped" {
  # Measured on Ubuntu 26.04: only a direct curl ... | sudo bash freezes.
  bootstrap_setup
  export SUDO_USER=ada STUB_PARENT_EXE=/usr/bin/dash STUB_SUDO_VERSION="sudo-rs 0.2.13"
  run_bootstrap
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "ran: install --channel latest"
}

@test "install.sh: a good download prints nothing, so the banner comes first" {
  bootstrap_setup
  run_bootstrap
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$output" "ran: install --channel latest"
}

@test "install.sh: run as bash -c, -q or any other option in \$0 is kept" {
  bootstrap_setup
  local script
  script=$(cat "${BATS_TEST_DIRNAME}/../../install.sh")
  run env PATH="$BIN:$PATH" bash -c "$script" -q --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "ran: install --channel latest -q --yes"
  run env PATH="$BIN:$PATH" bash -c "$script" -x --yes
  assert_out "ran: install --channel latest -x --yes"
}

@test "screens: a number or a stray dot at a menu is not taken as a domain or mail server" {
  local typo
  for typo in 12 22 1.5; do
    rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
    tty_answers "$typo" 2 "$typo" "" 1 "certs@example.com" 1 "$typo" 2 "$typo" "" 1 "Grace" "grace@example.com" \
      "long-password-1" "long-password-1" "y"
    ff_install
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    assert_out "Type 1, 2 or 3, or a domain such as review.yourstudio.com."
    assert_out "'$typo' is not a domain name like review.yourstudio.com."
    assert_out "Type 1 or 2, or the mail server's name."
    assert_out "'$typo' is not a mail server name like smtp.postmarkapp.com."
    assert_has "$ENV" "FRONTEND_URL=https://203-0-113-7.sslip.io"
    if grep -q "^SMTP_HOST=." "$ENV"; then grep "^SMTP_HOST" "$ENV"; false; fi
  done
  # A typed IP address still means plain HTTP on it.
  rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
  tty_answers 10.0.0.5 "${REST[@]}"
  export STUB_LOCAL_IP=10.0.0.5
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=http://10.0.0.5"
}

@test "screens: Enter at Mail server goes back to the email menu" {
  tty_answers "" "certs@example.com" 1 2 "" 1 "Grace" "grace@example.com" "long-password-1" "long-password-1" "y"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ "$(grep -o "Choose 1 or 2" <<<"$output" | wc -l | tr -d ' ')" -eq 3 ] || { echo "$output"; false; }
  if grep -q "^SMTP_HOST=." "$ENV"; then grep "^SMTP_HOST" "$ENV"; false; fi
  assert_out "To add email later, run: sudo freeframe configure"
}

@test "screens: a command in a wrapped message gets a line of its own" {
  export FREEFRAME_DOMAIN=review.example.com STUB_DNS_FAILS=1000
  tty_answers "certs@example.com" "${REST[@]}" "s"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -A1 -xF " Using the temporary address 203-0-113-7.sslip.io instead. Change it later with:" <<<"$output" |
    grep -qxF "   sudo freeframe configure" || { echo "$output"; false; }
  # Wrapped, the command still never shares a line with the sentence.
  rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
  : >"$STUB_DIR/dns-count"
  export COLUMNS=60
  tty_answers "certs@example.com" "${REST[@]}" "s"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  if grep -E "later with: *sudo|[a-z.] sudo freeframe configure" <<<"$output" | grep -v "To add email later, run:"; then
    echo "$output"; false
  fi
  grep -qxF "   sudo freeframe configure" <<<"$output" || { echo "$output"; false; }
}

@test "_ff_lines wraps each line of a text with several lines, keeping the breaks" {
  FF_WIDTH=12
  assert_eq "$(_ff_lines "> " "  " "" $'one two three\nfour five six')" \
    "$(printf '%s\n' "> one two" "  three" "  four five" "  six")"
  FF_WIDTH=0
  assert_eq "$(_ff_lines "> " "  " "" $'one two three\nfour five six')" \
    "$(printf '%s\n' "> one two three" "  four five six")"
  FF_WIDTH=12
  assert_eq "$(_ff_lines "> " "  " "" $'one\n\ntwo')" "$(printf '%s\n' "> one" "" "  two")"
}

# ---------------------------------------------------------------- hints and state lines

@test "install: a program is listed as stopped only when stopping it worked" {
  printf '%s\n' "y" "" "certs@example.com" "1" "" "Grace" "grace@example.com" \
    "long-password-1" "long-password-1" "y" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  export STUB_SS='LISTEN 0 511 [::]:443 [::]:* users:(("apache2",pid=900,fd=4))'
  export STUB_UNIT=apache2.service STUB_SYSTEMCTL_FAIL=1
  ff_install
  [ "$status" -eq 1 ]
  assert_out "Could not stop apache2."
  if [[ $output == *"Already done: stopped apache2"* ]]; then echo "$output"; false; fi
}

@test "install: before the command is installed, a bad option points at the one-line install command" {
  # No freeframe command in FF_BIN_DIR: the person ran the bootstrap.
  run bash -c 'source "$1"; main install --channel stable --bogus' ff "$FF_SCRIPT"
  [ "$status" -eq 2 ]
  assert_out "Unknown option: --bogus"
  assert_out 'sudo FREEFRAME_CHANNEL=stable bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/stable/install.sh)" install --help'
  if [[ $output == *"run 'freeframe help'"* ]]; then echo "$output"; false; fi
  # Without a channel: latest, like install.sh.
  run bash -c 'source "$1"; main install --bogus' ff "$FF_SCRIPT"
  assert_out "$SUDO_C_LATEST install --help"
  # Once the command is installed, it is named.
  mkdir -p "$FF_BIN_DIR"
  printf '#!/usr/bin/env bash\n' >"$FF_BIN_DIR/freeframe"
  chmod 755 "$FF_BIN_DIR/freeframe"
  run bash -c 'source "$1"; main install --bogus' ff "$FF_SCRIPT"
  [ "$status" -eq 2 ]
  assert_out "run 'freeframe help'"
  if [[ $output == *"install.sh"* ]]; then echo "$output"; false; fi
}

@test "install: with no terminal before the command is installed, the hint is the one-line install command" {
  plain_answers
  ff_install --channel stable
  [ "$status" -eq 2 ]
  assert_out 'sudo FREEFRAME_CHANNEL=stable bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/stable/install.sh)" install --yes --admin-email you@yourstudio.com'
  if [[ $output == *" freeframe install --yes"* ]]; then echo "$output"; false; fi
  mkdir -p "$FF_BIN_DIR"
  printf '#!/usr/bin/env bash\n' >"$FF_BIN_DIR/freeframe"
  chmod 755 "$FF_BIN_DIR/freeframe"
  ff_install --channel stable
  [ "$status" -eq 2 ]
  assert_out "sudo freeframe install --yes --admin-email you@yourstudio.com"
}

@test "install: answers ending before the command is installed point at the one-line install command" {
  printf '%s\n' "" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  ff_install --channel stable
  [ "$status" -eq 2 ]
  assert_out "The answers ended before every question was answered"
  assert_out '/freeframe/stable/install.sh)" install --help'
  if [[ $output == *"see: freeframe help"* ]]; then echo "$output"; false; fi
}

@test "install: a failure after server changes lists what was already done" {
  plain_answers
  export FF_RAM_MB=3000 STUB_UFW_ACTIVE=1 STUB_FETCH_FAIL=docker-compose.https.yml
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "Could not download docker-compose.https.yml"
  assert_out "installed the freeframe command at $FF_BIN_DIR/freeframe"
  assert_out "installed Docker"
  assert_out "added a 2 GB swap file"
  assert_out "ufw firewall"
  if [[ $output == *"has only written its log"* ]]; then echo "$output"; false; fi
  # A failed download replaces none of the setup files, so it is not claimed.
  if [[ $output == *"downloaded the setup files"* ]]; then echo "$output"; false; fi
}

@test "install: a failure right after the download says the setup files are there" {
  plain_answers
  export STUB_DOCKER=ok STUB_DERIVE_FAIL=1
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "downloaded the setup files into $FF_ROOT"
  if [[ $output == *"installed Docker"* ]]; then echo "$output"; false; fi
}

@test "install: the one-line install command in a hint follows the settings file's channel" {
  printf 'FREEFRAME_CHANNEL=stable\n' >"$ENV"
  run bash -c 'source "$1"; main install --bogus' ff "$FF_SCRIPT"
  [ "$status" -eq 2 ]
  assert_out 'sudo FREEFRAME_CHANNEL=stable bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/stable/install.sh)" install --help'
  # An explicit --channel still wins.
  run bash -c 'source "$1"; main install --channel v1.22.0 --bogus' ff "$FF_SCRIPT"
  assert_out 'sudo FREEFRAME_CHANNEL=v1.22.0 bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/v1.22.0/install.sh)" install --help'
}

# ------------------------------------------------- why the download failed

# _pull_kind OUTPUT: what _ff_pull_failure_kind says about docker's output.
_pull_kind() { bash -c 'source "$1"; _ff_pull_failure_kind "$2"' ff-kind "$FF_SCRIPT" "$1"; }

@test "pull failure kind: a release that is not published or not public" {
  local o
  for o in \
    'Error response from daemon: manifest unknown' \
    'Error response from daemon: Head "https://ghcr.io/v2/techiebutler/freeframe-api/manifests/9.9.9": denied' \
    ' api Error failed to resolve reference "ghcr.io/techiebutler/freeframe-api:9.9.9": ghcr.io/techiebutler/freeframe-api:9.9.9: not found' \
    'Error response from daemon: error from registry: requested access to the resource is denied' \
    'Error response from daemon: Head "https://ghcr.io/v2/techiebutler/freeframe-web/manifests/1.2.3": unauthorized' \
    'pull access denied for ghcr.io/techiebutler/freeframe-web, repository does not exist or may require authorization: Requested access to the resource is denied'; do
    run _pull_kind "$o"
    [ "$status" -eq 0 ]
    assert_eq "$output" missing
  done
}

@test "pull failure kind: the registry cannot be reached" {
  local o
  for o in \
    'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io on 127.0.0.53:53: no such host' \
    'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp 140.82.112.34:443: i/o timeout' \
    'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp 140.82.112.34:443: connect: connection refused' \
    'Error response from daemon: Get "https://ghcr.io/v2/": net/http: TLS handshake timeout' \
    'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp 2606:50c0::1:443: connect: network is unreachable'; do
    run _pull_kind "$o"
    [ "$status" -eq 0 ]
    assert_eq "$output" network
  done
}

@test "pull failure kind: a full disk wins over the other words around it" {
  run _pull_kind 'failed to register layer: write /var/lib/docker/tmp/x: no space left on device'
  assert_eq "$output" disk
  run _pull_kind 'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host
write /var/lib/docker/tmp/x: no space left on device'
  assert_eq "$output" disk
}

@test "pull failure kind: a network failure wins over a denied next to it" {
  run _pull_kind 'Error response from daemon: Head "https://ghcr.io/v2/techiebutler/freeframe-api/manifests/1.2.3": denied
Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host'
  assert_eq "$output" network
}

@test "pull failure kind: anything else, an empty output, or a missing program, is other" {
  local o
  for o in '' 'something unexpected happened' \
    'error getting credentials - err: exec: "docker-credential-desktop": executable file not found in $PATH' \
    'error getting credentials - err: exit status 1, out: `not found`' \
    'docker-credential-pass: command not found' \
    'open /root/.docker/config.json: no such file or directory' \
    'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/images/json": dial unix /var/run/docker.sock: connect: permission denied' \
    'failed to register layer: Error processing tar file(exit status 1): open /usr/lib/x: permission denied'; do
    run _pull_kind "$o"
    [ "$status" -eq 0 ]
    assert_eq "$output" other
  done
}

@test "install: a release that is not published is not reported as a network problem" {
  plain_answers
  export STUB_PULL_FAIL=1 STUB_PULL_ERR='Error response from daemon: manifest unknown'
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "is not available on ghcr.io yet (the release may not be published, or its images are not public)."
  assert_out "check https://github.com/Techiebutler/freeframe/releases for a newer release; to pin a release that is published, set FREEFRAME_VERSION in $FF_ROOT/.env.prod, then run sudo freeframe install again."
  assert_out "If this server was logged in to ghcr.io with docker login, run sudo docker logout ghcr.io and try again."
  assert_out "continues from here"
  assert_no_out "can reach ghcr.io"
  assert_no_out "could not be downloaded"
  # What docker said is in the log, for whoever has to look, and never on the screen.
  assert_no_out "manifest unknown"
  grep -q "manifest unknown" "$FF_ROOT/install.log"
}

@test "install: what the download prints reaches install.log while it runs" {
  plain_answers
  export STUB_PULL_FAIL=1 STUB_PULL_ERR='Error response from daemon: manifest unknown' STUB_PULL_PEEK=1
  ff_install --yes
  [ "$status" -eq 1 ]
  [ -e "$BATS_TEST_TMPDIR/pull-live" ]
}

@test "install: only the end of what the download printed decides, so old output cannot" {
  plain_answers
  # "manifest unknown" first, then more than 64 KiB of other lines.
  STUB_PULL_ERR="manifest unknown
$(head -c 70000 /dev/zero | tr '\0' x)"
  export STUB_PULL_FAIL=1 STUB_PULL_ERR
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "from ghcr.io failed."
  assert_no_out "is not available on ghcr.io"
}

@test "install: a download that cannot reach ghcr.io keeps the network advice" {
  plain_answers
  export STUB_PULL_FAIL=1 STUB_PULL_ERR='Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host'
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "could not be downloaded."
  assert_out "check that this server can reach ghcr.io, then run sudo freeframe install again."
  assert_no_out "is not available on ghcr.io"
}

@test "install: a full disk during the download says so and shows how to see the free space" {
  plain_answers
  export STUB_PULL_FAIL=1 STUB_PULL_ERR='failed to register layer: no space left on device'
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "The disk is full"
  assert_out "df -h /var/lib/docker"
  assert_out "then run sudo freeframe install again."
  assert_no_out "can reach ghcr.io"
}

@test "install: a download that fails for another reason points at install.log without guessing" {
  plain_answers
  export STUB_PULL_FAIL=1 STUB_PULL_ERR='something unexpected happened'
  ff_install --yes
  [ "$status" -eq 1 ]
  assert_out "from ghcr.io failed."
  assert_out "install.log"
  assert_no_out "can reach ghcr.io"
  assert_no_out "is not available on ghcr.io"
  assert_no_out "disk is full"
}

# ---------------------------------------------------------------- video processing (GPU)

# The rest of an interactive run after the web address step, with the Video
# processing question answered GPU_ANSWER before the confirmation.
rest_gpu() { REST_GPU=(1 "" "Grace" "grace@example.com" "long-password-1" "long-password-1" "$1" "y"); }

@test "gpu: a server without a GPU says so in the check, and processes video on the CPU" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qxF "   GPU: none found" <<<"$output" || { echo "$output"; false; }
  [[ $output == *"Checking this server ... ok"*"   GPU: none found"* ]] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_GPU=off"
  assert_out "   Video         processed on the CPU (no GPU found)"
  grep -qxF " Video processing: CPU (no GPU found)" <<<"$output" || { echo "$output"; false; }
  assert_not_called install_nvidia_toolkit
}

@test "gpu: a ready NVIDIA GPU is used without a question, and nothing is installed for it" {
  plain_answers
  export STUB_GPU=ready
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qxF "   GPU: NVIDIA GeForce RTX 5070 Ti (driver 610.47)" <<<"$output" || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
  assert_out "processed on the GPU (NVIDIA GeForce RTX 5070 Ti), with the CPU as a fallback"
  grep -qxF " Video processing: GPU (NVIDIA GeForce RTX 5070 Ti)" <<<"$output" || { echo "$output"; false; }
  assert_not_called install_nvidia_toolkit
}

@test "gpu: unattended, a GPU without the toolkit stays on the CPU and says how to use it" {
  plain_answers
  export STUB_GPU=notoolkit
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_GPU=off"
  assert_out "add --gpu nvidia to the install command"
  grep -qxF "         sudo freeframe configure" <<<"$output" || { echo "$output"; false; }
  assert_out "processed on the CPU (the NVIDIA container toolkit is not set up)"
  assert_not_called install_nvidia_toolkit
}

@test "gpu: unattended with --gpu nvidia, the toolkit is set up after Docker, before anything else" {
  plain_answers
  export STUB_GPU=notoolkit
  ff_install --yes --gpu nvidia
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order install_docker install_nvidia_toolkit "fetch latest docker-compose.prod.yml" derive_env "dc up -d"
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
  assert_out "Setting up the NVIDIA container toolkit"
  grep -qxF " Video processing: GPU (NVIDIA GeForce RTX 5070 Ti)" <<<"$output" || { echo "$output"; false; }
  # The toolkit output goes to the log, not the screen.
  [[ $(grep -c install_nvidia_toolkit "$CALLS") == 1 ]]
}

@test "gpu: FREEFRAME_GPU=nvidia works like --gpu nvidia" {
  plain_answers
  export STUB_GPU=noruntime FREEFRAME_GPU=nvidia
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx install_nvidia_toolkit "$CALLS"
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
}

@test "gpu: a toolkit that cannot be set up never fails the install; video stays on the CPU" {
  plain_answers
  export STUB_GPU=notoolkit STUB_GPU_SETUP_FAIL=1
  ff_install --yes --gpu nvidia
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "The NVIDIA container toolkit could not be set up, so FreeFrame processes video on the CPU"
  assert_has "$ENV" "FREEFRAME_GPU=off"
  grep -qxF " Video processing: CPU (the NVIDIA container toolkit could not be set up)" <<<"$output" || { echo "$output"; false; }
  assert_out "FreeFrame is ready: http://203.0.113.7"
  # The way to try again, on a line of its own.
  grep -qxF "   sudo freeframe configure" <<<"$output" || { echo "$output"; false; }
}

@test "gpu: an unknown --gpu value is refused before anything is written" {
  plain_answers
  ff_install --yes --gpu cuda
  [ "$status" -eq 2 ]
  assert_out "must be nvidia or off"
  assert_root_untouched
}

@test "gpu: an NVIDIA card without a working driver gets the driver suggestion, and the install goes on" {
  plain_answers
  export STUB_GPU=nodriver
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qxF "   GPU: NVIDIA (no working driver)" <<<"$output" || { echo "$output"; false; }
  assert_out "its driver does not answer"
  grep -qxF "         sudo ubuntu-drivers install" <<<"$output" || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_GPU=off"
  assert_not_called install_nvidia_toolkit
}

@test "gpu: an Intel GPU is explained, with the guide's section, and the install stays on the CPU" {
  plain_answers
  export STUB_GPU=intel
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qxF "   GPU: Intel (not used with the published images)" <<<"$output" || { echo "$output"; false; }
  assert_out "docs/deployment.md#hardware-accelerated-transcoding-optional"
  assert_out "processed on the CPU (the Intel GPU is not used with the published images)"
  assert_has "$ENV" "FREEFRAME_GPU=off"
}

@test "gpu screens: a GPU without the toolkit adds a fifth step, Video processing, and yes sets it up" {
  unset LC_ALL LC_CTYPE
  export LANG=C.UTF-8 STUB_GPU=notoolkit
  rest_gpu y
  tty_answers 3 "${REST_GPU[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Five short questions"
  assert_eq "$(step_headers)" "$(printf '%s\n' "1/5 Web address" "2/5 Storage" "3/5 Email" "4/5 Admin account" "5/5 Video processing")"
  assert_out "This server has an NVIDIA GPU: NVIDIA GeForce RTX 5070 Ti (driver 610.47)."
  assert_out " Use the NVIDIA GPU for video processing? [Y/n]"
  # The question comes before the summary, and nothing is installed before
  # the confirmation.
  [[ $output == *"Use the NVIDIA GPU"*"Ready to install"*"Install now?"* ]] || { echo "$output"; false; }
  assert_order install_docker install_nvidia_toolkit
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
}

@test "gpu screens: no at the Video processing step keeps the CPU and installs nothing for the GPU" {
  export STUB_GPU=notoolkit
  rest_gpu n
  tty_answers 3 "${REST_GPU[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_GPU=off"
  assert_out "processed on the CPU (you chose the CPU)"
  assert_not_called install_nvidia_toolkit
}

@test "gpu screens: Enter at the Video processing step means yes" {
  export STUB_GPU=notoolkit
  rest_gpu ""
  tty_answers 3 "${REST_GPU[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
}

@test "gpu screens: cancelling at the summary installs nothing, GPU toolkit included" {
  export STUB_GPU=notoolkit
  tty_answers 3 1 "" "Grace" "grace@example.com" "long-password-1" "long-password-1" "y" "n"
  ff_install
  [ "$status" -eq 1 ]
  assert_out "Install cancelled"
  assert_not_called install_nvidia_toolkit
  assert_not_called install_docker
}

@test "gpu screens: a ready GPU, no driver or no GPU ask nothing: still four steps" {
  local s
  for s in ready nodriver none intel; do
    rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
    : >"$CALLS"
    export STUB_GPU=$s
    tty_answers 3 "${REST[@]}"
    ff_install
    [ "$status" -eq 0 ] || { echo "$s: $output"; false; }
    assert_eq "$(step_headers)" "$(printf '%s\n' "1/4 Web address" "2/4 Storage" "3/4 Email" "4/4 Admin account")"
  done
}

@test "gpu screens: the GPU question alone is one step of one" {
  export STUB_GPU=notoolkit FREEFRAME_HTTPS=off FREEFRAME_STORAGE=bundled FREEFRAME_SMTP_HOST=smtp.example.com \
    FREEFRAME_SMTP_FROM=noreply@example.com FREEFRAME_ADMIN_NAME=Grace FREEFRAME_ADMIN_EMAIL=grace@example.com \
    FREEFRAME_ADMIN_PASSWORD=long-password-1
  tty_answers y y
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(step_headers)" "1/1 Video processing"
  assert_out "One short question"
}

@test "gpu: a re-run keeps the GPU chosen before, and sets the toolkit up without asking again" {
  plain_answers
  printf 'FREEFRAME_GPU=nvidia\n' >"$ENV"
  export STUB_GPU=notoolkit
  # Storage, email, then the confirmation: no Video processing question.
  tty_answers 1 "" y
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  if [[ $output == *"Video processing?"* ]]; then echo "$output"; false; fi
  grep -qx install_nvidia_toolkit "$CALLS"
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
}

@test "gpu: settings that ask for the GPU on a server without a usable one are turned to the CPU, after a backup" {
  plain_answers
  printf 'FREEFRAME_GPU=nvidia\n' >"$ENV"
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "say FREEFRAME_GPU=nvidia"
  assert_has "$ENV" "FREEFRAME_GPU=off"
  grep -l '^FREEFRAME_GPU=nvidia$' "$FF_ROOT"/.env.prod.* >/dev/null
  assert_not_called install_nvidia_toolkit
}

# ---------------------------------------------------------------- fix round 1

@test "gpu screens: the banner is printed before the GPU is detected" {
  export STUB_GPU=notoolkit STUB_GPU_MARK=1
  rest_gpu y
  tty_answers 3 "${REST_GPU[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [[ $output == *"Self-hosted review for your team's video, images and audio"*"<<detect_gpu>>"*"Welcome!"*"Five short questions"* ]] ||
    { echo "$output"; false; }
  # The banner is the first thing on the screen.
  [[ ${output%%<<detect_gpu>>*} == *"| __| _ ___ ___| __|"* ]] || { echo "$output"; false; }
}

@test "gpu screens: unattended, the one-line header is printed before the GPU is detected" {
  plain_answers
  export STUB_GPU_MARK=1
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [[ $output == *"FreeFrame installer (--yes"*"<<detect_gpu>>"* ]] || { echo "$output"; false; }
}

@test "gpu: Docker left down by a failed toolkit set-up is restarted once more, and the install goes on on the CPU" {
  plain_answers
  export STUB_GPU=notoolkit STUB_GPU_SETUP_FAIL=1 STUB_GPU_DOCKER_DOWN=1
  ff_install --yes --gpu nvidia
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order install_nvidia_toolkit "systemctl restart docker" "dc up -d"
  assert_has "$ENV" "FREEFRAME_GPU=off"
  assert_out "FreeFrame is ready"
}

@test "gpu: Docker that stays down after the NVIDIA change stops the install with the undo, before any download or start" {
  plain_answers
  export STUB_GPU=notoolkit STUB_GPU_SETUP_FAIL=1 STUB_GPU_DOCKER_DOWN=1 STUB_DOCKER_STAYS_DOWN=1
  ff_install --yes --gpu nvidia
  [ "$status" -eq 1 ]
  assert_out "Docker did not come back after the NVIDIA change"
  assert_out "/etc/docker/daemon.json"
  assert_out "sudo cp /etc/docker/daemon.json.before-freeframe-nvidia-20261028-101010 /etc/docker/daemon.json && sudo systemctl restart docker"
  assert_not_called "dc pull"
  assert_not_called "dc up"
  assert_not_called "fetch latest"
}

@test "gpu screens: with other containers running, the Video processing step and the summary say they stop for a moment" {
  export STUB_GPU=notoolkit STUB_OTHER_CONTAINERS=2
  rest_gpu y
  tty_answers 3 "${REST_GPU[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [[ $output == *"Video processing"*"2 other containers are running on this server"*"Use the NVIDIA GPU"* ]] || { echo "$output"; false; }
  assert_out "every container on this server stops for a moment"
  [[ $output == *"Ready to install"*"stops the 2 other containers running on this server for a moment"*"Install now?"* ]] ||
    { echo "$output"; false; }
}

@test "gpu: unattended with --gpu nvidia and another container running, the summary says it stops for a moment" {
  plain_answers
  export STUB_GPU=notoolkit STUB_OTHER_CONTAINERS=1
  ff_install --yes --gpu nvidia
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "stops the 1 other container running on this server for a moment"
}

@test "gpu screens: with no other containers, no word about them" {
  export STUB_GPU=notoolkit
  rest_gpu y
  tty_answers 3 "${REST_GPU[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_no_out "other container"
}

@test "gpu: the detection result reaches install.log once it starts, and not the screen" {
  plain_answers
  export STUB_GPU=notoolkit
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qxF "GPU check: state notoolkit (NVIDIA GeForce RTX 5070 Ti, driver 610.47), nvidia-smi: NVIDIA GeForce RTX 5070 Ti, 610.47; video on the CPU" "$FF_ROOT/install.log" ||
    { cat "$FF_ROOT/install.log"; false; }
  assert_no_out "GPU check: state"
  # Once, after the log's header.
  [ "$(grep -c '^GPU check:' "$FF_ROOT/install.log")" -eq 1 ]
  [[ $(sed -n '/===== freeframe install/,$p' "$FF_ROOT/install.log") == *"GPU check: state notoolkit"* ]]
}

@test "gpu: with no GPU, the log says so too" {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qxF "GPU check: state none, nvidia-smi: no answer; video on the CPU" "$FF_ROOT/install.log" || { cat "$FF_ROOT/install.log"; false; }
}


# ---------------------------------------------------------------- the worker's GPU, after the start

# smi_asks / recreates: how often the worker was asked about the GPU, and
# created again on its own.
smi_asks() { grep -c '^dc exec -T worker nvidia-smi -L$' "$CALLS" || true; }
recreates() { grep -c '^dc up -d --no-build --no-deps --force-recreate worker$' "$CALLS" || true; }

@test "gpu worker: a worker that sees the GPU at the first ask is asked once and not started again" {
  plain_answers
  export STUB_GPU=ready STUB_WORKER_SMI=pass
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(smi_asks)" 1
  assert_eq "$(recreates)" 0
  grep -qx "dc_bounded 30 exec -T worker nvidia-smi -L" "$CALLS" || { cat "$CALLS"; false; }
  # After FreeFrame is started, with a wait for the worker first.
  assert_order "dc up -d --no-build traefik" "ps -q --status running worker" "exec -T worker nvidia-smi -L"
  grep -qxF " Video processing: GPU (NVIDIA GeForce RTX 5070 Ti)" <<<"$output" || { echo "$output"; false; }
  grep -qxF "GPU self-check: the worker sees the GPU (NVIDIA GeForce RTX 5070 Ti)" "$FF_ROOT/install.log" ||
    { cat "$FF_ROOT/install.log"; false; }
  assert_no_out "started again"
}

@test "gpu worker: a worker that does not see the GPU is started again once, and then does" {
  plain_answers
  export STUB_GPU=ready STUB_WORKER_SMI=restart
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(recreates)" 1
  assert_eq "$(smi_asks)" 2
  assert_order "exec -T worker nvidia-smi -L" "up -d --no-build --no-deps --force-recreate worker" \
    "ps -q --status running worker" "exec -T worker nvidia-smi -L"
  assert_out "The worker did not see the GPU at first, so it was started again; it uses the GPU now."
  grep -qxF " Video processing: GPU (NVIDIA GeForce RTX 5070 Ti)" <<<"$output" || { echo "$output"; false; }
  # What nvidia-smi said is in the log, on one line.
  grep -qxF "GPU self-check: the worker's nvidia-smi -L said: Failed to initialize NVML: GPU access blocked by the operating system; Failed to properly shut down NVML: GPU access blocked by the operating system (exit 255)" "$FF_ROOT/install.log" ||
    { cat "$FF_ROOT/install.log"; false; }
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
}

@test "gpu worker: a worker that never sees the GPU is started again once, the install goes on, and every line says the CPU" {
  plain_answers
  export STUB_GPU=ready STUB_WORKER_SMI=fail
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(recreates)" 1
  assert_eq "$(smi_asks)" 2
  assert_out "FreeFrame is ready: http://203.0.113.7"
  assert_out "The worker could not use the NVIDIA GPU (NVIDIA GeForce RTX 5070 Ti), even after it was started again, so video is processed on the CPU for now."
  grep -qxF " Video processing: CPU for now: the worker could not use the GPU (NVIDIA GeForce RTX 5070 Ti)." <<<"$output" ||
    { echo "$output"; false; }
  assert_no_out "Video processing: GPU"
  assert_out "docs/deployment.md#troubleshooting-the-installer"
  grep -qxF "   sudo freeframe restart" <<<"$output" || { echo "$output"; false; }
  # The setting stays, so a later start can pick the GPU up.
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
  # The log has nvidia-smi's answer and the same closing line.
  grep -qF "Failed to initialize NVML: GPU access blocked by the operating system" "$FF_ROOT/install.log"
  grep -qxF " Video processing: CPU for now: the worker could not use the GPU (NVIDIA GeForce RTX 5070 Ti)." "$FF_ROOT/install.log" ||
    { cat "$FF_ROOT/install.log"; false; }
}

@test "gpu worker: the backup units' daemon-reload comes before the start, so the worker keeps the GPU with no recreate" {
  plain_answers
  export STUB_GPU=ready STUB_RELOAD_DROPS_GPU=1
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "systemctl daemon-reload" "dc up -d --no-build" backup_timer_on "dc exec -T worker nvidia-smi -L"
  assert_eq "$(recreates)" 0
  assert_eq "$(smi_asks)" 1
  # The worker FreeFrame is left with sees the GPU, as the closing line says.
  [ -e "$STUB_DIR/worker-gpu-up" ]
  grep -qxF " Video processing: GPU (NVIDIA GeForce RTX 5070 Ti)" <<<"$output" || { echo "$output"; false; }
}

@test "gpu worker: a worker that never runs and whose nvidia-smi fails is created again once, then said to be stopped, not on the CPU" {
  plain_answers
  export STUB_GPU=ready STUB_WORKER_SMI=fail STUB_WORKER_DOWN=1 FF_GPU_WORKER_WAIT=4
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(recreates)" 1
  assert_out "The worker that processes video is not running, so no video is processed until it starts."
  grep -qxF " Video processing: stopped: the worker that processes video is not running." <<<"$output" || { echo "$output"; false; }
  grep -qxF "   sudo freeframe logs worker" <<<"$output" || { echo "$output"; false; }
  assert_no_out "CPU for now"
  assert_no_out "Video processing: GPU"
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
  grep -qxF " Video processing: stopped: the worker that processes video is not running." "$FF_ROOT/install.log"
}

@test "gpu worker: with the GPU off, the worker is never asked and nothing waits for it" {
  local s
  for s in none notoolkit nodriver; do
    rm -rf "$FF_ROOT" && mkdir -p "$FF_ROOT"
    : >"$CALLS"
    plain_answers
    export STUB_GPU=$s STUB_WORKER_SMI=fail
    ff_install --yes
    [ "$status" -eq 0 ] || { echo "$s: $output"; false; }
    assert_not_called "nvidia-smi"
    assert_not_called "ps -q --status running worker"
    assert_not_called "force-recreate"
    assert_no_out "Checking that video processing can use the GPU"
    if grep -q '^GPU self-check' "$FF_ROOT/install.log"; then cat "$FF_ROOT/install.log"; false; fi
  done
}

@test "gpu worker: chosen with --gpu off on a ready GPU, nothing is checked either" {
  plain_answers
  export STUB_GPU=ready STUB_WORKER_SMI=fail
  ff_install --yes --gpu off
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called "nvidia-smi"
  grep -qxF " Video processing: CPU (chosen with --gpu off)" <<<"$output" || { echo "$output"; false; }
}

@test "gpu worker: a worker that is slow to start is waited for, within a limit, and asked anyway" {
  plain_answers
  export STUB_GPU=ready STUB_WORKER_SMI=pass STUB_WORKER_DOWN=1 FF_GPU_WORKER_WAIT=6
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  # 6 seconds, in steps of 2: four looks, three waits.
  assert_eq "$(grep -c '^dc_bounded 30 ps -q --status running worker$' "$CALLS")" 4
  assert_eq "$(smi_asks)" 1
  grep -qxF " Video processing: GPU (NVIDIA GeForce RTX 5070 Ti)" <<<"$output" || { echo "$output"; false; }
}

@test "gpu worker: the toolkit set up by the install, then the worker checked" {
  plain_answers
  export STUB_GPU=notoolkit STUB_WORKER_SMI=fail
  ff_install --yes --gpu nvidia
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order install_nvidia_toolkit "exec -T worker nvidia-smi -L"
  grep -qxF " Video processing: CPU for now: the worker could not use the GPU (NVIDIA GeForce RTX 5070 Ti)." <<<"$output" ||
    { echo "$output"; false; }
}

# ---------------------------------------------------------------- putting FreeFrame back, unattended

# kept_install: what an uninstall that kept the data leaves, with its
# settings put back: a complete .env.prod (from an earlier install) and the
# database's volume.
kept_install() {
  plain_answers
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  find "$FF_ROOT" -mindepth 1 -maxdepth 1 ! -name .env.prod -exec rm -rf {} +
  : >"$CALLS"
  unset FREEFRAME_ADMIN_NAME FREEFRAME_ADMIN_EMAIL FREEFRAME_ADMIN_PASSWORD
}

@test "admin kept: --yes with the settings and a database that has an admin needs no admin answers" {
  kept_install
  export STUB_PGDATA=1
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_no_out "Missing answer"
  assert_out "An admin account already exists, so no new one was made."
  assert_out "Sign in with the admin account that already existed."
  assert_order "localhost:8000/health" "localhost:8000/setup/status" "dc up -d --no-build traefik"
  assert_not_called create-superadmin
  # The summary says what happens to the admin.
  assert_out "   Admin         the one already in the database kept on this server"
  [ -f "$FF_ROOT/.installed" ]
}

@test "admin kept: --yes with the settings and an empty database stops before opening up, and a re-run with the email finishes" {
  kept_install
  export STUB_PGDATA=1 STUB_SETUP_NEEDED=1
  ff_install --yes
  [ "$status" -eq 2 ] || { echo "$output"; false; }
  assert_out "Missing answer: set FREEFRAME_ADMIN_EMAIL (the admin account's email)"
  assert_out "FreeFrame is running but cannot be reached from outside yet, and its database has no admin account."
  assert_out "Running the install command again with FREEFRAME_ADMIN_EMAIL set creates it and continues from here."
  assert_not_called create-superadmin
  assert_not_called "dc up -d --no-build traefik"
  [ ! -e "$FF_ROOT/.installed" ]
  grep -qF "Missing answer: set FREEFRAME_ADMIN_EMAIL" "$FF_ROOT/install.log"

  : >"$CALLS"
  export FREEFRAME_ADMIN_EMAIL=admin@example.com FREEFRAME_ADMIN_PASSWORD=s3cret-pass
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Admin account created for admin@example.com."
  assert_order create-superadmin "dc up -d --no-build traefik"
  assert_not_called "setup/status"
}

@test "admin kept: an API that does not say whether there is an admin stops the same way" {
  kept_install
  export STUB_PGDATA=1 STUB_SETUP_STATUS_FAIL=1
  ff_install --yes
  [ "$status" -eq 2 ] || { echo "$output"; false; }
  assert_out "Missing answer: set FREEFRAME_ADMIN_EMAIL"
  assert_not_called create-superadmin
  assert_not_called "dc up -d --no-build traefik"
}

@test "admin kept: with the settings but no database volume, the email is asked for up front, as before" {
  kept_install
  ff_install --yes
  [ "$status" -eq 2 ] || { echo "$output"; false; }
  assert_out "Missing answer: set FREEFRAME_ADMIN_EMAIL"
  assert_not_called "dc up"
  assert_not_called fetch
}

@test "admin kept: a fresh server (no settings) never looks for the volume and needs the email" {
  export FREEFRAME_HTTPS=off STUB_PGDATA=1
  ff_install --yes
  [ "$status" -eq 2 ] || { echo "$output"; false; }
  assert_out "Missing answer: set FREEFRAME_ADMIN_EMAIL"
  assert_not_called _ff_pgdata_kept
}

@test "admin kept: an email given is used as before, even with the volume there" {
  kept_install
  export STUB_PGDATA=1 FREEFRAME_ADMIN_EMAIL=admin@example.com STUB_ADMIN_CODE=403 \
    STUB_ADMIN_BODY='{"detail":"Setup already completed. Superadmin already exists."}'
  ff_install --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -q create-superadmin "$CALLS"
  assert_not_called "setup/status"
  assert_out "An admin account already exists"
}

@test "admin kept: a bad admin password given ahead of time is still refused before anything changes" {
  kept_install
  export STUB_PGDATA=1 FREEFRAME_ADMIN_PASSWORD=short
  ff_install --yes
  [ "$status" -eq 2 ] || { echo "$output"; false; }
  assert_out "The admin password must be 8 to 72 characters long."
  assert_not_called "dc up"
}

@test "admin kept: interactive, the admin questions say an existing admin is kept" {
  kept_install
  export STUB_PGDATA=1
  # Storage, skip email, name, email, password twice, confirm.
  tty_answers "${REST[@]}"
  ff_install
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "This server keeps FreeFrame's database from before. If it already has an admin account, these answers are not used: sign in with that account."
  grep -q create-superadmin "$CALLS"
}
