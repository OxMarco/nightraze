#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
set -a
. ./.env
set +a

base_url="https://$DOMAIN"
healthy=0
for _attempt in $(seq 1 40); do
  if curl --connect-timeout 3 --max-time 10 -fsS "$base_url/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 3
done

if [ "$healthy" -ne 1 ]; then
  echo "Health smoke check failed for $base_url/health" >&2
  curl --connect-timeout 3 --max-time 10 -v "$base_url/health" || true
  exit 1
fi

curl --connect-timeout 3 --max-time 10 -fsS "$base_url/" >/dev/null

headers="$(mktemp)"
trap 'rm -f "$headers"' EXIT
curl --http1.1 --connect-timeout 3 --max-time 3 -sS -D "$headers" -o /dev/null \
  -H "Origin: $base_url" \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$base_url/play?name=smoke" 2>/dev/null || true

if ! grep -Eq '^HTTP/[0-9.]+ 101' "$headers"; then
  echo "WebSocket smoke check failed for $base_url/play" >&2
  sed -n '1,20p' "$headers" >&2
  exit 1
fi

echo "Smoke checks passed: static site, simulation health, and WebSocket upgrade."
