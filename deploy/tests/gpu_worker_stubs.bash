# What the worker container sees of the GPU, shared by install_stubs.bash,
# manage_stubs.bash and backup_stubs.bash. Each stub's dc calls these for
# `exec -T worker nvidia-smi -L` and for the starts that create the worker.
#
# STUB_WORKER_SMI: what nvidia-smi -L in the worker does:
#   pass     it lists the GPU (STUB_WORKER_GPU, or an RTX 5070 Ti line)
#   fail     it fails every time, with the NVML message WSL2 gave
#   nogpu    it answers (exit 0) but lists no GPU
#   restart  it fails until the worker is created again
#            (dc up -d --no-build --no-deps --force-recreate worker)
#   unset    it lists the GPU when STUB_WORKER_GPU is set, or when the
#            worker was last started with docker-compose.gpu.yml while
#            Docker can use the GPU (STUB_GPU=ready); otherwise it fails.

# What nvidia-smi printed in the worker on WSL2, blank line included.
STUB_NVML_BLOCKED="Failed to initialize NVML: GPU access blocked by the operating system
Failed to properly shut down NVML: GPU access blocked by the operating system
"

_stub_worker_smi() {
  case ${STUB_WORKER_SMI:-} in
    pass) ;;
    nogpu)
      printf 'No devices were found\n'
      return 0
      ;;
    fail)
      printf '%s\n' "$STUB_NVML_BLOCKED"
      return 255
      ;;
    restart)
      if [[ ! -e $STUB_DIR/worker-recreated ]]; then
        printf '%s\n' "$STUB_NVML_BLOCKED"
        return 255
      fi
      ;;
    *)
      if [[ -z ${STUB_WORKER_GPU:-} ]] && ! [[ ${STUB_GPU:-none} == ready && -e $STUB_DIR/worker-gpu-up ]]; then
        return 1
      fi
      ;;
  esac
  printf '%s\n' "${STUB_WORKER_GPU:-GPU 0: NVIDIA GeForce RTX 5070 Ti (UUID: GPU-0d5e2b6c-1111-2222-3333-444455556666)}"
}

# _stub_worker_started: a start that (re)creates the worker notes whether
# it had the GPU file.
_stub_worker_started() {
  if [[ $(compose_files "$FF_ROOT/.env.prod") == *"-f docker-compose.gpu.yml"* ]]; then
    : >"$STUB_DIR/worker-gpu-up"
  else
    rm -f "$STUB_DIR/worker-gpu-up"
  fi
}

# _stub_worker_recreated: the worker created again on its own.
_stub_worker_recreated() {
  : >"$STUB_DIR/worker-recreated"
  _stub_worker_started
}

# _stub_daemon_reload: what systemctl daemon-reload does to a running worker
# on a host whose Docker uses the systemd cgroup driver, when
# STUB_RELOAD_DROPS_GPU is set: it loses the GPU until it is created again.
_stub_daemon_reload() {
  [[ -z ${STUB_RELOAD_DROPS_GPU:-} ]] || rm -f "$STUB_DIR/worker-gpu-up"
}
