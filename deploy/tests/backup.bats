#!/usr/bin/env bats
# `freeframe backup`, `freeframe restore` and the nightly backup timer, with
# every side effect stubbed (backup_stubs.bash). Like install.bats, each flow
# runs in a fresh bash under the script's own strict mode.

load helpers

setup() {
  common_setup
  export STUB_DIR="$BATS_TEST_TMPDIR"
  export CALLS="$BATS_TEST_TMPDIR/calls"
  : >"$CALLS"
  STUBS="${BATS_TEST_DIRNAME}/backup_stubs.bash"
  ENV="$FF_ROOT/.env.prod"
  BK="$FF_ROOT/backups"
  # An installed server: a settings file with a quoted database user, so the
  # names must come through env_get.
  printf "POSTGRES_USER='ffuser'\nPOSTGRES_DB=ffdb\nPOSTGRES_PASSWORD=pw\n" >"$ENV"
  chmod 600 "$ENV"
}

# ff ARGS...: run `freeframe ARGS` with the stubs.
ff() {
  run bash -c 'set -Eeuo pipefail; source "$1"; source "$2"; shift 2; main "$@"' \
    ff-run "$FF_SCRIPT" "$STUBS" "$@"
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

assert_out() {
  if [[ $output != *"$1"* ]]; then
    echo "expected output to contain: $1"
    echo "--- output ---"
    echo "$output"
    return 1
  fi
}

# old_backup STAMP [CONTENT]: an earlier backup and its settings copy.
old_backup() {
  mkdir -p "$BK"
  printf 'PGDMP %s\n' "${2:-old $1}" >"$BK/freeframe-$1.dump"
  printf 'X=1\n' >"$BK/freeframe-$1.env.prod"
}

dumps() { (cd "$BK" && LC_ALL=C ls freeframe-*.dump 2>/dev/null) || true; }

# ---------------------------------------------------------------- backup

@test "backup: writes to a .partial name and renames it only when the dump is complete" {
  ff backup
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx 'dc exec -T postgres pg_dump -Fc -U ffuser ffdb' "$CALLS"
  # While pg_dump ran, only the .partial name existed.
  grep -q '^freeframe-[0-9]\{8\}-[0-9]\{6\}\.dump\.partial$' "$STUB_DIR/during-dump"
  if grep -q '\.dump$' "$STUB_DIR/during-dump"; then false; fi
  local d
  d=$(dumps)
  [[ $d =~ ^freeframe-[0-9]{8}-[0-9]{6}\.dump$ ]] || { echo "dumps: $d"; false; }
  assert_eq "$(cat "$BK/$d")" "PGDMP current database v2"
  cmp "$ENV" "$BK/${d%.dump}.env.prod"
  [ -z "$(ls "$BK" | grep partial)" ]
  assert_out "$BK/$d"
}

@test "backup: the dump and the settings copy are private (600, folder 700)" {
  ff backup
  [ "$status" -eq 0 ]
  local d
  d=$(dumps)
  assert_eq "$(stat -c %a "$BK/$d")" 600
  assert_eq "$(stat -c %a "$BK/${d%.dump}.env.prod")" 600
  assert_eq "$(stat -c %a "$BK")" 700
}

@test "backup: a failed dump leaves no .dump and removes the .partial" {
  old_backup 20261020-030000
  export STUB_DUMP_FAIL=1
  ff backup
  [ "$status" -eq 1 ]
  # The .partial existed while pg_dump ran, and is gone now.
  grep -q '\.dump\.partial$' "$STUB_DIR/during-dump"
  assert_eq "$(ls -A "$BK" | grep -v '^\.' | tr '\n' ' ')" \
    "freeframe-20261020-030000.dump freeframe-20261020-030000.env.prod "
  assert_out "could not be backed up"
  assert_out "No new backup was made"
  assert_out "install.log"
}

@test "backup: output that is not a database dump is not kept" {
  export STUB_DUMP_GARBAGE=1
  ff backup
  [ "$status" -eq 1 ]
  [ -z "$(dumps)" ]
  [ -z "$(ls -A "$BK" | grep -v '^\.')" ]
  assert_out "No new backup was made"
}

@test "backup: keeps the newest 7 with their settings copies" {
  local s
  for s in 01 02 03 04 05 06 07 08; do old_backup "202610$s-030000"; done
  ff backup
  [ "$status" -eq 0 ]
  assert_eq "$(dumps | wc -l | tr -d ' ')" 7
  [ ! -e "$BK/freeframe-20261001-030000.dump" ]
  [ ! -e "$BK/freeframe-20261002-030000.env.prod" ]
  [ -e "$BK/freeframe-20261003-030000.dump" ]
}

@test "backup: refuses when free space is below twice the last dump" {
  old_backup 20261020-030000
  export STUB_BIG_LAST=$((700 * 1048576)) STUB_BIG_LAST_FILE="$BK/freeframe-20261020-030000.dump"
  export STUB_FREE_MB=1300
  ff backup
  [ "$status" -eq 1 ]
  assert_out "1300 MB free"
  assert_out "at least 1400 MB"
  assert_not_called pg_dump
  assert_eq "$(dumps)" "freeframe-20261020-030000.dump"
  # With room for twice the last one, it goes ahead.
  export STUB_FREE_MB=1500
  ff backup
  [ "$status" -eq 0 ] || { echo "$output"; false; }
}

@test "backup: refuses below 1 GB free even when the last dump was small" {
  export STUB_FREE_MB=1000
  ff backup
  [ "$status" -eq 1 ]
  assert_out "1000 MB free"
  assert_out "at least 1024 MB"
  assert_not_called pg_dump
  [ -z "$(dumps)" ]
}

@test "backup: waits up to a minute for the database (the catch-up run at boot)" {
  export STUB_PG_READY_AFTER=4
  ff backup --quiet
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(grep -c '^sleep 5$' "$CALLS")" 3
  assert_order "pg_isready" "pg_isready" "pg_isready" "pg_isready" "pg_dump"
}

@test "backup: a database that never answers is refused after the wait, with no dump" {
  export STUB_PG_DOWN=1
  ff backup --quiet
  [ "$status" -eq 1 ]
  assert_out "FreeFrame's database is not running, so no backup was made."
  assert_out "sudo freeframe restart"
  assert_not_called pg_dump
  # 60 seconds in 5-second steps.
  assert_eq "$(grep -c '^sleep 5$' "$CALLS")" 12
}

@test "backup --quiet prints nothing on success" {
  ff backup --quiet
  [ "$status" -eq 0 ]
  assert_eq "$output" ""
  [ -n "$(dumps)" ]
}

@test "backup --quiet prints a plain error on failure" {
  export STUB_DUMP_FAIL=1
  ff backup --quiet
  [ "$status" -eq 1 ]
  assert_out "could not be backed up"
  export STUB_DUMP_FAIL="" STUB_FREE_MB=10
  ff backup --quiet
  [ "$status" -eq 1 ]
  assert_out "not enough free disk space"
}

@test "backup: says plainly that the backups stay on this server" {
  ff backup
  [ "$status" -eq 0 ]
  assert_out "on this server only"
  assert_out "media"
}

@test "backup: without an installed FreeFrame it says so" {
  rm -f "$ENV"
  ff backup
  [ "$status" -eq 1 ]
  assert_out "not installed"
  assert_not_called "dc "
}

@test "backup: not root exits 2 and names sudo" {
  export STUB_NOT_ROOT=1
  ff backup
  [ "$status" -eq 2 ]
  assert_out "sudo freeframe backup"
  assert_not_called "dc "
}

@test "backup: a second backup or restore at the same time is refused" {
  command -v flock >/dev/null || skip "no flock"
  exec 8>>"$FF_ROOT/.freeframe.lock"
  flock -n 8
  ff backup
  exec 8>&-
  [ "$status" -eq 1 ]
  assert_out "Another freeframe command (an update, rollback, backup, restore, restart, configure or uninstall) is running right now"
  assert_not_called pg_dump
}

@test "backup: only the nightly run, and only behind an update or rollback, is skipped instead of refused" {
  command -v flock >/dev/null || skip "no flock"
  exec 8>>"$FF_ROOT/.freeframe.lock"
  flock -n 8
  # Behind a running update (the lock file names it and its live process).
  printf 'update %s\n' "$$" >"$FF_ROOT/.freeframe.lock"
  ff backup --quiet
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "The nightly backup was skipped: a freeframe update is running right now"
  assert_not_called pg_dump
  # By hand, the same is refused: a backup was asked for and none was made.
  ff backup
  [ "$status" -eq 1 ]
  assert_out "Another freeframe command"
  # Behind a restore, the nightly run is refused as before.
  printf 'restore %s\n' "$$" >"$FF_ROOT/.freeframe.lock"
  ff backup --quiet
  [ "$status" -eq 1 ]
  assert_out "Another freeframe command"
  # A name left by a process that has ended says nothing about the holder.
  printf 'update 999999999\n' >"$FF_ROOT/.freeframe.lock"
  ff backup --quiet
  [ "$status" -eq 1 ]
  assert_out "Another freeframe command"
  exec 8>&-
  assert_not_called pg_dump
}

@test "backup: 8 nightly runs during an unfinished restore leave every real backup in place" {
  local s before
  for s in 01 02 03 04 05 06 07; do old_backup "202610$s-030000"; done
  # A restore failed after dropping the database: the record stands, and
  # the database is there but empty.
  printf '%s\n' "$BK/freeframe-20261007-030000.dump" >"$FF_ROOT/.restore-undo"
  export STUB_DB_STATE=empty
  before=$(ls -A "$BK")
  for s in 1 2 3 4 5 6 7 8; do
    ff backup --quiet
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    assert_eq "$(printf '%s\n' "$output" | grep -c .)" 1
    assert_out "The nightly backup was skipped: a restore of the database did not finish"
  done
  assert_eq "$(ls -A "$BK")" "$before"
  assert_not_called pg_dump
}

@test "backup: by hand during an unfinished restore is refused in plain words" {
  old_backup 20261020-030000
  printf '%s\n' "$BK/freeframe-20261020-030000.dump" >"$FF_ROOT/.restore-undo"
  ff backup
  [ "$status" -eq 1 ]
  assert_out "A restore of the database did not finish, so the database may be empty, and a backup of it could replace a real one. No backup was made."
  assert_out "sudo freeframe restore --yes '$BK/freeframe-20261020-030000.dump'"
  assert_not_called pg_dump
  assert_eq "$(dumps)" "freeframe-20261020-030000.dump"
}

@test "backup: an empty database is never backed up, and nothing is pruned" {
  local s before
  for s in 01 02 03 04 05 06 07; do old_backup "202610$s-030000"; done
  export STUB_DB_STATE=empty
  before=$(ls -A "$BK")
  ff backup --quiet
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "The nightly backup was skipped: FreeFrame's database is empty (it has no tables)"
  ff backup
  [ "$status" -eq 1 ]
  assert_out "FreeFrame's database is empty (it has no tables), and a backup of it could replace a real one. No backup was made."
  assert_eq "$(ls -A "$BK")" "$before"
  assert_not_called pg_dump
}

@test "backup: the lock file names the command that holds it" {
  command -v flock >/dev/null || skip "no flock"
  ff backup
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qE '^backup [0-9]+$' "$FF_ROOT/.freeframe.lock"
}

@test "backup: with no log file possible, a failure does not point at one" {
  mkdir "$FF_ROOT/install.log"
  export STUB_DUMP_FAIL=1
  ff backup --quiet
  [ "$status" -eq 1 ]
  assert_out "could not be backed up"
  if [[ $output == *"/dev/null"* || $output == *"end of"* ]]; then echo "$output"; false; fi
}

@test "backup: a failing step in it is checked, not left to an ERR trap that never fires" {
  # backup_create runs inside `if !`, so no ERR trap can catch a failure in
  # it. A date that cannot be read must still stop it, with no odd file name.
  export STUB_STAMP_FAIL=1
  ff backup
  [ "$status" -eq 1 ]
  assert_out "could not be named"
  assert_not_called pg_dump
  [ -z "$(ls -A "$BK" | grep -v '^\.')" ]
  # And there is no dead ERR handler left in the script.
  if grep -q '_backup_on_error' "$FF_SCRIPT"; then false; fi
}

@test "backup: refusals and failures are written to install.log too" {
  export STUB_FREE_MB=500
  ff backup
  [ "$status" -eq 1 ]
  grep -q "not enough free disk space" "$FF_ROOT/install.log"
  grep -q "No new backup was made" "$FF_ROOT/install.log"
  export STUB_FREE_MB="" STUB_DUMP_FAIL=1
  ff backup --quiet
  [ "$status" -eq 1 ]
  grep -q "could not be backed up" "$FF_ROOT/install.log"
  # Settings values never reach the log.
  if grep -q "pw" "$FF_ROOT/install.log"; then cat "$FF_ROOT/install.log"; false; fi
}

@test "backup: a lock refusal is written to install.log" {
  command -v flock >/dev/null || skip "no flock"
  exec 8>>"$FF_ROOT/.freeframe.lock"
  flock -n 8
  ff backup --quiet
  exec 8>&-
  [ "$status" -eq 1 ]
  grep -q "Another freeframe command (an update, rollback, backup, restore, restart, configure or uninstall) is running right now" "$FF_ROOT/install.log"
}

@test "restore: a failed safety copy is in install.log once, not twice" {
  old_backup 20261020-030000
  export STUB_DUMP_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_eq "$(grep -c "No new backup was made" "$FF_ROOT/install.log")" 1
}

@test "backup: the log records the run" {
  ff backup
  [ "$status" -eq 0 ]
  grep -q 'freeframe backup' "$FF_ROOT/install.log"
  assert_eq "$(stat -c %a "$FF_ROOT/install.log")" 600
}

@test "parse_args: --quiet and -q set FF_QUIET" {
  parse_args backup --quiet
  assert_eq "$FF_QUIET" 1
  parse_args -q backup
  assert_eq "$FF_QUIET" 1
  parse_args backup
  assert_eq "$FF_QUIET" ""
}

# ---------------------------------------------------------------- restore: list

@test "restore without FILE lists backups newest first with sizes and dates" {
  old_backup 20261024-030512
  old_backup 20261026-030001 "$(head -c 3000 /dev/zero | tr '\0' x)"
  old_backup 20261025-031500
  ff restore
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  local a b c
  a=$(grep -n 'freeframe-20261026-030001.dump' <<<"$output" | head -1 | cut -d: -f1)
  b=$(grep -n 'freeframe-20261025-031500.dump' <<<"$output" | head -1 | cut -d: -f1)
  c=$(grep -n 'freeframe-20261024-030512.dump' <<<"$output" | head -1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ]
  ((a < b && b < c)) || { echo "$output"; false; }
  [[ $(sed -n "${a}p" <<<"$output") == *"2026-10-26 03:00:01"*"KB"* ]] || { echo "$output"; false; }
  [[ $(sed -n "${c}p" <<<"$output") == *"2026-10-24 03:05:12"*"bytes"* ]] || { echo "$output"; false; }
  assert_out "sudo freeframe restore '$BK/freeframe-20261026-030001.dump'"
  assert_not_called "dc "
}

@test "restore without FILE and no backups says how to make one" {
  ff restore
  [ "$status" -eq 0 ]
  assert_out "no backups"
  assert_out "sudo freeframe backup"
}

# ---------------------------------------------------------------- restore: refusals

@test "restore without --yes and no terminal refuses and changes nothing" {
  old_backup 20261020-030000
  ff restore "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 2 ]
  assert_out "no terminal"
  assert_out "--yes"
  assert_not_called "dc "
}

@test "restore: answering no cancels and changes nothing" {
  old_backup 20261020-030000
  printf 'n\n' >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  ff restore "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_out "replaces"
  assert_out "Restore cancelled. Nothing was changed."
  assert_not_called "dc "
}

@test "restore: answering yes goes ahead" {
  old_backup 20261020-030000
  printf 'y\n' >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
  ff restore "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "dc exec -T postgres dropdb" "dc exec -T postgres pg_restore"
}

@test "restore: a file that is not a backup is refused before any change" {
  printf 'CREATE TABLE x();\n' >"$BATS_TEST_TMPDIR/backup.sql"
  ff restore --yes "$BATS_TEST_TMPDIR/backup.sql"
  [ "$status" -eq 1 ]
  assert_out "is not a FreeFrame database backup"
  assert_not_called "dc "
}

@test "restore: a missing file is refused; a bare name is found in the backups folder" {
  ff restore --yes nosuch.dump
  [ "$status" -eq 1 ]
  assert_out "There is no backup file"
  assert_not_called "dc "
  old_backup 20261020-030000
  ff restore --yes freeframe-20261020-030000.dump
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(cat "$STUB_DIR/restored")" "PGDMP old 20261020-030000"
}

@test "restore: not root exits 2" {
  export STUB_NOT_ROOT=1
  ff restore
  [ "$status" -eq 2 ]
  assert_out "sudo freeframe restore"
}

@test "restore: every printed command quotes its path, so it can be pasted" {
  # A backup copied in under a folder whose name has spaces and a quote.
  local d="$BATS_TEST_TMPDIR/old server's backups"
  mkdir -p "$d"
  printf 'PGDMP old\n' >"$d/freeframe-20261020-030000.dump"
  export STUB_RESTORE_FAIL=1
  ff restore --yes "$d/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  local q="'$BATS_TEST_TMPDIR/old server'\\''s backups/freeframe-20261020-030000.dump'"
  assert_out "To try again, run: sudo freeframe restore --yes $q"
  # The printed command, run through a shell, gives back the exact path.
  local cmd
  cmd=${output#*To try again, run: sudo freeframe restore --yes }
  cmd="${cmd%%.dump\'*}.dump'"
  eval "set -- $cmd"
  assert_eq "$#" 1
  assert_eq "$1" "$d/freeframe-20261020-030000.dump"
  # The undo command is quoted too, and so is the no-terminal hint.
  local safety
  safety=$(dumps | tail -1)
  assert_out "run: sudo freeframe restore --yes '$BK/$safety'"
  unset STUB_RESTORE_FAIL
  rm -f "$FF_ROOT/.restore-undo"
  export FF_YES=""
  ff restore "$d/freeframe-20261020-030000.dump"
  [ "$status" -eq 2 ]
  assert_out "add --yes: sudo freeframe restore --yes $q"
}

@test "restore: two files is a usage error" {
  ff restore a.dump b.dump
  [ "$status" -eq 2 ]
  assert_not_called "dc "
}

# ---------------------------------------------------------------- restore: the steps

@test "restore calls stop, dropdb, createdb, pg_restore, up in that order" {
  old_backup 20261020-030000
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "dc up -d --no-build postgres" "dc exec -T postgres pg_isready" \
    "dc stop " \
    "dc exec -T postgres dropdb -U ffuser --if-exists --force ffdb" \
    "dc exec -T postgres createdb -U ffuser -O ffuser ffdb" \
    "dc exec -T postgres pg_restore -U ffuser -d ffdb --no-owner --no-acl --single-transaction" \
    "dc up -d --no-build" "localhost:8000/health"
  # Every service except postgres and traefik is stopped.
  local stop
  stop=$(grep '^dc stop ' "$CALLS")
  assert_eq "$stop" "dc stop redis api worker email_worker maintenance_worker beat web minio minio-init"
  # The dump's bytes reached pg_restore.
  assert_eq "$(cat "$STUB_DIR/restored")" "PGDMP old 20261020-030000"
  assert_out "The database is back as it was"
}

@test "restore: a safety copy of the current database is saved first, as a normal backup" {
  local s
  for s in 14 15 16 17 18 19 20; do old_backup "202610$s-030000"; done
  # Restore the oldest of 7: the safety copy must not prune it away.
  ff restore --yes "$BK/freeframe-20261014-030000.dump"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "dc stop " "dc exec -T postgres pg_dump -Fc -U ffuser ffdb" "dc exec -T postgres dropdb"
  assert_eq "$(dumps | wc -l | tr -d ' ')" 8
  [ -e "$BK/freeframe-20261014-030000.dump" ]
  local safety
  safety=$(dumps | tail -1)
  [[ $safety != freeframe-20261020-030000.dump ]]
  assert_eq "$(cat "$BK/$safety")" "PGDMP current database v2"
  [ -e "$BK/${safety%.dump}.env.prod" ]
  assert_out "sudo freeframe restore --yes '$BK/$safety'"
  assert_eq "$(cat "$STUB_DIR/restored")" "PGDMP old 20261014-030000"
}

@test "restore: a database that is not there has nothing to save, and the restore goes ahead" {
  old_backup 20261020-030000
  export STUB_DB_STATE=absent
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called pg_dump
  assert_out "nothing to save"
  assert_order "dc exec -T postgres dropdb" "dc exec -T postgres pg_restore"
  # The check goes through the maintenance database, with the name as a
  # psql variable.
  grep -q -- "-d postgres -v db=ffdb" "$CALLS"
  grep -q "datname = :'db'" "$STUB_DIR/maint-sql"
}

@test "restore: an empty database (no tables) has nothing to save" {
  old_backup 20261020-030000
  export STUB_DB_STATE=empty
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called pg_dump
  assert_out "nothing to save"
  [ ! -e "$FF_ROOT/.restore-undo" ]
}

@test "restore: a database that exists but cannot be opened is never dropped" {
  old_backup 20261020-030000
  export STUB_DB_OPEN_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_not_called pg_dump
  assert_not_called dropdb
  assert_out "could not be checked"
  assert_out "before changing anything"
  assert_order "dc stop " "dc up -d --no-build"
}

@test "restore: the maintenance check failing is never read as nothing to save" {
  old_backup 20261020-030000
  export STUB_MAINT_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_not_called dropdb
  assert_out "could not be checked"
}

@test "restore: a retry after a failed restore keeps the first safety copy as the undo" {
  old_backup 20261020-030000
  export STUB_RESTORE_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  local safety1
  safety1=$(dumps | tail -1)
  assert_eq "$(cat "$BK/$safety1")" "PGDMP current database v2"
  assert_eq "$(cat "$FF_ROOT/.restore-undo")" "$BK/$safety1"
  assert_eq "$(stat -c %a "$FF_ROOT/.restore-undo")" 600
  # The retry fails too: no copy of the empty database is taken, and the
  # undo still points at the first copy.
  : >"$CALLS"
  sleep 1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_not_called pg_dump
  assert_out "nothing new to save"
  assert_out "sudo freeframe restore --yes '$BK/$safety1'"
  assert_eq "$(dumps | tail -1)" "$safety1"
  assert_eq "$(cat "$FF_ROOT/.restore-undo")" "$BK/$safety1"
  # The undo itself then works, puts the first copy back and clears the record.
  unset STUB_RESTORE_FAIL
  ff restore --yes "$BK/$safety1"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(cat "$STUB_DIR/restored")" "PGDMP current database v2"
  [ ! -e "$FF_ROOT/.restore-undo" ]
  # Having just put that copy back, it is not offered as a way back again.
  if [[ $output == *"to go back to it"* ]]; then echo "$output"; false; fi
}

@test "restore: a retry over a database with data takes a new copy and offers it as the undo" {
  old_backup 20261020-030000
  export STUB_API_DOWN=1 FF_API_WAIT=10
  # Attempt 1 puts the backup back but FreeFrame does not come up.
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  local safety1
  safety1=$(dumps | tail -1)
  unset STUB_API_DOWN
  sleep 1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  local safety2
  safety2=$(dumps | tail -1)
  [[ $safety2 != "$safety1" ]]
  assert_out "to go back to it, run: sudo freeframe restore --yes '$BK/$safety2'"
  if [[ $output == *"$safety1"* ]]; then echo "$output"; false; fi
  [ ! -e "$FF_ROOT/.restore-undo" ]
}

@test "restore: FreeFrame not starting after the backup is back leaves no undo record" {
  old_backup 20261020-030000
  export STUB_UP_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_out "The backup has been put back, but FreeFrame could not be started again."
  local safety
  safety=$(dumps | tail -1)
  # This run's copy is still named as the way back.
  assert_out "to go back to it, run: sudo freeframe restore --yes '$BK/$safety'"
  [ ! -e "$FF_ROOT/.restore-undo" ]
}

@test "restore: a health timeout after the backup is back leaves no undo record" {
  old_backup 20261020-030000
  export STUB_API_DOWN=1 FF_API_WAIT=10
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_out "did not finish starting"
  [ ! -e "$FF_ROOT/.restore-undo" ]
}

@test "restore: stopped after the copy is recorded but before the drop, the record is dropped too" {
  # The database still has its data, so a record would only mislead a later
  # restore (and a retry takes a fresh copy anyway).
  old_backup 20261020-030000
  export STUB_UNDO_SET_HANG=1
  ff_signal TERM undo-set restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_not_called dropdb
  [ ! -e "$FF_ROOT/.restore-undo" ]
  assert_out "the database has not been changed"
}

@test "restore: a stale record over a database with data is replaced by a fresh copy" {
  old_backup 20261001-030000 "weeks old"
  old_backup 20261020-030000
  printf '%s\n' "$BK/freeframe-20261001-030000.dump" >"$FF_ROOT/.restore-undo"
  # Stop after the drop, so the record can be looked at mid-way.
  export STUB_RESTORE_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  local fresh
  fresh=$(dumps | tail -1)
  assert_eq "$(cat "$BK/$fresh")" "PGDMP current database v2"
  assert_eq "$(cat "$FF_ROOT/.restore-undo")" "$BK/$fresh"
  assert_out "its copy ($BK/freeframe-20261001-030000.dump) is an ordinary backup again"
  assert_out "run: sudo freeframe restore --yes '$BK/$fresh'"
  if [[ $output == *"restore --yes '$BK/freeframe-20261001-030000.dump'"* ]]; then echo "$output"; false; fi
  # A successful run then offers the fresh copy and clears the record.
  unset STUB_RESTORE_FAIL
  printf '%s\n' "$BK/freeframe-20261001-030000.dump" >"$FF_ROOT/.restore-undo"
  rm -f "$STUB_DIR/dbstate"
  sleep 1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  fresh=$(dumps | tail -1)
  assert_out "The database as it was before is saved; to go back to it, run: sudo freeframe restore --yes '$BK/$fresh'"
  [ ! -e "$FF_ROOT/.restore-undo" ]
}

@test "restore: putting the recorded copy back over data offers the new copy, not the file itself" {
  old_backup 20261020-030000
  printf '%s\n' "$BK/freeframe-20261020-030000.dump" >"$FF_ROOT/.restore-undo"
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  if [[ $output == *"kept too"* || $output == *"ordinary backup again"* ]]; then echo "$output"; false; fi
  local s2
  s2=$(dumps | tail -1)
  [[ $s2 != freeframe-20261020-030000.dump ]]
  assert_out "to go back to it, run: sudo freeframe restore --yes '$BK/$s2'"
}

@test "restore: a recorded copy that was deleted is said, and the record dropped" {
  old_backup 20261020-030000
  printf '%s\n' "$BK/freeframe-20261001-000000.dump" >"$FF_ROOT/.restore-undo"
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "no longer there"
  grep -q pg_dump "$CALLS"
}

@test "backup: the recorded undo copy is never pruned and not used for the size rule" {
  local s
  old_backup 20261001-030000 "the copy to undo with"
  printf '%s\n' "$BK/freeframe-20261001-030000.dump" >"$FF_ROOT/.restore-undo"
  for s in 02 03 04 05 06 07 08 09; do old_backup "202610$s-030000"; done
  # The recorded copy is huge, the others are small: it must not count.
  export STUB_BIG_LAST=$((900 * 1048576)) STUB_BIG_LAST_FILE="$BK/freeframe-20261001-030000.dump"
  export STUB_FREE_MB=1100
  # freeframe backup itself refuses while the record stands; backup_create
  # (restore's safety copy, update) still protects the copy.
  run bash -c 'set -Eeuo pipefail; source "$1"; source "$2"; backup_create prune' \
    ff-run "$FF_SCRIPT" "$STUBS"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ -e "$BK/freeframe-20261001-030000.dump" ]
  [ -e "$BK/freeframe-20261001-030000.env.prod" ]
  # 7 normal ones are kept besides it.
  assert_eq "$(dumps | wc -l | tr -d ' ')" 8
  [ ! -e "$BK/freeframe-20261003-030000.dump" ]
  [ -e "$BK/freeframe-20261004-030000.dump" ]
}

@test "restore without FILE does not suggest the rollback's copy, and lists it with its date" {
  old_backup 20261020-030000
  old_backup 20261021-030000-before-rollback
  ff restore
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "sudo freeframe restore '$BK/freeframe-20261020-030000.dump'"
  if [[ $output == *"restore '$BK/freeframe-20261021-030000-before-rollback.dump'"* ]]; then echo "$output"; false; fi
  assert_out "freeframe-20261021-030000-before-rollback.dump"
  assert_out "2026-10-21 03:00:00"
  assert_out "before a rollback"
}

@test "backup: a rollback's copy ages out like any backup, with its settings copy, and counts for the size rule" {
  local s
  old_backup 20261001-030000-before-rollback
  for s in 02 03 04 05 06 07; do old_backup "202610$s-030000"; done
  ff backup
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(dumps | wc -l | tr -d ' ')" 7
  [ ! -e "$BK/freeframe-20261001-030000-before-rollback.dump" ]
  [ ! -e "$BK/freeframe-20261001-030000-before-rollback.env.prod" ]
  # The newest backup is a big rollback copy: twice its size is needed. Its
  # name must sort after the backup made above, which is named with the real
  # clock, so it is dated far ahead (as uninstall.bats does for its newest backup).
  old_backup 20991230-030000-before-rollback
  export STUB_BIG_LAST=$((700 * 1048576)) STUB_BIG_LAST_FILE="$BK/freeframe-20991230-030000-before-rollback.dump"
  export STUB_FREE_MB=1300
  ff backup
  [ "$status" -eq 1 ]
  assert_out "at least 1400 MB"
}

@test "backup_prune leaves a protected dump alone and does not count it" {
  local s
  for s in 01 02 03 04; do old_backup "202610$s-030000"; done
  backup_prune "$BK" 2 "$BK/freeframe-20261001-030000.dump"
  assert_eq "$(dumps | tr '\n' ' ')" "freeframe-20261001-030000.dump freeframe-20261003-030000.dump freeframe-20261004-030000.dump "
}

@test "restore without FILE mentions an unfinished restore's undo copy" {
  old_backup 20261020-030000
  printf '%s\n' "$BK/freeframe-20261020-030000.dump" >"$FF_ROOT/.restore-undo"
  ff restore
  [ "$status" -eq 0 ]
  assert_out "A restore did not finish"
  assert_out "sudo freeframe restore --yes '$BK/freeframe-20261020-030000.dump'"
}

@test "restore: a failed safety copy changes nothing and starts FreeFrame again" {
  old_backup 20261020-030000
  export STUB_DUMP_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_not_called dropdb
  assert_not_called pg_restore
  assert_order "dc stop " "pg_dump" "dc up -d --no-build"
  assert_out "before changing anything"
  [ -z "$(ls -A "$BK" | grep partial)" ]
}

@test "restore: too little disk for the safety copy changes nothing" {
  old_backup 20261020-030000
  export STUB_FREE_MB=10
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_not_called dropdb
  assert_out "not enough free disk space"
  assert_out "before changing anything"
}

@test "restore: the database server not starting stops before any change" {
  old_backup 20261020-030000
  export STUB_PG_DOWN=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_not_called "dc stop"
  assert_not_called dropdb
  assert_out "nothing was changed"
}

@test "restore: dropdb failing leaves the database as it was and starts FreeFrame again" {
  old_backup 20261020-030000
  export STUB_DROP_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_not_called createdb
  assert_order "dropdb" "dc up -d --no-build"
  assert_out "unchanged"
  assert_out "install.log"
}

@test "restore: it says FreeFrame was started again only when it was" {
  old_backup 20261020-030000
  export STUB_DROP_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_out "FreeFrame has been started again."
  export STUB_UP_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  if [[ $output == *"has been started again"* ]]; then echo "$output"; false; fi
  assert_out "FreeFrame could not be started again. To start it, run: sudo freeframe restart"
  # The same for a stop that fails, and a database that cannot be checked.
  export STUB_DROP_FAIL="" STUB_STOP_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_out "FreeFrame could not be stopped, so nothing was changed."
  assert_out "FreeFrame could not be started again."
  export STUB_STOP_FAIL="" STUB_DB_OPEN_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_out "FreeFrame could not be started again."
}

@test "restore: dropdb failing on a database with data forgets the new record" {
  old_backup 20261020-030000
  export STUB_DROP_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_out "The current database could not be removed, so it is unchanged."
  [ ! -e "$FF_ROOT/.restore-undo" ]
}

@test "restore: dropdb failing after the database went away keeps the undo and leaves FreeFrame stopped" {
  old_backup 20261020-030000
  export STUB_DROP_FAIL_GONE=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  if [[ $output == *unchanged* ]]; then echo "$output"; false; fi
  assert_out "may already have been removed"
  assert_out "To try again, run: sudo freeframe restore --yes '$BK/freeframe-20261020-030000.dump'"
  local safety
  safety=$(dumps | tail -1)
  assert_out "run: sudo freeframe restore --yes '$BK/$safety'"
  assert_out "install.log"
  # Only the database server was started; FreeFrame stays stopped.
  [ "$(grep -c '^dc up -d' "$CALLS")" -eq 1 ]
  assert_not_called createdb
  assert_eq "$(cat "$FF_ROOT/.restore-undo")" "$BK/$safety"
}

@test "restore: dropdb failing when the database can no longer be checked is treated as maybe removed" {
  old_backup 20261020-030000
  export STUB_DROP_FAIL=1 STUB_MAINT_FAIL_AFTER_DROP=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  if [[ $output == *unchanged* ]]; then echo "$output"; false; fi
  assert_out "may already have been removed"
  [ "$(grep -c '^dc up -d' "$CALLS")" -eq 1 ]
  local safety
  safety=$(dumps | tail -1)
  assert_eq "$(cat "$FF_ROOT/.restore-undo")" "$BK/$safety"
}

@test "restore: an early stop while an earlier restore is unfinished keeps FreeFrame stopped and names the command that works" {
  old_backup 20261019-030000 "the copy from before"
  old_backup 20261020-030000
  # An earlier restore left the database empty, with its undo record.
  printf '%s\n' "$BK/freeframe-20261019-030000.dump" >"$FF_ROOT/.restore-undo"
  printf 'empty' >"$STUB_DIR/dbstate"
  export STUB_STOP_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  # Not started on a database that may be empty, and restart (which refuses
  # then) is not what it suggests.
  [ "$(grep -c '^dc up -d --no-build$' "$CALLS")" -eq 0 ]
  if [[ $output == *"sudo freeframe restart"* ]]; then echo "$output"; false; fi
  assert_out "an earlier restore did not finish"
  assert_out "To finish, run: sudo freeframe restore --yes '$BK/freeframe-20261020-030000.dump'"
  assert_out "sudo freeframe restore --yes '$BK/freeframe-20261019-030000.dump'"
  assert_eq "$(cat "$FF_ROOT/.restore-undo")" "$BK/freeframe-20261019-030000.dump"
}

@test "restore: interrupted while stopping with an earlier restore unfinished, it does not suggest restart" {
  old_backup 20261019-030000
  old_backup 20261020-030000
  printf '%s\n' "$BK/freeframe-20261019-030000.dump" >"$FF_ROOT/.restore-undo"
  printf 'empty' >"$STUB_DIR/dbstate"
  export STUB_STOP_HANG=1
  ff_signal TERM stop restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  if [[ $output == *"sudo freeframe restart"* ]]; then echo "$output"; false; fi
  assert_out "To finish, run: sudo freeframe restore --yes '$BK/freeframe-20261020-030000.dump'"
}

@test "restore: createdb failing after the drop says the database is gone and how to retry" {
  old_backup 20261020-030000
  export STUB_CREATE_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_not_called pg_restore
  # FreeFrame stays stopped: an app on an empty database would offer its
  # setup page to anyone.
  [ "$(grep -c '^dc up -d' "$CALLS")" -eq 1 ]
  assert_out "The database has been removed"
  assert_out "sudo freeframe restore --yes '$BK/freeframe-20261020-030000.dump'"
  assert_out "install.log"
}

@test "restore: pg_restore failing says the database is empty, FreeFrame stays stopped, and how to retry" {
  old_backup 20261020-030000
  export STUB_RESTORE_FAIL=1
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  [ "$(grep -c '^dc up -d' "$CALLS")" -eq 1 ]
  assert_out "The database is empty now"
  assert_out "FreeFrame is stopped"
  assert_out "sudo freeframe restore --yes '$BK/freeframe-20261020-030000.dump'"
  local safety
  safety=$(dumps | tail -1)
  assert_out "sudo freeframe restore --yes '$BK/$safety'"
  assert_out "install.log"
  assert_eq "$(cat "$FF_ROOT/.restore-undo")" "$BK/$safety"
}

@test "restore: FreeFrame not answering afterwards says the backup is back but the app is not" {
  old_backup 20261020-030000
  export STUB_API_DOWN=1 FF_API_WAIT=10
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_out "The backup has been put back"
  assert_out "sudo freeframe logs"
}

@test "restore: the log records what happened" {
  old_backup 20261020-030000
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 0 ]
  grep -q 'freeframe restore' "$FF_ROOT/install.log"
  grep -q 'The database is back as it was' "$FF_ROOT/install.log"
}

