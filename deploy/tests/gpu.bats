#!/usr/bin/env bats
# GPU detection (detect_gpu), the decision whether video is processed on the
# GPU or the CPU (_gpu_decide), the words for it, and compose_files with the
# GPU file.
#
# Detection reads a fake system: FF_SYS_ROOT holds the /sys, /proc, /dev and
# /usr/lib/wsl files, and $BIN (first in PATH) holds fake nvidia-smi,
# nvidia-ctk and docker programs. Nothing here reaches a real GPU or Docker.

load helpers

setup() {
  common_setup
  export FF_SYS_ROOT="$BATS_TEST_TMPDIR/sys-root"
  mkdir -p "$FF_SYS_ROOT"
  BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$BIN"
  export PATH="$BIN:$PATH"
  # docker answers with only runc unless a test says otherwise.
  fake_docker "io.containerd.runc.v2 runc "
  F="$FF_ROOT/.env.prod"
}

# fake_prog NAME BODY: an executable NAME in $BIN running BODY.
fake_prog() {
  printf '#!/bin/sh\n%s\n' "$2" >"$BIN/$1"
  chmod +x "$BIN/$1"
}

# fake_docker RUNTIMES: `docker info` lists RUNTIMES (empty: docker fails).
fake_docker() {
  if [[ -z $1 ]]; then
    fake_prog docker 'echo "Cannot connect to the Docker daemon" >&2; exit 1'
  else
    fake_prog docker "case \"\$1\" in info) printf '%s\n' '$1' ;; *) exit 1 ;; esac"
  fi
}

# smi_answers NAME VERSION: an nvidia-smi that reports one GPU.
smi_body() { printf 'printf "%%s\\n" "%s, %s"' "$1" "$2"; }

# pci_display ID VENDOR: a PCI display device (class 0x03....).
pci_display() {
  mkdir -p "$FF_SYS_ROOT/sys/bus/pci/devices/$1"
  printf '0x030000\n' >"$FF_SYS_ROOT/sys/bus/pci/devices/$1/class"
  printf '%s\n' "$2" >"$FF_SYS_ROOT/sys/bus/pci/devices/$1/vendor"
}

# pci_other ID VENDOR: a PCI device that is not a display (a NIC).
pci_other() {
  mkdir -p "$FF_SYS_ROOT/sys/bus/pci/devices/$1"
  printf '0x020000\n' >"$FF_SYS_ROOT/sys/bus/pci/devices/$1/class"
  printf '%s\n' "$2" >"$FF_SYS_ROOT/sys/bus/pci/devices/$1/vendor"
}

# render_node NAME VENDOR: /dev/dri/NAME with its sysfs vendor.
render_node() {
  mkdir -p "$FF_SYS_ROOT/dev/dri" "$FF_SYS_ROOT/sys/class/drm/$1/device"
  : >"$FF_SYS_ROOT/dev/dri/$1"
  printf '%s\n' "$2" >"$FF_SYS_ROOT/sys/class/drm/$1/device/vendor"
}

# wsl_smi NAME VERSION: the WSL2 layout: nvidia-smi only in /usr/lib/wsl/lib
# (not on PATH), /dev/dxg, and no /proc/driver/nvidia.
wsl_smi() {
  mkdir -p "$FF_SYS_ROOT/usr/lib/wsl/lib" "$FF_SYS_ROOT/dev"
  printf '#!/bin/sh\n%s\n' "$(smi_body "$1" "$2")" >"$FF_SYS_ROOT/usr/lib/wsl/lib/nvidia-smi"
  chmod +x "$FF_SYS_ROOT/usr/lib/wsl/lib/nvidia-smi"
  : >"$FF_SYS_ROOT/dev/dxg"
}

gpu_vars() { printf '%s|%s|%s|%s|%s' "$FF_GPU_VENDOR" "$FF_GPU_NAME" "$FF_GPU_DRIVER" "$FF_GPU_STATE" "$FF_GPU_WSL"; }

# ---------------------------------------------------------------- detection

@test "gpu detect: WSL2 with an RTX 5070 Ti and no toolkit (nvidia-smi only in /usr/lib/wsl/lib)" {
  wsl_smi "NVIDIA GeForce RTX 5070 Ti" 610.47
  run command -v nvidia-smi
  [ "$status" -ne 0 ]
  detect_gpu
  assert_eq "$(gpu_vars)" "nvidia|NVIDIA GeForce RTX 5070 Ti|610.47|notoolkit|1"
  assert_eq "$(_gpu_line)" "GPU: NVIDIA GeForce RTX 5070 Ti (driver 610.47)"
}

