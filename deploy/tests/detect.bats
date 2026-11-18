#!/usr/bin/env bats
# Detecting a FreeFrame this script does not manage, DNS, IP and OS checks.
# docker and getent are always stubbed: these tests never reach a real daemon.

load helpers

setup() {
  common_setup
  PS_OUT=""
  VOL_OUT=""
  DOCKER_FAIL=""
  # Canned docker: `ps` prints PS_OUT, `volume ls` prints VOL_OUT. Lines are
  # tab-separated in the order detect_foreign_install asks for.
  docker() {
    [[ -n "$DOCKER_FAIL" ]] && { echo "Cannot connect to the Docker daemon" >&2; return 1; }
    case "$1" in
      ps) [[ -n "$PS_OUT" ]] && printf '%s\n' "$PS_OUT"; return 0 ;;
      volume) [[ -n "$VOL_OUT" ]] && printf '%s\n' "$VOL_OUT"; return 0 ;;
      *) echo "unexpected docker call: $*" >&2; return 99 ;;
    esac
  }
}

# ctr PROJECT WORKDIR SERVICE IMAGE ; vol NAME PROJECT
ctr() { printf '%s\t%s\t%s\t%s' "$1" "$2" "$3" "$4"; }
vol() { printf '%s\t%s' "$1" "$2"; }

@test "detect: (a) nothing on the server" {
  run detect_foreign_install
  [ "$status" -eq 1 ]
}

@test "detect: (b) only containers of project freeframe whose working dir is FF_ROOT" {
  PS_OUT="$(ctr freeframe "$FF_ROOT" api ghcr.io/techiebutler/freeframe-api:1.22.0)
$(ctr freeframe "$FF_ROOT" web ghcr.io/techiebutler/freeframe-web:1.22.0)
$(ctr freeframe "$FF_ROOT" postgres postgres:16-alpine)
$(ctr freeframe "$FF_ROOT" traefik traefik:v2.11)"
  VOL_OUT="$(vol freeframe_pgdata freeframe)
$(vol freeframe_redisdata freeframe)"
  run detect_foreign_install
  [ "$status" -eq 1 ]
}

@test "detect: (c) a project freeframe in /home/u/freeframe with freeframe_pgdata" {
  PS_OUT="$(ctr freeframe /home/u/freeframe api freeframe-api)
$(ctr freeframe /home/u/freeframe worker freeframe-worker)
$(ctr freeframe /home/u/freeframe postgres postgres:16-alpine)"
  VOL_OUT="$(vol freeframe_pgdata freeframe)"
  run detect_foreign_install
  [ "$status" -eq 0 ]
}

@test "detect: a published FreeFrame image in another directory" {
  PS_OUT="$(ctr review /srv/review api ghcr.io/techiebutler/freeframe-api:1.21.0)"
  run detect_foreign_install
  [ "$status" -eq 0 ]
}

@test "detect: a clone in a renamed directory, found by its pgdata volume and services" {
  PS_OUT="$(ctr review /srv/review api review-api)
$(ctr review /srv/review worker review-worker)
$(ctr review /srv/review email_worker review-email_worker)
$(ctr review /srv/review maintenance_worker review-maintenance_worker)
$(ctr review /srv/review postgres postgres:16-alpine)"
  VOL_OUT="$(vol review_pgdata review)"
  run detect_foreign_install
  [ "$status" -eq 0 ]
}

@test "detect: a stopped clone named freeframe that left only its database volume" {
  VOL_OUT="$(vol freeframe_pgdata freeframe)"
  run detect_foreign_install
  [ "$status" -eq 0 ]
}

@test "detect: the same leftover volume is ours when this script's settings exist" {
  : > "$FF_ROOT/.env.prod"
  VOL_OUT="$(vol freeframe_pgdata freeframe)"
  run detect_foreign_install
  [ "$status" -eq 1 ]
}

@test "detect: an old unlabelled freeframe_pgdata volume" {
  VOL_OUT="$(vol freeframe_pgdata "")"
  run detect_foreign_install
  [ "$status" -eq 0 ]
}

@test "detect: an unrelated app with its own pgdata volume is not FreeFrame" {
  PS_OUT="$(ctr blog /srv/blog app wordpress:6)
$(ctr blog /srv/blog db postgres:16)"
  VOL_OUT="$(vol blog_pgdata blog)"
  run detect_foreign_install
  [ "$status" -eq 1 ]
}

@test "detect: our own containers next to a clone elsewhere still finds the clone" {
  PS_OUT="$(ctr freeframe "$FF_ROOT" api ghcr.io/techiebutler/freeframe-api:1.22.0)
$(ctr freeframe /home/u/freeframe api freeframe-api)"
  VOL_OUT="$(vol freeframe_pgdata freeframe)"
  run detect_foreign_install
  [ "$status" -eq 0 ]
}

@test "detect: a git checkout of FreeFrame in the install folder" {
  mkdir -p "$FF_ROOT/.git"
  run detect_foreign_install
  [ "$status" -eq 0 ]
}

