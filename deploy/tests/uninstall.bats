#!/usr/bin/env bats
# `freeframe uninstall`: a final backup first, then FreeFrame's containers,
# its nightly backup, $FF_ROOT and the command, keeping the Docker volumes
# unless --delete-data. Side effects stubbed (uninstall_stubs.bash): Docker's
# objects are lines in files, $FF_ROOT_HOME stands in for /root.
#
# shellcheck disable=SC2154 # bats' run sets $output and $status

load manage_helpers

setup() {
  manage_setup
  STUBS="${BATS_TEST_DIRNAME}/uninstall_stubs.bash"
  installed_server sslip bundled 1.21.0
  export FF_ROOT_HOME="$BATS_TEST_TMPDIR/roothome"
  mkdir -p "$FF_ROOT_HOME"
  chmod 700 "$FF_ROOT_HOME"
  export FF_FSTAB="$BATS_TEST_TMPDIR/fstab"
  : >"$FF_FSTAB"
  # The nightly backup as install_backup_timer leaves it.
  cp "$FF_ROOT"/systemd/freeframe-backup.* "$FF_SYSTEMD_DIR/"
  mkdir -p "$FF_SYSTEMD_DIR/timers.target.wants"
  ln -s ../freeframe-backup.timer "$FF_SYSTEMD_DIR/timers.target.wants/freeframe-backup.timer"
  # Two nightly backups and the log.
  mkdir -p "$BK"
  chmod 700 "$BK"
  local s
  for s in 20261026-030000 20261027-030000; do
    printf 'PGDMP %s\n' "$s" >"$BK/freeframe-$s.dump"
    cp "$ENV" "$BK/freeframe-$s.env.prod"
  done
  chmod 600 "$BK"/*
  printf '===== freeframe install =====\n' >"$FF_ROOT/install.log"
  dk_server
}

# dk_server: the containers, volumes and network `freeframe install` makes,
# plus another project's volume and Docker's own network.
dk_server() {
  local d="$STUB_DIR/dk" s image
  mkdir -p "$d"
  : >"$d/containers"
  for s in traefik postgres redis api worker email_worker maintenance_worker beat web minio; do
    case $s in
      api | worker | email_worker | maintenance_worker | beat) image=ghcr.io/techiebutler/freeframe-api:1.21.0 ;;
      web) image=ghcr.io/techiebutler/freeframe-web:1.21.0 ;;
      *) image=$s:latest ;;
    esac
    printf 'id-%s|freeframe|%s|%s|%s\n' "$s" "$FF_ROOT" "$s" "$image" >>"$d/containers"
  done
  printf '%s\n' 'freeframe_pgdata|freeframe' 'freeframe_redisdata|freeframe' 'freeframe_letsencrypt|freeframe' \
    'freeframe_miniodata|freeframe' 'other_data|other' >"$d/volumes"
  printf '%s\n' 'net-ff|freeframe_default|freeframe' 'net-br|bridge|' >"$d/networks"
}

# saved_dir: the one folder an uninstall saved its files in.
saved_dir() {
  local d
  d=$(find "$FF_ROOT_HOME" -mindepth 1 -maxdepth 1 -name 'freeframe-removed-*' -type d)
  [[ -n $d && $(printf '%s\n' "$d" | wc -l) -eq 1 ]] || { echo "saved folders: '$d'"; return 1; }
  printf '%s' "$d"
}

# answers LINE...: what is typed at the terminal, one line per question.
answers() {
  printf '%s\n' "$@" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
}

# assert_nothing_changed: nothing removed, moved or stopped.
assert_nothing_changed() {
  [ -f "$ENV" ] || { echo "the settings file is gone"; return 1; }
  [ -f "$FF_ROOT/.installed" ]
  [ -x "$FF_BIN_DIR/freeframe" ]
  [ -f "$FF_SYSTEMD_DIR/freeframe-backup.timer" ]
  [ -f "$BK/freeframe-20261026-030000.dump" ]
  grep -q '^id-api|' "$STUB_DIR/dk/containers"
  grep -q '^freeframe_pgdata|' "$STUB_DIR/dk/volumes"
  assert_not_called "dc down"
  assert_not_called "systemctl disable"
  assert_not_called "docker rm"
  assert_not_called "docker volume rm"
  assert_not_called "rm -rf"
  [ -z "$(ls -A "$FF_ROOT_HOME")" ] || { echo "saved: $(ls -A "$FF_ROOT_HOME")"; return 1; }
}

# assert_removed: everything this installer set up is gone.
assert_removed() {
  [ ! -e "$FF_ROOT" ] || { echo "left in $FF_ROOT:"; ls -A "$FF_ROOT"; return 1; }
  [ ! -e "$FF_BIN_DIR/freeframe" ]
  [ ! -e "$FF_SYSTEMD_DIR/freeframe-backup.timer" ]
  [ ! -e "$FF_SYSTEMD_DIR/freeframe-backup.service" ]
  [ ! -L "$FF_SYSTEMD_DIR/timers.target.wants/freeframe-backup.timer" ]
  ! grep -q '|freeframe|' "$STUB_DIR/dk/containers"
  ! grep -q '|freeframe$' "$STUB_DIR/dk/networks"
}

# --- Refusals ------------------------------------------------------------

@test "uninstall: needs root, and changes nothing without it" {
  STUB_NOT_ROOT=1 ff uninstall --yes
  [ "$status" -eq 2 ]
  assert_out "Please run this as root."
  assert_out "sudo freeframe uninstall"
  assert_nothing_changed
}

@test "uninstall: with no FreeFrame from this installer there is nothing to remove, and nothing changes" {
  rm -f "$ENV" "$FF_ROOT/.installed"
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "there is nothing to remove"
  assert_out "Nothing was changed."
  assert_not_called "dc "
  assert_not_called "systemctl"
  assert_not_called "docker rm"
  assert_not_called "rm -rf"
  [ -x "$FF_BIN_DIR/freeframe" ]
  [ -f "$BK/freeframe-20261026-030000.dump" ]
  [ -z "$(ls -A "$FF_ROOT_HOME")" ]
  # The folder holds backups: it is never offered for deletion.
  assert_out "backups"
  assert_no_out "sudo rm -rf"
}

@test "uninstall: a FreeFrame set up by hand is refused and never touched" {
  printf '%s\n' "id-clone|freeframe|/home/me/freeframe|api|freeframe-api" >>"$STUB_DIR/dk/containers"
  ff uninstall --yes
  [ "$status" -eq 3 ] || { echo "$output"; false; }
  assert_out "set up by hand"
  assert_out "nothing was changed"
  assert_nothing_changed
  grep -q '^id-clone|' "$STUB_DIR/dk/containers"
}

@test "uninstall: a git checkout in the FreeFrame folder is refused" {
  mkdir "$FF_ROOT/.git"
  ff uninstall --yes
  [ "$status" -eq 3 ]
  assert_out "set up by hand"
  assert_nothing_changed
}

@test "uninstall: Docker not answering stops before changing anything" {
  STUB_DOCKER_DOWN=1 ff uninstall --yes
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "stopped before changing anything"
  assert_out "sudo systemctl start docker"
  assert_nothing_changed
}

@test "uninstall: does not start while another freeframe command runs, with the busy message" {
  command -v flock >/dev/null || skip "no flock"
  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  ff uninstall --yes
  exec 9>&-
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "Another freeframe command (an update, rollback, backup, restore, restart, configure or uninstall) is running right now, so the uninstall did not start. Nothing was changed."
  assert_not_called "pg_dump"
  assert_nothing_changed
}

@test "uninstall: other words and answers are refused" {
  ff uninstall now
  [ "$status" -eq 2 ]
  assert_out "freeframe uninstall takes no other words"
  ff uninstall --yes --domain review.example.com
  [ "$status" -eq 2 ]
  assert_out "--domain"
  assert_nothing_changed
}

@test "uninstall options belong to uninstall only" {
  local o
  for o in --dry-run --delete-data --confirm-delete-data --skip-backup; do
    ff status "$o"
    [ "$status" -eq 2 ] || { echo "$o: $output"; false; }
    assert_out "$o"
    assert_out "freeframe uninstall"
  done
  assert_not_called "probe_health"
}

@test "uninstall: --confirm-delete-data without --delete-data is a mistake, not a deletion" {
  ff uninstall --yes --confirm-delete-data
  [ "$status" -eq 2 ]
  assert_out "--confirm-delete-data"
  assert_out "--delete-data"
  assert_nothing_changed
}

# --- Confirmation --------------------------------------------------------

@test "uninstall: with no terminal and no --yes it refuses and names --yes" {
  ff uninstall
  [ "$status" -eq 2 ] || { echo "$output"; false; }
  assert_out "no terminal here to ask"
  assert_out "sudo freeframe uninstall --yes"
  assert_nothing_changed
}

@test "uninstall: explains what is removed and kept, and a wrong answer cancels" {
  answers "yes"
  ff uninstall
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "This removes FreeFrame from this server:"
  assert_out "It keeps:"
  assert_out "freeframe_pgdata"
  assert_out "the database"
  assert_out "freeframe_miniodata"
  assert_out "type its web address (203-0-113-7.sslip.io) or the word remove"
  assert_out "Uninstall cancelled. Nothing was changed."
  assert_nothing_changed
}

@test "uninstall: typing the web address goes ahead" {
  answers "203-0-113-7.sslip.io"
  ff uninstall
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  assert_removed
}

@test "uninstall: typing the full address, in capitals, goes ahead" {
  answers "HTTPS://203-0-113-7.SSLIP.IO/"
  ff uninstall
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_removed
}

@test "uninstall: typing remove goes ahead" {
  answers " remove "
  ff uninstall
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_removed
}

@test "uninstall: the answers ending cancels" {
  answers
  ff uninstall
  [ "$status" -eq 1 ]
  assert_out "Nothing was changed."
  assert_nothing_changed
}

# --- The run -------------------------------------------------------------

@test "uninstall --yes: final backup, everything moved to the saved folder, FreeFrame removed, volumes kept" {
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  assert_removed
  local d f final
  d=$(saved_dir)
  [[ ${d##*/} =~ ^freeframe-removed-[0-9]{8}-[0-9]{6}$ ]]
  [ "$(stat -c %a "$d" 2>/dev/null || stat -f %Lp "$d")" = 700 ]
  # The two earlier backups and the final one, with their settings copies.
  [ -f "$d/freeframe-20261026-030000.dump" ]
  [ -f "$d/freeframe-20261027-030000.env.prod" ]
  final=$(cd "$d" && ls freeframe-*.dump | grep -v -e 20261026-030000 -e 20261027-030000)
  [ -n "$final" ]
  grep -q '^PGDMP current database' "$d/$final"
  [ -f "$d/${final%.dump}.env.prod" ]
  # A copy of the settings and the log.
  [ -f "$d/.env.prod" ]
  [ -f "$d/install.log" ]
  grep -q '===== freeframe install =====' "$d/install.log"
  grep -q '===== freeframe uninstall' "$d/install.log"
  for f in "$d"/* "$d"/.env.prod; do
    [ "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" = 600 ] || { echo "$f is not 600"; false; }
  done
  # The settings copy is the settings, byte for byte.
  grep -q '^JWT_SECRET=' "$d/.env.prod"
  # Volumes kept, named, with the command that deletes them later.
  grep -q '^freeframe_pgdata|' "$STUB_DIR/dk/volumes"
  grep -q '^freeframe_miniodata|' "$STUB_DIR/dk/volumes"
  assert_not_called "docker volume rm"
  assert_not_called "--volumes"
  assert_out "FreeFrame has been removed from this server."
  assert_out "sudo docker volume rm freeframe_letsencrypt freeframe_miniodata freeframe_pgdata freeframe_redisdata"
  assert_no_out "other_data"
  # The way back.
  assert_out "sudo mkdir -p '$FF_ROOT'"
  assert_out "sudo install -m 600 '$d/.env.prod' '$FF_ROOT/.env.prod'"
  assert_out 'sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/latest/install.sh)"'
  assert_out "sudo freeframe restore '$d/$final'"
  # Left alone, with how to remove each.
  assert_out "sudo docker image prune -a"
  assert_out "sudo apt remove docker-ce"
  assert_not_called "docker image"
  assert_not_called "apt"
  assert_not_called "ufw"
}

@test "uninstall: the backup comes before any removal, and the command goes last" {
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "dc exec -T postgres pg_dump" "dc config -q" "dc down --remove-orphans" \
    "systemctl disable --now freeframe-backup.timer" "systemctl daemon-reload" \
    "rm -rf -- $FF_ROOT" "rm -f -- $FF_BIN_DIR/freeframe"
  # Nothing is removed before the backup is saved.
  local first_removal backup
  backup=$(grep -n 'pg_dump' "$CALLS" | head -1 | cut -d: -f1)
  first_removal=$(grep -n -E '^(dc down|systemctl disable|docker rm|docker volume rm|rm -rf)' "$CALLS" | head -1 | cut -d: -f1)
  ((backup < first_removal))
  # The command is the last thing removed.
  [ "$(grep -E '^(rm |dc down|docker rm|docker volume rm|docker network rm|systemctl)' "$CALLS" | tail -1)" = "rm -f -- $FF_BIN_DIR/freeframe" ]
}

@test "uninstall: a stopped database is started on its own for the final backup" {
  STUB_PG_STOPPED=1 ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  assert_order "dc up -d --no-build postgres" "dc exec -T postgres pg_dump" "dc down"
  assert_not_called "dc up -d --no-build --"
  assert_removed
}

@test "uninstall: a backup that fails stops everything, with nothing removed, and names --skip-backup" {
  STUB_PG_DOWN=1 FF_BACKUP_DB_WAIT=5 ff uninstall --yes
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "The final backup could not be made, so nothing was removed."
  assert_out "sudo freeframe uninstall --skip-backup"
  assert_nothing_changed
  [ -f "$FF_ROOT/install.log" ]
}

@test "uninstall: a backup that fails stops the database again when it was this run that started it" {
  STUB_PG_STOPPED=1 STUB_PG_DOWN=1 FF_BACKUP_DB_WAIT=5 ff uninstall --yes
  [ "$status" -eq 1 ]
  assert_order "dc up -d --no-build postgres" "dc stop postgres"
  assert_nothing_changed
}

@test "uninstall --skip-backup --yes: no final backup, the earlier ones still kept" {
  ff uninstall --yes --skip-backup
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called "pg_dump"
  assert_not_called "pg_isready"
  local d
  d=$(saved_dir)
  [ "$(cd "$d" && ls freeframe-*.dump)" = "$(printf '%s\n' freeframe-20261026-030000.dump freeframe-20261027-030000.dump)" ]
  [ -f "$d/.env.prod" ]
  assert_out "No final backup was made (--skip-backup)"
  assert_removed
}

@test "uninstall --skip-backup in a terminal asks for it again in words" {
  answers "remove" "yes"
  ff uninstall --skip-backup
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "type: no backup"
  assert_out "Uninstall cancelled. Nothing was changed."
  assert_nothing_changed
  answers "remove" "no backup"
  ff uninstall --skip-backup
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called "pg_dump"
  assert_removed
}

# --- Data ----------------------------------------------------------------

@test "uninstall --delete-data in a terminal needs delete typed as well" {
  answers "remove" "yes"
  ff uninstall --delete-data
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "type: delete"
  assert_out "Uninstall cancelled. Nothing was changed."
  assert_nothing_changed
  answers "remove" "delete"
  ff uninstall --delete-data
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  assert_removed
  ! grep -q '|freeframe$' "$STUB_DIR/dk/volumes"
  grep -q '^other_data|other$' "$STUB_DIR/dk/volumes"
  assert_order "dc exec -T postgres pg_dump" "dc down" "docker volume rm freeframe_letsencrypt" "rm -rf -- $FF_ROOT"
  assert_out "Deleted for good: the Docker volumes freeframe_letsencrypt, freeframe_miniodata, freeframe_pgdata and freeframe_redisdata"
  assert_no_out "sudo docker volume rm"
}

@test "uninstall --yes --delete-data still asks for delete on a terminal" {
  answers "no"
  ff uninstall --yes --delete-data
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "type: delete"
  assert_nothing_changed
}

@test "uninstall --yes --delete-data with no terminal refuses and names --confirm-delete-data" {
  ff uninstall --yes --delete-data
  [ "$status" -eq 2 ] || { echo "$output"; false; }
  assert_out "--confirm-delete-data"
  assert_nothing_changed
}

@test "uninstall --yes --delete-data --confirm-delete-data: unattended, deletes the volumes too" {
  ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_removed
  ! grep -q '|freeframe$' "$STUB_DIR/dk/volumes"
  # The final backup is still made first, and kept.
  local d
  d=$(saved_dir)
  [ "$(cd "$d" && ls freeframe-*.dump | wc -l | tr -d ' ')" = 3 ]
  assert_out "sudo freeframe restore '$d/"
}

@test "uninstall: volumes that cannot be deleted stop the run and say what is left" {
  STUB_VOLRM_FAIL=freeframe_miniodata ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "could not be deleted"
  local d
  d=$(saved_dir)
  assert_out "$d"
  # FreeFrame's folder and command are still here, so a second run can finish,
  # and the folder names where this run saved the backups.
  [ -f "$ENV" ]
  [ -x "$FF_BIN_DIR/freeframe" ]
  assert_has "$FF_ROOT/.uninstall-saved" "saved=$d"
  [ "$(stat -c %a "$FF_ROOT/.uninstall-saved" 2>/dev/null || stat -f %Lp "$FF_ROOT/.uninstall-saved")" = 600 ]
}

@test "uninstall rerun after --delete-data stopped part-way: no new backup of a database made afresh, the first folder reused" {
  STUB_VOLRM_FAIL=freeframe_miniodata ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  local d final
  d=$(saved_dir)
  final=$(sed -n 's/^final=//p' "$FF_ROOT/.uninstall-saved")
  [ -f "$d/$final" ]
  ! grep -q '^freeframe_pgdata|' "$STUB_DIR/dk/volumes"
  : >"$CALLS"
  ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  # The database was not started again (that would make an empty one) and
  # nothing was backed up: the real final backup is the first run's.
  assert_not_called "dc up"
  assert_not_called "pg_dump"
  ! grep -q '|freeframe$' "$STUB_DIR/dk/volumes"
  [ "$(saved_dir)" = "$d" ]
  assert_out "An earlier freeframe uninstall stopped part-way"
  assert_out "$d"
  assert_out "sudo freeframe restore '$d/$final'"
  assert_removed
}

@test "uninstall rerun: the dry run names the folder and the final backup the earlier run made" {
  STUB_VOLRM_FAIL=freeframe_miniodata ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 1 ]
  local d final
  d=$(saved_dir)
  final=$(sed -n 's/^final=//p' "$FF_ROOT/.uninstall-saved")
  ff uninstall --dry-run --delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "An earlier freeframe uninstall stopped part-way"
  assert_out "in $d"
  assert_out "$final"
  assert_no_out "made before anything is removed"
  assert_no_out "freeframe-removed-<date>"
}

@test "uninstall rerun: a failure says what the earlier run removed, never that nothing was" {
  STUB_VOLRM_FAIL=freeframe_miniodata ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 1 ]
  STUB_DOWN_FAIL=1 ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "could not all be removed"
  assert_out "An earlier uninstall already removed part of FreeFrame"
  assert_no_out "othing was removed"
  assert_no_out "othing has been removed"
}

@test "uninstall rerun: when the earlier run's folder is gone, it says so and makes no backup" {
  STUB_VOLRM_FAIL=freeframe_miniodata ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 1 ]
  local d
  d=$(saved_dir)
  rm -rf "$d"
  : >"$CALLS"
  ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "$d"
  assert_out "is no longer there"
  assert_not_called "pg_dump"
  assert_not_called "dc up"
  assert_removed
  [ -f "$(saved_dir)/.env.prod" ]
}

# new_final DIR NAME...: the one dump in DIR that is none of NAMEs (and not a
# backup from setup).
new_final() {
  local d=$1 f n out=""
  shift
  for f in "$d"/freeframe-*.dump; do
    n=${f##*/}
    case " $* freeframe-20261026-030000.dump freeframe-20261027-030000.dump " in
      *" $n "*) ;;
      *) out+="$n " ;;
    esac
  done
  out=${out% }
  [[ -n $out && $out != *" "* ]] || { echo "new dumps in $d: '$out'"; return 1; }
  printf '%s' "$out"
}

