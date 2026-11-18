#!/usr/bin/env bats
# `freeframe status`, `logs` and `restart`, with every side effect stubbed
# (manage_stubs.bash).

load manage_helpers

setup() {
  manage_setup
  installed_server sslip bundled 1.21.0
}

# ---------------------------------------------------------------- status

@test "status: version, channel, address, services, disk and backups, and never a secret" {
  mkdir -p "$BK"
  printf 'PGDMP x\n' >"$BK/freeframe-20261025-030411.dump"
  printf 'PGDMP y\n' >"$BK/freeframe-20261026-030412.dump"
  ff status
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Version:"
  assert_out "1.21.0"
  assert_out "latest channel"
  assert_out "https://203-0-113-7.sslip.io"
  assert_out "answers"
  # Every container, including one that stopped.
  assert_out "api"
  assert_out "Up 2 hours (healthy)"
  assert_out "worker"
  assert_out "Exited (1) 5 minutes ago"
  # Disk and backups.
  assert_out "free"
  assert_out "2026-10-26 03:04:12"
  assert_out "Tue 2026-10-27 03:07:12 UTC"
  assert_out "on this server only"
  local k v
  for k in POSTGRES_PASSWORD REDIS_PASSWORD JWT_SECRET S3_ACCESS_KEY S3_SECRET_KEY; do
    v=$(env_get "$ENV" "$k")
    [ -n "$v" ]
    assert_no_out "$v"
  done
}

