#!/usr/bin/env bats
# .env.prod reading and writing, secrets, backup copies and backup pruning.

load helpers

setup() {
  common_setup
  F="$BATS_TEST_TMPDIR/.env.prod"
}

@test "env_get prints the value of a key" {
  printf 'A=1\nB=two\n' > "$F"
  run env_get "$F" B
  [ "$status" -eq 0 ]
  assert_eq "$output" "two"
}

@test "env_get prints nothing for a missing key or a missing file" {
  printf 'A=1\n' > "$F"
  run env_get "$F" B
  [ "$status" -eq 0 ]
  assert_eq "$output" ""
  run env_get "$BATS_TEST_TMPDIR/nope" A
  [ "$status" -eq 0 ]
  assert_eq "$output" ""
}

@test "env_get reads hand-written files the way compose does" {
  cat > "$F" <<'X'
# a comment
API_WORKERS=4                  # Gunicorn worker processes
SINGLE='pa$word'
DOUBLE="it's \$x \"q\" b\\s"
DUP=first
DUP=last
X
  assert_eq "$(env_get "$F" API_WORKERS)" "4"
  assert_eq "$(env_get "$F" SINGLE)" 'pa$word'
  assert_eq "$(env_get "$F" DOUBLE)" "it's \$x \"q\" b\\s"
  assert_eq "$(env_get "$F" DUP)" "last"
}

@test "env_get reads export-prefixed and indented lines, as compose does" {
  printf 'export JWT_SECRET=x\n   DOMAIN=review.example.com\n\texport  A=1\n' > "$F"
  assert_eq "$(env_get "$F" JWT_SECRET)" "x"
  assert_eq "$(env_get "$F" DOMAIN)" "review.example.com"
  assert_eq "$(env_get "$F" A)" "1"
  assert_eq "$(env_get "$F" EXPORT)" ""
}

@test "a copied file using export JWT_SECRET=x keeps x and never gets a second line" {
  printf 'export JWT_SECRET=x\n' > "$F"
  env_set_if_missing "$F" JWT_SECRET newvalue
  assert_eq "$(cat "$F")" "export JWT_SECRET=x"
}

@test "an indented empty key is filled in place, keeping its indentation" {
  printf 'A=1\n  export REDIS_PASSWORD=\nC=3\n' > "$F"
  env_set_if_missing "$F" REDIS_PASSWORD abc
  assert_eq "$(cat "$F")" "$(printf 'A=1\n  export REDIS_PASSWORD=abc\nC=3')"
}

@test "env_set replaces an export-prefixed line in place" {
  printf 'export A=1\nB=2\n' > "$F"
  env_set "$F" A 9
  assert_eq "$(cat "$F")" "$(printf 'export A=9\nB=2')"
}

@test "a key that only shares a prefix is a different key" {
  printf 'JWT_SECRET_OLD=x\nMYJWT_SECRET=y\n' > "$F"
  assert_eq "$(env_get "$F" JWT_SECRET)" ""
  env_set_if_missing "$F" JWT_SECRET z
  assert_has "$F" "JWT_SECRET=z"
  assert_has "$F" "JWT_SECRET_OLD=x"
  assert_has "$F" "MYJWT_SECRET=y"
}

@test "env_set_if_missing writes a missing key" {
  printf 'A=1\n' > "$F"
  run env_set_if_missing "$F" B two
  [ "$status" -eq 0 ]
  assert_has "$F" "B=two"
  assert_has "$F" "A=1"
}

@test "env_set_if_missing creates the file with owner-only permissions" {
  env_set_if_missing "$F" A 1
  assert_has "$F" "A=1"
  run ls -l "$F"
  [[ "$output" == -rw-------* ]]
}

@test "env_set_if_missing keeps an existing non-empty value" {
  printf 'JWT_SECRET=keepme\n' > "$F"
  run env_set_if_missing "$F" JWT_SECRET newvalue
  [ "$status" -eq 0 ]
  assert_has "$F" "JWT_SECRET=keepme"
  assert_eq "$(grep -c JWT_SECRET "$F")" "1"
}