# plant_marker: an uninstall's marker naming a real saved folder.
plant_marker() {
  local d="$FF_ROOT_HOME/freeframe-removed-20261020-101010"
  mkdir -p -m 700 "$d"
  printf 'saved=%s\nfinal=\n' "$d" >"$FF_ROOT/.uninstall-saved"
  chmod 600 "$FF_ROOT/.uninstall-saved"
}

@test "uninstall rerun after a stop at dc down: the database is still there, so it is backed up, and the restore line names that backup" {
  STUB_DOWN_FAIL=1 ff uninstall --yes
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  local d first new
  d=$(saved_dir)
  first=$(sed -n 's/^final=//p' "$FF_ROOT/.uninstall-saved")
  [ -f "$d/$first" ]
  # A nightly backup ran in between.
  printf 'PGDMP nightly\n' >"$BK/freeframe-20261028-030000.dump"
  cp "$ENV" "$BK/freeframe-20261028-030000.env.prod"
  : >"$CALLS"
  ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  grep -q 'pg_dump' "$CALLS"
  [ "$(saved_dir)" = "$d" ]
  new=$(new_final "$d" "$first" freeframe-20261028-030000.dump)
  assert_out "sudo freeframe restore '$d/$new'"
  [ -f "$d/$first" ]
  [ -f "$d/freeframe-20261028-030000.dump" ]
  assert_order "pg_dump" "docker volume rm"
  assert_out "a final backup of the database, made before anything is removed"
  assert_removed
}

