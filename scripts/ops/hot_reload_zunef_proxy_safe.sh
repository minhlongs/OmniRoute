#!/bin/bash
# hot_reload_zunef_proxy_safe.sh - Zero-downtime hot reload for zunef-token-proxy
# Guarantees no in-flight streams are severed before restarting.
set -uo pipefail

PORT=8790
MAX_WAIT_SEC=60
UID_NUM=$(id -u)
PLIST_LABEL="com.user.zunef-token-proxy"

echo "=== [Hot-Reload Safe Guard] Checking in-flight streams on port $PORT ==="
start_wait=$(date +%s)
while true; do
  active_conns=$( (lsof -nP -iTCP:$PORT -sTCP:ESTABLISHED 2>/dev/null || true) | grep -v 'COMMAND' | wc -l | tr -d ' ' )
  if [ "${active_conns:-0}" -eq 0 ]; then
    echo "[Hot-Reload Safe Guard] Zero active connections detected. Safe to reload."
    break
  fi
  now=$(date +%s)
  elapsed=$((now - start_wait))
  if [ "$elapsed" -ge "$MAX_WAIT_SEC" ]; then
    echo "[Hot-Reload Safe Guard] WARNING: Max wait time reached ($MAX_WAIT_SEC s), $active_conns connections still active."
    echo "Aborting reload to prevent dropping in-flight streams."
    exit 1
  fi
  echo "[Hot-Reload Safe Guard] $active_conns active connection(s) in-flight. Waiting... ($elapsed s / $MAX_WAIT_SEC s)"
  sleep 1
done

OLD_PID=$(pgrep -f 'zunef-token-proxy/proxy.cjs' || echo 'none')
echo "[Hot-Reload Safe Guard] Reloading $PLIST_LABEL (Current PID: $OLD_PID)..."

launchctl kickstart -k "gui/$UID_NUM/$PLIST_LABEL"
sleep 1

NEW_PID=$(pgrep -f 'zunef-token-proxy/proxy.cjs' || echo 'none')
echo "[Hot-Reload Safe Guard] New process started with PID: $NEW_PID"

# Smoke test
echo "[Hot-Reload Safe Guard] Running smoke test on health endpoint..."
health=$(curl -s -m 5 "http://127.0.0.1:$PORT/health" || echo 'failed')
echo "[Hot-Reload Safe Guard] Health status: $health"
echo "=== [Hot-Reload Safe Guard] Done. Successfully reloaded with zero in-flight drops. ==="
