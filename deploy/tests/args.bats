#!/usr/bin/env bats
# Arguments, environment answers, prompts and the subcommand dispatcher.

load helpers

setup() {
  common_setup
}

@test "parse_args sets the subcommand" {
  parse_args install
  assert_eq "$FF_CMD" "install"
}

@test "parse_args with no arguments means help" {
  parse_args
  assert_eq "$FF_CMD" "help"
}

@test "env var seeds the answer" {
  FREEFRAME_DOMAIN=review.example.com
  FREEFRAME_SMTP_PASSWORD='s3cret$'
  FREEFRAME_CHANNEL=latest
  parse_args install
  assert_eq "$FF_DOMAIN" "review.example.com"
  assert_eq "$FF_SMTP_PASSWORD" 's3cret$'
  assert_eq "$FF_CHANNEL" "latest"
}

@test "every answer variable is seeded from its FREEFRAME_ env var" {
  local name
  for name in DOMAIN HTTPS ACME_EMAIL STORAGE S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY \
    S3_SECRET_KEY S3_REGION SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_FROM \
    ADMIN_NAME ADMIN_EMAIL ADMIN_PASSWORD CHANNEL; do
    printf -v "FREEFRAME_$name" '%s' "value-$name"
  done
  parse_args install
  for name in DOMAIN HTTPS ACME_EMAIL STORAGE S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY \
    S3_SECRET_KEY S3_REGION SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_FROM \
    ADMIN_NAME ADMIN_EMAIL ADMIN_PASSWORD CHANNEL; do
    local var="FF_$name"
    assert_eq "${!var}" "value-$name"
  done
}

@test "the flag overrides the env var" {
  FREEFRAME_DOMAIN=from-env.example.com
  FREEFRAME_HTTPS=sslip
  parse_args install --domain from-flag.example.com --https=own
  assert_eq "$FF_DOMAIN" "from-flag.example.com"
  assert_eq "$FF_HTTPS" "own"
}

@test "every answer has a flag" {
  parse_args install --domain d --https own --acme-email a@x --storage s3 \
    --s3-endpoint https://e --s3-bucket b --s3-access-key ak --s3-secret-key sk \
    --s3-region r --smtp-host h --smtp-port 465 --smtp-user u --smtp-password p \
    --smtp-from f@x --admin-name "Ada L" --admin-email ad@x --admin-password pw \
    --channel latest --yes
  assert_eq "$FF_DOMAIN|$FF_HTTPS|$FF_ACME_EMAIL|$FF_STORAGE" "d|own|a@x|s3"
  assert_eq "$FF_S3_ENDPOINT|$FF_S3_BUCKET|$FF_S3_ACCESS_KEY|$FF_S3_SECRET_KEY|$FF_S3_REGION" \
    "https://e|b|ak|sk|r"
  assert_eq "$FF_SMTP_HOST|$FF_SMTP_PORT|$FF_SMTP_USER|$FF_SMTP_PASSWORD|$FF_SMTP_FROM" \
    "h|465|u|p|f@x"
  assert_eq "$FF_ADMIN_NAME|$FF_ADMIN_EMAIL|$FF_ADMIN_PASSWORD" "Ada L|ad@x|pw"
  assert_eq "$FF_CHANNEL|$FF_YES" "latest|1"
}

@test "FREEFRAME_YES seeds yes and --yes or -y sets it" {
  FREEFRAME_YES=true
  parse_args install
  assert_eq "$FF_YES" "1"
  unset FREEFRAME_YES
  parse_args install
  assert_eq "$FF_YES" ""
  parse_args -y install
  assert_eq "$FF_YES" "1"
  FREEFRAME_YES=0
  parse_args install
  assert_eq "$FF_YES" ""
}

@test "flags may come before the subcommand and extra words are kept" {
  parse_args --yes restore /opt/freeframe/backups/freeframe-20261026-030000.dump
  assert_eq "$FF_CMD" "restore"
  assert_eq "${FF_ARGS[0]}" "/opt/freeframe/backups/freeframe-20261026-030000.dump"
}

@test "unknown flag exits 2" {
  run parse_args install --domian review.example.com
  [ "$status" -eq 2 ]
  [[ "$output" == *"--domian"* ]]
}

@test "a flag without its value exits 2" {
  run parse_args install --domain
  [ "$status" -eq 2 ]
  [[ "$output" == *"--domain"* ]]
}

@test "the executed script exits 2 on an unknown flag" {
  run bash "$FF_SCRIPT" install --bogus
  [ "$status" -eq 2 ]
}

@test "require_answer with no TTY and an empty answer fails naming FREEFRAME_DOMAIN" {
  FF_DOMAIN=""
  run require_answer FF_DOMAIN FREEFRAME_DOMAIN "Web address"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Missing answer: set FREEFRAME_DOMAIN (Web address)"* ]]
}

