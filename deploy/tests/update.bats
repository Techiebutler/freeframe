#!/usr/bin/env bats
# `freeframe update` (spec goals 12 and 12b), with every side effect stubbed
# (manage_stubs.bash). Each flow runs in a fresh bash under the script's own
# strict mode.

load manage_helpers

setup() {
  manage_setup
  installed_server sslip bundled 1.21.0
  # The channel now has a newer release.
  remote_release 1.22.0
}

# A newer freeframe command on the channel: the script plus one line.
newer_command() { printf '\n# a newer freeframe command\n' >>"$STUB_REMOTE/deploy/freeframe"; }

newest_dump() { (cd "$BK" && LC_ALL=C ls freeframe-*.dump 2>/dev/null | tail -1); }

# ---------------------------------------------------------------- self-update

@test "update: re-execs exactly once when the downloaded command differs" {
  newer_command
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  assert_eq "$(grep -c '^reexec ' "$CALLS")" 1
  assert_eq "$(grep -c '^fetch latest deploy/freeframe$' "$CALLS")" 1
  grep -qx "reexec $FF_BIN_DIR/freeframe update" "$CALLS"
  cmp "$STUB_REMOTE/deploy/freeframe" "$FF_BIN_DIR/freeframe"
  # The re-executed run did the update itself.
  assert_order "reexec " "dc exec -T postgres pg_dump" "dc up -d --no-build"
  assert_out "The freeframe command was updated"
}

@test "update: running the installed command itself, a newer download still re-execs once" {
  newer_command
  # As on a server: the script that runs is /usr/local/bin/freeframe, the
  # very file the update replaces.
  run bash -c 'set -Eeuo pipefail; source "$1"; source "$2"; shift 2; main "$@"' \
    ff-run "$FF_BIN_DIR/freeframe" "$STUBS" update
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  assert_eq "$(grep -c '^reexec ' "$CALLS")" 1
  cmp "$STUB_REMOTE/deploy/freeframe" "$FF_BIN_DIR/freeframe"
}

@test "update: does not re-exec when the downloaded command is the same" {
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called reexec
  assert_eq "$(grep -c '^fetch latest deploy/freeframe$' "$CALLS")" 1
  cmp "$FF_SCRIPT" "$FF_BIN_DIR/freeframe"
}

@test "update: with FF_SELF_UPDATED=1 the command is not downloaded again" {
  newer_command
  export FF_SELF_UPDATED=1
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called "deploy/freeframe"
  assert_not_called reexec
  cmp "$FF_SCRIPT" "$FF_BIN_DIR/freeframe"
}

@test "update: the real re-exec runs the new command once, with the same options" {
  # A stand-in that carries the marks of a freeframe script.
  printf '#!/usr/bin/env bash\nFF_SCRIPT_KIND=freeframe-management-script\ncmd_update() { :; }\necho "new freeframe: FF_SELF_UPDATED=$FF_SELF_UPDATED args: $*"\n' \
    >"$STUB_REMOTE/deploy/freeframe"
  export STUB_REAL_REEXEC=1
  ff update --channel latest
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "new freeframe: FF_SELF_UPDATED=1 args: update --channel latest"
  cmp "$STUB_REMOTE/deploy/freeframe" "$FF_BIN_DIR/freeframe"
  [ "$(stat -c %a "$FF_BIN_DIR/freeframe")" = 755 ]
  # The old process stopped at the exec: nothing else ran.
  assert_no_dc_change
}

@test "update: the re-exec'd command carries on with the lock the update took" {
  command -v flock >/dev/null || skip "no flock"
  # A stand-in new command that reports on the lock.
  cat >"$STUB_REMOTE/deploy/freeframe" <<'SCRIPT'
#!/usr/bin/env bash
FF_SCRIPT_KIND=freeframe-management-script
cmd_update() { :; }
exec {g}>>"$FF_ROOT/.freeframe.lock"
if flock -n "$g"; then echo "lock: free"; else echo "lock: held"; fi
if [[ -n ${FF_LOCK_FD:-} ]] && flock -n "$FF_LOCK_FD"; then echo "lock: carried on"; fi
SCRIPT
  export STUB_REAL_REEXEC=1
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  # Nobody else can take it, and the new command has it.
  assert_out "lock: held"
  assert_out "lock: carried on"
}

@test "update: a cut-off command download is refused and nothing changes" {
  printf '#!/usr/bin/env bash\nif true; then\n' >"$STUB_REMOTE/deploy/freeframe"
  cp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  ff update
  [ "$status" -eq 1 ]
  assert_out "nothing was changed"
  cmp "$FF_SCRIPT" "$FF_BIN_DIR/freeframe"
  cmp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  assert_no_dc_change
  [ ! -d "$BK" ]
}

@test "update: a download that is valid bash but not the freeframe script is refused" {
  printf '#!/usr/bin/env bash\necho "some other script"\n' >"$STUB_REMOTE/deploy/freeframe"
  ff update
  [ "$status" -eq 1 ]
  assert_out "is not the freeframe command"
  assert_out "nothing was changed"
  cmp "$FF_SCRIPT" "$FF_BIN_DIR/freeframe"
  assert_no_dc_change
  # With the marker but without the update command, it is refused too.
  printf '#!/usr/bin/env bash\nFF_SCRIPT_KIND=freeframe-management-script\n' >"$STUB_REMOTE/deploy/freeframe"
  ff update
  [ "$status" -eq 1 ]
  cmp "$FF_SCRIPT" "$FF_BIN_DIR/freeframe"
}

@test "update: a failed command download stops before anything changes" {
  export STUB_FETCH_FAIL=deploy/freeframe
  ff update
  [ "$status" -eq 1 ]
  assert_out "nothing was changed"
  assert_no_dc_change
  assert_not_called "fetch latest docker-compose"
}

# ---------------------------------------------------------------- the update

