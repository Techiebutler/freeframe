#!/usr/bin/env bats
# `freeframe rollback`: back to the version and the database from before an
# update that did not come up. Side effects stubbed (manage_stubs.bash).

load manage_helpers

setup() {
  manage_setup
  installed_server sslip bundled 1.21.0
  remote_release 1.22.0
  local f
  mkdir -p "$BATS_TEST_TMPDIR/before"
  for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml; do
    cp "$FF_ROOT/$f" "$BATS_TEST_TMPDIR/before/$f"
  done
  cp "$FF_ROOT/systemd/freeframe-backup.service" "$BATS_TEST_TMPDIR/before/freeframe-backup.service"
}

# failed_update: an update to 1.22.0 whose new version never answers.
failed_update() {
  STUB_API_DOWN=1 FF_API_WAIT=10 ff update
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [ -e "$FF_ROOT/.update-undo" ]
  UPDATE_BACKUP=$(sed -n 's/^backup=//p' "$FF_ROOT/.update-undo")
  [ -f "$UPDATE_BACKUP" ]
  : >"$CALLS"
}

assert_files_from_before() {
  local f
  for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml; do
    cmp "$BATS_TEST_TMPDIR/before/$f" "$FF_ROOT/$f" || { echo "$f is not as before"; return 1; }
  done
  cmp "$BATS_TEST_TMPDIR/before/freeframe-backup.service" "$FF_ROOT/systemd/freeframe-backup.service"
}

# FreeFrame was started (anything but the database server alone).
assert_not_started() {
  if grep -E '^dc up -d' "$CALLS" | grep -qv '^dc up -d --no-build postgres$'; then
    echo "FreeFrame was started:"
    grep '^dc up' "$CALLS"
    return 1
  fi
}

@test "rollback: stops, puts the setup files back, pins the old version, restores the backup, then starts" {
  failed_update
  # The update had started its new version, which may have changed the database.
  grep -qx "phase=started" "$FF_ROOT/.update-undo"
  ff rollback --yes
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  # Stopped while the new release's files were still in place.
  grep -q '1.22.0' "$STUB_DIR/images-at-stop"
  assert_order "dc stop " "dc exec -T postgres dropdb" "dc exec -T postgres createdb" \
    "dc exec -T postgres pg_restore" "dc up -d --no-build --remove-orphans" "localhost:8000/health" \
    "probe_health sslip" install_backup_timer
  assert_files_from_before
  assert_has "$ENV" "FREEFRAME_VERSION=1.21.0"
  # The pin was written with env_set after a backup of the settings.
  local b
  b=$(env_backups | tail -1)
  [ -n "$b" ]
  assert_no_key "$FF_ROOT/$b" FREEFRAME_VERSION
  # The database that went back is the backup taken before the update.
  cmp "$UPDATE_BACKUP" "$STUB_DIR/restored"
  [ ! -e "$FF_ROOT/.update-undo" ]
  [ ! -e "$FF_ROOT/.restore-undo" ]
  assert_out "FreeFrame is back on 1.21.0"
  assert_out "delete the FREEFRAME_VERSION line"
}

@test "rollback: its copy of the database from before has its own name, so it is never taken for the newest backup" {
  failed_update
  ff rollback --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  local copy
  copy=$(cd "$BK" && ls | grep -E '^freeframe-[0-9]{8}-[0-9]{6}-before-rollback\.dump$')
  [ -n "$copy" ] || { ls -A "$BK"; false; }
  [ -f "$BK/${copy%.dump}.env.prod" ]
  # The only ordinary backup is still the one the update took.
  assert_eq "$(cd "$BK" && ls | grep -E '^freeframe-[0-9]{8}-[0-9]{6}\.dump$')" "${UPDATE_BACKUP##*/}"
}