# ---------------------------------------------------------------- signals

# ff_signal SIG STEP ARGS...: run `freeframe ARGS` in its own process group,
# wait until the stubbed STEP hangs, then send SIG to the whole group (as
# systemctl stop, a shutdown or Ctrl-C do). INT cannot be tested this way:
# bash starts background jobs with SIGINT ignored, and an ignored signal
# cannot be trapped. INT, TERM and HUP share one handler.
ff_signal() {
  local sig=$1 step=$2 pid n=0
  shift 2
  command -v setsid >/dev/null || skip "no setsid"
  # FF_SIGNAL_ERR=FILE sends stderr there instead (for example /dev/full).
  if [[ -n ${FF_SIGNAL_ERR:-} ]]; then
    setsid bash -c 'set -Eeuo pipefail; source "$1"; source "$2"; shift 2; main "$@"' \
      ff-run "$FF_SCRIPT" "$STUBS" "$@" >"$BATS_TEST_TMPDIR/out" 2>"$FF_SIGNAL_ERR" &
  else
    setsid bash -c 'set -Eeuo pipefail; source "$1"; source "$2"; shift 2; main "$@"' \
      ff-run "$FF_SCRIPT" "$STUBS" "$@" >"$BATS_TEST_TMPDIR/out" 2>&1 &
  fi
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

@test "backup: stopped part-way (TERM), it removes the part-written files and says so" {
  export STUB_DUMP_HANG=1
  ff_signal TERM pg_dump backup --quiet
  [ "$status" -eq 1 ]
  assert_out "The backup was stopped (SIGTERM) before it finished."
  assert_out "No new backup was made"
  [ -z "$(ls -A "$BK" | grep -v '^\.')" ]
}

@test "backup: stopped with its stderr gone, it still logs and cleans up" {
  [ -w /dev/full ] || skip "no /dev/full"
  export STUB_DUMP_HANG=1 FF_SIGNAL_ERR=/dev/full
  ff_signal TERM pg_dump backup --quiet
  [ "$status" -eq 1 ]
  grep -q "The backup was stopped (SIGTERM) before it finished." "$FF_ROOT/install.log"
  grep -q "No new backup was made" "$FF_ROOT/install.log"
  [ -z "$(ls -A "$BK" | grep -v '^\.')" ]
}

@test "backup: a refusal with its stderr gone is still logged" {
  [ -w /dev/full ] || skip "no /dev/full"
  export STUB_FREE_MB=500
  run bash -c 'set -Eeuo pipefail; source "$1"; source "$2"; shift 2; exec 2>/dev/full; main "$@"' \
    ff-run "$FF_SCRIPT" "$STUBS" backup --quiet
  [ "$status" -eq 1 ]
  grep -q "not enough free disk space" "$FF_ROOT/install.log"
  grep -q "No new backup was made" "$FF_ROOT/install.log"
}

@test "backup: files a killed backup left behind are removed by the next one" {
  mkdir -p "$BK"
  printf 'PGDMP-half' >"$BK/freeframe-20261020-030000.dump.partial"
  printf 'X=1' >"$BK/freeframe-20261020-030000.env.prod.partial"
  old_backup 20261019-030000
  ff backup
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$BK" | grep partial)" ]
  [ -e "$BK/freeframe-20261019-030000.dump" ]
  grep -q 'left by a backup that did not finish' "$FF_ROOT/install.log"
}