@test "update: backs up, saves the setup files, downloads, merges, pulls, starts, checks, then refreshes the timer" {
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "fetch latest deploy/freeframe" "dc exec -T postgres pg_dump -Fc" \
    "fetch latest docker-compose.prod.yml" "fetch latest docker-compose.images.yml" \
    "fetch latest docker-compose.https.yml" "fetch latest docker-compose.storage.yml" \
    "fetch latest deploy/systemd/freeframe-backup.service" "fetch latest deploy/systemd/freeframe-backup.timer" \
    derive_env "dc pull" "dc up -d --no-build" "localhost:8000/health" \
    "probe_health sslip 203-0-113-7.sslip.io" install_backup_timer
  # The units the timer is refreshed from are the channel's new ones.
  cmp "$STUB_REMOTE/deploy/systemd/freeframe-backup.service" "$FF_ROOT/systemd/freeframe-backup.service"
  cmp "$STUB_REMOTE/docker-compose.images.yml" "$FF_ROOT/docker-compose.images.yml"
  # It ended well: no way back is kept open.
  [ ! -e "$FF_ROOT/.update-undo" ]
}

@test "update: prints the version before and after, and the backup it took" {
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "FreeFrame was updated from 1.21.0 to 1.22.0."
  local d
  d=$(newest_dump)
  [ -n "$d" ]
  assert_out "$BK/$d"
}

@test "update: the same version says it is up to date" {
  remote_release 1.21.0
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "already on the newest release of the latest channel (1.21.0)"
}

@test "update: keeps every existing key and adds the ones a new release needs" {
  # Settings from an older release: two keys the current one writes are missing.
  grep -v -e '^MAINTENANCE_CONCURRENCY=' -e '^MAIL_PROVIDER=' "$ENV" >"$ENV.tmp"
  mv "$ENV.tmp" "$ENV"
  chmod 600 "$ENV"
  cp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  # Every line that was there is still there, unchanged.
  local line
  while IFS= read -r line; do
    grep -qxF -- "$line" "$ENV" || { echo "lost or changed: $line"; false; }
  done <"$BATS_TEST_TMPDIR/env.before"
  assert_has "$ENV" "MAINTENANCE_CONCURRENCY=1"
  assert_has "$ENV" "MAIL_PROVIDER=smtp"
  assert_secrets_same "$BATS_TEST_TMPDIR/env.before" "$ENV"
  # The file was backed up before the keys were added, and nothing pins the version.
  cmp "$FF_ROOT/$(env_backups | tail -1)" "$BATS_TEST_TMPDIR/env.before"
  assert_no_key "$ENV" FREEFRAME_VERSION
  [ "$(stat -c %a "$ENV")" = 600 ]
}

@test "update: a complete settings file is left byte for byte" {
  cp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  cmp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  [ -z "$(env_backups)" ]
}

@test "update: no answers from the command line reach the settings" {
  export FREEFRAME_SMTP_HOST=smtp.example.com
  ff update
  [ "$status" -eq 2 ]
  assert_out "sudo freeframe configure"
  assert_not_called "dc "
}

# ---------------------------------------------------------------- failures

@test "update: FreeFrame not healthy afterwards names sudo freeframe rollback and exits 1" {
  export STUB_API_DOWN=1 FF_API_WAIT=10
  ff update
  [ "$status" -eq 1 ]
  assert_out "FreeFrame did not come back after the update to 1.22.0."
  assert_out "To go back to 1.21.0 with the database as it was just before the update, run: sudo freeframe rollback"
  assert_no_out "tee -a"
  assert_out "sudo freeframe logs"
  assert_out "install.log"
}

@test "update: a failed update leaves the record and the setup files from before for the rollback" {
  local f
  mkdir -p "$BATS_TEST_TMPDIR/before"
  for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml; do
    cp "$FF_ROOT/$f" "$BATS_TEST_TMPDIR/before/$f"
  done
  export STUB_API_DOWN=1 FF_API_WAIT=10
  ff update
  [ "$status" -eq 1 ]
  [ "$(stat -c %a "$FF_ROOT/.update-undo")" = 600 ]
  grep -qx "version=1.21.0" "$FF_ROOT/.update-undo"
  grep -qx "backup=$BK/$(newest_dump)" "$FF_ROOT/.update-undo"
  grep -q "^time=20" "$FF_ROOT/.update-undo"
  [ "$(stat -c %a "$FF_ROOT/rollback")" = 700 ]
  for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml; do
    cmp "$BATS_TEST_TMPDIR/before/$f" "$FF_ROOT/rollback/$f"
  done
  cmp "$FF_ROOT/rollback/freeframe-backup.service" <(sed 's/1.22.0/1.21.0/' "$STUB_REMOTE/deploy/systemd/freeframe-backup.service")
}

@test "update: the stack not starting names the rollback too" {
  export STUB_UP_FAIL=1
  ff update
  [ "$status" -eq 1 ]
  assert_out "run: sudo freeframe rollback"
  [ -e "$FF_ROOT/.update-undo" ]
}

@test "update: no answer through the web address names the rollback" {
  export STUB_HEALTH_FAIL=1 FF_HEALTH_WAIT=10
  ff update
  [ "$status" -eq 1 ]
  assert_out "run: sudo freeframe rollback"
}

@test "update: a failed image download puts the setup files from before back and drops the record" {
  cp "$FF_ROOT/docker-compose.images.yml" "$BATS_TEST_TMPDIR/images.before"
  export STUB_PULL_FAIL=1 STUB_PULL_ERR='dial tcp: lookup ghcr.io: no such host'
  ff update
  [ "$status" -eq 1 ]
  assert_out "could not be downloaded"
  assert_out "FreeFrame is running the version it had (1.21.0), with its setup files from before"
  assert_out "Running sudo freeframe update again is safe."
  assert_not_called "dc up -d"
  cmp "$BATS_TEST_TMPDIR/images.before" "$FF_ROOT/docker-compose.images.yml"
  [ ! -e "$FF_ROOT/.update-undo" ]
  # So a plain re-run is not refused.
  unset STUB_PULL_FAIL
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
}

@test "update: a backup that fails stops it before anything is downloaded" {
  export STUB_PG_DOWN=1 FF_BACKUP_DB_WAIT=10
  ff update
  [ "$status" -eq 1 ]
  assert_out "No new backup was made"
  assert_out "The update stopped before changing anything"
  assert_not_called "fetch latest docker-compose"
  assert_not_called "dc pull"
  cmp "$FF_ROOT/docker-compose.images.yml" <(sed 's/1.22.0/1.21.0/g' "$STUB_REMOTE/docker-compose.images.yml")
}