@test "uninstall rerun with the saved folder deleted and the database still there: a new folder and a new final backup" {
  STUB_DOWN_FAIL=1 ff uninstall --yes
  [ "$status" -eq 1 ]
  local d nd new
  d=$(saved_dir)
  rm -rf "$d"
  : >"$CALLS"
  ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "is no longer there"
  grep -q 'pg_dump' "$CALLS"
  nd=$(saved_dir)
  # A fresh folder: the backups that went with the deleted one are not in it.
  [ ! -e "$nd/freeframe-20261026-030000.dump" ]
  new=$(new_final "$nd")
  assert_out "sudo freeframe restore '$nd/$new'"
  assert_removed
}

@test "uninstall rerun after a first run with --skip-backup: the database is backed up now" {
  STUB_DOWN_FAIL=1 ff uninstall --yes --skip-backup
  [ "$status" -eq 1 ]
  grep -qx 'final=' "$FF_ROOT/.uninstall-saved"
  local d new
  d=$(saved_dir)
  : >"$CALLS"
  ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -q 'pg_dump' "$CALLS"
  new=$(new_final "$d")
  assert_out "sudo freeframe restore '$d/$new'"
}

@test "uninstall rerun with --skip-backup --delete-data: the question says no final backup exists and names the newest backup" {
  STUB_DOWN_FAIL=1 ff uninstall --yes --skip-backup
  [ "$status" -eq 1 ]
  answers "remove" "no backup" "delete"
  ff uninstall --skip-backup --delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called "pg_dump"
  assert_out "the newest copy of the database is the backup freeframe-20261027-030000.dump"
  assert_out "the earlier uninstall made no final backup"
  assert_no_out "is then the only copy"
  assert_out "sudo freeframe restore '$(saved_dir)/freeframe-20261027-030000.dump'"
}