@test "restore: stopped (TERM) while the backup goes in, it says the database is empty and how to go on" {
  old_backup 20261020-030000
  export STUB_RESTORE_HANG=1
  ff_signal TERM pg_restore restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_out "The restore was stopped (SIGTERM) while putting the backup back"
  assert_out "The database is empty now"
  assert_out "sudo freeframe restore --yes '$BK/freeframe-20261020-030000.dump'"
  local safety
  safety=$(dumps | tail -1)
  assert_out "sudo freeframe restore --yes '$BK/$safety'"
  assert_out "install.log"
  # FreeFrame was not started on the empty database, and the undo is kept.
  [ "$(grep -c '^dc up -d' "$CALLS")" -eq 1 ]
  assert_eq "$(cat "$FF_ROOT/.restore-undo")" "$BK/$safety"
  grep -q "stopped (SIGTERM)" "$FF_ROOT/install.log"
}

@test "restore: stopped (HUP) while saving the safety copy, nothing was changed and no part file is left" {
  old_backup 20261020-030000
  export STUB_DUMP_HANG=1
  ff_signal HUP pg_dump restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ] || { echo "status $status"; echo "$output"; cat "$CALLS"; false; }
  assert_out "The restore was stopped (SIGHUP) while saving a copy of the current database"
  assert_out "the database has not been changed"
  assert_not_called dropdb
  [ -z "$(ls -A "$BK" | grep partial)" ]
}

