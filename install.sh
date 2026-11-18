#!/bin/sh
# ============================================================
# FreeFrame installer: one command on a fresh Ubuntu or Debian server.
#
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/Techiebutler/freeframe/latest/install.sh)"
#
# This small script downloads the freeframe command from the same branch or
# tag and runs `freeframe install` from that download, with the terminal
# attached, so its questions can be answered. It writes nothing itself:
# `freeframe install` puts the command at /usr/local/bin/freeframe once its
# checks have passed and the install goes ahead, so a refused run leaves the
# server as it was.
#
# Answers can be given ahead of time. With bash -c, the word right after the
# script is only its name, so write install there and the options after it.
# sudo drops variables set before it, so put them after it:
#
#   sudo bash -c "$(curl -fsSL .../install.sh)" install --domain review.yourstudio.com
#   sudo FREEFRAME_CHANNEL=stable bash -c "$(curl -fsSL .../stable/install.sh)"
#
# Without a terminal (cloud-init, CI) every answer must be given ahead of
# time with --yes, and the script can then also arrive through a pipe:
#
#   curl -fsSL .../install.sh | sudo FREEFRAME_ADMIN_EMAIL=you@yourstudio.com bash -s -- --yes
#
# A piped run that asks questions does not work under sudo-rs (Ubuntu
# 26.04's sudo): the questions freeze. This script then stops before it
# downloads anything and shows the bash -c form instead.
#
# The branch or tag is --channel when given, otherwise FREEFRAME_CHANNEL,
# otherwise latest.
#
# Everything sits in main(), which runs on the last line, so a download that
# is cut short never runs half a script.
# ============================================================

RAW=https://raw.githubusercontent.com/Techiebutler/freeframe
GUIDE=https://github.com/Techiebutler/freeframe/blob/main/docs/deployment.md

# quote WORD: WORD as the shell needs it typed (in single quotes when it
# holds anything but plain characters).
quote() {
  case $1 in
    "" | *[!A-Za-z0-9._/=:@,+-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

# install_cmd REF [ARGS...]: the interactive install command for REF, which
# works with every sudo. FREEFRAME_CHANNEL is named for any ref but latest,
# because the script cannot see the address it was downloaded from.
# The $( ) is printed for the reader to type, never run here.
# shellcheck disable=SC2016
install_cmd() {
  cmd_ref=$1
  shift
  if [ "$cmd_ref" = latest ]; then
    printf 'sudo bash -c "$(curl -fsSL %s/%s/install.sh)"' "$RAW" "$cmd_ref"
  else
    printf 'sudo FREEFRAME_CHANNEL=%s bash -c "$(curl -fsSL %s/%s/install.sh)"' "$cmd_ref" "$RAW" "$cmd_ref"
  fi
  # Passwords and keys are never printed back (secret_options names them).
  cmd_skip=""
  cmd_first=1
  for cmd_arg in "$@"; do
    if [ -n "$cmd_skip" ]; then
      cmd_skip=""
      continue
    fi
    case $cmd_arg in
      --admin-password | --s3-secret-key | --smtp-password) cmd_skip=1 && continue ;;
      --admin-password=* | --s3-secret-key=* | --smtp-password=*) continue ;;
    esac
    if [ -n "$cmd_first" ]; then
      printf ' install'
      cmd_first=""
    fi
    printf ' %s' "$(quote "$cmd_arg")"
  done
  printf '\n'
}

# secret_options ARGS...: the password and key options among ARGS, one per
# line, each once. install_cmd leaves them out of the command it shows.
secret_options() {
  for opt_arg in "$@"; do
    case $opt_arg in
      --admin-password | --admin-password=*) echo --admin-password ;;
      --s3-secret-key | --s3-secret-key=*) echo --s3-secret-key ;;
      --smtp-password | --smtp-password=*) echo --smtp-password ;;
    esac
  done | awk '!seen[$0]++'
}