@test "uninstall rerun: a final backup that was deleted is said to be gone, not never made" {
  STUB_VOLRM_FAIL=freeframe_miniodata ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 1 ]
  local d final
  d=$(saved_dir)
  final=$(sed -n 's/^final=//p' "$FF_ROOT/.uninstall-saved")
  rm -f "$d/$final"
  ff uninstall --dry-run --delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "($final) is no longer there"
  assert_no_out "made none"
  assert_no_out "made no final backup"
}

@test "uninstall rerun: a marker naming /etc is not trusted: nothing is moved into it or changed in it" {
  STUB_DOWN_FAIL=1 ff uninstall --yes
  [ "$status" -eq 1 ]
  local mode
  mode=$(stat -c %a /etc/passwd 2>/dev/null || stat -f %Lp /etc/passwd)
  printf 'saved=/etc\nfinal=passwd\n' >"$FF_ROOT/.uninstall-saved"
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ "$(stat -c %a /etc/passwd 2>/dev/null || stat -f %Lp /etc/passwd)" = "$mode" ]
  [ ! -e /etc/.env.prod ]
  [ -z "$(find /etc -maxdepth 1 -name 'freeframe-*' 2>/dev/null)" ]
  assert_no_out "settings in /etc"
  assert_no_out "Kept in /etc"
  assert_no_out "'/etc/"
  [ "$(find "$FF_ROOT_HOME" -mindepth 1 -maxdepth 1 -name 'freeframe-removed-*' | wc -l | tr -d ' ')" = 2 ]
}

@test "uninstall rerun: a marker naming a folder inside the FreeFrame folder is not trusted" {
  STUB_DOWN_FAIL=1 ff uninstall --yes
  [ "$status" -eq 1 ]
  local planted="$FF_ROOT/freeframe-removed-20261028-000000"
  mkdir -p "$planted"
  printf 'saved=%s\nfinal=\n' "$planted" >"$FF_ROOT/.uninstall-saved"
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_no_out "in $planted"
  assert_no_out "restore '$planted"
  [ "$(find "$FF_ROOT_HOME" -mindepth 1 -maxdepth 1 -name 'freeframe-removed-*' | wc -l | tr -d ' ')" = 2 ]
  assert_removed
}

