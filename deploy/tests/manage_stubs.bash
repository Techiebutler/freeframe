# Stubs for every side effect of `freeframe update`, `configure`, `status`,
# `logs` and `restart`. update.bats, configure.bats and manage.bats source
# this file after the script, in a fresh bash, so these definitions replace
# the real wrappers. Each call is appended to $CALLS, one line per call. The
# STUB_* environment variables are the knobs the tests turn.
#
# Downloads come from $STUB_REMOTE, a folder laid out like the repository at
# the channel's ref (the real fetch, through FF_FETCH_FROM_DIR). Nothing here
# reaches the network, Docker, PostgreSQL or systemd.

_stub_log() { printf '%s\n' "$*" >>"$CALLS"; }

# shellcheck source-path=SCRIPTDIR source=gpu_worker_stubs.bash
source "${BASH_SOURCE[0]%/*}/gpu_worker_stubs.bash"

ff_is_root() { [[ -z ${STUB_NOT_ROOT:-} ]]; }
ff_sleep() { _stub_log "sleep $1"; }
_ff_free_mb() { printf '%s\n' "${STUB_FREE_MB:-80000}"; }

public_ip() {
  [[ -n ${STUB_PUBLIC_IP-203.0.113.7} ]] || return 1
  printf '%s\n' "${STUB_PUBLIC_IP-203.0.113.7}"
}
local_ip() { printf '%s\n' "${STUB_LOCAL_IP:-203.0.113.7}"; }

# A ref with its own folder ($STUB_REMOTE_REFS/REF) is served from there;
# every other ref from $STUB_REMOTE. STUB_FETCH_FAIL_REF fails a whole ref.
eval "_real_fetch() $(declare -f fetch | tail -n +2)"
fetch() {
  _stub_log "fetch $1 $2"
  [[ -z ${STUB_FETCH_FAIL:-} || $2 != "$STUB_FETCH_FAIL" ]] || return 1
  [[ -z ${STUB_FETCH_FAIL_REF:-} || $1 != "$STUB_FETCH_FAIL_REF" ]] || return 1
  if [[ -n ${STUB_REMOTE_REFS:-} && -d $STUB_REMOTE_REFS/$1 ]]; then
    FF_FETCH_FROM_DIR=$STUB_REMOTE_REFS/$1 _real_fetch "$@"
  else
    FF_FETCH_FROM_DIR=$STUB_REMOTE _real_fetch "$@"
  fi
}

# _stub_hang NAME: for the signal tests. Note this process group (the test
# signals all of it, as Ctrl-C and a closed SSH session do), say the long
# step has started, and wait.
_stub_hang() {
  local -a st
  read -r -a st </proc/$BASHPID/stat
  printf '%s' "${st[4]}" >"$STUB_DIR/pgid"
  : >"$STUB_DIR/hanging-$1"
  sleep 30
}

# STUB_UNDO_SET_HANG: hang right after the update record is written.
if [[ -n ${STUB_UNDO_SET_HANG:-} ]]; then
  eval "_real_update_undo_set() $(declare -f _update_undo_set | tail -n +2)"
  _update_undo_set() {
    _real_update_undo_set "$@" || return 1
    _stub_hang undo-set
  }
fi

# STUB_PUTBACK_FAIL: the setup files from before cannot be put back.
if [[ -n ${STUB_PUTBACK_FAIL:-} ]]; then
  _update_put_back() {
    _stub_log _update_put_back
    return 1
  }
fi

# STUB_SAY_FAIL=TEXT: printing a line containing TEXT fails, an unexpected
# failure in the middle of the flow (the ERR trap's case).
if [[ -n ${STUB_SAY_FAIL:-} ]]; then
  eval "_real_say() $(declare -f say | tail -n +2)"
  say() {
    if [[ $* == *"$STUB_SAY_FAIL"* ]]; then return 1; fi
    _real_say "$@"
  }
fi

# docker itself (rollback stops by project label when the compose files in
# place cannot be read).
docker() {
  _stub_log "docker $*"
  case "$*" in
    "ps "*) printf '%s\n' 'c1|api' 'c2|postgres' 'c3|traefik' 'c4|worker' ;;
  esac
  return 0
}

# The self-update's re-exec, followed in this process (the real one would
# start the downloaded script without these stubs). STUB_REAL_REEXEC keeps
# the real one.
if [[ -z ${STUB_REAL_REEXEC:-} ]]; then
  _ff_reexec() {
    _stub_log "reexec $*"
    shift
    export FF_SELF_UPDATED=1
    main "$@"
    exit $?
  }
