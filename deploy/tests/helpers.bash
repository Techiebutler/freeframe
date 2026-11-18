# Shared setup for the deploy/freeframe bats tests.
# The script is sourced, never executed with a real subcommand, and every
# external program with side effects (docker, getent) is stubbed per test.

FF_SCRIPT="${BATS_TEST_DIRNAME}/../freeframe"

common_setup() {
  # Start every test from a clean slate: no answer or root variables leak in
  # from the caller's environment.
  local v
  for v in $(compgen -v | grep -E '^(FREEFRAME|FF)_' || true); do
    unset "$v"
  done
  # The screen width and colour come from the terminal, not from the shell
  # the suite runs in.
  unset COLUMNS NO_COLOR
  FF_SCRIPT="${BATS_TEST_DIRNAME}/../freeframe"
  export FF_ROOT="$BATS_TEST_TMPDIR/root"
  mkdir -p "$FF_ROOT"
  # A path that does not exist: "no terminal" unless a test says otherwise.
  export FF_TTY="$BATS_TEST_TMPDIR/no-tty"
  # shellcheck source=../freeframe
  source "$FF_SCRIPT"
}

# Run a command in a fresh bash with the script sourced under the same strict
# mode it uses when executed (set -Eeuo pipefail), so unbound variables and
# failing pipelines show up in tests.
ff_strict() {
  bash -c 'set -Eeuo pipefail; source "$1"; shift; "$@"' ff-strict "$FF_SCRIPT" "$@"
}

# assert_has FILE LINE: FILE contains LINE as a whole line.
assert_has() {
  if ! grep -qxF -- "$2" "$1"; then
    echo "expected line: $2"
    echo "--- $1 ---"
    cat "$1"
    return 1
  fi
}

# assert_no_key FILE KEY: FILE has no KEY= line.
assert_no_key() {
  if grep -q "^$2=" "$1"; then
    echo "unexpected key $2 in $1:"
    grep "^$2=" "$1"
    return 1
  fi
}

# assert_eq ACTUAL EXPECTED
assert_eq() {
  if [[ "$1" != "$2" ]]; then
    echo "expected: $2"
    echo "actual:   $1"
    return 1
  fi
}