@test "gpu detect: a native NVIDIA card with the toolkit and Docker's nvidia runtime is ready" {
  pci_display 0000:01:00.0 0x10de
  fake_prog nvidia-smi "$(smi_body "NVIDIA L4" 580.95.05)"
  fake_prog nvidia-ctk 'exit 0'
  fake_docker "io.containerd.runc.v2 nvidia runc "
  detect_gpu
  assert_eq "$(gpu_vars)" "nvidia|NVIDIA L4|580.95.05|ready|"
}

@test "gpu detect: the toolkit is installed but Docker has no nvidia runtime yet" {
  pci_display 0000:01:00.0 0x10de
  fake_prog nvidia-smi "$(smi_body "NVIDIA L4" 580.95.05)"
  fake_prog nvidia-ctk 'exit 0'
  detect_gpu
  assert_eq "$FF_GPU_STATE" noruntime
}

@test "gpu detect: Docker that does not answer counts as no nvidia runtime" {
  pci_display 0000:01:00.0 0x10de
  fake_prog nvidia-smi "$(smi_body "NVIDIA L4" 580.95.05)"
  fake_prog nvidia-ctk 'exit 0'
  fake_docker ""
  detect_gpu
  assert_eq "$FF_GPU_STATE" noruntime
}

@test "gpu detect: nvidia-container-toolkit alone counts as the toolkit" {
  pci_display 0000:01:00.0 0x10de
  fake_prog nvidia-smi "$(smi_body "NVIDIA L4" 580.95.05)"
  fake_prog nvidia-container-toolkit 'exit 0'
  fake_docker "nvidia runc "
  detect_gpu
  assert_eq "$FF_GPU_STATE" ready
}

@test "gpu detect: an NVIDIA card whose nvidia-smi fails has no working driver" {
  pci_display 0000:01:00.0 0x10de
  fake_prog nvidia-smi 'echo "NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver." >&2; exit 9'
  detect_gpu
  assert_eq "$(gpu_vars)" "nvidia|NVIDIA||nodriver|"
  assert_eq "$(_gpu_line)" "GPU: NVIDIA (no working driver)"
}

@test "gpu detect: an NVIDIA card with no nvidia-smi at all has no working driver" {
  pci_display 0000:01:00.0 0x10de
  detect_gpu
  assert_eq "$FF_GPU_VENDOR|$FF_GPU_STATE" "nvidia|nodriver"
}

@test "gpu detect: /proc/driver/nvidia alone shows an NVIDIA card" {
  mkdir -p "$FF_SYS_ROOT/proc/driver/nvidia"
  detect_gpu
  assert_eq "$FF_GPU_VENDOR|$FF_GPU_STATE" "nvidia|nodriver"
}

@test "gpu detect: nvidia-smi that answers with nothing usable is no working driver" {
  pci_display 0000:01:00.0 0x10de
  fake_prog nvidia-smi 'echo "No devices were found"'
  detect_gpu
  assert_eq "$FF_GPU_STATE" nodriver
}

@test "gpu detect: an nvidia-smi that hangs is given up on" {
  pci_display 0000:01:00.0 0x10de
  fake_prog nvidia-smi 'exec sleep 30'
  export FF_GPU_SMI_TIMEOUT=1
  local t0=$SECONDS
  detect_gpu
  assert_eq "$FF_GPU_STATE" nodriver
  ((SECONDS - t0 < 10))
}

@test "gpu detect: an Intel render node is Intel, not used with the published images" {
  render_node renderD128 0x8086
  detect_gpu
  assert_eq "$FF_GPU_VENDOR|$FF_GPU_STATE" "intel|unsupported"
  assert_eq "$(_gpu_line)" "GPU: Intel (not used with the published images)"
}

@test "gpu detect: an AMD render node is AMD" {
  render_node renderD128 0x1002
  detect_gpu
  assert_eq "$FF_GPU_VENDOR|$FF_GPU_STATE" "amd|unsupported"
  assert_eq "$(_gpu_line)" "GPU: AMD (not used with the published images)"
}

@test "gpu detect: an Intel display device with no render node is still Intel" {
  pci_display 0000:00:02.0 0x8086
  detect_gpu
  assert_eq "$FF_GPU_VENDOR" intel
}