@test "restore: stopped while FreeFrame is being stopped, it says it may be partly stopped and how to start it" {
  old_backup 20261020-030000
  export STUB_STOP_HANG=1
  ff_signal TERM stop restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_out "while stopping FreeFrame"
  assert_out "FreeFrame may be partly stopped; the database has not been changed."
  assert_out "sudo freeframe restart"
  assert_not_called dropdb
  [ ! -e "$FF_ROOT/.restore-undo" ]
}

@test "restore: stopped during the drop, it says the database may be gone and gives retry and undo" {
  old_backup 20261020-030000
  export STUB_DROP_HANG=1
  ff_signal TERM dropdb restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 1 ]
  assert_out "while removing the current database"
  assert_out "The database may already have been removed."
  assert_out "To try again, run: sudo freeframe restore --yes '$BK/freeframe-20261020-030000.dump'"
  local safety
  safety=$(dumps | tail -1)
  assert_out "run: sudo freeframe restore --yes '$BK/$safety'"
  # The database may be gone, so the record stays for a retry.
  assert_eq "$(cat "$FF_ROOT/.restore-undo")" "$BK/$safety"
}

# ---------------------------------------------------------------- the timer

UNITS="${BATS_TEST_DIRNAME}/../systemd"

@test "the timer runs every night at 03:00, catches up, with a random 15-minute delay" {
  local t="$UNITS/freeframe-backup.timer"
  assert_has "$t" "OnCalendar=*-*-* 03:00"
  assert_has "$t" "Persistent=true"
  assert_has "$t" "RandomizedDelaySec=15m"
  assert_has "$t" "WantedBy=timers.target"
}

