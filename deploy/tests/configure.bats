#!/usr/bin/env bats
# `freeframe configure` (spec goal 12c), with every side effect stubbed
# (manage_stubs.bash). Each flow runs in a fresh bash under the script's own
# strict mode.

load manage_helpers

setup() {
  manage_setup
}

# tty LINE...: the answers typed at the terminal, one per line.
tty() {
  printf '%s\n' "$@" >"$BATS_TEST_TMPDIR/tty"
  export FF_TTY="$BATS_TEST_TMPDIR/tty"
}

keep_copy() { cp "$ENV" "$BATS_TEST_TMPDIR/env.before"; }
BEFORE() { printf '%s' "$BATS_TEST_TMPDIR/env.before"; }

# ---------------------------------------------------------------- address

@test "configure: a new own domain rewrites only the address keys, after a backup, and keeps every secret" {
  installed_server sslip bundled
  keep_copy
  ff configure --yes --domain review.yourstudio.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(changed_keys "$(BEFORE)" "$ENV")" \
    "DOMAIN FREEFRAME_HTTPS FRONTEND_URL S3_PUBLIC_ENDPOINT STORAGE_DOMAIN"
  assert_has "$ENV" "FRONTEND_URL=https://review.yourstudio.com"
  assert_has "$ENV" "DOMAIN=review.yourstudio.com"
  assert_has "$ENV" "STORAGE_DOMAIN=storage.review.yourstudio.com"
  assert_has "$ENV" "S3_PUBLIC_ENDPOINT=https://storage.review.yourstudio.com"
  assert_has "$ENV" "FREEFRAME_HTTPS=own"
  assert_secrets_same "$(BEFORE)" "$ENV"
  # The backup holds the settings exactly as they were.
  local b
  b=$(env_backups)
  [ "$(wc -w <<<"$b")" -eq 1 ]
  cmp "$FF_ROOT/$b" "$(BEFORE)"
  [ "$(stat -c %a "$FF_ROOT/$b")" = 600 ]
  assert_out "$FF_ROOT/$b"
  assert_order "dns_points_here review.yourstudio.com 203.0.113.7" \
    "dns_points_here storage.review.yourstudio.com 203.0.113.7" \
    "dc up -d --no-build --force-recreate" "localhost:8000/health" \
    "probe_health own review.yourstudio.com" "cert_issued review.yourstudio.com"
}

@test "configure: a new address warns that links already sent by email stop working" {
  installed_server sslip bundled
  ff configure --yes --domain review.yourstudio.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Links already sent by email"
  assert_out "https://203-0-113-7.sslip.io"
  assert_out "stop working"
}

@test "configure: a new own domain waits for its DNS records before changing anything" {
  installed_server sslip bundled
  keep_copy
  export STUB_DNS_FAILS=1000 FF_DNS_WAIT=30
  ff configure --yes --domain review.yourstudio.com
  [ "$status" -eq 1 ]
  assert_out "do not point at this server"
  assert_out "sudo freeframe configure"
  cmp "$ENV" "$(BEFORE)"
  [ -z "$(env_backups)" ]
  assert_not_called "dc up"
  grep -q "sleep 15" "$CALLS"
}

@test "configure: DNS that starts pointing here after a while is waited for" {
  installed_server sslip bundled
  export STUB_DNS_FAILS=2
  ff configure --yes --domain review.yourstudio.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_order "dns_points_here review.yourstudio.com" "sleep 15" "dns_points_here review.yourstudio.com" \
    "dc up -d --no-build --force-recreate"
}