@test "rollback: a database check that fails never starts the old version, and says a re-run is safe" {
  failed_update
  export STUB_MAINT_FAIL=1
  ff rollback --yes
  [ "$status" -eq 1 ]
  assert_not_started
  assert_out "Its setup files and version are back to 1.21.0, but the database is not yet back"
  assert_out "Running sudo freeframe rollback again is safe."
  assert_out "stopped before changing the database"
  assert_no_out "nothing was changed"
  assert_no_out "before changing anything"
  assert_no_out "sudo freeframe restart"
  assert_no_out "FreeFrame has been started again"
  [ -e "$FF_ROOT/.update-undo" ]
}

@test "rollback: a dropdb that fails on a database with data does not start the old version" {
  failed_update
  export STUB_DROP_FAIL=1
  ff rollback --yes
  [ "$status" -eq 1 ]
  assert_not_started
  assert_out "rollback again is safe"
  assert_no_out "FreeFrame has been started again"
}

@test "rollback: the database server not starting says the database was not changed, not nothing" {
  failed_update
  export STUB_PG_DOWN=1 FF_DB_WAIT=4
  ff rollback --yes
  [ "$status" -eq 1 ]
  assert_out "FreeFrame's database did not start, so the database was not changed."
  assert_out "Its setup files and version are back to 1.21.0"
  assert_not_started
}

@test "rollback: the backup failing to go back leaves FreeFrame stopped, and running it again finishes" {
  failed_update
  export STUB_RESTORE_FAIL=1
  ff rollback --yes
  [ "$status" -eq 1 ]
  assert_not_started
  assert_out "To try again, run: sudo freeframe rollback"
  # The other undo command (the copy of what the update left) is not offered.
  assert_no_out "sudo freeframe restore --yes"
  [ -e "$FF_ROOT/.update-undo" ]
  [ -e "$FF_ROOT/.restore-undo" ]
  # While it is unfinished, restart sends you back to the rollback.
  ff restart
  [ "$status" -eq 1 ]
  assert_out "sudo freeframe rollback"
  : >"$CALLS"
  unset STUB_RESTORE_FAIL
  ff rollback --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_files_from_before
  [ ! -e "$FF_ROOT/.update-undo" ]
  [ ! -e "$FF_ROOT/.restore-undo" ]
}

@test "rollback: FreeFrame that cannot be stopped is said, and a re-run is safe" {
  failed_update
  export STUB_STOP_FAIL=1
  ff rollback --yes
  [ "$status" -eq 1 ]
  assert_out "FreeFrame could not be stopped."
  assert_out "rollback again is safe"
  assert_not_called "pg_restore"
  [ -e "$FF_ROOT/.update-undo" ]
}

@test "rollback: the old version not answering afterwards is said, with the record kept" {
  failed_update
  export STUB_API_DOWN=1 FF_API_WAIT=10
  ff rollback --yes
  [ "$status" -eq 1 ]
  assert_out "FreeFrame 1.21.0 did not answer after the rollback."
  assert_out "rollback again is safe"
  [ -e "$FF_ROOT/.update-undo" ]
}

@test "rollback: with no update record there is nothing to roll back" {
  ff rollback --yes
  [ "$status" -eq 0 ]
  assert_out "There is no update to roll back"
  assert_not_called "dc "
}

@test "rollback: it asks first; no terminal and no --yes refuses" {
  failed_update
  ff rollback
  [ "$status" -eq 2 ]
  assert_out "--yes"
  assert_not_called "dc "
  printf 'n\n' >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  ff rollback
  [ "$status" -eq 1 ]
  assert_out "This takes FreeFrame back to version 1.21.0"
  assert_out "Rollback cancelled. Nothing was changed."
  assert_not_called "dc "
  printf 'y\n' >"$BATS_TEST_TMPDIR/tty"
  ff rollback
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "FreeFrame is back on 1.21.0"
}

