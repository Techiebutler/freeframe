#!/usr/bin/env bats
# Proves that docker compose reads values written by env_set back exactly as
# typed, through both paths the stack uses: `env_file:` (what the containers
# get) and `--env-file` interpolation of ${VAR} in the compose file.
#
# This is the one test file that calls the real docker, and only
# `docker compose config`, which reads files and starts nothing. It skips when
# docker compose is not installed (the bats image has none).

load helpers

setup() {
  common_setup
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    skip "docker compose is not available here"
  fi
  F="$BATS_TEST_TMPDIR/.env.prod"
}

# The value as `docker compose config --format json` prints it: JSON string
# escapes for \ " and tab, and every $ doubled (compose escapes $ in output).
json_expect() {
  local v=$1
  v=${v//\\/\\\\}
  v=${v//\"/\\\"}
  v=${v//$'\t'/\\t}
  v=${v//\$/\$\$}
  printf '%s' "$v"
}

@test "compose reads every awkward value back exactly as typed" {
  local -a values=(
    'pa$word' 'two words' 'a#b' 'a #b' 'q"uote' "'lead" '${HOME}' '$$' ' lead'
    'trail ' 'a=b' "O'Brien" 'end\' "it's\\" 'back\slash' 'tab\tx' 'a`b'
    "it's \$x" 'plain-Value_1.2/3:4@5'
  )
  local i compose="$BATS_TEST_TMPDIR/compose.yml"
  {
    printf 'services:\n'
    printf '  envfile:\n    image: alpine\n    env_file: %s\n' "$F"
    printf '  interp:\n    image: alpine\n    environment:\n'
    for i in "${!values[@]}"; do
      printf '      V%d: ${V%d}\n' "$i" "$i"
    done
  } >"$compose"
  for i in "${!values[@]}"; do
    env_set "$F" "V$i" "${values[$i]}"
  done

  run docker compose -p ffenvroundtrip --env-file "$F" -f "$compose" config --format json
  if [ "$status" -ne 0 ]; then
    echo "$output"
    cat "$F"
    return 1
  fi
  local out=$output bad=0 want n
  for i in "${!values[@]}"; do
    want="\"V$i\": \"$(json_expect "${values[$i]}")\""
    n=$(grep -cF -- "$want" <<<"$out" || true)
    if [ "$n" -ne 2 ]; then
      echo "V$i: typed [${values[$i]}] file line [$(grep "^V$i=" "$F")]"
      echo "  expected twice: $want"
      grep -F "\"V$i\":" <<<"$out" | sed 's/^/  got: /'
      bad=1
    fi
  done
  [ "$bad" -eq 0 ]
}

@test "production app services drop Linux capabilities and cannot gain privileges" {
  local root="$BATS_TEST_DIRNAME/../.." service
  cp "$root/docker-compose.prod.yml" "$root/docker-compose.gpu.yml" "$BATS_TEST_TMPDIR/"
  : > "$F"

  run docker compose --env-file "$F" -f "$BATS_TEST_TMPDIR/docker-compose.prod.yml" \
    -f "$BATS_TEST_TMPDIR/docker-compose.gpu.yml" config --format json
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }

  for service in api worker email_worker maintenance_worker beat web; do
    jq -e --arg svc "$service" '.services[$svc] |
      (.cap_drop == ["ALL"]) and (.security_opt | index("no-new-privileges:true") != null)' \
      <<< "$output" || { echo "Missing hardening on $service"; return 1; }
  done

  jq -e '.services.worker.deploy.resources.reservations.devices |
    any(.driver == "nvidia" and (.capabilities | index("video") != null))' <<< "$output"
}