@test "the backup service runs freeframe backup --quiet once" {
  local s="$UNITS/freeframe-backup.service"
  assert_has "$s" "Type=oneshot"
  assert_has "$s" "ExecStart=/usr/local/bin/freeframe backup --quiet"
  assert_has "$s" "After=docker.service"
}

@test "the units pass systemd-analyze verify" {
  command -v systemd-analyze >/dev/null || skip "no systemd-analyze"
  local d="$BATS_TEST_TMPDIR/units"
  mkdir -p "$d"
  cp "$UNITS"/freeframe-backup.* "$d/"
  # verify checks that ExecStart exists; point it at a stand-in.
  printf '#!/bin/sh\n' >"$d/freeframe"
  chmod 755 "$d/freeframe"
  sed -i "s#/usr/local/bin/freeframe#$d/freeframe#" "$d/freeframe-backup.service"
  run systemd-analyze verify "$d/freeframe-backup.service" "$d/freeframe-backup.timer"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
}

@test "install_backup_timer installs both units and starts the timer" {
  mkdir -p "$FF_ROOT/systemd" "$BATS_TEST_TMPDIR/etc"
  cp "$UNITS"/freeframe-backup.* "$FF_ROOT/systemd/"
  export FF_SYSTEMD_DIR="$BATS_TEST_TMPDIR/etc"
  systemctl() { printf 'systemctl %s\n' "$*" >>"$CALLS"; }
  install_backup_timer
  cmp "$UNITS/freeframe-backup.service" "$FF_SYSTEMD_DIR/freeframe-backup.service"
  cmp "$UNITS/freeframe-backup.timer" "$FF_SYSTEMD_DIR/freeframe-backup.timer"
  assert_eq "$(stat -c %a "$FF_SYSTEMD_DIR/freeframe-backup.timer")" 644
  assert_order "systemctl daemon-reload" "systemctl enable --now --no-reload freeframe-backup.timer"
}