@test "gpu detect: NVIDIA wins over an Intel integrated GPU" {
  render_node renderD128 0x8086
  pci_display 0000:00:02.0 0x8086
  pci_display 0000:01:00.0 0x10de
  fake_prog nvidia-smi "$(smi_body "NVIDIA GeForce RTX 4060" 575.64)"
  detect_gpu
  assert_eq "$FF_GPU_VENDOR|$FF_GPU_NAME|$FF_GPU_STATE" "nvidia|NVIDIA GeForce RTX 4060|notoolkit"
}

@test "gpu detect: nothing at all, or only a server's BMC display and a NIC, is no GPU" {
  detect_gpu
  assert_eq "$(gpu_vars)" "none|||none|"
  assert_eq "$(_gpu_line)" "GPU: none found"
  pci_display 0000:02:00.0 0x1a03
  pci_other 0000:03:00.0 0x8086
  detect_gpu
  assert_eq "$FF_GPU_VENDOR" none
}

@test "gpu detect: an NVIDIA render node (nouveau) with no driver of NVIDIA's is no working driver" {
  render_node renderD128 0x10de
  detect_gpu
  assert_eq "$FF_GPU_VENDOR|$FF_GPU_STATE" "nvidia|nodriver"
}

@test "gpu detect: several GPUs name the first" {
  pci_display 0000:01:00.0 0x10de
  fake_prog nvidia-smi 'printf "%s\n" "NVIDIA L4, 580.95.05" "NVIDIA L4, 580.95.05"'
  detect_gpu
  assert_eq "$FF_GPU_NAME|$FF_GPU_DRIVER" "NVIDIA L4|580.95.05"
}

# ---------------------------------------------------------------- decision

# gpu STATE [NAME]: the detection result, set by hand.
gpu() {
  FF_GPU_STATE=$1 FF_GPU_WSL="" FF_GPU_DRIVER="" FF_GPU_NAME=""
  case $1 in
    ready | notoolkit | noruntime) FF_GPU_VENDOR=nvidia FF_GPU_NAME=${2:-NVIDIA GeForce RTX 5070 Ti} FF_GPU_DRIVER=610.47 ;;
    nodriver) FF_GPU_VENDOR=nvidia FF_GPU_NAME=NVIDIA ;;
    unsupported)
      FF_GPU_VENDOR=${2:-intel} FF_GPU_NAME=Intel
      [[ $FF_GPU_VENDOR != amd ]] || FF_GPU_NAME=AMD
      ;;
    none) FF_GPU_VENDOR=none ;;
  esac
}

decided() { printf '%s|%s|%s' "$FF_GPU" "${FF_GPU_SETUP:-}" "${FF_GPU_ASK:-}"; }

with_tty() {
  printf '\n' >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
}

@test "gpu decide: a ready GPU is used, with no question" {
  gpu ready
  with_tty
  _gpu_decide "$F"
  assert_eq "$(decided)" "nvidia||"
  assert_eq "$FF_GPU_NOTE" ""
}

@test "gpu decide: a working GPU without the toolkit is asked about when there is a terminal" {
  gpu notoolkit
  with_tty
  _gpu_decide "$F"
  assert_eq "$(decided)" "off||1"
  gpu noruntime
  FF_GPU=""
  _gpu_decide "$F"
  assert_eq "$(decided)" "off||1"
}

@test "gpu decide: unattended, the toolkit is set up only with --gpu nvidia" {
  gpu notoolkit
  FF_YES=1
  _gpu_decide "$F"
  assert_eq "$(decided)" "off||"
  [[ $FF_GPU_NOTE == *"--gpu nvidia"* && $FF_GPU_NOTE == *"sudo freeframe configure"* ]] || { echo "$FF_GPU_NOTE"; false; }
  [[ $FF_GPU_WHY == "the NVIDIA container toolkit is not set up" ]] || { echo "$FF_GPU_WHY"; false; }
  FF_GPU=nvidia
  _gpu_decide "$F"
  assert_eq "$(decided)" "nvidia|1|"
}

@test "gpu decide: --gpu nvidia with a ready GPU needs no set-up and no question" {
  gpu ready
  with_tty
  FF_GPU=nvidia
  _gpu_decide "$F"
  assert_eq "$(decided)" "nvidia||"
}

@test "gpu decide: --gpu off keeps the CPU even with a ready GPU" {
  gpu ready
  with_tty
  FF_GPU=off
  _gpu_decide "$F"
  assert_eq "$(decided)" "off||"
  assert_eq "$FF_GPU_WHY" "chosen with --gpu off"
}