@test "configure: moving to plain HTTP uses the server's address and keeps every secret" {
  installed_server sslip bundled
  keep_copy
  ff configure --yes --https off
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_HTTPS=off"
  assert_has "$ENV" "FRONTEND_URL=http://203.0.113.7"
  assert_has "$ENV" "S3_PUBLIC_ENDPOINT=http://203.0.113.7:9000"
  assert_has "$ENV" "STORAGE_ROUTED=false"
  assert_has "$ENV" "STORAGE_PORT_BIND=0.0.0.0:9000"
  assert_eq "$(env_get "$ENV" DOMAIN)" ""
  assert_secrets_same "$(BEFORE)" "$ENV"
  assert_has "$ENV" "ACME_EMAIL=certs@example.com"
  grep -q "dc up -d --no-build --force-recreate" "$CALLS"
  assert_out "http://203.0.113.7"
}

@test "configure: behind a router, plain HTTP uses the server's own network address" {
  installed_server sslip bundled
  export STUB_LOCAL_IP=10.0.0.5
  ff configure --yes --https off
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FRONTEND_URL=http://10.0.0.5"
}

@test "configure: turning HTTPS on for a plain HTTP server asks for the certificate email" {
  installed_server off bundled
  sed -i '/^ACME_EMAIL=/d' "$ENV"
  keep_copy
  ff configure --yes --domain review.yourstudio.com
  [ "$status" -eq 2 ]
  assert_out "FREEFRAME_ACME_EMAIL"
  cmp "$ENV" "$(BEFORE)"

  ff configure --yes --domain review.yourstudio.com --acme-email certs@yourstudio.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_HTTPS=own"
  assert_has "$ENV" "FRONTEND_URL=https://review.yourstudio.com"
  assert_has "$ENV" "ACME_EMAIL=certs@yourstudio.com"
  assert_has "$ENV" "STORAGE_ROUTED=true"
  assert_has "$ENV" "STORAGE_PORT_BIND=127.0.0.1:9000"
  assert_secrets_same "$(BEFORE)" "$ENV"
}

@test "configure: a certificate that does not arrive is reported, not hidden" {
  installed_server sslip bundled
  export STUB_CERT_FAIL=1 FF_CERT_WAIT=20
  ff configure --yes --domain review.yourstudio.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "has not arrived yet"
  assert_out "sudo freeframe restart"
}

@test "configure: FreeFrame not answering afterwards says how to put the old settings back" {
  installed_server sslip bundled
  export STUB_API_DOWN=1 FF_API_WAIT=10
  ff configure --yes --domain review.yourstudio.com
  [ "$status" -eq 1 ]
  local b
  b=$(env_backups)
  assert_out "sudo cp '$FF_ROOT/$b' '$ENV' && sudo freeframe restart"
}

# ---------------------------------------------------------------- email

@test "configure: adding SMTP changes only SMTP_* and MAIL_FROM_ADDRESS" {
  installed_server sslip bundled
  keep_copy
  export FREEFRAME_SMTP_PASSWORD='p@ss $word'
  ff configure --yes --smtp-host smtp.example.com --smtp-user mailer@example.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  local k
  for k in $(changed_keys "$(BEFORE)" "$ENV"); do
    [[ $k == SMTP_* || $k == MAIL_FROM_ADDRESS ]] || { echo "unexpected change: $k"; false; }
  done
  assert_has "$ENV" "SMTP_HOST=smtp.example.com"
  assert_has "$ENV" "SMTP_PORT=587"
  assert_has "$ENV" "SMTP_USE_TLS=true"
  assert_has "$ENV" "SMTP_USER=mailer@example.com"
  assert_eq "$(env_get "$ENV" SMTP_PASSWORD)" 'p@ss $word'
  assert_has "$ENV" "MAIL_FROM_ADDRESS=mailer@example.com"
  assert_secrets_same "$(BEFORE)" "$ENV"
  cmp "$FF_ROOT/$(env_backups)" "$(BEFORE)"
  # No address change: no warning about links, no DNS check.
  assert_no_out "Links already sent"
  assert_not_called dns_points_here
  # The password is never printed.
  assert_no_out 'p@ss $word'
}