@test "install_backup_timer: units that did not change mean no daemon-reload and no enable" {
  mkdir -p "$FF_ROOT/systemd" "$BATS_TEST_TMPDIR/etc"
  cp "$UNITS"/freeframe-backup.* "$FF_ROOT/systemd/"
  cp "$UNITS"/freeframe-backup.* "$BATS_TEST_TMPDIR/etc/"
  export FF_SYSTEMD_DIR="$BATS_TEST_TMPDIR/etc"
  # Enabled and running.
  systemctl() { printf 'systemctl %s\n' "$*" >>"$CALLS"; }
  install_backup_timer
  if grep -E 'daemon-reload|systemctl enable' "$CALLS"; then false; fi
  # Not enabled (or stopped): enabled and started, still without a reload.
  : >"$CALLS"
  systemctl() {
    printf 'systemctl %s\n' "$*" >>"$CALLS"
    [[ $1 != is-enabled ]]
  }
  install_backup_timer
  grep -qx "systemctl enable --now --no-reload freeframe-backup.timer" "$CALLS"
  if grep -q daemon-reload "$CALLS"; then false; fi
  # One unit changed: copied, one daemon-reload, enabled again.
  : >"$CALLS"
  printf '# changed\n' >>"$FF_ROOT/systemd/freeframe-backup.timer"
  install_backup_timer
  cmp "$FF_ROOT/systemd/freeframe-backup.timer" "$FF_SYSTEMD_DIR/freeframe-backup.timer"
  assert_order "systemctl daemon-reload" "systemctl enable --now --no-reload freeframe-backup.timer"
  [ "$(grep -c 'daemon-reload' "$CALLS")" -eq 1 ]
}