@test "status: Last is the newest ordinary backup, not a rollback's copy" {
  mkdir -p "$BK"
  printf 'PGDMP x\n' >"$BK/freeframe-20261025-030411.dump"
  printf 'PGDMP y\n' >"$BK/freeframe-20261026-120000-before-rollback.dump"
  ff status
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Last:         2026-10-25 03:04:11 (freeframe-20261025-030411.dump"
  assert_out "2 kept"
}

@test "status: a newer release on the channel is named with the command to get it" {
  export STUB_REMOTE_VERSION=1.22.0
  ff status
  [ "$status" -eq 0 ]
  assert_out "1.22.0 is available on the latest channel"
  assert_out "sudo freeframe update"
  grep -qx "remote_version latest" "$CALLS"
}

@test "status: the newest release says so" {
  ff status
  [ "$status" -eq 0 ]
  assert_out "this is the newest release on the latest channel"
}

@test "status: a server ahead of its channel says so, not that it is the newest" {
  sed -i "s/FREEFRAME_VERSION:-[^}]*}/FREEFRAME_VERSION:-1.22.0}/" "$FF_ROOT/docker-compose.images.yml"
  env_set "$ENV" FREEFRAME_CHANNEL stable
  export STUB_REMOTE_VERSION=1.21.0
  ff status
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "this server runs 1.22.0, ahead of the stable channel (1.21.0)"
  assert_out "sudo freeframe update --channel latest"
  assert_no_out "this is the newest release"
}

@test "status: an unreadable version is not called ahead of the channel" {
  rm "$FF_ROOT/docker-compose.images.yml"
  ff status
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "could not read the version this server runs"
  assert_no_out "ahead of the"
  assert_no_out "this is the newest release"
}

@test "status: no network is not an error" {
  export STUB_NET_DOWN=1
  ff status
  [ "$status" -eq 0 ]
  assert_out "Could not check for a newer release"
  assert_out "Version:"
}

@test "status: the certificate's expiry is shown for HTTPS" {
  ff status
  [ "$status" -eq 0 ]
  assert_out "Jan 24 10:00:00 2027 GMT"
  grep -qx "cert_expiry 203-0-113-7.sslip.io" "$CALLS"
}

@test "status: plain HTTP has no certificate line" {
  env_set "$ENV" FREEFRAME_HTTPS off
  env_set "$ENV" FRONTEND_URL http://203.0.113.7
  ff status
  [ "$status" -eq 0 ]
  assert_not_called cert_expiry
  assert_out "http://203.0.113.7"
}

@test "status: Docker not answering still shows the rest" {
  export STUB_DOCKER_DOWN=1
  ff status
  [ "$status" -eq 0 ]
  assert_out "Docker does not answer"
  assert_out "Version:"
  assert_out "free"
}

@test "status: a timer that is off is said, with the command to turn it on" {
  export STUB_TIMER_STATE=inactive
  ff status
  [ "$status" -eq 0 ]
  assert_out "sudo systemctl enable --now freeframe-backup.timer"
}

@test "status: a pinned version and a channel given with --channel are shown, nothing is written" {
  printf 'FREEFRAME_VERSION=1.20.0\n' >>"$ENV"
  cp "$ENV" "$BATS_TEST_TMPDIR/env.before"
  ff status --channel stable
  [ "$status" -eq 0 ]
  assert_out "1.20.0 (pinned"
  grep -qx "remote_version stable" "$CALLS"
  cmp "$ENV" "$BATS_TEST_TMPDIR/env.before"
}

# ---------------------------------------------------------------- logs

@test "logs: follows the last 200 lines, of everything or one part" {
  ff logs
  [ "$status" -eq 0 ]
  grep -qx "dc logs -f --tail 200" "$CALLS"
  : >"$CALLS"
  ff logs api
  [ "$status" -eq 0 ]
  grep -qx "dc logs -f --tail 200 api" "$CALLS"
}

@test "logs: an unknown part is named, with the list of parts" {
  ff logs apii
  [ "$status" -eq 2 ]
  assert_out "apii"
  assert_out "api worker"
  assert_not_called "dc logs"
}

# ---------------------------------------------------------------- restart

@test "restart: recreates every container without building, then waits for FreeFrame" {
  ff restart
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "dc up -d --no-build --force-recreate" "localhost:8000/health"
  assert_out "FreeFrame is running again"
}

@test "restart: FreeFrame not coming back says how to see why" {
  export STUB_API_DOWN=1 FF_API_WAIT=10
  ff restart
  [ "$status" -eq 1 ]
  assert_out "sudo freeframe logs"
}

@test "restart: an unfinished restore is not started over, and its record is kept" {
  mkdir -p "$BK"
  printf 'PGDMP old\n' >"$BK/freeframe-20261020-030000.dump"
  printf '%s\n' "$BK/freeframe-20261020-030000.dump" >"$FF_ROOT/.restore-undo"
  ff restart
  [ "$status" -eq 1 ]
  assert_out "A restore of the database did not finish"
  assert_out "sudo freeframe restore --yes '$BK/freeframe-20261020-030000.dump'"
  assert_not_called "dc up"
  assert_eq "$(cat "$FF_ROOT/.restore-undo")" "$BK/freeframe-20261020-030000.dump"
}

@test "restart: waits its turn behind a backup or restore" {
  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  ff restart
  exec 9>&-
  [ "$status" -eq 1 ]
  assert_out "Another freeframe command (an update, rollback, backup, restore, restart, configure or uninstall) is running right now"
  assert_not_called "dc up"
}

@test "restart: while a restore runs, it says another command is running, not that the database may be empty" {
  command -v flock >/dev/null || skip "no flock"
  # A restore in progress: it holds the lock, and its undo record stands.
  mkdir -p "$BK"
  printf 'PGDMP old\n' >"$BK/freeframe-20261020-030000.dump"
  printf '%s\n' "$BK/freeframe-20261020-030000.dump" >"$FF_ROOT/.restore-undo"
  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  ff restart
  exec 9>&-
  [ "$status" -eq 1 ]
  assert_out "Another freeframe command (an update, rollback, backup, restore, restart, configure or uninstall) is running right now, so FreeFrame was not restarted."
  assert_no_out "did not finish"
  assert_no_out "may be empty"
  assert_not_called "dc up"
  assert_eq "$(cat "$FF_ROOT/.restore-undo")" "$BK/freeframe-20261020-030000.dump"
}

@test "restart: an inherited FF_LOCK_FD on another file is not taken for the lock" {
  command -v flock >/dev/null || skip "no flock"
  # Another freeframe command holds the lock...
  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  # ...and this one inherits a descriptor on some other file under the name.
  exec 8>>"$BATS_TEST_TMPDIR/not-the-lock"
  FF_LOCK_FD=8 ff restart
  exec 8>&- 9>&-
  [ "$status" -eq 1 ]
  assert_out "is running right now, so FreeFrame was not restarted."
  assert_not_called "dc up"
}

@test "restart: an inherited FF_LOCK_FD on the lock file it holds carries on with that lock" {
  command -v flock >/dev/null || skip "no flock"
  # As the update's re-exec hands it on: the descriptor is open on the lock
  # file and holds the lock.
  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  FF_LOCK_FD=9 ff restart
  exec 9>&-
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -q "^dc up -d --no-build --force-recreate" "$CALLS"
}

@test "status, logs and restart need root and an installed FreeFrame" {
  local c
  for c in status logs restart; do
    STUB_NOT_ROOT=1 ff "$c"
    [ "$status" -eq 2 ] || { echo "$c: $output"; false; }
    assert_out "sudo freeframe $c"
  done
  rm "$ENV"
  for c in status logs restart; do
    ff "$c"
    [ "$status" -eq 1 ] || { echo "$c: $output"; false; }
    assert_out "not installed"
  done
}

# ---------------------------------------------------------------- version order

@test "remote_version: with FF_FETCH_FROM_DIR the version is read from that folder, as fetch does" {
  local d="$BATS_TEST_TMPDIR/workspace"
  mkdir -p "$d"
  printf 'services:\n  api:\n    image: x:${FREEFRAME_VERSION:-1.23.4}\n' >"$d/docker-compose.images.yml"
  # No network at all: a curl would fail.
  curl() { return 7; }
  FF_FETCH_FROM_DIR=$d run remote_version latest
  [ "$status" -eq 0 ]
  assert_eq "$output" 1.23.4
  rm "$d/docker-compose.images.yml"
  FF_FETCH_FROM_DIR=$d run remote_version latest
  [ "$status" -ne 0 ]
}

@test "_ff_version_gt: numbers compare as numbers, and a pre-release ranks below its release" {
  _ff_version_gt 1.22.0 1.21.9
  _ff_version_gt 1.10.0 1.9.0
  _ff_version_gt v1.22.0 1.21.0
  _ff_version_gt 1.22.0 1.22.0-rc1
  _ff_version_gt 1.22.0-rc2 1.22.0-rc1
  _ff_version_gt 1.22.0-rc.10 1.22.0-rc.9
  _ff_version_gt 1.22.0-rc1 1.21.0
  _ff_version_gt 1.22.1 1.22.0
  if _ff_version_gt 1.22.0-rc1 1.22.0; then echo "rc ranked above its release"; false; fi
  if _ff_version_gt 1.22.0 1.22.0; then echo "equal ranked newer"; false; fi
  if _ff_version_gt 1.22.0 v1.22.0; then echo "v prefix counted"; false; fi
  if _ff_version_gt 1.9.0 1.10.0; then echo "compared as text"; false; fi
}

@test "_ff_version_gt works under strict mode, where a non-zero step would end the script" {
  run bash -c 'set -Eeuo pipefail; source "$1"; if _ff_version_gt 1.21.0 1.22.0; then echo newer; else echo older; fi; _ff_version_gt 1.22.0 1.22.0-rc1 && echo after' ff "$FF_SCRIPT"
  [ "$status" -eq 0 ]
  assert_out "older"
  assert_out "after"
}

@test "status: with FreeFrame not answering, the certificate line does not blame DNS" {
  export STUB_HEALTH_FAIL=1 STUB_CERT_FAIL=1
  ff status
  [ "$status" -eq 0 ]
  assert_out "Certificate:  not checked: FreeFrame's web entrance (Traefik) is not answering"
  assert_no_out "DNS records point here"
  # Answering but no certificate yet: then DNS is the thing to check.
  export STUB_HEALTH_FAIL=""
  ff status
  assert_out "Check that the DNS records point here"
}

@test "_ff_version_gt compares labels by byte, whatever the server's language" {
  local loc
  loc=$(locale -a 2>/dev/null | grep -i -m1 -E '^(en_US|de_DE)\.utf-?8$') || skip "no UTF-8 locale with dictionary order here"
  # In C order 'a' (97) comes after 'B' (66); a dictionary order puts a first.
  run env LC_ALL="$loc" bash -c 'source "$1"; _ff_version_gt 1.0.0-rc.a 1.0.0-rc.B' ff "$FF_SCRIPT"
  [ "$status" -eq 0 ]
}

# ---------------------------------------------------------------- status: video processing

@test "status gpu: the GPU in use, seen by the worker, is named" {
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready STUB_WORKER_GPU="GPU 0: NVIDIA GeForce RTX 5070 Ti (UUID: GPU-0d5e2b6c-1111-2222-3333-444455556666)"
  ff status
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qxF "  Video:        processed on the GPU (NVIDIA GeForce RTX 5070 Ti), with the CPU as a fallback" <<<"$output" ||
    { echo "$output"; false; }
  grep -qx "dc exec -T worker nvidia-smi -L" "$CALLS"
}

@test "status gpu: the GPU chosen but not seen by the worker says why, with the fix" {
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=notoolkit
  ff status
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "  Video:        on the CPU: the GPU is chosen (FREEFRAME_GPU=nvidia), but the worker does not see it"
  assert_out "the NVIDIA container toolkit is not set up for Docker"
  assert_out "sudo freeframe configure --yes --gpu nvidia"

  export STUB_GPU=ready
  ff status
  assert_out "To start the worker again with the GPU, run: sudo freeframe restart"

  export STUB_GPU=nodriver
  ff status
  assert_out "the NVIDIA driver on this server does not answer"
}

@test "status gpu: a stopped worker cannot be asked, and says so" {
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready STUB_WORKER_DOWN=1
  ff status
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "  Video:        set to the GPU, but the worker that processes video is not running"
}

@test "status gpu: the GPU chosen without the GPU file (an older release's set) says so" {
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready
  ff status
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "docker-compose.gpu.yml is missing"
  assert_not_called "dc exec -T worker nvidia-smi -L"
}

@test "status gpu: on the CPU, a GPU that could be used is pointed out" {
  export STUB_GPU=notoolkit
  ff status
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qxF "  Video:        processed on the CPU. This server's NVIDIA GPU (NVIDIA GeForce RTX 5070 Ti) is not used; to use it, run: sudo freeframe configure" <<<"$output" ||
    { echo "$output"; false; }
  assert_not_called "dc exec -T worker nvidia-smi -L"
}

@test "status gpu: on the CPU with no usable GPU, the reason is given" {
  local s want
  for s in none nodriver intel; do
    export STUB_GPU=$s
    ff status
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    case $s in
      none) want="  Video:        processed on the CPU (no GPU found)" ;;
      nodriver) want="  Video:        processed on the CPU (the NVIDIA driver is not working)" ;;
      intel) want="  Video:        processed on the CPU (the Intel GPU is not used with the published images)" ;;
    esac
    grep -qxF "$want" <<<"$output" || { echo "$output"; false; }
  done
}