@test "configure: port 465 means TLS from the first byte" {
  installed_server sslip bundled
  ff configure --yes --smtp-host smtp.example.com --smtp-port 465 --smtp-from noreply@example.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "SMTP_USE_TLS=false"
  assert_has "$ENV" "MAIL_FROM_ADDRESS=noreply@example.com"
}

@test "configure: SMTP without a from address is refused before anything changes" {
  installed_server sslip bundled
  keep_copy
  ff configure --yes --smtp-host smtp.example.com
  [ "$status" -eq 2 ]
  assert_out "FREEFRAME_SMTP_FROM"
  cmp "$ENV" "$(BEFORE)"
}

# ---------------------------------------------------------------- storage

@test "configure: switching where footage is kept is refused with a plain explanation" {
  installed_server sslip bundled
  keep_copy
  ff configure --yes --storage s3 --s3-bucket media
  [ "$status" -eq 2 ]
  assert_out "does not move footage"
  cmp "$ENV" "$(BEFORE)"
  assert_not_called "dc "

  # The bundled storage's keys are generated secrets: never set from outside.
  export FREEFRAME_S3_SECRET_KEY=mine
  ff configure --yes
  [ "$status" -eq 2 ]
  cmp "$ENV" "$(BEFORE)"
}

@test "configure: the keys of your own S3 bucket can be changed" {
  installed_server sslip s3
  keep_copy
  export FREEFRAME_S3_SECRET_KEY=new-secret
  ff configure --yes --s3-access-key AKNEW
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(changed_keys "$(BEFORE)" "$ENV")" "S3_ACCESS_KEY S3_SECRET_KEY"
  assert_has "$ENV" "S3_ACCESS_KEY=AKNEW"
  assert_has "$ENV" "S3_SECRET_KEY=new-secret"
  assert_no_out new-secret
}

@test "configure: a new bucket says that footage already uploaded stays in the old one" {
  installed_server sslip s3
  ff configure --yes --s3-bucket media2
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "S3_BUCKET=media2"
  assert_out "stays in media"
}

# ---------------------------------------------------------------- interactive

@test "configure: Enter at every question changes nothing" {
  installed_server sslip bundled
  keep_copy
  tty "" "" "" ""
  ff configure
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Nothing to change"
  cmp "$ENV" "$(BEFORE)"
  [ -z "$(env_backups)" ]
  assert_not_called "dc "
}

@test "configure: interactive, a typed domain is shown with the warning and saved after a yes" {
  installed_server sslip bundled
  keep_copy
  # address, email (Enter keeps none), storage (Enter keeps), confirm.
  tty "review.yourstudio.com" "" "" "y"
  ff configure
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Now: https://203-0-113-7.sslip.io"
  assert_out "Links already sent by email"
  assert_has "$ENV" "FRONTEND_URL=https://review.yourstudio.com"
  assert_secrets_same "$(BEFORE)" "$ENV"
}

@test "configure: interactive, answering no changes nothing" {
  installed_server sslip bundled
  keep_copy
  tty "review.yourstudio.com" "" "" "n"
  ff configure
  [ "$status" -eq 1 ]
  assert_out "Nothing was changed"
  cmp "$ENV" "$(BEFORE)"
  assert_not_called "dc "
}

@test "configure: interactive, choosing the other storage explains and keeps footage where it is" {
  installed_server sslip bundled
  keep_copy
  tty "" "" "2" ""
  ff configure
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "does not move footage"
  cmp "$ENV" "$(BEFORE)"
}

@test "configure: interactive SMTP, the password is typed and kept out of the output" {
  installed_server sslip bundled
  tty "" "smtp.example.com" "587" "mailer@example.com" "s3cret-mail" "" "" "y"
  ff configure
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "SMTP_HOST=smtp.example.com"
  assert_has "$ENV" "SMTP_PASSWORD=s3cret-mail"
  assert_has "$ENV" "MAIL_FROM_ADDRESS=mailer@example.com"
  assert_no_out "s3cret-mail"
}