@test "backup_units_install: units on disk that systemd has not loaded (an earlier reload failed) are reloaded; an old systemd or an error is no" {
  mkdir -p "$FF_ROOT/systemd" "$BATS_TEST_TMPDIR/etc"
  cp "$UNITS"/freeframe-backup.* "$FF_ROOT/systemd/"
  cp "$UNITS"/freeframe-backup.* "$BATS_TEST_TMPDIR/etc/"
  export FF_SYSTEMD_DIR="$BATS_TEST_TMPDIR/etc"
  # The files are the same, but the timer's definition in systemd is old.
  systemctl() {
    printf 'systemctl %s\n' "$*" >>"$CALLS"
    if [[ $1 == show ]]; then printf 'yes\nno\n'; fi
    return 0
  }
  backup_units_install
  grep -qx "systemctl show -p NeedDaemonReload --value freeframe-backup.timer freeframe-backup.service" "$CALLS"
  [ "$(grep -c '^systemctl daemon-reload$' "$CALLS")" -eq 1 ]
  [ "$FF_UNITS_CHANGED" = 1 ]
  # The service's, the second line, counts as well.
  : >"$CALLS"
  systemctl() {
    printf 'systemctl %s\n' "$*" >>"$CALLS"
    if [[ $1 == show ]]; then printf 'no\nyes\n'; fi
    return 0
  }
  backup_units_install
  [ "$(grep -c '^systemctl daemon-reload$' "$CALLS")" -eq 1 ]
  # Loaded as on disk: no reload.
  : >"$CALLS"
  systemctl() {
    printf 'systemctl %s\n' "$*" >>"$CALLS"
    if [[ $1 == show ]]; then printf 'no\nno\n'; fi
    return 0
  }
  backup_units_install
  if grep -q daemon-reload "$CALLS"; then false; fi
  # A systemd that does not know the property prints nothing; one that
  # fails is an error: neither reloads, and neither fails.
  : >"$CALLS"
  systemctl() {
    printf 'systemctl %s\n' "$*" >>"$CALLS"
    if [[ $1 == show ]]; then printf '\n\n'; fi
    return 0
  }
  backup_units_install
  systemctl() {
    printf 'systemctl %s\n' "$*" >>"$CALLS"
    [[ $1 != show ]]
  }
  backup_units_install
  if grep -q daemon-reload "$CALLS"; then false; fi
}