@test "detect: docker not answering is not reported as nothing found" {
  DOCKER_FAIL=1
  run detect_foreign_install
  [ "$status" -eq 2 ]
}

@test "detect: no docker installed means nothing to find" {
  unset -f docker
  PATH="$BATS_TEST_TMPDIR/empty-bin" run detect_foreign_install
  [ "$status" -eq 1 ]
}

@test "dns_points_here when the name resolves to this IP" {
  getent() {
    [[ "$1 $2" == "ahostsv4 review.example.com" ]] || return 2
    printf '%s\n' "203.0.113.7     STREAM review.example.com" \
      "203.0.113.7     DGRAM" "203.0.113.7     RAW"
  }
  run dns_points_here review.example.com 203.0.113.7
  [ "$status" -eq 0 ]
}

@test "dns_points_here when the name resolves elsewhere" {
  getent() { printf '%s\n' "198.51.100.9    STREAM review.example.com"; }
  run dns_points_here review.example.com 203.0.113.7
  [ "$status" -eq 1 ]
}

@test "dns_points_here does not match a longer address" {
  getent() { printf '%s\n' "203.0.113.70    STREAM review.example.com"; }
  run dns_points_here review.example.com 203.0.113.7
  [ "$status" -eq 1 ]
}

@test "dns_points_here with one of several addresses" {
  getent() { printf '%s\n' "198.51.100.9    STREAM x" "203.0.113.7     STREAM"; }
  run dns_points_here review.example.com 203.0.113.7
  [ "$status" -eq 0 ]
}

@test "dns_points_here when the name does not resolve" {
  getent() { return 2; }
  run dns_points_here typo.example.com 203.0.113.7
  [ "$status" -eq 1 ]
}

@test "is_public_ipv4 203.0.113.7 is public" {
  run is_public_ipv4 203.0.113.7
  [ "$status" -eq 0 ]
  run is_public_ipv4 8.8.8.8
  [ "$status" -eq 0 ]
  run is_public_ipv4 172.32.0.1
  [ "$status" -eq 0 ]
  run is_public_ipv4 100.128.0.1
  [ "$status" -eq 0 ]
}

@test "is_public_ipv4 private, loopback, link-local, CGNAT and malformed are not public" {
  local ip
  for ip in 10.1.2.3 172.16.0.1 172.31.255.255 192.168.0.1 127.0.0.1 169.254.1.1 \
    100.64.0.1 100.127.255.255 0.0.0.0 224.0.0.1 255.255.255.255 \
    999.1.1.1 1.2.3 1.2.3.4.5 a.b.c.d "" 01.2.3.4 "1.2.3.4 "; do
    run is_public_ipv4 "$ip"
    if [ "$status" -ne 1 ]; then
      echo "expected not public: '$ip'"
      return 1
    fi
  done
}

@test "sslip_host 203.0.113.7 is 203-0-113-7.sslip.io" {
  run sslip_host 203.0.113.7
  assert_eq "$output" "203-0-113-7.sslip.io"
}

@test "os_supported allowlist" {
  run os_supported ubuntu 24.04; [ "$status" -eq 0 ]
  run os_supported ubuntu 22.04; [ "$status" -eq 0 ]
  run os_supported ubuntu 26.04; [ "$status" -eq 0 ]
  run os_supported debian 12; [ "$status" -eq 0 ]
  run os_supported debian 13; [ "$status" -eq 0 ]
  run os_supported ubuntu 20.04; [ "$status" -eq 1 ]
  run os_supported ubuntu 25.04; [ "$status" -eq 1 ]
  run os_supported debian 11; [ "$status" -eq 1 ]
  run os_supported centos 9; [ "$status" -eq 1 ]
  run os_supported "" ""; [ "$status" -eq 1 ]
}

@test "detect works under strict mode (set -Eeuo pipefail)" {
  PS_OUT="$(ctr freeframe /home/u/freeframe api freeframe-api)"
  VOL_OUT="$(vol freeframe_pgdata freeframe)"
  export PS_OUT VOL_OUT DOCKER_FAIL
  export -f docker
  run ff_strict detect_foreign_install
  [ "$status" -eq 0 ]
  PS_OUT="" VOL_OUT=""
  run ff_strict detect_foreign_install
  [ "$status" -eq 1 ]
}

@test "valid_hostname" {
  local n
  for n in review.example.com Review-1.Example.com nas 203.0.113.7 a.b-c.d; do
    run valid_hostname "$n"; [ "$status" -eq 0 ] || { echo "rejected $n"; return 1; }
  done
  for n in "" https://a.com a.com:80 a.com/x "a b.com" "a\`b.com" -a.com a-.com a..b a.com. \
    "a_b.com" ".a.com" "a.com " "$(printf 'x%.0s' {1..64}).com"; do
    run valid_hostname "$n"; [ "$status" -eq 1 ] || { echo "accepted [$n]"; return 1; }
  done
}