@test "help: names --gpu and video processing" {
  run bash "$FF_SCRIPT" help
  [ "$status" -eq 0 ]
  assert_out "--gpu"
  assert_out "video"
}

@test "status gpu: asking the worker is bounded in time" {
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready STUB_WORKER_GPU="GPU 0: NVIDIA L4 (UUID: GPU-1)"
  ff status
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -qx "dc_bounded 30 exec -T worker nvidia-smi -L" "$CALLS" || { cat "$CALLS"; false; }
}

# ---------------------------------------------------------------- a GPU that breaks later

gpu_on() {
  printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"
  env_set "$ENV" FREEFRAME_GPU nvidia
}

@test "restart gpu: a GPU that works is used" {
  gpu_on
  export STUB_GPU=ready
  ff restart
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  grep -q '^files .*-f docker-compose.gpu.yml' "$CALLS" || { cat "$CALLS"; false; }
  assert_no_out "on the CPU"
}

@test "restart gpu: a GPU that broke (driver, toolkit) starts on the CPU, says so, and keeps the setting" {
  local s
  for s in nodriver notoolkit none; do
    gpu_on
    : >"$CALLS"
    export STUB_GPU=$s
    ff restart
    [ "$status" -eq 0 ] || { echo "$s: $output"; false; }
    assert_out "FreeFrame starts with video processing on the CPU until that is fixed"
    assert_out "FREEFRAME_GPU=nvidia is kept"
    assert_out "sudo freeframe restart"
    if grep -q '^files .*gpu' "$CALLS"; then cat "$CALLS"; false; fi
    grep -q '^files ' "$CALLS"
    assert_has "$ENV" "FREEFRAME_GPU=nvidia"
  done
}

