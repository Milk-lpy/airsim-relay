#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'HELP'
Usage: bash install.sh [--source DIR | --ref TAG_OR_SHA] [--dir DIR]
                       [--bind IP|auto-private] [--setup-port PORT]

Installs AirSIM Relay using Docker Engine and Docker Compose v2 on Linux.
Default installation: /opt/airsim-relay-standalone
Relay HTTPS: 127.0.0.1:18788 (choose a LAN or WireGuard IP with --bind).
Setup: 127.0.0.1:18181 via SSH local forwarding.
--source uses an extracted source tree. Image builds still need Docker Hub
and npm on a fresh machine. --ref defaults to the main branch.
Re-running against the same directory preserves device data, credentials,
and previous network selections. The final setup link grants admin access.
HELP
}

fail() { printf 'AirSIM: %s\n' "$*" >&2; exit 1; }

valid_ipv4() {
  local ip=$1 octet
  [[ $ip =~ ^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$ ]] || return 1
  local -a octets
  IFS=. read -ra octets <<< "$ip"
  for octet in "${octets[@]}"; do (( octet <= 255 )) || return 1; done
}

auto_private() {
  command -v ip >/dev/null || fail '--bind auto-private requires iproute2; use --bind with a local IP'
  local address
  address=$(ip -4 route get 1.1.1.1 | awk '{ for (i=1;i<NF;i++) if ($i=="src") {print $(i+1); exit} }')
  valid_ipv4 "$address" || fail 'No IPv4 route found; select a local IP with --bind'
  case "$address" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) printf '%s\n' "$address" ;;
    *) fail 'Default route does not use an RFC 1918 address; select your LAN or WireGuard IP with --bind' ;;
  esac
}

