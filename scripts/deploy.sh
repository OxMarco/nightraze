#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

compose() {
  docker compose -f docker-compose.prod.yml "$@"
}

rollback() {
  if ! docker image inspect nightraze-app:rollback >/dev/null 2>&1; then
    echo "No rollback image is available." >&2
    return 1
  fi

  echo "Restoring the previous application image..."
  docker image tag nightraze-app:rollback nightraze-app:current
  compose up -d --force-recreate --remove-orphans --wait --wait-timeout 90
  echo "Rollback is healthy."
}

if [ "${1:-}" = "--rollback" ]; then
  rollback
  exit 0
fi

if [ ! -f .env ]; then
  echo "Missing .env; copy .env.example and configure it first." >&2
  exit 1
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ "${SKIP_PULL:-0}" != "1" ]; then
  git pull --ff-only
fi

echo "Validating configuration and running the full test suite..."
compose config --quiet
make test

# Preserve the exact image ID used by the running container. Retagging is
# instantaneous and leaves one deliberately simple, local rollback point.
app_container="$(compose ps -q app 2>/dev/null || true)"
if [ -n "$app_container" ]; then
  docker image tag "$(docker inspect --format '{{.Image}}' "$app_container")" nightraze-app:rollback
  rollback_ready=1
else
  rollback_ready=0
fi

# Keep compose acting on one service at a time so deploy-time pressure stays
# away from the live game process. (Inside the single application image,
# BuildKit may still run the client and server build stages concurrently; both
# are short, and that is bounded by the builder rather than by compose.)
export COMPOSE_PARALLEL_LIMIT=1
compose pull --ignore-buildable
compose build --pull

echo "Starting the new release and waiting for container health..."
if compose up -d --remove-orphans --wait --wait-timeout 90 && ./scripts/smoke.sh; then
  echo "Deployment completed successfully."
  exit 0
fi

echo "Deployment failed health checks." >&2
if [ "$rollback_ready" -eq 1 ]; then
  rollback
else
  echo "This was the first deployment, so no prior images exist to restore." >&2
fi
exit 1