@test "update: a failed setup file download replaces none of them" {
  export STUB_FETCH_FAIL=docker-compose.storage.yml
  cp "$FF_ROOT/docker-compose.images.yml" "$BATS_TEST_TMPDIR/images.before"
  ff update
  [ "$status" -eq 1 ]
  assert_out "Could not download docker-compose.storage.yml"
  cmp "$FF_ROOT/docker-compose.images.yml" "$BATS_TEST_TMPDIR/images.before"
  assert_not_called "dc pull"
  [ -z "$(ls -A "$FF_ROOT" | grep '^\.download')" ]
}

@test "update: a setup file that cannot be moved into place puts back the ones already moved" {
  export STUB_MV_FAIL=docker-compose.storage.yml
  local f
  mkdir -p "$BATS_TEST_TMPDIR/before"
  for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml; do
    cp "$FF_ROOT/$f" "$BATS_TEST_TMPDIR/before/$f"
  done
  ff update
  [ "$status" -eq 1 ]
  assert_out "could not be put in place, so none of the setup files was replaced"
  # The images file was moved in before the storage file failed: it is back.
  for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml; do
    cmp "$BATS_TEST_TMPDIR/before/$f" "$FF_ROOT/$f"
  done
  assert_not_called "dc pull"
  [ -z "$(ls -A "$FF_ROOT" | grep '^\.download')" ]
}

@test "update: a pinned server takes its setup files from the pinned release's tag and says it stays" {
  printf 'FREEFRAME_VERSION=1.22.5\n' >>"$ENV"
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "pinned to version 1.22.5"
  grep -qx "fetch v1.22.5 docker-compose.images.yml" "$CALLS"
  grep -qx "fetch v1.22.5 deploy/systemd/freeframe-backup.timer" "$CALLS"
  assert_not_called "fetch latest docker-compose"
  # The command itself still comes from the channel.
  grep -qx "fetch latest deploy/freeframe" "$CALLS"
  assert_has "$ENV" "FREEFRAME_VERSION=1.22.5"
  assert_out "FreeFrame stays on the pinned version 1.22.5"
  assert_no_out "newest release"
}

# ---------------------------------------------------------------- channel

@test "update: --channel wins, is saved with a settings backup, and the command and files come from it" {
  ff update --channel stable
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx "fetch stable deploy/freeframe" "$CALLS"
  grep -qx "fetch stable docker-compose.images.yml" "$CALLS"
  assert_not_called "fetch latest"
  assert_has "$ENV" "FREEFRAME_CHANNEL=stable"
  assert_has "$FF_ROOT/$(env_backups | head -1)" "FREEFRAME_CHANNEL=latest"
}

@test "update: a release that is not published is not reported as a network problem, and nothing was changed" {
  cp "$FF_ROOT/docker-compose.images.yml" "$BATS_TEST_TMPDIR/images.before"
  export STUB_PULL_FAIL=1 STUB_PULL_ERR='Error response from daemon: manifest unknown'
  ff update
  [ "$status" -eq 1 ]
  assert_out "FreeFrame 1.22.0 is not available on ghcr.io yet (the release may not be published, or its images are not public)."
  assert_out "check https://github.com/Techiebutler/freeframe/releases for a newer release, then run sudo freeframe update again later; nothing was changed, so running it again is safe."
  assert_out "If this server was logged in to ghcr.io with docker login, run sudo docker logout ghcr.io and try again."
  assert_no_out "can reach ghcr.io"
  assert_no_out "could not be downloaded"
  assert_no_out "manifest unknown"
  assert_not_called "dc up -d"
  cmp "$FF_ROOT/docker-compose.images.yml" "$BATS_TEST_TMPDIR/images.before"
}

@test "update: when an earlier update's files were put back first, the missing-release advice says so" {
  run bash -c 'source "$1"; FF_PULL_OUT="manifest unknown" FF_UPDATE_PUT_BACK=1; _ff_pull_failure_text update 1.22.0; printf "%s" "$FF_PULL_TRY"' ff "$FF_SCRIPT"
  [ "$status" -eq 0 ]
  [[ $output == *"nothing else was changed (the setup files from before an earlier update that stopped part-way were put back first), so running it again is safe."* ]] || { echo "$output"; false; }
}

@test "update: a download that cannot reach ghcr.io keeps the network advice" {
  export STUB_PULL_FAIL=1 STUB_PULL_ERR='Error response from daemon: Get "https://ghcr.io/v2/": dial tcp 140.82.112.34:443: i/o timeout'
  ff update
  [ "$status" -eq 1 ]
  assert_out "FreeFrame 1.22.0 could not be downloaded."
  assert_out "check that this server can reach ghcr.io, then run sudo freeframe update again."
  assert_no_out "is not available on ghcr.io"
}

@test "update: a full disk during the download says so and shows how to see the free space" {
  export STUB_PULL_FAIL=1 STUB_PULL_ERR='failed to register layer: no space left on device'
  ff update
  [ "$status" -eq 1 ]
  assert_out "The disk is full"
  assert_out "df -h /var/lib/docker"
  assert_out "then run sudo freeframe update again."
  assert_no_out "can reach ghcr.io"
}

@test "update: a download that fails for another reason points at install.log without guessing" {
  export STUB_PULL_FAIL=1 STUB_PULL_ERR='something unexpected happened'
  ff update
  [ "$status" -eq 1 ]
  assert_out "The download of FreeFrame 1.22.0 from ghcr.io failed."
  assert_out "install.log"
  assert_no_out "can reach ghcr.io"
  assert_no_out "is not available on ghcr.io"
}

@test "update: --channel is not saved when the update fails, at any step" {
  local knob
  for knob in pull setup-files start; do
    : >"$CALLS"
    case $knob in
      pull) STUB_PULL_FAIL=1 ff update --channel stable ;;
      # The setup files of the channel cannot be downloaded (the command
      # itself comes from the same ref, so only its files fail).
      setup-files) STUB_FETCH_FAIL=docker-compose.prod.yml ff update --channel stable ;;
      start) STUB_API_DOWN=1 FF_API_WAIT=10 ff update --channel stable ;;
    esac
    [ "$status" -eq 1 ] || { echo "$knob: $output"; false; }
    assert_eq "$(env_get "$ENV" FREEFRAME_CHANNEL)" latest
    assert_no_out "The channel is now stable"
    rm -f "$FF_ROOT/.update-undo"
  done
}