@test "env_set_if_missing fills an existing empty value" {
  printf 'A=1\nREDIS_PASSWORD=\nC=3\n' > "$F"
  env_set_if_missing "$F" REDIS_PASSWORD abc
  assert_eq "$(cat "$F")" "$(printf 'A=1\nREDIS_PASSWORD=abc\nC=3')"
}

@test "env_set_if_missing never touches other lines" {
  cat > "$F" <<'X'
# keep this comment
A=1
   indented line stays
WEIRD='quoted value'
API_WORKERS=4                  # inline comment stays
X
  cp "$F" "$BATS_TEST_TMPDIR/before"
  env_set_if_missing "$F" NEW_KEY v
  env_set_if_missing "$F" A changed
  head -n 5 "$F" > "$BATS_TEST_TMPDIR/after-head"
  cmp "$BATS_TEST_TMPDIR/before" "$BATS_TEST_TMPDIR/after-head"
  assert_eq "$(tail -n 1 "$F")" "NEW_KEY=v"
}

@test "env_set_if_missing adds a newline when the file does not end with one" {
  printf 'A=1' > "$F"
  env_set_if_missing "$F" B 2
  assert_eq "$(cat "$F")" "$(printf 'A=1\nB=2')"
}

@test "env_set_if_missing with an empty value writes nothing" {
  printf 'A=1\n' > "$F"
  run env_set_if_missing "$F" B ""
  [ "$status" -eq 0 ]
  assert_no_key "$F" B
}

@test "env_set overwrites an existing value in place" {
  printf 'A=1\nFRONTEND_URL=http://old\nC=3\n' > "$F"
  env_set "$F" FRONTEND_URL https://new.example.com
  assert_eq "$(cat "$F")" "$(printf 'A=1\nFRONTEND_URL=https://new.example.com\nC=3')"
}

@test "a pre-created empty file with wide permissions becomes 600 on the first write" {
  : > "$F"
  chmod 644 "$F"
  env_set_if_missing "$F" JWT_SECRET abc
  run ls -l "$F"
  [[ "$output" == -rw-------* ]]
}

@test "a copied 644 file becomes 600 when a key is replaced" {
  printf 'A=1\n' > "$F"
  chmod 644 "$F"
  env_set "$F" A 2
  run ls -l "$F"
  [[ "$output" == -rw-------* ]]
}

@test "env_backup copies are 600 even when the original is not" {
  printf 'JWT_SECRET=s\n' > "$F"
  chmod 644 "$F"
  b=$(env_backup "$F")
  run ls -l "$b"
  [[ "$output" == -rw-------* ]]
}

@test "env_set keeps the file mode" {
  printf 'A=1\n' > "$F"
  chmod 600 "$F"
  env_set "$F" A 2
  run ls -l "$F"
  [[ "$output" == -rw-------* ]]
}

@test "a newline in a value is rejected" {
  printf 'A=1\n' > "$F"
  run env_set_if_missing "$F" B "$(printf 'x\ny')"
  [ "$status" -ne 0 ]
  [[ "$output" == *"line break"* ]]
  assert_no_key "$F" B
  run env_set "$F" A "$(printf 'x\ny')"
  [ "$status" -ne 0 ]
  assert_has "$F" "A=1"
}

@test "an invalid key name is rejected" {
  run env_set "$F" "BAD KEY" v
  [ "$status" -ne 0 ]
  run env_set "$F" "1A" v
  [ "$status" -ne 0 ]
}