@test "uninstall: with nothing installed, a folder it may not remove is never offered to rm -rf" {
  rm -f "$ENV" "$FF_ROOT/.installed"
  rm -rf "$BK"
  # Nothing of FreeFrame's in Docker, so only the path itself can stop the hint.
  : >"$STUB_DIR/dk/containers"
  : >"$STUB_DIR/dk/volumes"
  ff uninstall --yes
  assert_out "sudo rm -rf '$FF_ROOT'"
  FF_ROOT="$FF_ROOT/." ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_no_out "rm -rf '$FF_ROOT/.'"
}

# setup_gone_rerun: a first run with --skip-backup stops at dc down; then the
# compose file goes missing while the database's volume stays.
setup_gone_rerun() {
  STUB_DOWN_FAIL=1 ff uninstall --yes --skip-backup
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  rm -f "$FF_ROOT/docker-compose.prod.yml"
  grep -q '^freeframe_pgdata|' "$STUB_DIR/dk/volumes"
  : >"$CALLS"
}

# assert_nothing_more_removed: a re-run that stopped removed nothing more.
assert_nothing_more_removed() {
  grep -q '^freeframe_pgdata|' "$STUB_DIR/dk/volumes" || { echo "pgdata deleted"; return 1; }
  [ -f "$ENV" ]
  [ -x "$FF_BIN_DIR/freeframe" ]
  [ -f "$FF_SYSTEMD_DIR/freeframe-backup.timer" ]
  assert_not_called "pg_dump"
  assert_not_called "dc down"
  assert_not_called "docker rm"
  assert_not_called "docker volume rm"
  assert_not_called "rm -rf"
}

@test "uninstall rerun: setup files gone with the database's volume still there stops with --delete-data, removing nothing more" {
  setup_gone_rerun
  ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "The setup files in $FF_ROOT are gone, so FreeFrame's database cannot be backed up"
  assert_out "freeframe_pgdata"
  assert_out "is still there"
  # With --delete-data, the hint says plainly what --skip-backup then does.
  assert_out "sudo freeframe uninstall --skip-backup --delete-data"
  assert_out "deletes the database's volume too, with no final backup of it"
  assert_no_out "stays in its volume unless --delete-data"
  assert_no_out "took the database away"
  assert_no_out "already deleted"
  # Stopped up front: no plan, and no try at starting the database.
  assert_no_out "This removes FreeFrame from this server:"
  assert_not_called "dc up"
  assert_nothing_more_removed
}

@test "uninstall rerun: setup files gone with the database's volume still there stops without --delete-data too" {
  setup_gone_rerun
  ff uninstall --yes
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "cannot be backed up"
  assert_out "the database stays in its volume unless --delete-data is given too"
  assert_no_out "This removes FreeFrame from this server:"
  assert_not_called "dc up"
  assert_nothing_more_removed
}

@test "uninstall rerun: setup files gone, --skip-backup on this run goes on, after no backup is typed" {
  setup_gone_rerun
  answers "remove" "nope"
  ff uninstall --skip-backup --delete-data
  [ "$status" -eq 1 ]
  assert_out "type: no backup"
  assert_nothing_more_removed
  answers "remove" "no backup" "delete"
  ff uninstall --skip-backup --delete-data
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  assert_not_called "pg_dump"
  ! grep -q '|freeframe$' "$STUB_DIR/dk/volumes"
  assert_no_out "took the database away"
  assert_removed
}

@test "uninstall rerun --dry-run: setup files gone with the volume still there says the real run would stop" {
  setup_gone_rerun
  ff uninstall --dry-run --delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "cannot be backed up"
  assert_out "So the uninstall stops before removing anything more, unless --skip-backup is given."
  # The plan and the closing command agree with what the real run does.
  assert_out "no final backup can be made: the setup files that start the database are gone"
  assert_no_out "if the database still has data"
  assert_out "To remove FreeFrame without a final backup, run: sudo freeframe uninstall --delete-data --skip-backup"
  assert_no_out "To remove FreeFrame, run: sudo freeframe uninstall --delete-data"
  assert_no_out "took the database away"
  assert_no_out "already deleted"
  assert_nothing_more_removed
}

@test "uninstall rerun --skip-backup with a newer backup than the earlier final: the question and the restore line name the newest" {
  STUB_DOWN_FAIL=1 ff uninstall --yes
  [ "$status" -eq 1 ]
  local d
  d=$(saved_dir)
  printf 'PGDMP nightly\n' >"$BK/freeframe-20991028-030000.dump"
  cp "$ENV" "$BK/freeframe-20991028-030000.env.prod"
  answers "remove" "no backup" "delete"
  ff uninstall --skip-backup --delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "the newest copy of the database is the backup freeframe-20991028-030000.dump"
  assert_no_out "is then the only copy"
  assert_out "sudo freeframe restore '$d/freeframe-20991028-030000.dump'"
}

@test "uninstall rerun --skip-backup with the earlier final as the only backup: only then is it called the only copy" {
  STUB_DOWN_FAIL=1 ff uninstall --yes
  [ "$status" -eq 1 ]
  local d final
  d=$(saved_dir)
  final=$(sed -n 's/^final=//p' "$FF_ROOT/.uninstall-saved")
  rm -f "$d"/freeframe-2026102[67]-030000.*
  answers "remove" "no backup" "delete"
  ff uninstall --skip-backup --delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "the final backup the earlier uninstall made ($final) is then the only copy of the database"
  assert_out "sudo freeframe restore '$d/$final'"
}

@test "uninstall rerun: an empty database goes on without a backup, and says so" {
  STUB_DOWN_FAIL=1 ff uninstall --yes
  [ "$status" -eq 1 ]
  : >"$CALLS"
  STUB_DB_EMPTY=1 ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "FreeFrame's database is empty (it has no tables), so no final backup was made of it; this run goes on without one."
  assert_not_called "pg_dump"
  assert_removed
}

@test "uninstall: a first run with a setup file missing stops and changes nothing" {
  rm -f "$FF_ROOT/docker-compose.prod.yml"
  ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "cannot be backed up"
  assert_out "nothing was removed"
  assert_not_called "dc up"
  assert_nothing_changed
}

@test "uninstall rerun: only docker-compose.images.yml missing also stops" {
  STUB_DOWN_FAIL=1 ff uninstall --yes --skip-backup
  [ "$status" -eq 1 ]
  rm -f "$FF_ROOT/docker-compose.images.yml"
  : >"$CALLS"
  ff uninstall --yes --delete-data --confirm-delete-data
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "cannot be backed up"
  assert_nothing_more_removed
}