@test "update: --channel is not written by the settings fill of an update that then fails" {
  # A settings file with no channel line (it follows latest).
  grep -v '^FREEFRAME_CHANNEL=' "$ENV" >"$ENV.tmp"
  mv "$ENV.tmp" "$ENV"
  chmod 600 "$ENV"
  STUB_API_DOWN=1 FF_API_WAIT=10 ff update --channel stable
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  [ "$(env_get "$ENV" FREEFRAME_CHANNEL)" != stable ]
}

@test "update: --channel is saved once the new version answers" {
  ff update --channel stable
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "localhost:8000/health" "probe_health"
  assert_has "$ENV" "FREEFRAME_CHANNEL=stable"
  assert_out "The channel is now stable"
}

@test "update: without --channel the server's channel is used for the command and the files" {
  env_set "$ENV" FREEFRAME_CHANNEL stable
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx "fetch stable deploy/freeframe" "$CALLS"
  grep -qx "fetch stable docker-compose.prod.yml" "$CALLS"
  assert_not_called "fetch latest"
}

# ---------------------------------------------------------------- downgrade

# this_server_runs VERSION: the setup files on this server are for VERSION.
this_server_runs() {
  sed -i "s/FREEFRAME_VERSION:-[^}]*}/FREEFRAME_VERSION:-$1}/" "$FF_ROOT/docker-compose.images.yml"
}

@test "update: a channel older than this server is refused, nothing changes and the channel is not saved" {
  this_server_runs 1.22.0
  remote_release 1.21.0
  newer_command
  cp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  cp "$FF_ROOT/docker-compose.images.yml" "$BATS_TEST_TMPDIR/images.before"
  ff update --channel stable
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "The stable channel is on FreeFrame 1.21.0, older than the 1.22.0 this server runs, so nothing was changed."
  assert_out "sudo freeframe update --channel latest"
  assert_out "Or wait until the stable channel reaches 1.22.0"
  cmp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  cmp "$FF_ROOT/docker-compose.images.yml" "$BATS_TEST_TMPDIR/images.before"
  assert_eq "$(env_get "$ENV" FREEFRAME_CHANNEL)" latest
  # The command on this server is not swapped for the channel's older one.
  cmp "$FF_SCRIPT" "$FF_BIN_DIR/freeframe"
  assert_no_dc_change
  assert_not_called "fetch stable docker-compose"
  assert_not_called "fetch stable deploy/freeframe"
  [ ! -d "$BK" ]
  [ -z "$(env_backups)" ]
}

@test "update: the running version counts when it is newer than the files, and latest is not offered on latest" {
  remote_release 1.21.0
  export STUB_RUNNING_IMAGE=ghcr.io/techiebutler/freeframe-api:1.22.0
  ff update
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "The latest channel is on FreeFrame 1.21.0, older than the 1.22.0 this server runs, so nothing was changed."
  assert_out "Wait until the latest channel reaches 1.22.0"
  assert_no_out "--channel latest"
  assert_not_called "dc pull"
  [ ! -d "$BK" ]
}

@test "update: a channel whose version cannot be read stops before anything changes" {
  export STUB_NET_DOWN=1
  ff update
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "nothing was changed"
  assert_no_dc_change
  [ ! -d "$BK" ]
}

@test "update: a channel that is not a branch or tag name is refused" {
  ff update --channel '../x'
  [ "$status" -eq 2 ]
  assert_not_called fetch
}

# ---------------------------------------------------------------- refusals

@test "update: not root, not installed, an unfinished install or restore, and the lock all refuse" {
  STUB_NOT_ROOT=1 ff update
  [ "$status" -eq 2 ]
  assert_out "sudo freeframe update"

  rm "$FF_ROOT/.installed"
  ff update
  [ "$status" -eq 1 ]
  assert_out "did not finish"
  assert_out "sudo freeframe install"
  printf 'FreeFrame installed\n' >"$FF_ROOT/.installed"

  mkdir -p "$BK"
  printf 'PGDMP old\n' >"$BK/freeframe-20261020-030000.dump"
  printf '%s\n' "$BK/freeframe-20261020-030000.dump" >"$FF_ROOT/.restore-undo"
  ff update
  [ "$status" -eq 1 ]
  assert_out "A restore of the database did not finish"
  assert_out "sudo freeframe restore --yes '$BK/freeframe-20261020-030000.dump'"
  rm "$FF_ROOT/.restore-undo"
  assert_not_called "dc "

  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  ff update
  exec 9>&-
  [ "$status" -eq 1 ]
  assert_out "Another freeframe command (an update, rollback, backup, restore, restart, configure or uninstall) is running right now"
  assert_not_called "dc "
}

@test "update: stray words are a usage error" {
  ff update now
  [ "$status" -eq 2 ]
  assert_not_called fetch
}

# ---------------------------------------------------------------- interrupted updates

SETUP_NAMES="docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml"

keep_files() {
  local f
  mkdir -p "$BATS_TEST_TMPDIR/before"
  for f in $SETUP_NAMES; do cp "$FF_ROOT/$f" "$BATS_TEST_TMPDIR/before/$f"; done
  cp "$FF_ROOT/systemd/freeframe-backup.service" "$BATS_TEST_TMPDIR/before/"
}

assert_files_before() {
  local f
  for f in $SETUP_NAMES; do
    cmp "$BATS_TEST_TMPDIR/before/$f" "$FF_ROOT/$f" || { echo "$f is not as before"; return 1; }
  done
  cmp "$BATS_TEST_TMPDIR/before/freeframe-backup.service" "$FF_ROOT/systemd/freeframe-backup.service"
}

# The update stopped before the new version started: as if it never ran.
assert_put_back() {
  assert_files_before
  [ ! -e "$FF_ROOT/.update-undo" ] || { echo "record left:"; cat "$FF_ROOT/.update-undo"; return 1; }
  [ -z "$(ls -A "$FF_ROOT" | grep '^\.download')" ]
  assert_out "FreeFrame is running the version it had (1.21.0), with its setup files from before."
  assert_out "Running sudo freeframe update again is safe."
  assert_no_out "Nothing has been changed"
  assert_no_out "sudo rm"
}