@test "require_answer with an answer already given succeeds without asking" {
  FF_DOMAIN=review.example.com
  run require_answer FF_DOMAIN FREEFRAME_DOMAIN "Web address"
  [ "$status" -eq 0 ]
}

@test "require_answer with a TTY asks the question" {
  printf 'typed.example.com\n' > "$BATS_TEST_TMPDIR/tty"
  FF_TTY="$BATS_TEST_TMPDIR/tty"
  FF_DOMAIN=""
  require_answer FF_DOMAIN FREEFRAME_DOMAIN "Web address" 2>/dev/null
  assert_eq "$FF_DOMAIN" "typed.example.com"
}

@test "require_answer keeps asking until something is typed" {
  printf '\n  \ntyped.example.com\n' > "$BATS_TEST_TMPDIR/tty"
  FF_TTY="$BATS_TEST_TMPDIR/tty"
  FF_DOMAIN=""
  require_answer FF_DOMAIN FREEFRAME_DOMAIN "Web address" 2>/dev/null
  assert_eq "$FF_DOMAIN" "typed.example.com"
}

@test "ask reads one line from FF_TTY" {
  printf 'review.example.com\n' > "$BATS_TEST_TMPDIR/tty"
  FF_TTY="$BATS_TEST_TMPDIR/tty"
  ask FF_DOMAIN "Web address" "" 2>/dev/null
  assert_eq "$FF_DOMAIN" "review.example.com"
}

@test "ask uses the default on Enter" {
  printf '\n' > "$BATS_TEST_TMPDIR/tty"
  FF_TTY="$BATS_TEST_TMPDIR/tty"
  ask FF_STORAGE "Where should media be kept" bundled 2>/dev/null
  assert_eq "$FF_STORAGE" "bundled"
}

@test "ask reads successive lines on successive calls" {
  printf 'first\nsecond\n' > "$BATS_TEST_TMPDIR/tty"
  FF_TTY="$BATS_TEST_TMPDIR/tty"
  ask FF_ADMIN_NAME "Name" "" 2>/dev/null
  ask FF_ADMIN_EMAIL "Email" "" 2>/dev/null
  assert_eq "$FF_ADMIN_NAME|$FF_ADMIN_EMAIL" "first|second"
}

@test "ask trims spaces and a Windows line ending" {
  printf '  review.example.com \r\n' > "$BATS_TEST_TMPDIR/tty"
  FF_TTY="$BATS_TEST_TMPDIR/tty"
  ask FF_DOMAIN "Web address" "" 2>/dev/null
  assert_eq "$FF_DOMAIN" "review.example.com"
}

@test "ask shows the question and the default" {
  printf '\n' > "$BATS_TEST_TMPDIR/tty"
  FF_TTY="$BATS_TEST_TMPDIR/tty"
  run ask FF_STORAGE "Where should media be kept" bundled
  [[ "$output" == *"Where should media be kept [bundled]"* ]]
}

@test "ask with no TTY fails" {
  run ask FF_DOMAIN "Web address" ""
  [ "$status" -ne 0 ]
}

@test "help lists every subcommand" {
  run bash "$FF_SCRIPT" help
  [ "$status" -eq 0 ]
  local c
  for c in install update rollback configure backup restore status logs restart help; do
    [[ "$output" == *"$c"* ]]
  done
}

@test "every subcommand is built: on a server without FreeFrame each one stops before doing anything" {
  local c
  for c in update rollback configure status logs restart; do
    run bash "$FF_SCRIPT" "$c"
    # 1: not installed here (FF_ROOT is empty); 2: not root.
    [[ $status -eq 1 || $status -eq 2 ]] || { echo "$c: $status $output"; false; }
    [[ $output != *"not implemented"* ]] || { echo "$c: $output"; false; }
    [[ $output == *"not installed"* || $output == *"as root"* ]] || { echo "$c: $output"; false; }
  done
}

@test "an unknown subcommand exits 2" {
  run bash "$FF_SCRIPT" frobnicate
  [ "$status" -eq 2 ]
}

@test "sourcing the script runs nothing and leaves the shell options alone" {
  run bash -c 'source "$1" install --bogus
    [[ -o errexit ]] && exit 3
    [[ -o nounset ]] && exit 4
    [[ -o pipefail ]] && exit 5
    echo sourced-ok' ff-source "$FF_SCRIPT"
  [ "$status" -eq 0 ]
  assert_eq "$output" "sourced-ok"
}

@test "require_answer fails when the terminal input ends with no answer" {
  printf '\n' > "$BATS_TEST_TMPDIR/tty"
  FF_TTY="$BATS_TEST_TMPDIR/tty"
  FF_DOMAIN=""
  run require_answer FF_DOMAIN FREEFRAME_DOMAIN "Web address"
  [ "$status" -ne 0 ]
  [[ "$output" == *"FREEFRAME_DOMAIN"* ]]
}