fi

# STUB_TIMER_HANG: refreshing the timer hangs (a signal after the update
# succeeded). STUB_TIMER_RUNS_BACKUP: enabling the timer fires a missed run
# at once, as Persistent=true does: `freeframe backup --quiet` in a process
# of its own, as systemd starts it (without this one's lock descriptor). Its
# output and exit status go to $STUB_DIR/timer-backup.out and .rc.
# The real one then runs, on $FF_SYSTEMD_DIR, with systemctl stubbed.
eval "_real_install_backup_timer() $(declare -f install_backup_timer | tail -n +2)"
install_backup_timer() {
  _stub_log install_backup_timer
  [[ -z ${STUB_TIMER_HANG:-} ]] || _stub_hang timer
  if [[ -n ${STUB_TIMER_RUNS_BACKUP:-} ]]; then
    local rc=0
    (
      if [[ -n ${FF_LOCK_FD:-} ]]; then eval "exec ${FF_LOCK_FD}>&-"; fi
      # shellcheck disable=SC2016 # the inner script expands its own $1 $2 $@
      exec env -u FF_LOCK_FD -u STUB_TIMER_RUNS_BACKUP bash -c \
        'set -Eeuo pipefail; source "$1"; source "$2"; shift 2; main "$@"' \
        ff-run "$FF_SCRIPT" "$STUBS" backup --quiet
    ) >"$STUB_DIR/timer-backup.out" 2>&1 || rc=$?
    printf '%s\n' "$rc" >"$STUB_DIR/timer-backup.rc"
  fi
  [[ -z ${STUB_TIMER_FAIL:-} ]] || return 1
  _real_install_backup_timer
}

# daemon-reload can drop the worker's GPU (gpu_worker_stubs.bash).
# STUB_TIMER_DISABLED: the backup timer is not enabled (or not running).
systemctl() {
  _stub_log "systemctl $*"
  if [[ $* == daemon-reload ]]; then _stub_daemon_reload; fi
  # STUB_NEED_RELOAD: systemd has not loaded the unit files on disk yet.
  if [[ $* == "show -p NeedDaemonReload --value "* ]]; then
    if [[ -n ${STUB_NEED_RELOAD:-} ]]; then printf 'no\nyes\n'; else printf 'no\nno\n'; fi
    return 0
  fi
  if [[ $* == "is-enabled --quiet freeframe-backup.timer" || $* == "is-active --quiet freeframe-backup.timer" ]]; then
    [[ -z ${STUB_TIMER_DISABLED:-} ]]
    return
  fi
  if [[ $* == "restart docker" && -e $STUB_DIR/docker-down ]]; then
    [[ -z ${STUB_DOCKER_STAYS_DOWN:-} ]] || return 1
    rm -f "$STUB_DIR/docker-down"
    return 0
  fi
  case "$*" in
    *NextElapseUSecRealtime*) printf '%s\n' "${STUB_TIMER_NEXT-Tue 2026-10-27 03:07:12 UTC}" ;;
    *ActiveState*) printf '%s\n' "${STUB_TIMER_STATE:-active}" ;;
  esac
  return 0
}

dns_points_here() {
  local n=0 f="$STUB_DIR/dns-count"
  [[ -f $f ]] && n=$(<"$f")
  n=$((n + 1))
  printf '%s' "$n" >"$f"
  _stub_log "dns_points_here $1 $2"
  ((n > ${STUB_DNS_FAILS:-0}))
}

probe_health() {
  _stub_log "probe_health $*"
  [[ -z ${STUB_HEALTH_FAIL:-} ]]
}

cert_issued() {
  _stub_log "cert_issued $1"
  [[ -z ${STUB_CERT_FAIL:-} ]]
}

cert_expiry() {
  _stub_log "cert_expiry $1"
  [[ -z ${STUB_CERT_FAIL:-} ]] || return 1
  printf '%s\n' "${STUB_CERT_END:-Jan 24 10:00:00 2027 GMT}"
}

# The channel's version: STUB_REMOTE_VERSION when set, otherwise the default
# in the images file the ref serves (as the real one reads it).
remote_version() {
  local d=$STUB_REMOTE
  _stub_log "remote_version $1"
  [[ -z ${STUB_NET_DOWN:-} ]] || return 1
  [[ -z ${STUB_FETCH_FAIL_REF:-} || $1 != "$STUB_FETCH_FAIL_REF" ]] || return 1
  if [[ -n ${STUB_REMOTE_VERSION:-} ]]; then
    printf '%s\n' "$STUB_REMOTE_VERSION"
    return 0
  fi
  if [[ -n ${STUB_REMOTE_REFS:-} && -d $STUB_REMOTE_REFS/$1 ]]; then d=$STUB_REMOTE_REFS/$1; fi
  [[ -f $d/docker-compose.images.yml ]] || return 1
  _ff_version_in "$(<"$d/docker-compose.images.yml")"
}