@test "update: stopped (TERM) during the image download, the old files are back and a re-run works" {
  keep_files
  export STUB_PULL_HANG=1
  ff_signal TERM pull update
  [ "$status" -eq 1 ]
  assert_out "The update was stopped (SIGTERM) while downloading FreeFrame 1.22.0"
  assert_put_back
  unset STUB_PULL_HANG
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "FreeFrame was updated from 1.21.0 to 1.22.0."
}

@test "update: stopped (HUP) in the middle of replacing the setup files, none of the new ones stays" {
  keep_files
  export STUB_MV_HANG=docker-compose.storage.yml
  ff_signal HUP mv update
  [ "$status" -eq 1 ]
  assert_out "stopped (SIGHUP)"
  assert_put_back
}

@test "update: a signal in the middle of the replace waits for it to finish, so the set on disk is whole" {
  # The saved copy cannot be put back here, so what is on disk is the
  # replace's own work. The signal arrives while the third file is moved;
  # the units come after it and hold the release number.
  export STUB_MV_HANG=docker-compose.https.yml STUB_PUTBACK_FAIL=1
  ff_signal HUP mv update
  [ "$status" -eq 1 ]
  local f
  for f in $SETUP_NAMES; do
    cmp "$STUB_REMOTE/$f" "$FF_ROOT/$f" || { echo "$f is not the new one"; return 1; }
  done
  cmp "$STUB_REMOTE/deploy/systemd/freeframe-backup.service" "$FF_ROOT/systemd/freeframe-backup.service"
  cmp "$STUB_REMOTE/deploy/systemd/freeframe-backup.timer" "$FF_ROOT/systemd/freeframe-backup.timer"
  [ -z "$(ls -A "$FF_ROOT" | grep '^\.download')" ]
  # The signal still stops the update, and the state it gives is true.
  assert_out "stopped (SIGHUP)"
  [ -e "$FF_ROOT/.update-undo" ]
  assert_out "run: sudo freeframe rollback"
  assert_no_out "update again"
  assert_not_called "dc pull"
}

@test "update: stopped (TERM) right after the record is written, nothing stays changed" {
  keep_files
  export STUB_UNDO_SET_HANG=1
  ff_signal TERM undo-set update
  [ "$status" -eq 1 ]
  assert_put_back
}

@test "update: an unexpected failure (ERR) after the record is written puts the old files back" {
  keep_files
  export STUB_SAY_FAIL="Downloading FreeFrame 1.22.0"
  ff update
  [ "$status" -eq 1 ]
  assert_out "The update stopped unexpectedly while"
  assert_put_back
}

@test "update: stopped once the new version is starting, the record stays and names the rollback" {
  export STUB_HEALTH_HANG=1
  ff_signal TERM health update
  [ "$status" -eq 1 ]
  [ -e "$FF_ROOT/.update-undo" ]
  grep -qx "phase=started" "$FF_ROOT/.update-undo"
  assert_out "run: sudo freeframe rollback"
  assert_no_out "update again"
}

@test "update: a record left by a killed update before the new version started is put back first" {
  keep_files
  # What a SIGKILL during the image download leaves: new files in place, the
  # saved set, and the record.
  mkdir -p "$FF_ROOT/rollback"
  local f
  for f in $SETUP_NAMES; do cp "$FF_ROOT/$f" "$FF_ROOT/rollback/$f"; cp "$STUB_REMOTE/$f" "$FF_ROOT/$f"; done
  cp "$FF_ROOT/systemd/"freeframe-backup.* "$FF_ROOT/rollback/"
  mkdir -p "$BK"
  printf 'PGDMP before\n' >"$BK/freeframe-20261020-030000.dump"
  printf 'version=1.21.0\nbackup=%s\ntime=2026-10-20 03:00:00 +0000\nphase=saved\n' "$BK/freeframe-20261020-030000.dump" \
    >"$FF_ROOT/.update-undo"
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "An earlier update stopped before it started the new version"
  assert_out "FreeFrame was updated from 1.21.0 to 1.22.0."
  [ ! -e "$FF_ROOT/.update-undo" ]
}

# started_record: what an update leaves once it started 1.22.0 and that did
# not come up: the new release's files on disk, and the record.
started_record() {
  local f
  for f in $SETUP_NAMES; do cp "$STUB_REMOTE/$f" "$FF_ROOT/$f"; done
  mkdir -p "$BK"
  printf 'PGDMP before\n' >"$BK/freeframe-20261020-030000.dump"
  printf 'version=1.21.0\nbackup=%s\ntime=2026-10-20 03:00:00 +0000\nphase=started\n' "$BK/freeframe-20261020-030000.dump" \
    >"$FF_ROOT/.update-undo"
}

@test "update: a record of an update whose new version started is refused, and removing it is offered" {
  started_record
  export STUB_RUNNING_IMAGE=ghcr.io/techiebutler/freeframe-api:1.22.0
  ff update
  [ "$status" -eq 1 ]
  assert_out "sudo freeframe rollback"
  assert_out "sudo rm '$FF_ROOT/.update-undo'"
  # A record without a phase (written by an older freeframe) is treated the same.
  sed -i '/^phase=/d' "$FF_ROOT/.update-undo"
  ff update
  [ "$status" -eq 1 ]
  assert_out "sudo freeframe rollback"
  assert_not_called "fetch latest docker-compose"
}

@test "update: removing a started update's record is offered only while the new version is what runs" {
  started_record
  # The new version never came up in place of the old one (its start failed).
  export STUB_RUNNING_IMAGE=ghcr.io/techiebutler/freeframe-api:1.21.0
  ff update
  [ "$status" -eq 1 ]
  assert_out "run: sudo freeframe rollback"
  assert_no_out "sudo rm"
  # Nothing runs at all.
  unset STUB_RUNNING_IMAGE
  ff update
  [ "$status" -eq 1 ]
  assert_out "run: sudo freeframe rollback"
  assert_no_out "sudo rm"
  assert_not_called "fetch latest docker-compose"
}

