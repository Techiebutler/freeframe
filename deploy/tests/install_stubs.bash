# Stubs for every side effect of `freeframe install`. install.bats sources
# this file after the script, in a fresh bash, so these definitions replace
# the real wrappers. Each call is appended to $CALLS, one line per call, so a
# test can check what ran and in which order. The STUB_* environment
# variables are the knobs the tests turn.
#
# Nothing here reaches the network, Docker, apt, systemd or the firewall.

_stub_log() { printf '%s\n' "$*" >>"$CALLS"; }

# shellcheck source-path=SCRIPTDIR source=gpu_worker_stubs.bash
source "${BASH_SOURCE[0]%/*}/gpu_worker_stubs.bash"

ff_is_root() { [[ -z ${STUB_NOT_ROOT:-} ]]; }
machine_arch() { printf '%s\n' "${STUB_ARCH:-x86_64}"; }
_ff_kernel() { printf '%s\n' "${STUB_KERNEL:-Linux}"; }

detect_foreign_install() {
  _stub_log detect_foreign_install
  return "${STUB_FOREIGN:-1}"
}

docker_status() {
  _stub_log docker_status
  # A failed NVIDIA set-up can leave Docker down ($STUB_DIR/docker-down).
  if [[ -e $STUB_DIR/docker-down ]]; then
    printf 'down\n'
    return 0
  fi
  printf '%s\n' "${STUB_DOCKER:-none}"
}

install_docker() {
  _stub_log install_docker
  STUB_DOCKER=ok
}

run_apt() { _stub_log "run_apt $*"; }

public_ip() {
  [[ -n ${STUB_PUBLIC_IP-203.0.113.7} ]] || return 1
  printf '%s\n' "${STUB_PUBLIC_IP-203.0.113.7}"
}
local_ip() { printf '%s\n' "${STUB_LOCAL_IP:-203.0.113.7}"; }

net_reachable() {
  _stub_log "net_reachable $1"
  [[ -z ${STUB_NET_DOWN:-} || $1 != *"$STUB_NET_DOWN"* ]]
}

_ff_free_mb() { printf '%s\n' "${STUB_FREE_MB:-80000}"; }

# ss -Hltnp: STUB_SS holds the listening lines. systemctl clears it when
# STUB_SS_CLEARS is set (the program holding the port was stopped).
ss() {
  [[ -n ${STUB_SS:-} ]] && printf '%s\n' "$STUB_SS"
  return 0
}
_ff_unit_of_pid() { printf '%s\n' "${STUB_UNIT:-}"; }
systemctl() {
  _stub_log "systemctl $*"
  if [[ $* == daemon-reload ]]; then _stub_daemon_reload; fi
  # Restarting Docker brings it back, unless STUB_DOCKER_STAYS_DOWN.
  if [[ $* == "restart docker" && -e $STUB_DIR/docker-down ]]; then
    [[ -z ${STUB_DOCKER_STAYS_DOWN:-} ]] || return 1
    rm -f "$STUB_DIR/docker-down"
    return 0
  fi
  # STUB_SYSTEMCTL_FAIL: stopping a program fails (it keeps the port).
  [[ -z ${STUB_SYSTEMCTL_FAIL:-} ]] || return 1
  [[ -n ${STUB_SS_CLEARS:-} ]] && STUB_SS=""
  return 0
}

swap_present() { [[ -n ${STUB_SWAP:-} ]]; }
add_swap() { _stub_log add_swap; }
ufw_active() { [[ -n ${STUB_UFW_ACTIVE:-} ]]; }
ufw() { _stub_log "ufw $*"; }

dns_points_here() {
  local n=0 f="$STUB_DIR/dns-count"
  [[ -f $f ]] && n=$(<"$f")
  n=$((n + 1))
  printf '%s' "$n" >"$f"
  _stub_log "dns_points_here $1 $2"
  ((n > ${STUB_DNS_FAILS:-0}))
}

fetch() {
  _stub_log "fetch $1 $2"
  [[ -n ${STUB_FETCH_FAIL:-} && $2 == "$STUB_FETCH_FAIL" ]] && return 1
  printf 'services: {}\n' >"$3"
}

ff_sleep() { _stub_log "sleep $1"; }

# The nightly backup units, put into systemd with a daemon-reload before
# FreeFrame starts (STUB_UNITS_FAIL: that fails), and the timer started
# after (STUB_TIMER_FAIL: that fails).
backup_units_install() {
  _stub_log backup_units_install
  [[ -z ${STUB_UNITS_FAIL:-} ]] || return 1
  systemctl daemon-reload
}
backup_timer_on() {
  _stub_log backup_timer_on
  [[ -z ${STUB_TIMER_FAIL:-} ]]
}

probe_health() {
  _stub_log "probe_health $*"
  [[ -z ${STUB_HEALTH_FAIL:-} ]]
}

cert_issued() {
  _stub_log "cert_issued $1"
  [[ -z ${STUB_CERT_FAIL:-} ]]
}