# Only install runtime sources. Previous deployments can contain private keys,
# configuration, or device databases beside their original checkout.
stage_source() (
  cd -- "$1"
  local dest=$2 file
  for file in Dockerfile .dockerignore compose.yaml install.sh LICENSE NOTICE THIRD_PARTY_NOTICES.md \
              setup/server.mjs setup/runtime.mjs setup/web/index.html \
              setup/trust/apple-{roots,intermediates}.pem push-relay-worker/self-hosted/package{,-lock}.json; do
    [[ -f $file && ! -L $file ]] || fail "Missing source file: $file"
  done
  shopt -s globstar nullglob
  local -a files=(Dockerfile .dockerignore compose.yaml install.sh LICENSE NOTICE THIRD_PARTY_NOTICES.md README.md
                  setup/*.mjs setup/trust/apple-{roots,intermediates}.pem setup/trust/README.md
                  setup/web/**/*.{js,mjs,html,css,svg,woff2}
                  push-relay-worker/src/*.mjs push-relay-worker/self-hosted/*.mjs
                  push-relay-worker/self-hosted/package{,-lock}.json)
  for file in "${files[@]}"; do
    if [[ -f $file && ! -L $file ]]; then cp --parents -- "$file" "$dest/"; fi
  done
)

compose_release() (
  unset AIRSIM_BIND_IP AIRSIM_IMAGE AIRSIM_SETUP_PORT COMPOSE_PROJECT_NAME COMPOSE_FILE
  cd -- "$1"
  shift
  docker compose --project-name "$project" --env-file .env -f compose.yaml "$@"
)

fetch_source() (
  local ref=$1 dest=$2 archive_dir
  [[ $ref =~ ^[a-zA-Z0-9._/-]+$ && $ref != *..* && $ref != /* ]] || fail 'Invalid GitHub ref'
  archive_dir=$(mktemp -d)
  trap 'rm -rf -- "$archive_dir"' EXIT
  curl --proto '=https' --proto-redir '=https' -fLsS --retry 3 \
    "https://codeload.github.com/Milk-lpy/airsim-relay/tar.gz/$ref" -o "$archive_dir/source.tar.gz"
  mkdir -- "$archive_dir/source"
  tar -xzf "$archive_dir/source.tar.gz" --strip-components=1 --no-same-owner -C "$archive_dir/source"
  stage_source "$archive_dir/source" "$dest"
)

# Authenticate inside the container. Only the public status is compared, and
# neither a credential nor an Authorization header appears in process arguments.
check_status() {
  compose_release "$1" exec -T relay node -e '
    const {readFileSync} = require("node:fs");
    const token = readFileSync("/data/setup-token", "utf8").trim();
    fetch("http://127.0.0.1:18181/api/status", {
      headers: {Authorization: "Bearer " + token}, signal: AbortSignal.timeout(2000)
    }).then(async response => {
      const {ok, status} = await response.json();
      const running = status?.configured === true && status?.running === true;
      const valid = response.ok && ok === true && typeof status?.configured === "boolean" &&
        typeof status?.running === "boolean";
      process.exit(valid && (process.argv[1] !== "running" || running) ? 0 : 1);
    }).catch(() => process.exit(1));
  ' "$2" >/dev/null 2>&1
}

wait_ready() {
  local release=$1 port=$2 expectation=$3 attempt
  for ((attempt=0; attempt<45; attempt++)); do
    if curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$port/" >/dev/null 2>&1 &&
        check_status "$release" "$expectation"; then return 0; fi
    sleep 1
  done
  return 1
}

main() {
  local install_dir=/opt/airsim-relay-standalone source_dir= ref= bind_ip=${AIRSIM_BIND_IP:-} setup_port=${AIRSIM_SETUP_PORT:-}
  while (( $# )); do
    case "$1" in
      -h|--help) usage; return ;;
      --dir|--source|--ref|--bind|--setup-port)
        (( $# >= 2 )) && [[ -n $2 ]] || fail "Missing value for $1"
        case "$1" in
          --dir) install_dir=$2 ;; --source) source_dir=$2 ;; --ref) ref=$2 ;;
          --bind) bind_ip=$2 ;; --setup-port) setup_port=$2 ;;
        esac
        shift 2 ;;
      *) fail "Unknown option $1 (see --help)" ;;
    esac
  done
  [[ -z $source_dir || -z $ref ]] || fail '--source and --ref cannot be used together'
  [[ $(uname -s) == Linux ]] || fail 'The installer requires Linux'
  local dep
  for dep in docker flock curl sha256sum tar; do command -v "$dep" >/dev/null || fail "Missing program: $dep"; done
  docker info >/dev/null 2>&1 || fail 'Cannot reach the local Docker Engine. Check Docker and your socket permissions.'
  docker compose version >/dev/null 2>&1 || fail 'Install the Docker Compose v2 plugin'
  mkdir -p -- "$install_dir/releases"
  install_dir=$(cd -- "$install_dir" && pwd -P)
  exec 9>"$install_dir/.install.lock"
  flock -n 9 || fail 'Another installation is running in this directory'
  local previous= current="$install_dir/current" project
  if [[ -L $current ]]; then
    previous=$(readlink -e -- "$current") || fail 'Existing current release is missing'
    [[ $previous == "$install_dir/releases/"* && -f "$previous/.env" ]] || fail 'Unrecognized current release'
  elif [[ -e $current ]]; then fail 'Installation directory contains an unrelated current file'; fi
  if [[ -n $previous ]]; then
    [[ -n $bind_ip ]] || bind_ip=$(sed -n 's/^AIRSIM_BIND_IP=//p' "$previous/.env")
    [[ -n $setup_port ]] || setup_port=$(sed -n 's/^AIRSIM_SETUP_PORT=//p' "$previous/.env")
  fi
  bind_ip=${bind_ip:-127.0.0.1}
  setup_port=${setup_port:-18181}
  [[ $bind_ip != auto-private ]] || bind_ip=$(auto_private)
  valid_ipv4 "$bind_ip" && [[ $bind_ip != 0.0.0.0 ]] || fail 'Select a specific local IPv4 address with --bind'
  [[ $setup_port =~ ^[1-9][0-9]{0,4}$ ]] && (( setup_port < 65536 && setup_port != 18788 )) || fail 'Choose a setup port in 1..65535 other than 18788'
  project="airsim-relay-$(printf %s "$install_dir" | sha256sum | cut -c1-12)"
  local stage
  stage=$(mktemp -d "$install_dir/releases/release.XXXXXXXXXX")
  if [[ -z $source_dir ]]; then fetch_source "${ref:-main}" "$stage"
  else stage_source "$source_dir" "$stage"; fi
  local release_name=${stage##*/} image="$project:${stage##*/}"
  # Store the project name here too, so manual Compose commands in current use
  # the same database volume as this installer.
  printf 'COMPOSE_PROJECT_NAME=%s\nAIRSIM_IMAGE=%s\nAIRSIM_BIND_IP=%s\nAIRSIM_SETUP_PORT=%s\n' \
    "$project" "$image" "$bind_ip" "$setup_port" > "$stage/.env"
  compose_release "$stage" build relay
  local token= expectation=ready previous_port
  if [[ -n $previous ]] && check_status "$previous" running; then expectation=running; fi
  if compose_release "$stage" up -d --no-build relay && wait_ready "$stage" "$setup_port" "$expectation"; then
    token=$(compose_release "$stage" exec -T relay cat /data/setup-token 2>/dev/null) || token=
  fi
  if [[ ! $token =~ ^[A-Za-z0-9_-]{43,128}$ ]]; then
    if [[ -n $previous ]]; then
      printf 'New release failed verification; restoring previous container.\n' >&2
      previous_port=$(sed -n 's/^AIRSIM_SETUP_PORT=//p' "$previous/.env")
      compose_release "$previous" up -d --no-build relay && wait_ready "$previous" "$previous_port" "$expectation" ||
        fail "Restore failed. Inspect the previous release in $previous"
    else
      compose_release "$stage" stop relay >&2 || true
    fi
    fail "Setup did not become ready. Inspect the failed release in $stage"
  fi
  local next="$install_dir/.current-$release_name"
  ln -s -- "releases/$release_name" "$next"
  mv -Tf -- "$next" "$current"
  printf '\nInstalled in %s\nRelay address after setup: https://%s:18788\n' "$current" "$bind_ip"
  printf 'Forward setup over SSH: ssh -N -L %s:127.0.0.1:%s user@server\n' "$setup_port" "$setup_port"
  printf 'Private setup link: http://127.0.0.1:%s/#token=%s\n' "$setup_port" "$token"
}

main "$@"
