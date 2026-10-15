#!/usr/bin/env bash

# Sourced by install.sh. Never source the saved configuration as shell code.
saved_network_value() {
  [ -f "$FLIGHT_FINDER_DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$FLIGHT_FINDER_DIR/.env" | tail -n 1
}

lan_ip() {
  if [ "$OS" = macos ]; then
    ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
  else
    hostname -I 2>/dev/null | awk '{print $1}' || true
  fi
}

port_in_use() {
  if command -v lsof >/dev/null; then
    lsof -i :"$1" >/dev/null 2>&1
  elif command -v ss >/dev/null; then
    ss -tln | grep -q ":$1 "
  elif command -v netstat >/dev/null; then
    netstat -tln 2>/dev/null | grep -q ":$1 "
  else
    return 1
  fi
}

configure_install_network() {
  local saved_port existing_web installed_port
  saved_port=$(saved_network_value HOST_PORT)
  if [ -n "$saved_port" ]; then
    HOST_PORT="$saved_port"
  fi
  [[ "$HOST_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$HOST_PORT" -le 65535 ] || fail "HOST_PORT must be between 1 and 65535, without leading zeros"
  while port_in_use "$HOST_PORT"; do
    existing_web=""
    if [ -f "$FLIGHT_FINDER_DIR/docker-compose.yml" ]; then
      existing_web=$($DC -f "$FLIGHT_FINDER_DIR/docker-compose.yml" ps -q web)
    fi
    if [ -n "$existing_web" ]; then
      installed_port=$($CONTAINER_CMD inspect --format '{{(index (index .NetworkSettings.Ports "3003/tcp") 0).HostPort}}' "$existing_web")
      [ "$installed_port" = "$HOST_PORT" ] && break
    fi
    [ -z "$saved_port" ] || fail "Saved port $HOST_PORT is occupied by another service. Free it before reinstalling."
    warn "Port ${HOST_PORT} is already in use."
    if [ "${FLIGHT_FINDER_YES:-}" = 1 ]; then
      HOST_PORT=$((HOST_PORT + 1))
    else
      local selected_port
      read -rp "  Enter a different port [default: $((HOST_PORT + 1))]: " selected_port < /dev/tty
      HOST_PORT="${selected_port:-$((HOST_PORT + 1))}"
    fi
    [[ "$HOST_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$HOST_PORT" -le 65535 ] || fail "HOST_PORT must be between 1 and 65535, without leading zeros"
  done
  INSTALL_BIND_ADDRESS="${HOST_BIND_ADDRESS:-$(saved_network_value HOST_BIND_ADDRESS)}"
  derive_install_origins
  ok "Using port ${HOST_PORT}"
}

# Shared by fresh installation and host-side update migration. Never infer trust
# from a browser request or a container's bridge address.
derive_install_origins() {
  INSTALL_LAN_IP=""
  INSTALL_PASSWORD_ORIGINS="[\"http://localhost:${HOST_PORT}\",\"http://127.0.0.1:${HOST_PORT}\",\"http://[::1]:${HOST_PORT}\""
  if [ "$INSTALL_BIND_ADDRESS" != 127.0.0.1 ] && [ "$INSTALL_BIND_ADDRESS" != ::1 ]; then
    INSTALL_LAN_IP=$(lan_ip)
    if [[ "$INSTALL_LAN_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      INSTALL_PASSWORD_ORIGINS+=",\"http://${INSTALL_LAN_IP}:${HOST_PORT}\""
    else
      INSTALL_LAN_IP=""
    fi
  fi
  INSTALL_PASSWORD_ORIGINS+="]"
}

wait_for_install_access() {
  local timeout="${FLIGHT_FINDER_STARTUP_TIMEOUT:-180}" deadline
  [[ "$timeout" =~ ^[1-9][0-9]{0,4}$ ]] || fail "FLIGHT_FINDER_STARTUP_TIMEOUT must be a positive number of seconds"
  deadline=$((SECONDS + timeout))
  until curl --max-time 2 -sf "http://localhost:${HOST_PORT}/api/health" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || fail "App did not become healthy. Run 'flight-finder logs' to diagnose startup."
    sleep 1
  done
  if ! curl --max-time 10 -fsS -H "Origin: http://localhost:${HOST_PORT}" -H 'Content-Type: application/json' \
    --data '{}' "http://localhost:${HOST_PORT}/api/access/check-origin" >/dev/null; then
    fail "Local access is not allowed by the instance configuration. Run 'flight-finder access origin http://localhost:${HOST_PORT}' or configure SIDEDOOR_PASSWORD_ORIGINS, then restart."
  fi
}

print_install_connections() {
  printf '\nConnection addresses must be configured before login.\n'
  printf '  Local: http://localhost:%s\n' "$HOST_PORT"
  if [ -n "$INSTALL_LAN_IP" ]; then
    printf '  LAN candidate: http://%s:%s\n' "$INSTALL_LAN_IP" "$HOST_PORT"
    printf '  An explicit SIDEDOOR_PASSWORD_ORIGINS list takes precedence over detected addresses.\n'
  fi
  printf '\nFor a reverse proxy, Cloudflare tunnel, or Tailscale HTTPS address:\n'
  printf '  flight-finder access origin https://your-hostname\n'
  printf 'Run that command locally after obtaining the address, before opening it.\n'
  printf 'Temporary tunnel addresses must be configured again when they change.\n'
  printf 'Use SIDEDOOR_PASSWORD_ORIGINS in the installed configuration for additional exact origins.\n'
}