@test "rollback: a missing backup is refused before anything changes" {
  failed_update
  rm "$UPDATE_BACKUP"
  ff rollback --yes
  [ "$status" -eq 1 ]
  assert_out "is not there any more"
  assert_not_called "dc "
}

@test "update: refuses while an earlier update's record stands, naming rollback and how to drop the record" {
  failed_update
  # The new version is what runs (it did not answer): removing the record
  # is offered too.
  STUB_RUNNING_IMAGE=ghcr.io/techiebutler/freeframe-api:1.22.0 ff update
  [ "$status" -eq 1 ]
  assert_out "An earlier update did not finish"
  assert_out "sudo freeframe rollback"
  assert_out "sudo rm '$FF_ROOT/.update-undo'"
  # Only asked which version runs; nothing else.
  if grep '^dc ' "$CALLS" | grep -vx 'dc ps --format {{.Image}} api'; then false; fi
  assert_not_called fetch
}

@test "update: an older rollback copy is replaced only once the new update's backup worked" {
  mkdir -p "$FF_ROOT/rollback"
  printf 'older\n' >"$FF_ROOT/rollback/docker-compose.images.yml"
  STUB_PG_DOWN=1 FF_BACKUP_DB_WAIT=10 ff update
  [ "$status" -eq 1 ]
  assert_eq "$(cat "$FF_ROOT/rollback/docker-compose.images.yml")" older
  [ ! -e "$FF_ROOT/.update-undo" ]
}

@test "backup: the backup a rollback needs is never pruned while the record stands" {
  failed_update
  local i
  mkdir -p "$BK"
  for i in 1 2 3 4 5 6 7 8; do
    printf 'PGDMP later %s\n' "$i" >"$BK/freeframe-2099010$i-030000.dump"
  done
  ff backup
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ -f "$UPDATE_BACKUP" ]
}

@test "status: an unfinished update names the rollback" {
  failed_update
  ff status
  [ "$status" -eq 0 ]
  assert_out "An update did not finish. To go back to 1.21.0, run: sudo freeframe rollback"
}

@test "status: while a rollback holds the lock over the record, the line is true for a rollback too" {
  command -v flock >/dev/null || skip "no flock"
  failed_update
  local t
  t=$(sed -n 's/^time=//p' "$FF_ROOT/.update-undo")
  # A rollback is running: it holds the lock, and the record stands.
  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  ff status
  exec 9>&-
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "A freeframe update or rollback is running right now (the update began $t). Check again once it has finished."
  assert_no_out "An update is running"
  assert_no_out "run: sudo freeframe rollback"
}

@test "rollback: a missed nightly backup that fires when the timer is enabled is skipped, not failed" {
  command -v flock >/dev/null || skip "no flock"
  failed_update
  export STUB_TIMER_RUNS_BACKUP=1 STUBS FF_SCRIPT
  ff rollback --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ "$(cat "$STUB_DIR/timer-backup.rc")" = 0 ] || { cat "$STUB_DIR/timer-backup.out"; false; }
  grep -q "The nightly backup was skipped: a freeframe rollback is running right now" "$STUB_DIR/timer-backup.out"
  if grep -q "Another freeframe command" "$STUB_DIR/timer-backup.out"; then false; fi
}

@test "rollback: compose files that do not parse are no dead end: it stops by project label" {
  failed_update
  export STUB_CONFIG_FAIL_NEW=1
  ff rollback --yes
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  grep -q "^docker ps --filter label=com.docker.compose.project=freeframe" "$CALLS"
  grep -qx "docker stop c1 c4" "$CALLS"
  assert_files_from_before
}

@test "rollback: a saved set without the main compose files is refused before anything changes" {
  failed_update
  rm "$FF_ROOT/rollback/docker-compose.images.yml"
  cp "$FF_ROOT/docker-compose.images.yml" "$BATS_TEST_TMPDIR/images.now"
  ff rollback --yes
  [ "$status" -eq 1 ]
  assert_out "incomplete"
  cmp "$BATS_TEST_TMPDIR/images.now" "$FF_ROOT/docker-compose.images.yml"
  assert_not_called "dc "
}