# ---------------------------------------------------------------- refusals and channel

@test "configure: with no terminal and no --yes it stops and names --yes" {
  installed_server sslip bundled
  keep_copy
  ff configure --domain review.yourstudio.com
  [ "$status" -eq 2 ]
  assert_out "--yes"
  cmp "$ENV" "$(BEFORE)"
}

@test "configure: --yes with nothing to change says so" {
  installed_server sslip bundled
  ff configure --yes
  [ "$status" -eq 0 ]
  assert_out "Nothing to change"
  assert_not_called "dc "
}

@test "configure: --channel is saved after a backup and needs no restart" {
  installed_server sslip bundled
  keep_copy
  ff configure --yes --channel stable
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(changed_keys "$(BEFORE)" "$ENV")" "FREEFRAME_CHANNEL"
  cmp "$FF_ROOT/$(env_backups)" "$(BEFORE)"
  assert_not_called "dc up"
  assert_out "sudo freeframe update"
}

@test "configure: refuses before the install finished and while a restore is unfinished" {
  installed_server sslip bundled
  rm "$FF_ROOT/.installed"
  ff configure --yes --domain review.yourstudio.com
  [ "$status" -eq 1 ]
  assert_out "sudo freeframe install"
  printf 'FreeFrame installed\n' >"$FF_ROOT/.installed"
  mkdir -p "$BK"
  printf 'PGDMP old\n' >"$BK/freeframe-20261020-030000.dump"
  printf '%s\n' "$BK/freeframe-20261020-030000.dump" >"$FF_ROOT/.restore-undo"
  ff configure --yes --domain review.yourstudio.com
  [ "$status" -eq 1 ]
  assert_out "A restore of the database did not finish"
  assert_not_called "dc "
}

@test "configure: while a restore runs, it says another command is running, not that the database may be empty" {
  command -v flock >/dev/null || skip "no flock"
  installed_server sslip bundled
  keep_copy
  mkdir -p "$BK"
  printf 'PGDMP old\n' >"$BK/freeframe-20261020-030000.dump"
  printf '%s\n' "$BK/freeframe-20261020-030000.dump" >"$FF_ROOT/.restore-undo"
  exec 9>>"$FF_ROOT/.freeframe.lock"
  flock -n 9
  ff configure --yes --domain review.yourstudio.com
  exec 9>&-
  [ "$status" -eq 1 ]
  assert_out "Another freeframe command (an update, rollback, backup, restore, restart, configure or uninstall) is running right now, so the settings were not changed."
  assert_no_out "did not finish"
  assert_no_out "may be empty"
  cmp "$ENV" "$(BEFORE)"
  assert_not_called "dc "
}

@test "configure: a restore left unfinished while it asked is refused once it has the lock" {
  installed_server sslip bundled
  keep_copy
  mkdir -p "$BK"
  printf 'PGDMP old\n' >"$BK/freeframe-20261020-030000.dump"
  export STUB_AT_LOCK='printf "%s\n" "$FF_ROOT/backups/freeframe-20261020-030000.dump" >"$FF_ROOT/.restore-undo"'
  ff configure --yes --domain review.yourstudio.com
  [ "$status" -eq 1 ]
  assert_out "A restore of the database did not finish"
  cmp "$ENV" "$(BEFORE)"
  [ -z "$(env_backups)" ]
  assert_not_called "dc "
}

@test "configure: answers that end part-way change nothing and say so" {
  installed_server sslip bundled
  keep_copy
  tty "review.yourstudio.com"
  ff configure
  [ "$status" -eq 2 ]
  assert_out "so nothing was changed"
  assert_out "sudo freeframe configure in a terminal"
  cmp "$ENV" "$(BEFORE)"
}