@test "uninstall --skip-backup --delete-data with only a rollback's copy: the question and the summary name the same dump" {
  rm -f "$BK"/freeframe-*
  printf 'PGDMP x\n' >"$BK/freeframe-20261027-030000-before-rollback.dump"
  answers "remove" "no backup" "delete"
  ff uninstall --skip-backup --delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_no_out "exists at all"
  assert_out "is then the only copy of the database"
  assert_out "freeframe-20261027-030000-before-rollback.dump"
  assert_out "sudo freeframe restore '$(saved_dir)/freeframe-20261027-030000-before-rollback.dump'"
}

@test "uninstall: a backup named by hand is never taken for the newest" {
  printf 'PGDMP hand\n' >"$BK/freeframe-copy.dump"
  answers "remove" "no backup" "delete"
  ff uninstall --skip-backup --delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "the newest copy of the database is the backup freeframe-20261027-030000.dump"
  assert_out "sudo freeframe restore '$(saved_dir)/freeframe-20261027-030000.dump'"
  assert_no_out "restore '$(saved_dir)/freeframe-copy.dump'"
  # status and restore pick the newest the same way.
  mkdir -p "$BATS_TEST_TMPDIR/bk"
  printf 'PGDMP\n' >"$BATS_TEST_TMPDIR/bk/freeframe-20261027-030000.dump"
  printf 'PGDMP\n' >"$BATS_TEST_TMPDIR/bk/freeframe-copy.dump"
  printf 'PGDMP\n' >"$BATS_TEST_TMPDIR/bk/freeframe-20991231-030000-before-rollback.dump"
  run bash -c 'source "$1"; _ff_backup_newest "$2"' x "$FF_SCRIPT" "$BATS_TEST_TMPDIR/bk"
  assert_eq "$output" "$BATS_TEST_TMPDIR/bk/freeframe-20261027-030000.dump"
}

@test "uninstall rerun: the same final backup in two places is still one copy" {
  STUB_DOWN_FAIL=1 ff uninstall --yes
  [ "$status" -eq 1 ]
  local d final
  d=$(saved_dir)
  final=$(sed -n 's/^final=//p' "$FF_ROOT/.uninstall-saved")
  rm -f "$d"/freeframe-2026102[67]-030000.*
  cp "$d/$final" "$BK/$final"
  answers "remove" "no backup" "delete"
  ff uninstall --skip-backup --delete-data
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "($final) is then the only copy of the database"
}

@test "a start that fails keeps an unfinished uninstall's marker" {
  plant_marker
  STUB_UP_FAIL=1 ff restart
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  [ -f "$FF_ROOT/.uninstall-saved" ]
  assert_no_out "is cancelled"
}

@test "restore's restart after an early failure cancels an unfinished uninstall's marker" {
  plant_marker
  STUB_MAINT_FAIL=1 ff restore --yes "$BK/freeframe-20261026-030000.dump"
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "FreeFrame has been started again."
  [ ! -e "$FF_ROOT/.uninstall-saved" ]
  assert_out "An earlier freeframe uninstall that did not finish is cancelled"
}

@test "restart cancels an unfinished uninstall's marker, and says so" {
  plant_marker
  ff restart
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ ! -e "$FF_ROOT/.uninstall-saved" ]
  assert_out "An earlier freeframe uninstall that did not finish is cancelled"
}

@test "restore cancels an unfinished uninstall's marker" {
  plant_marker
  ff restore --yes "$BK/freeframe-20261026-030000.dump"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ ! -e "$FF_ROOT/.uninstall-saved" ]
  assert_out "An earlier freeframe uninstall that did not finish is cancelled"
}

@test "update cancels an unfinished uninstall's marker" {
  plant_marker
  remote_release 1.22.0
  ff update
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ ! -e "$FF_ROOT/.uninstall-saved" ]
  assert_out "An earlier freeframe uninstall that did not finish is cancelled"
}

@test "configure cancels an unfinished uninstall's marker" {
  plant_marker
  ff configure --yes --domain review.yourstudio.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ ! -e "$FF_ROOT/.uninstall-saved" ]
  assert_out "An earlier freeframe uninstall that did not finish is cancelled"
}

@test "rollback cancels an unfinished uninstall's marker" {
  remote_release 1.22.0
  STUB_API_DOWN=1 FF_API_WAIT=10 ff update
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  plant_marker
  ff rollback --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ ! -e "$FF_ROOT/.uninstall-saved" ]
  assert_out "An earlier freeframe uninstall that did not finish is cancelled"
}

@test "uninstall: an empty database is never saved as the final backup" {
  STUB_DB_EMPTY=1 ff uninstall --yes
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "FreeFrame's database is empty"
  assert_out "nothing was removed"
  assert_out "sudo freeframe uninstall --skip-backup"
  assert_not_called "pg_dump"
  assert_nothing_changed
}

@test "uninstall: dc down is bounded in time and never told to remove volumes" {
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qE '^dc_bounded [0-9]+ down --remove-orphans$' "$CALLS" || { cat "$CALLS"; false; }
  [ "$(grep '^dc down' "$CALLS")" = "dc down --remove-orphans" ]
}

@test "uninstall: the lock file goes only once the lock is let go" {
  command -v flock >/dev/null || skip "no flock"
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -q '^rm-lock: free$' "$CALLS" || { cat "$CALLS"; false; }
  ! grep -q '^rm-lock: held$' "$CALLS"
}

@test "uninstall: never removes /, /., // or a folder that is its own parent" {
  local p
  for p in / /. // "$FF_ROOT/."; do
    : >"$CALLS"
    run bash -c 'set -Eeuo pipefail; source "$1"; source "$2"; rm() { _stub_log "rm $*"; }; FF_LOG=/dev/null; _uninstall_root "$3"' \
      ff-run "$FF_SCRIPT" "$STUBS" "$p"
    [ "$status" -eq 1 ] || { echo "$p: $output"; false; }
    assert_not_called "rm "
  done
}

@test "uninstall: a saved folder inside the FreeFrame folder is refused before anything changes" {
  FF_ROOT_HOME="$FF_ROOT/keep" ff uninstall --yes
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "inside"
  assert_nothing_changed
  [ ! -e "$FF_ROOT/keep" ]
  FF_ROOT_HOME="$FF_ROOT" ff uninstall --dry-run
  [ "$status" -eq 1 ]
}