@test "gpu decide: an NVIDIA card without a working driver stays on the CPU and suggests the driver" {
  gpu nodriver
  with_tty
  _ff_os_field() { [[ $1 == ID ]] && printf ubuntu; }
  _gpu_decide "$F"
  assert_eq "$(decided)" "off||"
  [[ $FF_GPU_NOTE == *"sudo ubuntu-drivers install"* && $FF_GPU_NOTE == *"reboot"* ]] || { echo "$FF_GPU_NOTE"; false; }
  # The command has a line of its own.
  grep -qx 'sudo ubuntu-drivers install' <<<"$FF_GPU_NOTE" || { echo "$FF_GPU_NOTE"; false; }
  assert_eq "$FF_GPU_WHY" "the NVIDIA driver is not working"
}

@test "gpu decide: on Debian the driver hint names Debian's guide" {
  gpu nodriver
  _ff_os_field() { [[ $1 == ID ]] && printf debian; }
  _gpu_decide "$F"
  [[ $FF_GPU_NOTE == *"wiki.debian.org/NvidiaGraphicsDrivers"* ]] || { echo "$FF_GPU_NOTE"; false; }
}

@test "gpu decide: on WSL2 the driver hint is the Windows driver" {
  gpu nodriver
  FF_GPU_WSL=1
  _gpu_decide "$F"
  [[ $FF_GPU_NOTE == *"Windows"* && $FF_GPU_NOTE == *"wsl --shutdown"* ]] || { echo "$FF_GPU_NOTE"; false; }
  [[ $FF_GPU_NOTE != *"ubuntu-drivers"* ]] || { echo "$FF_GPU_NOTE"; false; }
}

@test "gpu decide: --gpu nvidia without a usable NVIDIA GPU continues on the CPU and says why" {
  gpu none
  FF_YES=1 FF_GPU=nvidia
  _gpu_decide "$F"
  assert_eq "$(decided)" "off||"
  [[ $FF_GPU_NOTE == *"--gpu nvidia was given"* && $FF_GPU_NOTE == *"no NVIDIA GPU"* ]] || { echo "$FF_GPU_NOTE"; false; }
  gpu nodriver
  FF_GPU=nvidia
  _gpu_decide "$F"
  assert_eq "$(decided)" "off||"
  [[ $FF_GPU_NOTE == *"--gpu nvidia was given"* && $FF_GPU_NOTE == *"driver"* ]] || { echo "$FF_GPU_NOTE"; false; }
}

@test "gpu decide: Intel and AMD stay on the CPU, with the guide's GPU section" {
  local v
  for v in intel amd; do
    gpu unsupported "$v"
    FF_GPU=""
    _gpu_decide "$F"
    assert_eq "$(decided)" "off||"
    [[ $FF_GPU_NOTE == *"$FF_GUIDE_URL#hardware-accelerated-transcoding-optional"* ]] || { echo "$FF_GPU_NOTE"; false; }
  done
  assert_eq "$FF_GPU_WHY" "the AMD GPU is not used with the published images"
}

@test "gpu decide: no GPU is the CPU with no note and no question" {
  gpu none
  with_tty
  _gpu_decide "$F"
  assert_eq "$(decided)" "off||"
  assert_eq "$FF_GPU_NOTE" ""
  assert_eq "$FF_GPU_WHY" "no GPU found"
}

@test "gpu decide: an unknown --gpu value is a usage error" {
  gpu ready
  FF_GPU=cuda
  run _gpu_decide "$F"
  [ "$status" -eq 2 ]
  [[ $output == *"nvidia or off"* ]] || { echo "$output"; false; }
}

@test "gpu decide: the settings file's choice wins on a re-run" {
  gpu ready
  with_tty
  printf 'FREEFRAME_GPU=off\n' >"$F"
  FF_GPU=nvidia
  _gpu_decide "$F"
  assert_eq "$(decided)" "off||"
  assert_eq "$FF_GPU_WHY" "as in the existing settings"

  printf 'FREEFRAME_GPU=nvidia\n' >"$F"
  FF_GPU=""
  gpu notoolkit
  _gpu_decide "$F"
  # Chosen before: set up without asking again.
  assert_eq "$(decided)" "nvidia|1|"
}