@test "status gpu: after a start on the CPU fallback, status says the CPU and why" {
  gpu_on
  export STUB_GPU=nodriver
  ff status
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "  Video:        on the CPU: the GPU is chosen (FREEFRAME_GPU=nvidia), but the worker does not see it: the NVIDIA driver on this server does not answer"
}

@test "status gpu: TRANSCODER_PIPELINE forcing the CPU in .env.prod is named, even with the GPU visible" {
  gpu_on
  export STUB_GPU=ready STUB_WORKER_GPU="GPU 0: NVIDIA L4 (UUID: GPU-1)"
  local v
  for v in Software cpu Intel; do
    env_set "$ENV" TRANSCODER_PIPELINE "$v"
    ff status
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    assert_out "  Video:        processed on the CPU: TRANSCODER_PIPELINE=$v in $ENV keeps video off the GPU (the worker sees NVIDIA L4)"
    assert_no_out "processed on the GPU"
  done
  # NVIDIA and Auto both use it.
  for v in NVIDIA Auto; do
    env_set "$ENV" TRANSCODER_PIPELINE "$v"
    ff status
    assert_out "processed on the GPU (NVIDIA L4)"
  done
}

@test "status gpu: the older TRANSCODER_BACKEND=cpu under Auto is named too" {
  gpu_on
  env_set "$ENV" TRANSCODER_PIPELINE Auto
  env_set "$ENV" TRANSCODER_BACKEND cpu
  export STUB_GPU=ready STUB_WORKER_GPU="GPU 0: NVIDIA L4 (UUID: GPU-1)"
  ff status
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "processed on the CPU: TRANSCODER_BACKEND=cpu in $ENV keeps video off the GPU"
}