@test "uninstall: --confirm-delete-data without --yes is refused, so delete is always typed in a terminal" {
  answers "remove" "delete"
  ff uninstall --delete-data --confirm-delete-data
  [ "$status" -eq 2 ] || { echo "$output"; false; }
  assert_out "--confirm-delete-data"
  assert_out "--yes"
  assert_nothing_changed
}

@test "uninstall: without a timer the summary does not claim to have removed one" {
  rm -f "$FF_SYSTEMD_DIR"/freeframe-backup.* "$FF_SYSTEMD_DIR/timers.target.wants/freeframe-backup.timer"
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Removed: its containers and network, $FF_ROOT and the freeframe command."
  assert_no_out "the nightly backup,"
}

# --- Fallbacks and leftovers ---------------------------------------------

@test "uninstall: setup files that do not parse fall back to removing by project label" {
  STUB_CONFIG_FAIL=1 ff uninstall --yes --skip-backup
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  assert_not_called "dc down"
  grep -q "^docker rm -f id-traefik id-postgres" "$CALLS"
  grep -q "^docker network rm net-ff$" "$CALLS"
  assert_removed
}

@test "uninstall: an unfinished install (settings, no .installed) is removed too" {
  rm -f "$FF_ROOT/.installed"
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_removed
}

@test "uninstall: running it twice, the second run says there is nothing to remove" {
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  : >"$CALLS"
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "there is nothing to remove"
  assert_not_called "dc "
  assert_not_called "rm -"
  # The data the first run kept is pointed at, not touched.
  assert_out "$(saved_dir)"
  grep -q '^freeframe_pgdata|' "$STUB_DIR/dk/volumes"
}

@test "uninstall: with nothing installed, a command or folder left by an install that stopped early is named" {
  rm -f "$ENV" "$FF_ROOT/.installed"
  rm -rf "$BK"
  ff uninstall --yes
  [ "$status" -eq 0 ]
  assert_out "$FF_BIN_DIR/freeframe"
  assert_out "sudo rm -rf '$FF_ROOT' '$FF_BIN_DIR/freeframe'"
  [ -x "$FF_BIN_DIR/freeframe" ]
}

@test "uninstall: with nothing installed, a hand-made clone in the folder is never offered for deletion" {
  rm -f "$ENV" "$FF_ROOT/.installed"
  rm -rf "$BK"
  mkdir "$FF_ROOT/.git"
  ff uninstall --yes
  [ "$status" -eq 0 ]
  assert_no_out "sudo rm -rf"
  rm -rf "$FF_ROOT/.git"
  printf '%s\n' "id-clone|freeframe|/home/me/freeframe|api|freeframe-api" >>"$STUB_DIR/dk/containers"
  ff uninstall --yes
  [ "$status" -eq 0 ]
  assert_no_out "sudo rm -rf"
}

@test "uninstall: a timer that is already gone is not an error" {
  rm -f "$FF_SYSTEMD_DIR"/freeframe-backup.* "$FF_SYSTEMD_DIR/timers.target.wants/freeframe-backup.timer"
  : >"$CALLS"
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called "systemctl disable"
  assert_removed
}

@test "uninstall: stopped while removing the folder, the settings file is still there and a second run finishes" {
  # The compose files are gone after the first run; only systemd/ is left.
  STUB_RM_FAIL="$FF_ROOT/systemd" ff uninstall --yes
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "could not be removed completely"
  [ -f "$ENV" ]
  [ ! -e "$FF_ROOT/docker-compose.prod.yml" ]
  [ -x "$FF_BIN_DIR/freeframe" ]
  local d final
  d=$(saved_dir)
  final=$(sed -n 's/^final=//p' "$FF_ROOT/.uninstall-saved")
  # The database's volume is still there but cannot be backed up now: the
  # re-run stops, and says the earlier final backup is safe.
  : >"$CALLS"
  ff uninstall --yes
  [ "$status" -eq 1 ] || { echo "$output"; false; }
  assert_out "cannot be backed up"
  assert_out "$final"
  assert_not_called "pg_dump"
  assert_not_called "dc down"
  # --skip-backup on this run goes on.
  : >"$CALLS"
  ff uninstall --yes --skip-backup
  [ "$status" -eq 0 ] || { echo "$output"; cat "$CALLS"; false; }
  assert_not_called "pg_dump"
  assert_no_out "othing was removed"
  assert_out "An earlier freeframe uninstall stopped part-way"
  [ "$(saved_dir)" = "$d" ]
  assert_out "sudo freeframe restore '$d/$final'"
  assert_removed
}

# --- Unfinished records --------------------------------------------------

@test "uninstall: an unfinished restore is warned about, says what is lost, and the uninstall still runs" {
  printf '%s\n' "$BK/freeframe-20261026-030000.dump" >"$FF_ROOT/.restore-undo"
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "A restore of the database did not finish"
  assert_out "may be empty"
  assert_out "freeframe-20261026-030000.dump"
  [ -f "$(saved_dir)/freeframe-20261026-030000.dump" ]
  assert_removed
}

@test "uninstall: an unfinished update is warned about: the way back is lost, its backup is kept" {
  mkdir -p "$FF_ROOT/rollback"
  printf 'version=1.20.0\nbackup=%s\ntime=2026-10-27 10:00:00 +0000\nphase=started\n' \
    "$BK/freeframe-20261027-030000.dump" >"$FF_ROOT/.update-undo"
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "An update did not finish"
  assert_out "sudo freeframe rollback"
  assert_out "1.20.0"
  assert_out "freeframe-20261027-030000.dump"
  [ -f "$(saved_dir)/freeframe-20261027-030000.dump" ]
  assert_removed
}

# --- Dry run -------------------------------------------------------------

@test "uninstall --dry-run: says what would be removed and kept, and changes nothing" {
  local before after
  before=$(cd "$FF_ROOT" && find . -print0 | LC_ALL=C sort -z | xargs -0 ls -ld 2>/dev/null | awk '{ print $1, $5, $NF }')
  cp "$STUB_DIR/dk/containers" "$BATS_TEST_TMPDIR/c.before"
  cp "$STUB_DIR/dk/volumes" "$BATS_TEST_TMPDIR/v.before"
  ff uninstall --dry-run
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Dry run: nothing was changed."
  assert_out "This removes FreeFrame from this server:"
  assert_out "10 containers"
  assert_out "freeframe-backup.timer"
  assert_out "$FF_ROOT"
  assert_out "$FF_BIN_DIR/freeframe"
  assert_out "a final backup of the database"
  assert_out "2 backups"
  assert_out "freeframe_pgdata"
  assert_out "freeframe_miniodata"
  assert_out "To remove FreeFrame, run: sudo freeframe uninstall"
  after=$(cd "$FF_ROOT" && find . -print0 | LC_ALL=C sort -z | xargs -0 ls -ld 2>/dev/null | awk '{ print $1, $5, $NF }')
  assert_eq "$after" "$before"
  cmp "$STUB_DIR/dk/containers" "$BATS_TEST_TMPDIR/c.before"
  cmp "$STUB_DIR/dk/volumes" "$BATS_TEST_TMPDIR/v.before"
  assert_not_called "pg_dump"
  assert_not_called "dc up"
  assert_nothing_changed
  # It does not take the lock: install.log is not even opened.
  [ "$(cat "$FF_ROOT/install.log")" = "===== freeframe install =====" ]
}