@test "rollback: install answers are refused, as update does" {
  failed_update
  ff rollback --yes --domain review.yourstudio.com
  [ "$status" -eq 2 ]
  assert_out "sudo freeframe configure"
  assert_not_called "dc "
}

@test "rollback: failure hints use sudo freeframe rollback, not a --yes form" {
  failed_update
  export STUB_RESTORE_FAIL=1
  ff rollback --yes
  [ "$status" -eq 1 ]
  assert_out "To try again, run: sudo freeframe rollback"
  assert_no_out "rollback --yes"
}

# ---------------------------------------------------------------- a new version that never started

# unstarted_update: the mixed-set update of round 2: the new files could not
# all be put in place, and the old ones not all back either, so the record
# stays, written before the new version was started.
unstarted_update() {
  STUB_MV_FAIL=docker-compose.storage.yml STUB_MV_OLD_FAIL=docker-compose.images.yml STUB_PUTBACK_FAIL=1 ff update
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  grep -qx "phase=saved" "$FF_ROOT/.update-undo"
  # The way it came out: some of the new release's files are on disk.
  grep -q 1.22.0 "$FF_ROOT/docker-compose.images.yml"
  : >"$CALLS"
}

assert_database_untouched() {
  local c
  for c in dropdb createdb pg_restore pg_dump; do assert_not_called "$c"; done
  [ ! -e "$STUB_DIR/restored" ]
  [ ! -e "$FF_ROOT/.restore-undo" ]
}

@test "rollback: a new version that never started gets its files and pin back and a restart, the database untouched" {
  unstarted_update
  # No yes is needed: nothing is lost.
  ff rollback
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  assert_database_untouched
  assert_files_from_before
  assert_has "$ENV" "FREEFRAME_VERSION=1.21.0"
  assert_order "dc up -d --no-build --remove-orphans" "localhost:8000/health" install_backup_timer
  [ ! -e "$FF_ROOT/.update-undo" ]
  assert_out "FreeFrame is back on 1.21.0."
  assert_out "The database was not changed: the new version (1.22.0) never ran, so nothing written since the update began is lost."
  assert_no_out "as it was just before the update"
  assert_out "delete the FREEFRAME_VERSION line"
}

@test "rollback: a new version that never started needs neither the backup nor a yes" {
  unstarted_update
  rm -f "$(sed -n 's/^backup=//p' "$FF_ROOT/.update-undo")"
  ff rollback
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_database_untouched
  assert_files_from_before
}

@test "rollback: a never-started update whose saved files are gone is not sent to a restore" {
  unstarted_update
  rm -rf "$FF_ROOT/rollback"
  ff rollback
  [ "$status" -eq 1 ]
  assert_no_out "sudo freeframe restore"
  assert_out "sudo rm '$FF_ROOT/.update-undo'"
  assert_database_untouched
  assert_not_called "dc "
}

@test "rollback: a record without the started flag (an older freeframe) restores, the safe choice" {
  failed_update
  sed -i '/^phase=/d' "$FF_ROOT/.update-undo"
  ff rollback --yes
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  grep -q "dc exec -T postgres pg_restore" "$CALLS"
  cmp "$UPDATE_BACKUP" "$STUB_DIR/restored"
  assert_out "with the database as it was just before the update"
}

@test "rollback: a never-started record without its version is not sent to a restore either" {
  unstarted_update
  sed -i 's/^version=.*/version=unknown/' "$FF_ROOT/.update-undo"
  ff rollback
  [ "$status" -eq 1 ]
  assert_out "does not say which version"
  assert_no_out "sudo freeframe restore"
  assert_database_untouched
  # The saved set is whole, so update puts it back itself: removing the
  # record first would leave the new release's files in place.
  assert_out "run: sudo freeframe update"
  assert_no_out "sudo rm"
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "putting its setup files from before back first"
  assert_out "FreeFrame was updated from 1.21.0 to 1.22.0."
}