@test "update: new files on disk under the old running version take the way back from the old release's tag" {
  # A record removed by hand after an update stopped part-way: the files are
  # the new release's, the containers still the old one's.
  local f
  for f in $SETUP_NAMES; do cp "$STUB_REMOTE/$f" "$FF_ROOT/$f"; done
  export STUB_RUNNING_IMAGE=ghcr.io/techiebutler/freeframe-api:1.21.0
  export STUB_REMOTE_REFS="$BATS_TEST_TMPDIR/refs"
  # The old release's files at its tag.
  mkdir -p "$STUB_REMOTE_REFS/v1.21.0/deploy/systemd"
  sed 's/1.22.0/1.21.0/g' "$STUB_REMOTE/docker-compose.images.yml" >"$STUB_REMOTE_REFS/v1.21.0/docker-compose.images.yml"
  for f in docker-compose.prod.yml docker-compose.https.yml docker-compose.storage.yml; do
    cp "$STUB_REMOTE/$f" "$STUB_REMOTE_REFS/v1.21.0/$f"
  done
  cp "$STUB_REMOTE"/deploy/systemd/* "$STUB_REMOTE_REFS/v1.21.0/deploy/systemd/"
  export STUB_API_DOWN=1 FF_API_WAIT=10
  ff update
  [ "$status" -eq 1 ]
  grep -qx "fetch v1.21.0 docker-compose.images.yml" "$CALLS"
  grep -qx "version=1.21.0" "$FF_ROOT/.update-undo"
  grep -q '1.21.0' "$FF_ROOT/rollback/docker-compose.images.yml"
  assert_out "To go back to 1.21.0"
}

@test "update: when the old release's files cannot be had, it stops before changing anything" {
  local f
  for f in $SETUP_NAMES; do cp "$STUB_REMOTE/$f" "$FF_ROOT/$f"; done
  export STUB_RUNNING_IMAGE=ghcr.io/techiebutler/freeframe-api:1.21.0 STUB_FETCH_FAIL_REF=v1.21.0
  ff update
  [ "$status" -eq 1 ]
  assert_out "FreeFrame runs version 1.21.0, but the setup files in $FF_ROOT are for 1.22.0"
  assert_out "nothing was changed"
  assert_not_called "dc pull"
  [ ! -e "$FF_ROOT/.update-undo" ]
}

# ---------------------------------------------------------------- the optional GPU file

@test "update: a release with the GPU compose file brings it in with the set" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx "fetch latest docker-compose.gpu.yml" "$CALLS"
  cmp "$STUB_REMOTE/docker-compose.gpu.yml" "$FF_ROOT/docker-compose.gpu.yml"
}

@test "update: a release without the GPU compose file (an older one) is no failure; the set has none" {
  [ ! -e "$STUB_REMOTE/docker-compose.gpu.yml" ]
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx "fetch latest docker-compose.gpu.yml" "$CALLS"
  [ ! -e "$FF_ROOT/docker-compose.gpu.yml" ]
  # The saved way back still has the one from before.
  [ -f "$FF_ROOT/rollback/docker-compose.gpu.yml" ]
}

@test "update: the GPU compose file failing for another reason than not being there fails the update as before" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  export STUB_FETCH_FAIL=docker-compose.gpu.yml
  cp "$FF_ROOT/docker-compose.images.yml" "$BATS_TEST_TMPDIR/images.before"
  ff update
  [ "$status" -eq 1 ]
  assert_out "Could not download docker-compose.gpu.yml"
  cmp "$FF_ROOT/docker-compose.images.yml" "$BATS_TEST_TMPDIR/images.before"
  assert_not_called "dc pull"
}

@test "update: a set whose move fails after a missing GPU file was taken out puts that file back" {
  printf 'gpu from before\n' >"$FF_ROOT/docker-compose.gpu.yml"
  export STUB_MV_FAIL=systemd/freeframe-backup.service
  ff update
  [ "$status" -eq 1 ]
  assert_out "could not be put in place"
  assert_eq "$(cat "$FF_ROOT/docker-compose.gpu.yml")" "gpu from before"
}

@test "update: the way back from an older release's tag without a GPU file is saved without one" {
  local f
  for f in $SETUP_NAMES; do cp "$STUB_REMOTE/$f" "$FF_ROOT/$f"; done
  export STUB_RUNNING_IMAGE=ghcr.io/techiebutler/freeframe-api:1.21.0
  export STUB_REMOTE_REFS="$BATS_TEST_TMPDIR/refs"
  mkdir -p "$STUB_REMOTE_REFS/v1.21.0/deploy/systemd"
  sed 's/1.22.0/1.21.0/g' "$STUB_REMOTE/docker-compose.images.yml" >"$STUB_REMOTE_REFS/v1.21.0/docker-compose.images.yml"
  for f in docker-compose.prod.yml docker-compose.https.yml docker-compose.storage.yml; do
    cp "$STUB_REMOTE/$f" "$STUB_REMOTE_REFS/v1.21.0/$f"
  done
  cp "$STUB_REMOTE"/deploy/systemd/* "$STUB_REMOTE_REFS/v1.21.0/deploy/systemd/"
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx "fetch v1.21.0 docker-compose.gpu.yml" "$CALLS"
  [ -f "$FF_ROOT/rollback/docker-compose.images.yml" ]
  [ ! -e "$FF_ROOT/rollback/docker-compose.gpu.yml" ]
}

# ---------------------------------------------------------------- minors (round 2)

@test "update: a mixed set that can be put back from the saved copy ends true and safe" {
  keep_files
  export STUB_MV_FAIL=docker-compose.storage.yml STUB_MV_OLD_FAIL=docker-compose.images.yml
  ff update
  [ "$status" -eq 1 ]
  # The saved copy put them back, so the headline does not say otherwise.
  assert_no_out "could not be put back either"
  assert_out "The new docker-compose.storage.yml could not be put in place; the setup files from before were put back from the copy saved before the update."
  assert_put_back
}

@test "update: a mixed set that cannot be put back keeps the record and names the rollback" {
  export STUB_MV_FAIL=docker-compose.storage.yml STUB_MV_OLD_FAIL=docker-compose.images.yml STUB_PUTBACK_FAIL=1
  ff update
  [ "$status" -eq 1 ]
  [ -e "$FF_ROOT/.update-undo" ]
  assert_out "run: sudo freeframe rollback"
  assert_no_out "Nothing has been changed"
  assert_no_out "update again"
}

@test "update: a server pinned to 1.21.0 or earlier is told it cannot be managed this way" {
  printf 'FREEFRAME_VERSION=1.21.0\n' >>"$ENV"
  ff update
  [ "$status" -eq 1 ]
  assert_out "after 1.21.0"
  assert_out "delete the FREEFRAME_VERSION line"
  assert_not_called "fetch v1.21.0"
  assert_not_called "dc "
}

@test "update: a pinned release whose files cannot be downloaded suggests removing the pin" {
  printf 'FREEFRAME_VERSION=1.22.0\n' >>"$ENV"
  export STUB_FETCH_FAIL_REF=v1.22.0
  ff update
  [ "$status" -eq 1 ]
  assert_out "release v1.22.0"
  assert_out "delete the FREEFRAME_VERSION line"
}

@test "every rollback hint uses the same command, sudo freeframe rollback" {
  if grep -n 'freeframe rollback --yes' "$FF_SCRIPT"; then false; fi
}

# ---------------------------------------------------------------- round 3

# killed_update_state: what an update killed before its new version started
# leaves (or what a running one has while it downloads): the new files in
# place, the saved set, and a phase=saved record.
killed_update_state() {
  local f
  mkdir -p "$FF_ROOT/rollback"
  for f in $SETUP_NAMES; do cp "$FF_ROOT/$f" "$FF_ROOT/rollback/$f"; cp "$STUB_REMOTE/$f" "$FF_ROOT/$f"; done
  cp "$FF_ROOT/systemd/"freeframe-backup.* "$FF_ROOT/rollback/"
  mkdir -p "$BK"
  printf 'PGDMP before\n' >"$BK/freeframe-20261020-030000.dump"
  printf 'version=1.21.0\nbackup=%s\ntime=2026-10-20 03:00:00 +0000\nphase=saved\n' "$BK/freeframe-20261020-030000.dump" \
    >"$FF_ROOT/.update-undo"
}

@test "update: a second update while the first holds the lock changes nothing of the first's" {
  command -v flock >/dev/null || skip "no flock"
  killed_update_state
  local f
  mkdir -p "$BATS_TEST_TMPDIR/during"
  for f in $SETUP_NAMES .update-undo; do cp "$FF_ROOT/$f" "$BATS_TEST_TMPDIR/during/$f"; done
  # The first update, still running, holds the lock.
  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  ff update
  exec 9>&-
  [ "$status" -eq 1 ]
  for f in $SETUP_NAMES .update-undo; do
    cmp "$BATS_TEST_TMPDIR/during/$f" "$FF_ROOT/$f" || { echo "$f was changed"; return 1; }
  done
  assert_out "Another freeframe command (an update, rollback, backup, restore, restart, configure or uninstall) is running right now, so the update did not start. Nothing was changed."
  assert_no_out "putting its setup files from before back"
  assert_not_called fetch
  assert_not_called "dc "
}

@test "update: a failed backup after an earlier update's files were put back does not say it changed nothing" {
  killed_update_state
  STUB_PG_DOWN=1 FF_BACKUP_DB_WAIT=10 ff update
  [ "$status" -eq 1 ]
  [ ! -e "$FF_ROOT/.update-undo" ]
  assert_out "putting its setup files from before back first"
  assert_out "because the database could not be backed up first"
  # The headline and the state line say the same thing.
  assert_no_out "stopped before changing anything,"
  assert_out "after putting back the setup files from before an earlier update that stopped part-way, and before changing anything else"
  assert_out "the setup files from before an earlier update that stopped part-way were put back first."
}

@test "update: a missed nightly backup that fires when the timer is enabled is skipped, not failed" {
  command -v flock >/dev/null || skip "no flock"
  export STUB_TIMER_RUNS_BACKUP=1 STUBS FF_SCRIPT
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  # The backup the timer started ran while the update still held the lock.
  [ "$(cat "$STUB_DIR/timer-backup.rc")" = 0 ] || { cat "$STUB_DIR/timer-backup.out"; false; }
  grep -q "The nightly backup was skipped: a freeframe update is running right now" "$STUB_DIR/timer-backup.out"
  if grep -q "Another freeframe command" "$STUB_DIR/timer-backup.out"; then false; fi
  # Nothing was dumped after the timer was enabled.
  sed -n '/^install_backup_timer$/,$p' "$CALLS" | { ! grep -q pg_dump; }
  grep -q "The nightly backup was skipped" "$FF_ROOT/install.log"
}

@test "update: a signal after the new version answered does not advise a rollback that has nothing to do" {
  export STUB_TIMER_HANG=1
  ff_signal TERM timer update
  [ "$status" -eq 1 ]
  [ ! -e "$FF_ROOT/.update-undo" ]
  assert_out "stopped (SIGTERM) while refreshing the nightly backups"
  assert_no_out "rollback"
  assert_out "FreeFrame 1.22.0 runs and answers"
  assert_out "What to try: the update itself is done."
}

@test "update: the record is flushed to disk as saved, then as started, before the new version starts" {
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "sync $FF_ROOT/.update-undo $FF_ROOT [phase=saved]" "dc pull" \
    "sync $FF_ROOT/.update-undo $FF_ROOT [phase=started]" "dc up -d --no-build"
}

@test "_ff_running_version: an image pinned by digest gives no version" {
  local img
  for img in "ghcr.io/techiebutler/freeframe-api@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" \
    "ghcr.io/techiebutler/freeframe-api:1.21.0@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; do
    run env STUB_RUNNING_IMAGE="$img" bash -c 'source "$1"; source "$2"; _ff_running_version' ff "$FF_SCRIPT" "$STUBS"
    [ "$status" -eq 0 ]
    [ -z "$output" ] || { echo "$img gave: $output"; return 1; }
  done
  run env STUB_RUNNING_IMAGE=ghcr.io/techiebutler/freeframe-api:1.21.0 bash -c 'source "$1"; source "$2"; _ff_running_version' ff "$FF_SCRIPT" "$STUBS"
  [ "$output" = 1.21.0 ]
}

@test "update: a digest-pinned running image is not taken for another release" {
  export STUB_RUNNING_IMAGE="ghcr.io/techiebutler/freeframe-api@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_no_out "FreeFrame runs version"
  assert_out "FreeFrame was updated from 1.21.0 to 1.22.0."
}

@test "update: a version pin edited by hand is named as such, not as an update that stopped" {
  printf 'FREEFRAME_VERSION=1.22.5\n' >>"$ENV"
  export STUB_RUNNING_IMAGE=ghcr.io/techiebutler/freeframe-api:1.22.0
  ff update
  assert_out "FreeFrame runs version 1.22.0, but FREEFRAME_VERSION in $ENV asks for 1.22.5."
  assert_no_out "stopped part-way"
}

@test "update: files from another release under the running one are named without guessing why" {
  local f
  for f in $SETUP_NAMES; do cp "$STUB_REMOTE/$f" "$FF_ROOT/$f"; done
  export STUB_RUNNING_IMAGE=ghcr.io/techiebutler/freeframe-api:1.21.0
  ff update
  assert_out "FreeFrame runs version 1.21.0, but the setup files here are for 1.22.0."
  assert_no_out "stopped part-way"
}

@test "update: an earlier update's files put back, then a refusal, does not say nothing was changed" {
  killed_update_state
  printf 'FREEFRAME_VERSION=1.21.0\n' >>"$ENV"
  ff update
  [ "$status" -eq 1 ]
  local f
  for f in $SETUP_NAMES; do cmp "$FF_ROOT/rollback/$f" "$FF_ROOT/$f"; done
  [ ! -e "$FF_ROOT/.update-undo" ]
  assert_out "after 1.21.0"
  assert_out "the setup files from before an earlier update that stopped part-way were put back first"
  assert_no_out "othing was changed"
  assert_no_out "othing has been changed"
}

@test "update: after an earlier update's files were put back, a failed command download says so" {
  killed_update_state
  export STUB_FETCH_FAIL=deploy/freeframe
  ff update
  [ "$status" -eq 1 ]
  assert_out "Could not download the freeframe command"
  assert_out "were put back first"
  assert_no_out "othing was changed"
}

@test "status: while an update holds the lock, its record is shown as an update in progress" {
  command -v flock >/dev/null || skip "no flock"
  killed_update_state
  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  ff status
  exec 9>&-
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "A freeframe update or rollback is running right now (the update began 2026-10-20 03:00:00 +0000). Check again once it has finished."
  assert_no_out "run: sudo freeframe rollback"
  # Once nothing holds the lock, the record is an update that did not finish.
  ff status
  assert_out "An update did not finish. To go back to 1.21.0, run: sudo freeframe rollback"
  # status itself leaves the lock free.
  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  exec 9>&-
}

@test "update gpu: a GPU that broke since the last start leaves the GPU file out for this start, and says so" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=nodriver
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "FreeFrame starts with video processing on the CPU until that is fixed"
  if grep -q '^files .*gpu' "$CALLS"; then cat "$CALLS"; false; fi
  grep -q '^files ' "$CALLS"
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
  [ -f "$FF_ROOT/docker-compose.gpu.yml" ]
}


@test "update gpu worker: after the new version starts, a worker that never sees the GPU is started again once, and the update still succeeds" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready STUB_WORKER_SMI=fail
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(grep -c '^dc up -d --no-build --no-deps --force-recreate worker$' "$CALLS")" 1
  assert_order "localhost:8000/health" "exec -T worker nvidia-smi -L" "up -d --no-build --no-deps --force-recreate worker" "exec -T worker nvidia-smi -L"
  assert_out "video is processed on the CPU for now"
  assert_out "FreeFrame was updated from 1.21.0 to 1.22.0."
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
}

@test "update gpu worker: a worker that sees the GPU is not touched" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(grep -c '^dc exec -T worker nvidia-smi -L$' "$CALLS")" 1
  assert_not_called "no-deps"
  assert_no_out "CPU"
}

@test "update gpu worker: new backup units mean a daemon-reload, which takes the GPU from the worker; the check after it gives it back" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready STUB_RELOAD_DROPS_GPU=1
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order install_backup_timer "systemctl daemon-reload" "dc exec -T worker nvidia-smi -L" "up -d --no-build --no-deps --force-recreate worker"
  [ -e "$STUB_DIR/worker-gpu-up" ]
  assert_out "The worker did not see the GPU at first, so it was started again; it uses the GPU now."
}

@test "update gpu worker: unchanged backup units mean no daemon-reload and no enable, so the worker keeps the GPU with no recreate" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  cp "$FF_SYSTEMD_DIR"/freeframe-backup.* "$STUB_REMOTE/deploy/systemd/"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready STUB_RELOAD_DROPS_GPU=1
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called "daemon-reload"
  assert_not_called "systemctl enable"
  assert_not_called "no-deps"
  assert_eq "$(grep -c '^dc exec -T worker nvidia-smi -L$' "$CALLS")" 1
  [ -e "$STUB_DIR/worker-gpu-up" ]
}

@test "update: a timer that is not enabled is enabled again without a reload" {
  cp "$FF_SYSTEMD_DIR"/freeframe-backup.* "$STUB_REMOTE/deploy/systemd/"
  export STUB_TIMER_DISABLED=1
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx "systemctl enable --now --no-reload freeframe-backup.timer" "$CALLS" || { cat "$CALLS"; false; }
  assert_not_called "daemon-reload"
}

@test "update gpu worker: a worker that never runs (even created again) is said to be stopped, with the logs command, not the CPU" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready STUB_WORKER_SMI=fail STUB_WORKER_DOWN=1 FF_GPU_WORKER_WAIT=4
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(grep -c '^dc up -d --no-build --no-deps --force-recreate worker$' "$CALLS")" 1
  assert_out "The worker that processes video is not running, so no video is processed until it starts. See why with: sudo freeframe logs worker"
  assert_no_out "on the CPU for now"
  grep -qF "GPU self-check: the worker is not running, so no video is processed until it starts" "$FF_ROOT/install.log"
}

@test "update: units on disk that systemd has not loaded yet are reloaded once, though cmp sees no change" {
  cp "$FF_SYSTEMD_DIR"/freeframe-backup.* "$STUB_REMOTE/deploy/systemd/"
  export STUB_NEED_RELOAD=1
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ "$(grep -c '^systemctl daemon-reload$' "$CALLS")" -eq 1 ]
  grep -qx "systemctl enable --now --no-reload freeframe-backup.timer" "$CALLS"
}