# docker compose for this install.
dc() {
  _stub_log "dc $*"
  case "$*" in
    "config --services")
      if [[ -n ${STUB_SERVICES+x} ]]; then
        [[ -z $STUB_SERVICES ]] || printf '%s\n' $STUB_SERVICES
        return 0
      fi
      printf '%s\n' traefik postgres redis api worker email_worker maintenance_worker beat web
      if [[ $(env_get "$(ff_root)/.env.prod" FREEFRAME_STORAGE) == bundled ]]; then
        printf '%s\n' minio minio-init
      fi
      ;;
    *create-superadmin*)
      local body='{"message":"Superadmin created","access_token":"tok-SECRET"}'
      cat >"$STUB_DIR/superadmin.json"
      # STUB_ADMIN_EXEC_FAIL: docker compose exec itself fails (no HTTP code).
      [[ -z ${STUB_ADMIN_EXEC_FAIL:-} ]] || return 1
      printf '%s\n%s' "${STUB_ADMIN_BODY:-$body}" "${STUB_ADMIN_CODE:-201}"
      ;;
    "up -d --no-build traefik") [[ -z ${STUB_TRAEFIK_FAIL:-} ]] ;;
    # The worker, and what it sees of the GPU (gpu_worker_stubs.bash).
    "up -d --no-build --no-deps --force-recreate worker") _stub_worker_recreated ;;
    "up -d --no-build "*) _stub_worker_started ;;
    "exec -T worker nvidia-smi -L") _stub_worker_smi ;;
    "ps -q --status running worker") [[ -n ${STUB_WORKER_DOWN:-} ]] || echo 0123456789ab ;;
    # Whether the database has an admin account (STUB_SETUP_NEEDED: none;
    # STUB_SETUP_STATUS_FAIL: the API does not answer).
    *"localhost:8000/setup/status"*)
      [[ -z ${STUB_SETUP_STATUS_FAIL:-} ]] || return 1
      if [[ -n ${STUB_SETUP_NEEDED:-} ]]; then
        printf '{"needs_setup":true,"message":"No superadmin found. Please complete initial setup."}'
      else
        printf '{"needs_setup":false,"message":"System is already configured"}'
      fi
      ;;
    *"localhost:8000/health"*) [[ -z ${STUB_API_DOWN:-} ]] ;;
    # Our own containers from an earlier attempt (STUB_OURS_RUNNING).
    # `stop traefik` stops it, unless STUB_TRAEFIK_STUCK.
    "ps -q traefik")
      [[ -n ${STUB_OURS_RUNNING:-} && ! -e $STUB_DIR/traefik-stopped ]] || return 0
      echo 0123456789ab
      ;;
    "ps -q "*) [[ -z ${STUB_OURS_RUNNING:-} ]] || echo 0123456789ab ;;
    "stop traefik") [[ -n ${STUB_TRAEFIK_STUCK:-} ]] || : >"$STUB_DIR/traefik-stopped" ;;
    # STUB_PULL_FAIL: the download fails; STUB_PULL_ERR is what docker prints.
    pull*)
      [[ -n ${STUB_PULL_FAIL:-} ]] || return 0
      [[ -z ${STUB_PULL_ERR:-} ]] || printf '%s\n' "$STUB_PULL_ERR" >&2
      # STUB_PULL_PEEK: note whether what was printed is already in the log.
      if [[ -n ${STUB_PULL_PEEK:-} ]] && grep -qF -- "${STUB_PULL_ERR%%$'\n'*}" "${FF_LOG:-/dev/null}" 2>/dev/null; then
        : >"$STUB_DIR/pull-live"
      fi
      return 1
      ;;
    *) return 0 ;;
  esac
}

# derive_env is real; wrap it so the call shows up in $CALLS.
eval "_real_derive_env() $(declare -f derive_env | tail -n +2)"
derive_env() {
  _stub_log derive_env
  # STUB_DERIVE_FAIL: the settings cannot be completed.
  [[ -z ${STUB_DERIVE_FAIL:-} ]] || return 1
  _real_derive_env "$@"
}

# The GPU: STUB_GPU is what detect_gpu finds: none (the default), ready,
# notoolkit, noruntime, nodriver, intel or amd. install_nvidia_toolkit
# makes a notoolkit or noruntime GPU ready, unless STUB_GPU_SETUP_FAIL.
detect_gpu() {
  _stub_log detect_gpu
  # STUB_GPU_MARK: show on the screen where the detection ran.
  [[ -z ${STUB_GPU_MARK:-} ]] || printf '<<detect_gpu>>\n' >&2
  FF_GPU_VENDOR=none FF_GPU_NAME="" FF_GPU_DRIVER="" FF_GPU_STATE=none FF_GPU_WSL=${STUB_GPU_WSL:-} FF_GPU_SMI_LINE=""
  case ${STUB_GPU:-none} in
    ready | notoolkit | noruntime)
      FF_GPU_VENDOR=nvidia FF_GPU_NAME="NVIDIA GeForce RTX 5070 Ti" FF_GPU_DRIVER=610.47 FF_GPU_STATE=$STUB_GPU
      FF_GPU_SMI_LINE="NVIDIA GeForce RTX 5070 Ti, 610.47"
      ;;
    nodriver) FF_GPU_VENDOR=nvidia FF_GPU_NAME=NVIDIA FF_GPU_STATE=nodriver ;;
    intel) FF_GPU_VENDOR=intel FF_GPU_NAME=Intel FF_GPU_STATE=unsupported ;;
    amd) FF_GPU_VENDOR=amd FF_GPU_NAME=AMD FF_GPU_STATE=unsupported ;;
  esac
}

# STUB_GPU_DOCKER_DOWN: the failed set-up leaves Docker down, after
# nvidia-ctk changed daemon.json (backed up first, as the real one does).
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

# STUB_OTHER_CONTAINERS: how many containers that are not FreeFrame's run.
_gpu_other_containers() { printf '%s' "${STUB_OTHER_CONTAINERS:-0}"; }

# dc with a time limit: logged, then the stubbed dc.
dc_bounded() {
  _stub_log "dc_bounded $*"
  shift
  dc "$@"
}

# STUB_PGDATA: the database's volume (freeframe_pgdata) is on this server,
# kept from an earlier install.
_ff_pgdata_kept() {
  _stub_log _ff_pgdata_kept
  [[ -n ${STUB_PGDATA:-} ]]
}