@test "rollback: a started record without its version still points at the restore" {
  failed_update
  sed -i 's/^version=.*/version=unknown/' "$FF_ROOT/.update-undo"
  ff rollback --yes
  [ "$status" -eq 1 ]
  assert_out "sudo freeframe restore --yes '$UPDATE_BACKUP'"
}

# ---------------------------------------------------------------- the record read under the lock

# snapshot_state DIR: the setup files, the settings and the record as they are.
snapshot_state() {
  local f
  mkdir -p "$1"
  for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml .env.prod; do
    cp "$FF_ROOT/$f" "$1/$f"
  done
  if [[ -e $FF_ROOT/.update-undo ]]; then cp "$FF_ROOT/.update-undo" "$1/.update-undo"; fi
}

# assert_state_is DIR: nothing changed since snapshot_state DIR.
assert_state_is() {
  local f
  for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml .env.prod; do
    cmp "$1/$f" "$FF_ROOT/$f" || { echo "$f was changed"; return 1; }
  done
  if [[ -e $1/.update-undo ]]; then
    cmp "$1/.update-undo" "$FF_ROOT/.update-undo" || { echo "the record was changed"; return 1; }
  else
    [ ! -e "$FF_ROOT/.update-undo" ] || { echo "a record appeared"; return 1; }
  fi
}

@test "rollback: a never-started update that ends before the lock is taken is not rolled back" {
  unstarted_update
  # While the rollback gets ready, the update finishes: its new version is
  # up, the database migrated, the record cleared and the lock released.
  export STUB_AT_LOCK='for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml; do cp "$STUB_REMOTE/$f" "$FF_ROOT/$f"; done; rm -f "$FF_ROOT/.update-undo"; mkdir -p "$STUB_DIR/after" && for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml .env.prod; do cp "$FF_ROOT/$f" "$STUB_DIR/after/$f"; done'
  ff rollback
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_state_is "$STUB_DIR/after"
  assert_not_called "dc "
  assert_not_called "docker "
  assert_out "There is no update to roll back any more"
  assert_out "nothing was changed"
  assert_no_out "Rolling back"
  assert_no_out "is back on"
}

@test "rollback: a never-started update that starts its new version before the lock is refused, not restored unasked" {
  unstarted_update
  export STUB_AT_LOCK='sed -i "s/^phase=saved$/phase=started/" "$FF_ROOT/.update-undo"; mkdir -p "$STUB_DIR/after" && for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml .env.prod .update-undo; do cp "$FF_ROOT/$f" "$STUB_DIR/after/$f"; done'
  ff rollback --yes
  [ "$status" -eq 1 ]
  assert_state_is "$STUB_DIR/after"
  grep -qx "phase=started" "$FF_ROOT/.update-undo"
  assert_database_untouched
  assert_not_called "dc "
  assert_out "went on to start its new version"
  assert_out "Nothing was changed."
  assert_out "run sudo freeframe rollback again"
  assert_no_out "is back on"
}

@test "rollback: a started update whose record is cleared after the yes is not rolled back" {
  failed_update
  printf 'y\n' >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  export STUB_AT_LOCK='rm -f "$FF_ROOT/.update-undo"; mkdir -p "$STUB_DIR/after" && for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml .env.prod; do cp "$FF_ROOT/$f" "$STUB_DIR/after/$f"; done'
  ff rollback
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Roll back now?"
  assert_state_is "$STUB_DIR/after"
  assert_database_untouched
  assert_not_called "dc "
  assert_out "There is no update to roll back any more"
}