# and_list WORD...: "a", "a and b", "a, b and c".
and_list() {
  while [ $# -gt 2 ]; do
    printf '%s, ' "$1"
    shift
  done
  if [ $# -eq 2 ]; then printf '%s and %s' "$1" "$2"; else printf '%s' "$1"; fi
}

# secret_variable OPTION: the FREEFRAME_ variable for a password option.
secret_variable() {
  printf 'FREEFRAME_%s' "$(printf '%s' "${1#--}" | tr 'a-z-' 'A-Z_')"
}

# not_yet LEAD IF: a "What to try" (LEAD, then IF, as "If it can,") for a
# channel that may not have the installer yet. On latest there is no other
# channel to suggest.
not_yet() {
  if [ "$ref" = latest ]; then
    echo "What to try: $1 $2 the latest release may not have the installer yet (it needs a release after v1.21.0): wait for the next release, or set FreeFrame up by hand as the guide explains: $GUIDE" >&2
  else
    echo "What to try: $1 $2 the '$ref' channel may not have the installer yet:" >&2
    echo "  sudo FREEFRAME_CHANNEL=latest bash -c \"\$(curl -fsSL $RAW/latest/install.sh)\"" >&2
  fi
}

stdin_is_terminal() { [ -t 0 ]; }

# started_by_sudo_rs: 0 when sudo-rs started this script. The parent process
# says which sudo it is; when /proc cannot be read, sudo --version does.
# SUDO_USER is set only under sudo, so root's own shell never counts. Only
# the direct parent counts: measured on Ubuntu 26.04, sudo sh -c 'curl |
# bash' and a pipe typed in a sudo -i shell both read the keyboard fine;
# only curl | sudo bash freezes.
started_by_sudo_rs() {
  [ -n "${SUDO_USER:-}" ] || return 1
  if parent=$(readlink "/proc/$PPID/exe" 2>/dev/null) && [ -n "$parent" ]; then
    case $parent in
      *sudo-rs* | /usr/lib/cargo/bin/sudo) return 0 ;;
      *) return 1 ;;
    esac
  fi
  case $(sudo --version 2>/dev/null | head -n 1) in
    sudo-rs*) return 0 ;;
  esac
  return 1
}

# sudo_rs_would_freeze ARGS...: 0 when this run would ask questions with
# the script arriving through a pipe under sudo-rs. sudo-rs cannot pass the
# keyboard on then, so the first question would freeze with nothing shown.
# A run that asks nothing (--yes, FREEFRAME_YES, --help) is fine.
sudo_rs_would_freeze() {
  case ${FREEFRAME_YES:-} in
    1 | [Tt]rue | TRUE | [Yy]es | YES | [Yy]) return 1 ;;
  esac
  for arg in "$@"; do
    case $arg in
      -y | --yes | -h | --help) return 1 ;;
    esac
  done
  if stdin_is_terminal; then return 1; fi
  started_by_sudo_rs
}