@test "gpu decide: a settings file asking for the GPU on a server without one is turned to the CPU" {
  printf 'FREEFRAME_GPU=nvidia\n' >"$F"
  gpu none
  _gpu_decide "$F"
  assert_eq "$(decided)" "off||"
  assert_eq "${FF_GPU_FORCE_OFF:-}" 1
  [[ $FF_GPU_NOTE == *"FREEFRAME_GPU=nvidia"* ]] || { echo "$FF_GPU_NOTE"; false; }
}

# ---------------------------------------------------------------- words

@test "gpu words: the summary says GPU or CPU, with the reason" {
  gpu ready
  FF_GPU=nvidia FF_GPU_SETUP=""
  assert_eq "$(_gpu_summary)" "processed on the GPU (NVIDIA GeForce RTX 5070 Ti), with the CPU as a fallback"
  FF_GPU_SETUP=1
  [[ $(_gpu_summary) == "processed on the GPU (NVIDIA GeForce RTX 5070 Ti), with the CPU as a fallback; the NVIDIA container toolkit is set up first"* ]] || { _gpu_summary; false; }
  gpu none
  FF_GPU=off FF_GPU_WHY="no GPU found"
  assert_eq "$(_gpu_summary)" "processed on the CPU (no GPU found)"
  assert_eq "$(_gpu_ready_line)" "Video processing: CPU (no GPU found)"
  gpu ready
  FF_GPU=nvidia
  assert_eq "$(_gpu_ready_line)" "Video processing: GPU (NVIDIA GeForce RTX 5070 Ti)"
}

# ---------------------------------------------------------------- compose_files

@test "compose_files: FREEFRAME_GPU=nvidia adds the GPU file last, when it is there" {
  printf 'FREEFRAME_HTTPS=off\nFREEFRAME_STORAGE=bundled\nFREEFRAME_GPU=nvidia\n' >"$F"
  : >"$FF_ROOT/docker-compose.gpu.yml"
  assert_eq "$(compose_files "$F")" \
    "-f docker-compose.prod.yml -f docker-compose.images.yml -f docker-compose.storage.yml -f docker-compose.gpu.yml"
}

@test "compose_files: no GPU file without FREEFRAME_GPU=nvidia" {
  : >"$FF_ROOT/docker-compose.gpu.yml"
  printf 'FREEFRAME_HTTPS=sslip\nFREEFRAME_STORAGE=bundled\nFREEFRAME_GPU=off\n' >"$F"
  assert_eq "$(compose_files "$F")" \
    "-f docker-compose.prod.yml -f docker-compose.images.yml -f docker-compose.https.yml -f docker-compose.storage.yml"
  printf 'FREEFRAME_HTTPS=off\nFREEFRAME_STORAGE=s3\n' >"$F"
  assert_eq "$(compose_files "$F")" "-f docker-compose.prod.yml -f docker-compose.images.yml"
}

@test "compose_files: FREEFRAME_GPU=nvidia without the file (an older release's set) leaves it out" {
  printf 'FREEFRAME_HTTPS=off\nFREEFRAME_STORAGE=s3\nFREEFRAME_GPU=nvidia\n' >"$F"
  assert_eq "$(compose_files "$F")" "-f docker-compose.prod.yml -f docker-compose.images.yml"
}

@test "derive_env: writes FREEFRAME_GPU only when it was decided, fill-missing" {
  FF_IP=203.0.113.7 FF_HTTPS=off
  derive_env "$F"
  assert_no_key "$F" FREEFRAME_GPU
  FF_GPU=nvidia derive_env "$F"
  assert_has "$F" FREEFRAME_GPU=nvidia
  FF_GPU=off derive_env "$F"
  assert_has "$F" FREEFRAME_GPU=nvidia
}

@test "parse_args: --gpu and FREEFRAME_GPU are answers" {
  parse_args install --gpu nvidia
  assert_eq "$FF_GPU" nvidia
  FREEFRAME_GPU=off parse_args install
  assert_eq "$FF_GPU" off
}

# ---------------------------------------------------------------- install_nvidia_toolkit