@test "uninstall --dry-run does not need the lock, and says when another command is running" {
  command -v flock >/dev/null || skip "no flock"
  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  ff uninstall --dry-run
  exec 9>&-
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "This removes FreeFrame from this server:"
  assert_out "Another freeframe command"
  assert_nothing_changed
}

@test "uninstall --dry-run --delete-data --skip-backup: the volumes are listed as deleted, and no final backup" {
  ff uninstall --dry-run --delete-data --skip-backup
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "deleted for good"
  assert_out "no final backup"
  assert_out "To remove FreeFrame, run: sudo freeframe uninstall --delete-data --skip-backup"
  assert_nothing_changed
}

@test "uninstall --dry-run: footage in an S3 bucket is said to be untouched" {
  rm -rf "$FF_ROOT" "$BATS_TEST_TMPDIR/bin-dir"
  mkdir -p "$FF_ROOT"
  installed_server sslip s3 1.21.0
  ff uninstall --dry-run
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "the S3 bucket media"
}

@test "uninstall --dry-run on a server with nothing installed says so" {
  rm -f "$ENV" "$FF_ROOT/.installed"
  ff uninstall --dry-run
  [ "$status" -eq 0 ]
  assert_out "there is nothing to remove"
}

@test "uninstall --dry-run of a FreeFrame set up by hand says it would refuse" {
  printf '%s\n' "id-clone|freeframe|/home/me/freeframe|api|freeframe-api" >>"$STUB_DIR/dk/containers"
  ff uninstall --dry-run
  [ "$status" -eq 3 ]
  assert_out "set up by hand"
  assert_nothing_changed
}

# --- Words ---------------------------------------------------------------

@test "uninstall: no secret is ever printed" {
  local k v secrets=()
  for k in $SECRET_KEYS; do
    v=$(env_get "$ENV" "$k")
    [[ -z $v ]] || secrets+=("$v")
  done
  ((${#secrets[@]} >= 4))
  ff uninstall --dry-run
  for v in "${secrets[@]}"; do assert_no_out "$v"; done
  answers "nope"
  ff uninstall
  for v in "${secrets[@]}"; do assert_no_out "$v"; done
  ff uninstall --yes
  [ "$status" -eq 0 ]
  for v in "${secrets[@]}"; do assert_no_out "$v"; done
}

@test "uninstall: what is left alone is named with how to remove it, the optional parts only when present" {
  ff uninstall --dry-run
  assert_out "sudo docker image prune -a"
  assert_no_out "nvidia-container-toolkit"
  assert_no_out "/swapfile"
  assert_no_out "ufw delete"
  printf '/swapfile none swap sw 0 0\n' >"$FF_FSTAB"
  STUB_UFW=1 STUB_TOOLKIT=1 ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "sudo apt remove nvidia-container-toolkit"
  assert_out "sudo swapoff /swapfile"
  assert_out "sudo ufw delete allow 80/tcp"
  assert_not_called "ufw"
  assert_not_called "swapoff"
}

@test "help lists uninstall and its options" {
  ff help
  [ "$status" -eq 0 ]
  assert_out "uninstall"
  assert_out "--dry-run"
  assert_out "--skip-backup"
  assert_out "--delete-data"
  assert_out "--confirm-delete-data"
}

@test "the nightly backup behind an uninstall is skipped, not failed" {
  command -v flock >/dev/null || skip "no flock"
  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  printf 'uninstall %s\n' "$$" >"$FF_ROOT/.freeframe.lock"
  ff backup --quiet
  exec 9>&-
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "The nightly backup was skipped: a freeframe uninstall is running right now."
}

# --- The way back --------------------------------------------------------

@test "after an uninstall that kept the data, the installer points at the saved settings" {
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  local d
  d=$(saved_dir)
  printf 'ID=ubuntu\nVERSION_ID=24.04\nPRETTY_NAME="Ubuntu 24.04"\n' >"$BATS_TEST_TMPDIR/os-release"
  FF_OS_RELEASE="$BATS_TEST_TMPDIR/os-release" ff install --yes --admin-email you@example.com
  [ "$status" -eq 3 ] || { echo "$output"; false; }
  assert_out "sudo install -m 600 '$d/.env.prod' '$FF_ROOT/.env.prod'"
}

@test "after an uninstall, a git checkout or a clone's container still gets the set-up-by-hand refusal" {
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  printf 'ID=ubuntu\nVERSION_ID=24.04\nPRETTY_NAME="Ubuntu 24.04"\n' >"$BATS_TEST_TMPDIR/os-release"
  mkdir -p "$FF_ROOT/.git"
  FF_OS_RELEASE="$BATS_TEST_TMPDIR/os-release" ff install --yes --admin-email you@example.com
  [ "$status" -eq 3 ] || { echo "$output"; false; }
  assert_out "set up by hand, not with this installer"
  assert_no_out "sudo install -m 600"
  rm -rf "$FF_ROOT"
  printf '%s\n' "id-clone|freeframe|/home/me/freeframe|api|freeframe-api" >>"$STUB_DIR/dk/containers"
  FF_OS_RELEASE="$BATS_TEST_TMPDIR/os-release" ff install --yes --admin-email you@example.com
  [ "$status" -eq 3 ] || { echo "$output"; false; }
  assert_out "set up by hand, not with this installer"
  assert_no_out "sudo install -m 600"
}

@test "after an uninstall, the saved settings put back make the kept volumes this installer's again" {
  ff uninstall --yes
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  mkdir -p "$FF_ROOT"
  install -m 600 "$(saved_dir)/.env.prod" "$FF_ROOT/.env.prod"
  run bash -c 'source "$1"; source "$2"; rc=0; detect_foreign_install || rc=$?; echo "rc=$rc"' \
    ff-run "$FF_SCRIPT" "$STUBS"
  assert_out "rc=1"
}