# ---------------------------------------------------------------- the worker's GPU, after a start

smi_asks() { grep -c '^dc exec -T worker nvidia-smi -L$' "$CALLS" || true; }
recreates() { grep -c '^dc up -d --no-build --no-deps --force-recreate worker$' "$CALLS" || true; }

@test "restart gpu worker: a worker that sees the GPU is asked once and left alone" {
  gpu_on
  export STUB_GPU=ready STUB_WORKER_SMI=pass
  ff restart
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(smi_asks)" 1
  assert_eq "$(recreates)" 0
  assert_order "dc up -d --no-build --force-recreate" "localhost:8000/health" "ps -q --status running worker" "exec -T worker nvidia-smi -L"
  assert_no_out "CPU"
}

@test "restart gpu worker: a worker that does not see the GPU is not created again (restart just did that, with no reload), and the CPU is said" {
  gpu_on
  export STUB_GPU=ready STUB_WORKER_SMI=fail
  ff restart
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(recreates)" 0
  assert_eq "$(smi_asks)" 1
  assert_out "FreeFrame is running again"
  assert_out "The worker could not use the NVIDIA GPU (NVIDIA GeForce RTX 5070 Ti), so video is processed on the CPU for now. What nvidia-smi said is in $FF_ROOT/install.log."
  assert_out "FREEFRAME_GPU=nvidia is kept. If video stays on the CPU, see https://github.com/Techiebutler/freeframe/blob/main/docs/deployment.md#troubleshooting-the-installer"
  # It does not send you to run the restart you just ran.
  assert_no_out "even after it was started again"
  assert_no_out "To try the GPU again, run: sudo freeframe restart"
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
  grep -qF "Failed to initialize NVML" "$FF_ROOT/install.log"
}

@test "restart gpu worker: with the GPU off, or left out for this start, nothing is asked" {
  export STUB_GPU=ready STUB_WORKER_SMI=fail
  ff restart
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called "nvidia-smi"
  assert_not_called "ps -q --status running worker"
  assert_not_called "no-deps"
  # The GPU chosen, but it broke: the start leaves the GPU file out, so
  # the worker is on the CPU and the start check said so already.
  gpu_on
  : >"$CALLS"
  export STUB_GPU=nodriver
  ff restart
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called "nvidia-smi"
  assert_not_called "no-deps"
}

@test "restart gpu worker: an answer that lists no GPU counts as not seeing it" {
  gpu_on
  export STUB_GPU=ready STUB_WORKER_SMI=nogpu
  ff restart
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(recreates)" 0
  assert_out "video is processed on the CPU for now"
  grep -qF "GPU self-check: the worker's nvidia-smi -L said: No devices were found (exit 0)" "$FF_ROOT/install.log" ||
    { cat "$FF_ROOT/install.log"; false; }
}

@test "restart gpu worker: a worker that is not running at all is not said to be on the CPU" {
  gpu_on
  export STUB_GPU=ready STUB_WORKER_SMI=fail STUB_WORKER_DOWN=1 FF_GPU_WORKER_WAIT=4
  ff restart
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(recreates)" 0
  assert_out "The worker that processes video is not running, so no video is processed until it starts. See why with: sudo freeframe logs worker"
  assert_no_out "on the CPU for now"
}