main() {
  # Run as bash -c "$(curl ...)" WORD ARGS, WORD is $0. The documented WORD
  # is install; an option there (the word left out) would be lost, so it is
  # taken back (a login shell's own name, such as -bash, is not an option). A leading install word among the arguments is dropped too.
  case $0 in
    -- | -bash | -sh | -dash | -zsh | -ksh) ;;
    -?*) set -- "$0" "$@" ;;
  esac
  if [ "${1:-}" = install ]; then shift; fi

  ref=${FREEFRAME_CHANNEL:-latest}
  # The script must come from the channel it installs: --channel wins.
  prev=""
  for arg in "$@"; do
    case $arg in
      --channel=*) ref=${arg#--channel=} ;;
      *) [ "$prev" = --channel ] && ref=$arg ;;
    esac
    prev=$arg
  done
  case $ref in
    "" | -* | *[!A-Za-z0-9._/-]* | *..*)
      echo "The channel must be a branch or tag name such as stable or latest (it is '$ref')." >&2
      echo "What to try: leave it out, or use stable or latest, for example:" >&2
      echo "  $(install_cmd latest)" >&2
      exit 2
      ;;
  esac

  # Linux servers only. On a Mac this would otherwise only stop later, at
  # bash 3.2, without saying why.
  kernel=$(uname -s 2>/dev/null) || kernel=""
  if [ "$kernel" != Linux ]; then
    case $kernel in
      Darwin) what=macOS try="on a Mac, run FreeFrame with Docker Desktop and the manual setup in the guide: $GUIDE#quick-setup" ;;
      MINGW* | MSYS* | CYGWIN*) what=Windows try="on Windows, Ubuntu in WSL2 with systemd switched on works for trying FreeFrame (not for a team to rely on: its address changes when Windows restarts, and it stops when the PC sleeps). Otherwise use a Linux server, or the manual setup in the guide: $GUIDE#quick-setup" ;;
      *) what=${kernel:-an unknown system} try="use a Linux server, or the manual setup in the guide: $GUIDE#quick-setup" ;;
    esac
    echo "The FreeFrame installer is for Linux servers: Ubuntu 22.04, 24.04 or 26.04, or Debian 12 or 13, on amd64 or arm64." >&2
    echo "This computer runs $what, so nothing was changed." >&2
    echo "What to try: $try" >&2
    exit 1
  fi

  if sudo_rs_would_freeze "$@"; then
    echo "This server's sudo (sudo-rs, which Ubuntu 26.04 uses) cannot pass the keyboard to a script that arrives through a pipe, so the installer's questions would freeze. Nothing was changed." >&2
    echo "What to try: run the installer this way instead, which works with every sudo:" >&2
    echo "  $(install_cmd "$ref" "$@")" >&2
    secrets=$(secret_options "$@" | tr '\n' ' ')
    if [ -n "$secrets" ]; then
      vars=""
      for o in $secrets; do vars="$vars $(secret_variable "$o")"; done
      # shellcheck disable=SC2086 # option and variable names hold no spaces
      if [ "$(echo $secrets | wc -w)" -eq 1 ]; then
        echo "Passwords and keys are left out of that command: type $(and_list $secrets) again yourself, or give it as $(and_list $vars) after sudo (other users of this server can see options with ps, but not variables), or leave it out and type it when the installer asks." >&2
      else
        echo "Passwords and keys are left out of that command: type $(and_list $secrets) again yourself, or give them as $(and_list $vars) after sudo (other users of this server can see options with ps, but not variables), or leave them out and type them when the installer asks." >&2
      fi
    fi
    echo "To install without questions, keep the pipe and give every answer ahead of time with --yes; the guide shows how: $GUIDE" >&2
    exit 1
  fi

  if [ "$(id -u)" != 0 ]; then
    echo "Please run the installer as root." >&2
    echo "What to try: put sudo in front of bash:" >&2
    echo "  $(install_cmd "$ref")" >&2
    exit 2
  fi

  if ! command -v curl >/dev/null 2>&1 || ! command -v bash >/dev/null 2>&1; then
    echo "This server is missing curl or bash, which the installer needs." >&2
    echo "What to try: sudo apt-get install -y curl bash, then run the install command again." >&2
    exit 1
  fi

  url="$RAW/$ref/deploy/freeframe"
  tmp=$(mktemp) || exit 1

  # Quiet when it works: the first thing an interactive install shows is
  # the FreeFrame banner. A failure says so below.
  if ! curl -fsSL --retry 3 --max-time 60 "$url" -o "$tmp"; then
    rm -f "$tmp"
    echo "Could not download the freeframe command from $url" >&2
    not_yet "check that this server can reach raw.githubusercontent.com, then run the install command again." "If it can,"
    exit 1
  fi
  if [ "$(head -n 1 "$tmp")" != '#!/usr/bin/env bash' ] || ! bash -n "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    echo "What was downloaded from $url is not a complete freeframe command." >&2
    not_yet "run the install command again in a few minutes." "If it keeps happening,"
    exit 1
  fi

  # Under `curl | bash` this script's input is the download, so the
  # questions read the terminal instead, when there is one.
  rc=0
  if (: </dev/tty) 2>/dev/null; then
    bash "$tmp" install --channel "$ref" "$@" </dev/tty || rc=$?
  else
    bash "$tmp" install --channel "$ref" "$@" </dev/null || rc=$?
  fi
  rm -f "$tmp"
  exit "$rc"
}

# FREEFRAME_INSTALL_SH_NO_MAIN: for the tests, which source this file to
# check the functions above.
[ -n "${FREEFRAME_INSTALL_SH_NO_MAIN:-}" ] || main "$@"