# docker compose for this install.
dc() {
  _stub_log "dc $*"
  case "$*" in
    "config --services")
      [[ -z ${STUB_DOCKER_DOWN:-} ]] || return 1
      # STUB_CONFIG_FAIL_NEW: the new release's compose files do not parse.
      if [[ -n ${STUB_CONFIG_FAIL_NEW:-} ]] && grep -q 1.22.0 "$FF_ROOT/docker-compose.images.yml"; then
        return 1
      fi
      printf '%s\n' traefik postgres redis api worker email_worker maintenance_worker beat web minio minio-init
      ;;
    "ps -q --status running worker") [[ -n ${STUB_WORKER_DOWN:-} ]] || echo 0123456789ab ;;
    "ps --format {{.Image}} api")
      # The image the running api container was started from.
      [[ -z ${STUB_RUNNING_IMAGE:-} ]] || printf '%s\n' "$STUB_RUNNING_IMAGE"
      ;;
    "ps "*)
      [[ -z ${STUB_DOCKER_DOWN:-} ]] || return 1
      printf "%s|%s|%s\n" traefik running "Up 2 hours" postgres running "Up 2 hours (healthy)" \
        api running "Up 2 hours (healthy)" worker exited "Exited (1) 5 minutes ago"
      ;;
    "exec -T postgres pg_isready "*) [[ -z ${STUB_PG_DOWN:-} ]] ;;
    # What restore asks the database (rollback runs restore's steps).
    "exec -T postgres psql -U "*" -d postgres "*)
      cat >/dev/null
      [[ -z ${STUB_MAINT_FAIL:-} ]] || return 1
      echo 1
      ;;
    "exec -T postgres psql "*) echo 42 ;;
    "exec -T postgres dropdb "*) [[ -z ${STUB_DROP_FAIL:-} ]] ;;
    "exec -T postgres createdb "*) return 0 ;;
    "exec -T postgres pg_restore "*)
      cat >"$STUB_DIR/restored"
      [[ -z ${STUB_RESTORE_FAIL:-} ]]
      ;;
    "stop"*)
      # The images file in place when FreeFrame was first stopped.
      [[ -e $STUB_DIR/images-at-stop ]] || cp "$FF_ROOT/docker-compose.images.yml" "$STUB_DIR/images-at-stop" 2>/dev/null || true
      [[ -z ${STUB_STOP_FAIL:-} ]]
      ;;
    "exec -T postgres pg_dump "*)
      [[ -z ${STUB_PG_DOWN:-} ]] || return 1
      printf 'PGDMP current database %s\n' "$(_ff_version_in "$(cat "$FF_ROOT/docker-compose.images.yml")" 2>/dev/null)"
      ;;
    *"localhost:8000/health"*)
      [[ -z ${STUB_HEALTH_HANG:-} ]] || _stub_hang health
      [[ -z ${STUB_API_DOWN:-} ]]
      ;;
    pull*)
      [[ -z ${STUB_PULL_HANG:-} ]] || _stub_hang pull
      # STUB_PULL_FAIL: the download fails; STUB_PULL_ERR is what docker prints.
      [[ -n ${STUB_PULL_FAIL:-} ]] || return 0
      [[ -z ${STUB_PULL_ERR:-} ]] || printf '%s\n' "$STUB_PULL_ERR" >&2
      # STUB_PULL_PEEK: note whether what was printed is already in the log.
      if [[ -n ${STUB_PULL_PEEK:-} ]] && grep -qF -- "${STUB_PULL_ERR%%$'\n'*}" "${FF_LOG:-/dev/null}" 2>/dev/null; then
        : >"$STUB_DIR/pull-live"
      fi
      return 1
      ;;
    # What the worker container sees of the GPU (gpu_worker_stubs.bash).
    "exec -T worker nvidia-smi -L") _stub_worker_smi ;;
    "up -d --no-build --no-deps --force-recreate worker") _stub_worker_recreated ;;
    "up -d"*)
      # The compose files this start used.
      _stub_log "files $(compose_files "$FF_ROOT/.env.prod")"
      [[ -z ${STUB_UP_FAIL:-} ]] || return 1
      _stub_worker_started
      ;;
    "logs "*) printf 'api-1  | started\n' ;;
    *) return 0 ;;
  esac
}