@test "backup_units_install then backup_timer_on: the install's split, one reload, before the timer starts" {
  mkdir -p "$FF_ROOT/systemd" "$BATS_TEST_TMPDIR/etc"
  cp "$UNITS"/freeframe-backup.* "$FF_ROOT/systemd/"
  export FF_SYSTEMD_DIR="$BATS_TEST_TMPDIR/etc"
  systemctl() { printf 'systemctl %s\n' "$*" >>"$CALLS"; }
  backup_units_install
  assert_eq "$(cat "$CALLS")" "systemctl daemon-reload"
  backup_timer_on
  assert_eq "$(sed -n 2p "$CALLS")" "systemctl enable --now --no-reload freeframe-backup.timer"
}

@test "install_backup_timer fails when the units are missing or systemctl fails" {
  mkdir -p "$BATS_TEST_TMPDIR/etc"
  export FF_SYSTEMD_DIR="$BATS_TEST_TMPDIR/etc"
  systemctl() { printf 'systemctl %s\n' "$*" >>"$CALLS"; }
  run install_backup_timer
  [ "$status" -ne 0 ]
  mkdir -p "$FF_ROOT/systemd"
  cp "$UNITS"/freeframe-backup.* "$FF_ROOT/systemd/"
  systemctl() { return 1; }
  run install_backup_timer
  [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------- helpers

@test "_ff_human_size and _ff_stamp_date" {
  assert_eq "$(_ff_human_size 512)" "512 bytes"
  assert_eq "$(_ff_human_size 3000)" "2 KB"
  assert_eq "$(_ff_human_size $((12 * 1048576 + 400000)))" "12.4 MB"
  assert_eq "$(_ff_human_size $((3 * 1073741824)))" "3.0 GB"
  assert_eq "$(_ff_stamp_date freeframe-20261026-030412.dump)" "2026-10-26 03:04:12"
  assert_eq "$(_ff_stamp_date something.dump)" ""
}

# ---------------------------------------------------------------- the worker's GPU, after a restore

@test "restore gpu worker: after FreeFrame starts again, a worker that never sees the GPU is started again once; the restore still succeeds" {
  old_backup 20261020-030000
  printf 'FREEFRAME_GPU=nvidia\n' >>"$ENV"
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  export STUB_WORKER_SMI=fail
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "dc exec -T postgres pg_restore" "localhost:8000/health" "exec -T worker nvidia-smi -L" \
    "up -d --no-build --no-deps --force-recreate worker" "exec -T worker nvidia-smi -L"
  [ "$(grep -c '^dc up -d --no-build --no-deps --force-recreate worker$' "$CALLS")" -eq 1 ]
  assert_out "The database is back as it was"
  assert_out "The worker could not use the NVIDIA GPU, even after it was started again, so video is processed on the CPU for now."
}

@test "restore gpu worker: with the GPU off, the worker is not asked" {
  old_backup 20261020-030000
  export STUB_WORKER_SMI=fail
  ff restore --yes "$BK/freeframe-20261020-030000.dump"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called "nvidia-smi"
  assert_not_called "no-deps"
}