@test "configure: at the DNS wait, s goes back to the temporary address it already had: nothing to change" {
  installed_server sslip bundled
  keep_copy
  export STUB_DNS_FAILS=1000
  tty "review.yourstudio.com" "" "" "y" "s"
  ff configure
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Nothing to change"
  cmp "$ENV" "$(BEFORE)"
  [ -z "$(env_backups)" ]
  assert_not_called "dc up"
}

@test "configure: at the DNS wait, s uses the temporary address without telling you to run configure" {
  installed_server off bundled
  export STUB_DNS_FAILS=1000
  # address, certificate email (plain HTTP had none), email, storage, yes, s.
  tty "review.yourstudio.com" "certs@example.com" "" "" "y" "s"
  ff configure
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Using the temporary address 203-0-113-7.sslip.io instead."
  assert_no_out "Change it later with: sudo freeframe configure"
  assert_has "$ENV" "FRONTEND_URL=https://203-0-113-7.sslip.io"
  assert_has "$ENV" "FREEFRAME_HTTPS=sslip"
}

# ---------------------------------------------------------------- video processing (GPU)

# gpu_file: the GPU compose file, as a release that has it puts it in place.
gpu_file() { printf 'services:\n  worker: {}\n' >"$FF_ROOT/docker-compose.gpu.yml"; }

@test "configure gpu: --gpu nvidia sets the toolkit up, warns about the Docker restart, and restarts FreeFrame" {
  installed_server off bundled
  gpu_file
  export STUB_GPU=notoolkit
  keep_copy
  ff configure --yes --gpu nvidia
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "FREEFRAME_GPU: (empty) -> nvidia"
  assert_out "restarts Docker"
  assert_out "every container on this server stops for a moment"
  assert_order install_nvidia_toolkit "dc up -d --no-build --force-recreate" "localhost:8000/health"
  assert_eq "$(changed_keys "$(BEFORE)" "$ENV")" "FREEFRAME_GPU"
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
  [[ $(compose_files "$ENV") == *"-f docker-compose.gpu.yml"* ]]
  assert_out "Video processing: GPU (NVIDIA GeForce RTX 5070 Ti)"
}

@test "configure gpu: a ready GPU is switched on without installing anything" {
  installed_server off bundled
  gpu_file
  export STUB_GPU=ready
  ff configure --yes --gpu nvidia
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called install_nvidia_toolkit
  assert_no_out "restarts Docker"
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
  grep -q "^dc up -d --no-build --force-recreate" "$CALLS"
}

@test "configure gpu: --gpu off turns it off and restarts FreeFrame" {
  installed_server off bundled
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready
  ff configure --yes --gpu off
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_GPU=off"
  assert_out "FREEFRAME_GPU: nvidia -> off"
  grep -q "^dc up -d --no-build --force-recreate" "$CALLS"
  assert_not_called install_nvidia_toolkit
  assert_out "Video processing: CPU (you chose the CPU)"
}

@test "configure gpu: --gpu off on a server already on the CPU changes nothing" {
  installed_server off bundled
  keep_copy
  ff configure --yes --gpu off
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "Nothing to change"
  cmp "$ENV" "$(BEFORE)"
}

@test "configure gpu: a toolkit that cannot be set up leaves video on the CPU, brings FreeFrame back and says so" {
  installed_server off bundled
  gpu_file
  export STUB_GPU=notoolkit STUB_GPU_SETUP_FAIL=1
  keep_copy
  ff configure --yes --gpu nvidia
  [ "$status" -eq 1 ]
  assert_out "The NVIDIA container toolkit could not be set up"
  assert_out "video is still processed on the CPU"
  # Docker may have been restarted part-way: FreeFrame is started again.
  assert_order install_nvidia_toolkit "dc up -d --no-build" "localhost:8000/health"
  assert_has "$ENV" "FREEFRAME_GPU=off"
  [[ $(compose_files "$ENV") != *gpu* ]]
}