# derive_env is real; wrap it so the call shows up in $CALLS.
eval "_real_derive_env() $(declare -f derive_env | tail -n +2)"
derive_env() {
  _stub_log derive_env
  _real_derive_env "$@"
}

# STUB_MV_FAIL=NAME: moving a downloaded file onto $FF_ROOT/NAME fails (a full or read-only
# disk at just the wrong moment). Every other mv is real.
# STUB_MV_OLD_FAIL=NAME: putting NAME back from a download's stage/old fails.
# STUB_MV_HANG=NAME: moving onto $FF_ROOT/NAME hangs first (a signal in the
# middle of the replace).
if [[ -n ${STUB_MV_FAIL:-}${STUB_MV_OLD_FAIL:-}${STUB_MV_HANG:-} ]]; then
  mv() {
    if [[ -n ${STUB_MV_FAIL:-} && ${!#} == "$FF_ROOT/$STUB_MV_FAIL" && $* == *"/.download."* ]]; then return 1; fi
    if [[ -n ${STUB_MV_OLD_FAIL:-} && ${!#} == "$FF_ROOT/$STUB_MV_OLD_FAIL" && $* == */old/* ]]; then return 1; fi
    if [[ -n ${STUB_MV_HANG:-} && ${!#} == "$FF_ROOT/$STUB_MV_HANG" ]]; then _stub_hang mv; fi
    command mv "$@"
  }
fi

# sync: logged with the update record's phase at that moment, so a test can
# tell the record was on disk before the new version started. The real sync
# also runs (harmless in a test).
sync() {
  _stub_log "sync $* [$(grep -h '^phase=' "$FF_ROOT/.update-undo" 2>/dev/null || printf 'no record')]"
  command sync "$@" 2>/dev/null || true
}

# STUB_AT_LOCK: a shell command run just before _ff_lock, as another
# freeframe command could change things between a question and the lock.
if [[ -n ${STUB_AT_LOCK:-} ]]; then
  eval "_real_ff_lock() $(declare -f _ff_lock | tail -n +2)"
  _ff_lock() {
    bash -c "$STUB_AT_LOCK"
    _real_ff_lock "$@"
  }
fi

# The GPU: STUB_GPU is what detect_gpu finds: none (the default), ready,
# notoolkit, noruntime, nodriver, intel or amd. install_nvidia_toolkit
# makes a notoolkit or noruntime GPU ready, unless STUB_GPU_SETUP_FAIL.
detect_gpu() {
  _stub_log detect_gpu
  FF_GPU_VENDOR=none FF_GPU_NAME="" FF_GPU_DRIVER="" FF_GPU_STATE=none FF_GPU_WSL=${STUB_GPU_WSL:-}
  case ${STUB_GPU:-none} in
    ready | notoolkit | noruntime)
      FF_GPU_VENDOR=nvidia FF_GPU_NAME="NVIDIA GeForce RTX 5070 Ti" FF_GPU_DRIVER=610.47 FF_GPU_STATE=$STUB_GPU
      ;;
    nodriver) FF_GPU_VENDOR=nvidia FF_GPU_NAME=NVIDIA FF_GPU_STATE=nodriver ;;
    intel) FF_GPU_VENDOR=intel FF_GPU_NAME=Intel FF_GPU_STATE=unsupported ;;
    amd) FF_GPU_VENDOR=amd FF_GPU_NAME=AMD FF_GPU_STATE=unsupported ;;
  esac
}

install_nvidia_toolkit() {
  _stub_log install_nvidia_toolkit
  if [[ -n ${STUB_GPU_SETUP_FAIL:-} ]]; then
    if [[ -n ${STUB_GPU_DOCKER_DOWN:-} ]]; then
      FF_GPU_DAEMON_JSON=/etc/docker/daemon.json FF_GPU_DAEMON_BACKUP=/etc/docker/daemon.json.before-freeframe-nvidia-20261028-101010
      : >"$STUB_DIR/docker-down"
    fi
    return 1
  fi
  STUB_GPU=ready
}

# Docker answers unless a failed NVIDIA set-up left it down.
docker_status() {
  _stub_log docker_status
  if [[ -e $STUB_DIR/docker-down ]]; then printf 'down\n'; else printf 'ok\n'; fi
}

# dc with a time limit: logged, then the stubbed dc.
dc_bounded() {
  _stub_log "dc_bounded $*"
  shift
  dc "$@"
}

