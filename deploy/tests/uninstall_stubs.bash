# Stubs for `freeframe uninstall` (uninstall.bats), sourced after the script
# in a fresh bash. On top of manage_stubs.bash: Docker's containers, volumes
# and networks are lines in files under $STUB_DIR/dk, so a test can see what
# was removed, and every rm is logged to $CALLS, so a test can see the order
# of the removals. Nothing here reaches Docker, PostgreSQL or systemd.
#
# $STUB_DIR/dk/containers  ID|PROJECT|WORKING_DIR|SERVICE|IMAGE
# $STUB_DIR/dk/volumes     NAME|PROJECT
# $STUB_DIR/dk/networks    ID|NAME|PROJECT

# shellcheck source-path=SCRIPTDIR source=manage_stubs.bash
source "$(dirname "${BASH_SOURCE[0]}")/manage_stubs.bash"

_dk() { printf '%s/dk/%s' "$STUB_DIR" "$1"; }

# _dk_drop FILE FIELD VALUE...: remove the lines whose FIELD is one of VALUEs.
_dk_drop() {
  local file=$1 field=$2 v
  shift 2
  for v in "$@"; do
    awk -F'|' -v f="$field" -v v="$v" '$f != v' "$file" >"$file.tmp"
    command mv -f "$file.tmp" "$file"
  done
}

docker() {
  _stub_log "docker $*"
  if [[ -n ${STUB_DOCKER_DOWN:-} ]]; then
    echo "Cannot connect to the Docker daemon" >&2
    return 1
  fi
  local proj wd svc image name
  case "$*" in
    # What detect_foreign_install asks (tab-separated, in its order).
    "ps -a --format "*)
      while IFS='|' read -r _ proj wd svc image; do
        printf '%s\t%s\t%s\t%s\n' "$proj" "$wd" "$svc" "$image"
      done <"$(_dk containers)"
      ;;
    "volume ls --format "*)
      while IFS='|' read -r name proj; do
        printf '%s\t%s\n' "$name" "$proj"
      done <"$(_dk volumes)"
      ;;
    "ps -aq --filter label=com.docker.compose.project=freeframe")
      awk -F'|' '$2 == "freeframe" { print $1 }' "$(_dk containers)"
      ;;
    "volume ls -q --filter label=com.docker.compose.project=freeframe")
      awk -F'|' '$2 == "freeframe" { print $1 }' "$(_dk volumes)"
      ;;
    "network ls -q --filter label=com.docker.compose.project=freeframe")
      awk -F'|' '$3 == "freeframe" { print $1 }' "$(_dk networks)"
      ;;
    "rm -f "*)
      shift 2
      _dk_drop "$(_dk containers)" 1 "$@"
      ;;
    "network rm "*)
      shift 2
      _dk_drop "$(_dk networks)" 1 "$@"
      ;;
    # STUB_VOLRM_FAIL="NAME...": those volumes cannot be removed; the others
    # are, and the call fails, as docker volume rm does.
    "volume rm "*)
      shift 2
      local v rc=0
      for v in "$@"; do
        if [[ " ${STUB_VOLRM_FAIL:-} " == *" $v "* ]]; then rc=1; else _dk_drop "$(_dk volumes)" 1 "$v"; fi
      done
      return "$rc"
      ;;
  esac
  return 0
}

eval "_manage_dc() $(declare -f dc | tail -n +2)"
dc() {
  # docker compose fails on every command when a -f file is missing.
  if [[ ! -f $FF_ROOT/docker-compose.prod.yml || ! -f $FF_ROOT/docker-compose.images.yml ]]; then
    _stub_log "dc $*"
    echo "open $FF_ROOT/docker-compose.prod.yml: no such file or directory" >&2
    return 1
  fi
  case "$*" in
    "config -q")
      _stub_log "dc $*"
      [[ -z ${STUB_CONFIG_FAIL:-} ]]
      ;;
    "down"*)
      _stub_log "dc $*"
      [[ -z ${STUB_DOWN_FAIL:-} ]] || return 1
      _dk_drop "$(_dk containers)" 2 freeframe
      _dk_drop "$(_dk networks)" 3 freeframe
      if [[ " $* " == *" --volumes "* || " $* " == *" -v "* ]]; then _dk_drop "$(_dk volumes)" 2 freeframe; fi
      ;;
    # STUB_PG_STOPPED: the database is not running until it is started.
    "exec -T postgres pg_isready "*)
      if [[ -n ${STUB_PG_STOPPED:-} && ! -e $STUB_DIR/pg-up ]]; then
        _stub_log "dc $*"
        return 1
      fi
      _manage_dc "$@"
      ;;
    # Starting the database without its volume makes a new, empty one, as
    # compose does.
    "up -d --no-build postgres")
      : >"$STUB_DIR/pg-up"
      if ! grep -q '^freeframe_pgdata|' "$(_dk volumes)"; then
        printf 'freeframe_pgdata|freeframe\n' >>"$(_dk volumes)"
        : >"$STUB_DIR/db-empty"
      fi
      _manage_dc "$@"
      ;;
    # STUB_DB_EMPTY (or a database made afresh): no tables.
    "exec -T postgres psql -U "*" -d postgres "*) _manage_dc "$@" ;;
    "exec -T postgres psql "*)
      _stub_log "dc $*"
      if [[ -n ${STUB_DB_EMPTY:-} || -e $STUB_DIR/db-empty ]]; then echo 0; else echo 42; fi
      ;;
    *) _manage_dc "$@" ;;
  esac
}

# STUB_RM_FAIL=TEXT: an rm whose paths include TEXT removes the others and
# fails, as rm does when one path cannot be removed.
rm() {
  _stub_log "rm $*"
  # Whether the lock is held when its file goes: a second open of the file
  # can take it only when nobody holds it.
  if [[ $* == *"$FF_ROOT/.freeframe.lock"* || $* == *"-- $FF_ROOT" ]] && [[ -e $FF_ROOT/.freeframe.lock ]] &&
    command -v flock >/dev/null 2>&1; then
    if (flock -n 7) 7>>"$FF_ROOT/.freeframe.lock"; then _stub_log "rm-lock: free"; else _stub_log "rm-lock: held"; fi
  fi
  if [[ -n ${STUB_RM_FAIL:-} && $* == *"$STUB_RM_FAIL"* ]]; then
    local a
    local -a keep=()
    for a in "$@"; do
      if [[ $a != *"$STUB_RM_FAIL"* ]]; then keep+=("$a"); fi
    done
    command rm "${keep[@]}"
    return 1
  fi
  command rm "$@"
}

ufw_active() { [[ -n ${STUB_UFW:-} ]]; }
_gpu_has_toolkit() { [[ -n ${STUB_TOOLKIT:-} ]]; }