# toolkit_stubs: apt, curl, gpg, systemctl and install, logged to $TK; the
# keyring and sources list go under $BATS_TEST_TMPDIR. Installing the
# package brings nvidia-ctk, as the real package does.
toolkit_stubs() {
  TK="$BATS_TEST_TMPDIR/toolkit-calls"
  : >"$TK"
  export FF_NVIDIA_KEYRING="$BATS_TEST_TMPDIR/keyrings/nvidia-container-toolkit-keyring.gpg"
  export FF_NVIDIA_LIST="$BATS_TEST_TMPDIR/sources.list.d/nvidia-container-toolkit.list"
  export FF_DOCKER_DAEMON_JSON="$BATS_TEST_TMPDIR/docker/daemon.json"
  mkdir -p "$(dirname "$FF_NVIDIA_LIST")"
  run_apt() {
    printf 'run_apt %s\n' "$*" >>"$TK"
    [[ -z ${APT_FAIL:-} || $* != *"$APT_FAIL"* ]] || return 1
    if [[ $* == "install nvidia-container-toolkit" ]]; then
      nvidia-ctk() { printf 'nvidia-ctk %s\n' "$*" >>"$TK"; }
    fi
  }
  curl() {
    local out="" url="" a
    while (($#)); do
      a=$1
      shift
      case $a in
        -o) out=$1; shift ;;
        https://*) url=$a ;;
      esac
    done
    printf 'curl %s\n' "$url" >>"$TK"
    case $url in
      */gpgkey) printf -- '-----BEGIN PGP PUBLIC KEY BLOCK-----\n' >"$out" ;;
      */nvidia-container-toolkit.list) printf '%s\n' "${LIST_BODY-deb https://nvidia.github.io/libnvidia-container/stable/deb/\$(ARCH) /}" >"$out" ;;
    esac
  }
  gpg() {
    printf 'gpg %s\n' "$*" >>"$TK"
    local o="" a
    while (($#)); do
      a=$1
      shift
      [[ $a != -o ]] || { o=$1; shift; }
    done
    printf 'dearmored\n' >"$o"
  }
  systemctl() { printf 'systemctl %s\n' "$*" >>"$TK"; }
}

@test "install_nvidia_toolkit: NVIDIA's apt steps, then Docker set up for it and restarted" {
  toolkit_stubs
  install_nvidia_toolkit
  # The order, and that each step ran.
  local want got
  got=$(sed 's/ -o .*//; s#/tmp/[^ ]*##' "$TK")
  want=$(printf '%s\n' "run_apt update" \
    "run_apt install --no-install-recommends ca-certificates curl gnupg" \
    "curl https://nvidia.github.io/libnvidia-container/gpgkey" \
    "gpg --batch --yes --dearmor" \
    "curl https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list" \
    "run_apt update" "run_apt install nvidia-container-toolkit" \
    "nvidia-ctk runtime configure --runtime=docker" "systemctl restart docker")
  assert_eq "$got" "$want"
  assert_eq "$(cat "$FF_NVIDIA_LIST")" \
    "deb [signed-by=$FF_NVIDIA_KEYRING] https://nvidia.github.io/libnvidia-container/stable/deb/\$(ARCH) /"
  [ -s "$FF_NVIDIA_KEYRING" ]
}

@test "install_nvidia_toolkit: with the toolkit already there, only Docker is set up and restarted" {
  toolkit_stubs
  nvidia-ctk() { printf 'nvidia-ctk %s\n' "$*" >>"$TK"; }
  install_nvidia_toolkit
  assert_eq "$(cat "$TK")" "$(printf '%s\n' "nvidia-ctk runtime configure --runtime=docker" "systemctl restart docker")"
  [ ! -e "$FF_NVIDIA_LIST" ]
}

@test "install_nvidia_toolkit: a failed package install removes the sources list again and changes Docker not at all" {
  toolkit_stubs
  APT_FAIL="install nvidia-container-toolkit"
  run install_nvidia_toolkit
  [ "$status" -ne 0 ]
  [ ! -e "$FF_NVIDIA_LIST" ]
  if grep -q 'nvidia-ctk\|systemctl' "$TK"; then cat "$TK"; false; fi
}

@test "install_nvidia_toolkit: a sources list that is not one (an error page) is never written" {
  toolkit_stubs
  LIST_BODY='<html>rate limited</html>'
  run install_nvidia_toolkit
  [ "$status" -ne 0 ]
  [ ! -e "$FF_NVIDIA_LIST" ]
  if grep -q 'install nvidia-container-toolkit' "$TK"; then cat "$TK"; false; fi
}

@test "_gpu_setup: ready once Docker lists the nvidia runtime; not when it never does" {
  install_nvidia_toolkit() { :; }
  ff_sleep() { :; }
  local n=0
  detect_gpu() {
    n=$((n + 1))
    FF_GPU_STATE=noruntime
    ((n < 3)) || FF_GPU_STATE=ready
  }
  _gpu_setup
  ((n == 3))
  detect_gpu() { FF_GPU_STATE=noruntime; }
  FF_DOCKER_WAIT=6 run _gpu_setup
  [ "$status" -ne 0 ]
  install_nvidia_toolkit() { return 1; }
  run _gpu_setup
  [ "$status" -ne 0 ]
}

@test "install_nvidia_toolkit: Docker's daemon.json is backed up before nvidia-ctk changes it" {
  toolkit_stubs
  export FF_DOCKER_DAEMON_JSON="$BATS_TEST_TMPDIR/docker/daemon.json"
  mkdir -p "$(dirname "$FF_DOCKER_DAEMON_JSON")"
  printf '{"log-driver": "local"}\n' >"$FF_DOCKER_DAEMON_JSON"
  nvidia-ctk() {
    printf 'nvidia-ctk %s\n' "$*" >>"$TK"
    printf '{"runtimes": {}}\n' >"$FF_DOCKER_DAEMON_JSON"
  }
  install_nvidia_toolkit
  [ -n "$FF_GPU_DAEMON_BACKUP" ]
  [[ $FF_GPU_DAEMON_BACKUP == "$FF_DOCKER_DAEMON_JSON".before-freeframe-nvidia-* ]]
  assert_eq "$(cat "$FF_GPU_DAEMON_BACKUP")" '{"log-driver": "local"}'
  assert_eq "$(_gpu_daemon_undo)" "sudo cp $FF_GPU_DAEMON_BACKUP $FF_DOCKER_DAEMON_JSON && sudo systemctl restart docker"
}

@test "install_nvidia_toolkit: with no daemon.json before, the undo removes the one nvidia-ctk wrote" {
  toolkit_stubs
  export FF_DOCKER_DAEMON_JSON="$BATS_TEST_TMPDIR/docker/daemon.json"
  nvidia-ctk() { printf 'nvidia-ctk %s\n' "$*" >>"$TK"; }
  install_nvidia_toolkit
  assert_eq "$FF_GPU_DAEMON_BACKUP" ""
  assert_eq "$(_gpu_daemon_undo)" "sudo rm -f $FF_DOCKER_DAEMON_JSON && sudo systemctl restart docker"
}

@test "gpu detect: an nvidia-smi that ignores the stop signal is killed" {
  pci_display 0000:01:00.0 0x10de
  fake_prog nvidia-smi 'trap "" TERM; exec sleep 30'
  export FF_GPU_SMI_TIMEOUT=1
  local t0=$SECONDS
  detect_gpu
  assert_eq "$FF_GPU_STATE" nodriver
  ((SECONDS - t0 < 15))
}

@test "gpu detect: a docker info that ignores the stop signal is killed" {
  pci_display 0000:01:00.0 0x10de
  fake_prog nvidia-smi "$(smi_body "NVIDIA L4" 580.95.05)"
  fake_prog nvidia-ctk 'exit 0'
  fake_prog docker 'trap "" TERM; exec sleep 30'
  export FF_DOCKER_INFO_TIMEOUT=1
  local t0=$SECONDS
  detect_gpu
  assert_eq "$FF_GPU_STATE" noruntime
  ((SECONDS - t0 < 15))
}

@test "dc_bounded: docker compose that hangs is stopped after the time given" {
  printf 'FREEFRAME_HTTPS=off\n' >"$F"
  fake_prog docker 'trap "" TERM; exec sleep 30'
  local t0=$SECONDS
  run dc_bounded 1 exec -T worker nvidia-smi -L
  # 124 or 137: timeout stopped it (not "command not found").
  [[ $status == 124 || $status == 137 ]] || { echo "status $status: $output"; false; }
  ((SECONDS - t0 < 15))
}

@test "_gpu_other_containers: counts running containers that are not FreeFrame's" {
  fake_prog docker 'case "$1" in ps) printf "%s\n" freeframe freeframe "" other ;; esac'
  assert_eq "$(_gpu_other_containers)" 2
  fake_prog docker 'case "$1" in ps) printf "%s\n" freeframe ;; esac'
  assert_eq "$(_gpu_other_containers)" 0
  fake_prog docker 'exit 0'
  assert_eq "$(_gpu_other_containers)" 0
  fake_docker ""
  assert_eq "$(_gpu_other_containers)" 0
}

@test "install_nvidia_toolkit: an admin's own NVIDIA sources list comes back when the install fails" {
  toolkit_stubs
  printf 'deb [arch=amd64] https://mirror.example/nvidia /\n' >"$FF_NVIDIA_LIST"
  APT_FAIL="install nvidia-container-toolkit"
  run install_nvidia_toolkit
  [ "$status" -ne 0 ]
  assert_eq "$(cat "$FF_NVIDIA_LIST")" "deb [arch=amd64] https://mirror.example/nvidia /"
}

@test "install_nvidia_toolkit: an admin's own NVIDIA sources list is never deleted when the download fails" {
  toolkit_stubs
  printf 'deb [arch=amd64] https://mirror.example/nvidia /\n' >"$FF_NVIDIA_LIST"
  LIST_BODY='<html>rate limited</html>'
  run install_nvidia_toolkit
  [ "$status" -ne 0 ]
  assert_eq "$(cat "$FF_NVIDIA_LIST")" "deb [arch=amd64] https://mirror.example/nvidia /"
}

@test "install_nvidia_toolkit: an admin's own NVIDIA sources list is kept aside when NVIDIA's replaces it" {
  toolkit_stubs
  printf 'deb [arch=amd64] https://mirror.example/nvidia /\n' >"$FF_NVIDIA_LIST"
  install_nvidia_toolkit
  [[ $(cat "$FF_NVIDIA_LIST") == "deb [signed-by="* ]]
  local kept
  kept=$(ls "$BATS_TEST_TMPDIR"/nvidia-container-toolkit.list.before-freeframe-*)
  assert_eq "$(cat "$kept")" "deb [arch=amd64] https://mirror.example/nvidia /"
  # Not inside sources.list.d, where apt would read or warn about it.
  [ -z "$(ls "$(dirname "$FF_NVIDIA_LIST")" | grep -v '^nvidia-container-toolkit.list$')" ]
}

@test "gpu detect: keeps nvidia-smi's own line for the log" {
  wsl_smi "NVIDIA GeForce RTX 5070 Ti" 610.47
  detect_gpu
  assert_eq "$FF_GPU_SMI_LINE" "NVIDIA GeForce RTX 5070 Ti, 610.47"
  detect_gpu_none() { :; }
  rm -rf "$FF_SYS_ROOT/usr"
  detect_gpu
  assert_eq "$FF_GPU_SMI_LINE" ""
}


@test "_gpu_worker_log: each line of the worker check starts a line of its own in the log" {
  export FF_LOG="$BATS_TEST_TMPDIR/install.log"
  printf '{"status":"ok"}' >"$FF_LOG"
  _gpu_worker_log "the worker sees the GPU (NVIDIA L4)"
  _gpu_worker_log "second"
  assert_eq "$(cat "$FF_LOG")" "$(printf '%s\n' '{"status":"ok"}' 'GPU self-check: the worker sees the GPU (NVIDIA L4)' 'GPU self-check: second')"
  # No log: nothing, and no failure.
  FF_LOG="" _gpu_worker_log "nowhere"
}

@test "_gpu_list_name: the name in nvidia-smi -L's first line" {
  assert_eq "$(_gpu_list_name $'GPU 0: NVIDIA GeForce RTX 5070 Ti (UUID: GPU-e3f1c5ac)\r\nGPU 1: NVIDIA L4 (UUID: GPU-2)')" "NVIDIA GeForce RTX 5070 Ti"
}

@test "_gpu_worker_wait: bounded by the clock, not only by its pauses (each look can take long)" {
  local n=0
  _gpu_worker_running() { n=$((n + 1)); sleep 2; return 1; }
  ff_sleep() { :; }
  FF_GPU_WORKER_WAIT=4
  run_wait() { _gpu_worker_wait; }
  if run_wait; then false; fi
  # Counting only the 2 s pauses would look 3 times (0, 2, 4); the clock
  # stops it after 2 looks (4 s).
  assert_eq "$n" 2
}

@test "_gpu_worker_say: no log, no word about where nvidia-smi's answer is" {
  FF_GPU_WORKER=unseen FF_GPU_NAME="NVIDIA L4" FF_LOG=""
  run _gpu_worker_say
  [[ $output == *"video is processed on the CPU for now."* ]]
  [[ $output != *"What nvidia-smi said"* ]]
  unset FF_LOG
  run _gpu_worker_say
  [[ $output != *"What nvidia-smi said"* ]]
  FF_LOG=/x/install.log
  run _gpu_worker_say
  [[ $output == *"What nvidia-smi said is in /x/install.log."* ]]
}