@test "rollback: a record replaced by another update's after the yes is refused" {
  failed_update
  export STUB_AT_LOCK='sed -i "s/^time=.*/time=2026-10-27 04:00:00 +0000/" "$FF_ROOT/.update-undo"; mkdir -p "$STUB_DIR/after" && for f in docker-compose.prod.yml docker-compose.images.yml docker-compose.https.yml docker-compose.storage.yml .env.prod .update-undo; do cp "$FF_ROOT/$f" "$STUB_DIR/after/$f"; done'
  ff rollback --yes
  [ "$status" -eq 1 ]
  assert_state_is "$STUB_DIR/after"
  assert_database_untouched
  assert_not_called "dc "
  assert_out "changed while this rollback was getting ready"
  assert_out "Nothing was changed."
}

@test "rollback: to a set from before the GPU file, the GPU file goes and compose leaves it out" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  failed_update
  [ -f "$FF_ROOT/docker-compose.gpu.yml" ]
  ff rollback --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ ! -e "$FF_ROOT/docker-compose.gpu.yml" ]
  [[ $(compose_files "$ENV") != *gpu* ]]
  assert_files_from_before
}

@test "rollback gpu worker: the old version's worker is checked for the GPU after the start, and started again once" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready
  failed_update
  export STUB_WORKER_SMI=restart
  ff rollback --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(grep -c '^dc up -d --no-build --no-deps --force-recreate worker$' "$CALLS")" 1
  assert_out "The worker did not see the GPU at first, so it was started again; it uses the GPU now."
  assert_out "FreeFrame is back on 1.21.0"
}

@test "rollback gpu worker: a never-started update's rollback checks the worker too" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready
  unstarted_update
  export STUB_WORKER_SMI=fail
  ff rollback --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(grep -c '^dc up -d --no-build --no-deps --force-recreate worker$' "$CALLS")" 1
  assert_out "video is processed on the CPU for now"
  assert_database_untouched
}

@test "rollback gpu worker: the units are as they were, so no daemon-reload, and the worker keeps the GPU with no recreate" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready
  failed_update
  export STUB_RELOAD_DROPS_GPU=1
  ff rollback --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order install_backup_timer "dc exec -T worker nvidia-smi -L"
  assert_not_called "daemon-reload"
  assert_not_called "no-deps"
  [ -e "$STUB_DIR/worker-gpu-up" ]
}

@test "rollback gpu worker: a unit the update changed is put back with one daemon-reload, the timer enabled without one, and the worker given the GPU back" {
  printf 'services:\n  worker: {}\n' >"$STUB_REMOTE/docker-compose.gpu.yml"
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready
  failed_update
  # The update had put the new release's units into systemd.
  cp "$STUB_REMOTE"/deploy/systemd/freeframe-backup.* "$FF_SYSTEMD_DIR/"
  if cmp -s "$BATS_TEST_TMPDIR/before/freeframe-backup.service" "$FF_SYSTEMD_DIR/freeframe-backup.service"; then false; fi
  export STUB_RELOAD_DROPS_GPU=1
  ff rollback --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  # The old units are back in systemd.
  cmp "$BATS_TEST_TMPDIR/before/freeframe-backup.service" "$FF_SYSTEMD_DIR/freeframe-backup.service"
  [ "$(grep -c '^systemctl daemon-reload$' "$CALLS")" -eq 1 ]
  grep -qx "systemctl enable --now --no-reload freeframe-backup.timer" "$CALLS"
  if grep -qx "systemctl enable --now freeframe-backup.timer" "$CALLS"; then false; fi
  # The reload took the GPU; the check after it gave it back.
  assert_order "systemctl daemon-reload" "dc exec -T worker nvidia-smi -L" "up -d --no-build --no-deps --force-recreate worker"
  [ "$(grep -c '^dc up -d --no-build --no-deps --force-recreate worker$' "$CALLS")" -eq 1 ]
  [ -e "$STUB_DIR/worker-gpu-up" ]
  assert_out "The worker did not see the GPU at first, so it was started again; it uses the GPU now."
}