@test "values compose would change are quoted and read back unchanged" {
  local v
  for v in 'pa$word' 'two words' 'a#b' 'a #b' "it's \$x" 'back\slash' 'q"uote' "'lead" \
    'end\' "it's\\" '${HOME}' '$$' ' lead' 'trail ' 'a=b' "O'Brien" 'tab\tx' 'a`b'; do
    : > "$F"
    env_set "$F" SMTP_PASSWORD "$v"
    assert_eq "$(env_get "$F" SMTP_PASSWORD)" "$v"
  done
  : > "$F"
  env_set "$F" SMTP_PASSWORD 'pa$word'
  assert_has "$F" "SMTP_PASSWORD='pa\$word'"
}

@test "a value ending in a backslash is double-quoted so compose can read it" {
  env_set "$F" V 'end\'
  assert_has "$F" 'V="end\\"'
  env_set "$F" W "it's\\"
  assert_has "$F" 'W="it'"'"'s\\"'
}

@test "a backtick together with a backslash or a single quote is rejected" {
  printf 'A=1\n' > "$F"
  run env_set "$F" A 'a\`b'
  [ "$status" -ne 0 ]
  [[ "$output" == *backtick* ]]
  run env_set "$F" A "it's \`x\`"
  [ "$status" -ne 0 ]
  assert_has "$F" "A=1"
}

@test "plain values are written unquoted" {
  env_set "$F" FRONTEND_URL "https://review.example.com"
  env_set "$F" MAIL_FROM_NAME "O'Brien"
  assert_has "$F" "FRONTEND_URL=https://review.example.com"
  assert_has "$F" "MAIL_FROM_NAME=O'Brien"
}

@test "env_backup creates a timestamped copy with the same contents" {
  printf 'A=1\nJWT_SECRET=s\n' > "$F"
  run env_backup "$F"
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^"$F".[0-9]{8}-[0-9]{6}$ ]]
  [ -f "$output" ]
  cmp "$F" "$output"
}

@test "env_backup twice in the same second keeps both copies" {
  printf 'A=1\n' > "$F"
  first=$(env_backup "$F")
  printf 'A=2\n' > "$F"
  second=$(env_backup "$F")
  [ "$first" != "$second" ]
  assert_has "$first" "A=1"
  assert_has "$second" "A=2"
}

@test "gen_secret 32 is 64 hex characters" {
  run gen_secret 32
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9a-f]{64}$ ]]
}

@test "gen_secret two calls differ" {
  a=$(gen_secret 32)
  b=$(gen_secret 32)
  [ "$a" != "$b" ]
}

@test "gen_secret 64 is 128 hex characters" {
  [[ "$(gen_secret 64)" =~ ^[0-9a-f]{128}$ ]]
}

@test "gen_secret uses openssl when it is installed" {
  openssl() { echo "openssl-called $*"; }
  run gen_secret 32
  assert_eq "$output" "openssl-called rand -hex 32"
}

@test "backup_prune leaves the newest 7 of 9 dumps and their settings copies" {
  d="$BATS_TEST_TMPDIR/backups"
  mkdir -p "$d"
  for day in 18 19 20 21 22 23 24 25 26; do
    : > "$d/freeframe-202610${day}-030000.dump"
    : > "$d/freeframe-202610${day}-030000.env.prod"
  done
  : > "$d/notes.txt"
  run backup_prune "$d" 7
  [ "$status" -eq 0 ]
  assert_eq "$(ls "$d" | grep -c '\.dump$')" "7"
  assert_eq "$(ls "$d" | grep -c '\.env\.prod$')" "7"
  [ ! -e "$d/freeframe-20261018-030000.dump" ]
  [ ! -e "$d/freeframe-20261019-030000.dump" ]
  [ ! -e "$d/freeframe-20261018-030000.env.prod" ]
  [ ! -e "$d/freeframe-20261019-030000.env.prod" ]
  [ -e "$d/freeframe-20261020-030000.dump" ]
  [ -e "$d/freeframe-20261026-030000.env.prod" ]
  [ -e "$d/notes.txt" ]
}

@test "backup_prune with fewer dumps than KEEP deletes nothing" {
  d="$BATS_TEST_TMPDIR/backups"
  mkdir -p "$d"
  : > "$d/freeframe-20261026-030000.dump"
  run backup_prune "$d" 7
  [ "$status" -eq 0 ]
  [ -e "$d/freeframe-20261026-030000.dump" ]
}

@test "backup_prune rejects a KEEP that is not a number" {
  d="$BATS_TEST_TMPDIR/backups"
  mkdir -p "$d"
  : > "$d/freeframe-20261026-030000.dump"
  run backup_prune "$d" abc
  [ "$status" -ne 0 ]
  [ -e "$d/freeframe-20261026-030000.dump" ]
}