@test "configure gpu: --gpu nvidia without a usable NVIDIA GPU is refused and nothing changes" {
  installed_server off bundled
  keep_copy
  local s
  for s in none nodriver intel; do
    : >"$CALLS"
    export STUB_GPU=$s
    ff configure --yes --gpu nvidia
    [ "$status" -eq 2 ] || { echo "$s: $output"; false; }
    assert_out "Nothing was changed"
    cmp "$ENV" "$(BEFORE)"
    assert_not_called install_nvidia_toolkit
  done
  STUB_GPU=nodriver ff configure --yes --gpu nvidia
  assert_out "sudo ubuntu-drivers install"
}

@test "configure gpu: an unknown --gpu value is a usage error" {
  installed_server off bundled
  ff configure --yes --gpu cuda
  [ "$status" -eq 2 ]
  assert_out "must be nvidia or off"
}

@test "configure gpu: interactive, a usable GPU is offered as section 4, and Enter keeps the CPU" {
  installed_server off bundled
  export STUB_GPU=notoolkit
  keep_copy
  tty "" "" "" ""
  ff configure
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "4. Video processing"
  assert_out "   Now: on the CPU"
  assert_out "This server has an NVIDIA GPU: NVIDIA GeForce RTX 5070 Ti (driver 610.47)."
  assert_out "Use the NVIDIA GPU for video processing? [y/N]"
  assert_out "Nothing to change"
  cmp "$ENV" "$(BEFORE)"
}

@test "configure gpu: interactive yes turns the GPU on, after the summary and its confirmation" {
  installed_server off bundled
  gpu_file
  export STUB_GPU=notoolkit
  tty "" "" "" "y" "y"
  ff configure
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [[ $output == *"4. Video processing"*"FREEFRAME_GPU: (empty) -> nvidia"*"restarts Docker"*"Save these changes and restart FreeFrame?"* ]] ||
    { echo "$output"; false; }
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
  grep -qx install_nvidia_toolkit "$CALLS"
}

@test "configure gpu: interactive, a GPU in use can be turned off" {
  installed_server off bundled
  gpu_file
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready
  tty "" "" "" "n" "y"
  ff configure
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "   Now: on the GPU (NVIDIA GeForce RTX 5070 Ti)"
  assert_out "Keep using the NVIDIA GPU for video processing? [Y/n]"
  assert_has "$ENV" "FREEFRAME_GPU=off"
}

@test "configure gpu: interactive, no usable GPU shows where video is processed and asks nothing" {
  installed_server off bundled
  local s want
  for s in none nodriver intel; do
    export STUB_GPU=$s
    tty "" "" ""
    ff configure
    [ "$status" -eq 0 ] || { echo "$s: $output"; false; }
    case $s in
      none) want="   Now: on the CPU (no GPU found)" ;;
      nodriver) want="   Now: on the CPU (the NVIDIA driver is not working)" ;;
      intel) want="   Now: on the CPU (the Intel GPU is not used with the published images)" ;;
    esac
    assert_out "$want"
    assert_no_out "Use the NVIDIA GPU"
  done
}


@test "configure gpu: the GPU chosen before whose toolkit is gone is set up again, and FreeFrame restarted" {
  installed_server off bundled
  gpu_file
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=notoolkit
  keep_copy
  ff configure --yes --gpu nvidia
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_no_out "Nothing to change"
  assert_order install_nvidia_toolkit "dc up -d --no-build --force-recreate" "localhost:8000/health"
  cmp "$ENV" "$(BEFORE)"
  assert_out "Video processing: GPU (NVIDIA GeForce RTX 5070 Ti)"
}

@test "configure gpu: Docker that stays down after a failed toolkit set-up stops with the undo, and nothing is saved" {
  installed_server off bundled
  gpu_file
  export STUB_GPU=notoolkit STUB_GPU_SETUP_FAIL=1 STUB_GPU_DOCKER_DOWN=1 STUB_DOCKER_STAYS_DOWN=1
  keep_copy
  ff configure --yes --gpu nvidia
  [ "$status" -eq 1 ]
  assert_out "Docker did not come back after the NVIDIA change"
  assert_out "sudo cp /etc/docker/daemon.json.before-freeframe-nvidia-20261028-101010 /etc/docker/daemon.json && sudo systemctl restart docker"
  assert_out "sudo freeframe configure"
  assert_not_called "dc up"
  cmp "$ENV" "$(BEFORE)"
}

@test "configure gpu: Docker left down by a failed toolkit set-up is restarted once more, then FreeFrame comes back" {
  installed_server off bundled
  gpu_file
  export STUB_GPU=notoolkit STUB_GPU_SETUP_FAIL=1 STUB_GPU_DOCKER_DOWN=1
  ff configure --yes --gpu nvidia
  [ "$status" -eq 1 ]
  assert_order install_nvidia_toolkit "systemctl restart docker" "dc up -d --no-build" "localhost:8000/health"
  assert_out "video is still processed on the CPU"
  assert_has "$ENV" "FREEFRAME_GPU=off"
}

@test "configure gpu: another change while the GPU is broken restarts FreeFrame on the CPU, saying so" {
  installed_server off bundled
  gpu_file
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=notoolkit
  ff configure --yes --smtp-host smtp.example.com --smtp-from noreply@example.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_out "FreeFrame starts with video processing on the CPU until that is fixed"
  if grep -q '^files .*gpu' "$CALLS"; then cat "$CALLS"; false; fi
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
}


# ---------------------------------------------------------------- the worker's GPU, after the restart

@test "configure gpu worker: the GPU turned on, but the worker never sees it: started again once, and the closing line says the CPU" {
  installed_server off bundled
  gpu_file
  export STUB_GPU=ready STUB_WORKER_SMI=fail
  ff configure --yes --gpu nvidia
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(grep -c '^dc up -d --no-build --no-deps --force-recreate worker$' "$CALLS")" 1
  assert_order "dc up -d --no-build --force-recreate" "localhost:8000/health" "exec -T worker nvidia-smi -L"
  grep -qxF "Video processing: CPU for now: the worker could not use the GPU (NVIDIA GeForce RTX 5070 Ti)." <<<"$output" ||
    { echo "$output"; false; }
  assert_out "FREEFRAME_GPU=nvidia is kept. To try the GPU again, run: sudo freeframe restart."
  assert_no_out "Video processing: GPU"
  assert_has "$ENV" "FREEFRAME_GPU=nvidia"
}

@test "configure gpu worker: the GPU turned on and seen after one more start says the GPU" {
  installed_server off bundled
  gpu_file
  export STUB_GPU=ready STUB_WORKER_SMI=restart
  ff configure --yes --gpu nvidia
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(grep -c '^dc up -d --no-build --no-deps --force-recreate worker$' "$CALLS")" 1
  grep -qxF "Video processing: GPU (NVIDIA GeForce RTX 5070 Ti)" <<<"$output" || { echo "$output"; false; }
}

@test "configure gpu worker: another change with the GPU on checks the worker too, and warns when it does not see it" {
  installed_server sslip bundled
  gpu_file
  env_set "$ENV" FREEFRAME_GPU nvidia
  export STUB_GPU=ready STUB_WORKER_SMI=fail
  ff configure --yes --domain review.yourstudio.com
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_eq "$(grep -c '^dc up -d --no-build --no-deps --force-recreate worker$' "$CALLS")" 1
  assert_out "video is processed on the CPU for now"
}

@test "configure gpu worker: --gpu off asks the worker nothing" {
  installed_server off bundled
  env_set "$ENV" FREEFRAME_GPU nvidia
  gpu_file
  export STUB_GPU=ready STUB_WORKER_SMI=fail
  ff configure --yes --gpu off
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  assert_not_called "nvidia-smi"
  assert_not_called "no-deps"
}
