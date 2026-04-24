#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-full}" # full | code-only | migrate | rebuild-db
APP_DIR="${APP_DIR:-/home/ec2-user/woa}"
ECOSYSTEM_FILE="${ECOSYSTEM_FILE:-ecosystem.config.cjs}"
APP_NAME="${APP_NAME:-cwa24}"
WORKER_NAME="${WORKER_NAME:-import-worker}"
NODE_ENV="${NODE_ENV:-production}"

REQUIRED_DB_ENV_VARS=(DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD)

log() {
  echo "[deploy] $*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

usage() {
  cat <<EOF
Usage: ./deploy.sh [mode]

Modes:
  full         Pull + install + migrate + reload app/worker
  code-only    Pull + install + reload app/worker (no DB migration)
  migrate      Pull + install + migrate only
  rebuild-db   Pull + install + destructive db rebuild + reload app/worker

Optional env overrides:
  APP_DIR=/home/ec2-user/woa
  ECOSYSTEM_FILE=ecosystem.config.cjs
  NODE_ENV=production
  APP_NAME=cwa24
  WORKER_NAME=import-worker
EOF
}

ensure_valkey() {
  log "Ensuring Valkey is installed and running"
  if ! command -v valkey-server >/dev/null 2>&1; then
    sudo dnf install -y valkey
  fi
  sudo systemctl enable valkey
  sudo systemctl start valkey
}

load_db_env_from_ecosystem_if_missing() {
  local missing=0
  for key in "${REQUIRED_DB_ENV_VARS[@]}"; do
    if [[ -z "${!key:-}" ]]; then
      missing=1
      break
    fi
  done

  if [[ "$missing" -eq 0 ]]; then
    return
  fi

  if [[ ! -f "${ECOSYSTEM_FILE}" ]]; then
    return
  fi

  log "Loading DB env from ${ECOSYSTEM_FILE} (migrate/cwa24 env block)"

  # shellcheck disable=SC1090
  eval "$(
    node -e '
      const path = process.argv[1];
      const cfg = require(path);
      const apps = Array.isArray(cfg?.apps) ? cfg.apps : [];
      const pick = (name) => apps.find((a) => a && a.name === name);
      const selected = pick("migrate") || pick("cwa24") || {};
      const env = Object.assign({}, selected.env || {}, selected.env_production || {});
      const keys = ["DB_HOST","DB_PORT","DB_NAME","DB_USER","DB_PASSWORD"];
      for (const key of keys) {
        const val = env[key];
        if (val !== undefined && val !== null && String(val).trim() !== "") {
          const safe = String(val).replace(/'\''/g, "'\''\"'\''\"'\''");
          console.log(`export ${key}='\''${safe}'\''`);
        }
      }
    ' "./${ECOSYSTEM_FILE}"
  )"
}

preflight_db_env() {
  load_db_env_from_ecosystem_if_missing

  local missing=()
  for key in "${REQUIRED_DB_ENV_VARS[@]}"; do
    if [[ -z "${!key:-}" ]]; then
      missing+=("$key")
    fi
  done

  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "[deploy] ERROR: Missing DB env vars: ${missing[*]}" >&2
    echo "[deploy] Set them in shell/env or in ${ECOSYSTEM_FILE} under migrate/cwa24 env." >&2
    exit 1
  fi

  log "DB preflight ok (host=${DB_HOST}, db=${DB_NAME}, user=${DB_USER}, port=${DB_PORT})"
}

run_pull_and_install() {
  log "Pulling latest"
  git pull origin main

  log "Installing dependencies"
  npm ci --omit=dev
}

run_migrate() {
  preflight_db_env
  log "Running DB migrations (NODE_ENV=${NODE_ENV})"
  NODE_ENV="${NODE_ENV}" npm run migrate
}

run_rebuild() {
  preflight_db_env
  log "Running DESTRUCTIVE DB rebuild (NODE_ENV=${NODE_ENV})"
  NODE_ENV="${NODE_ENV}" npm run db:rebuild
}

reload_services() {
  log "Deploying app (reload env from ${ECOSYSTEM_FILE})"
  pm2 start "${ECOSYSTEM_FILE}" --only "${APP_NAME}" --env "${NODE_ENV}" --update-env

  log "Deploying import worker (reload env from ${ECOSYSTEM_FILE})"
  pm2 start "${ECOSYSTEM_FILE}" --only "${WORKER_NAME}" --env "${NODE_ENV}" --update-env

  pm2 save
}

main() {
  require_cmd git
  require_cmd npm
  require_cmd node
  require_cmd pm2

  cd "${APP_DIR}" || exit 1

  ensure_valkey
  run_pull_and_install

  case "${MODE}" in
    code-only)
      reload_services
      ;;
    migrate)
      run_migrate
      ;;
    full)
      run_migrate
      reload_services
      ;;
    rebuild-db)
      run_rebuild
      reload_services
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      echo "Unknown mode: ${MODE}" >&2
      usage
      exit 1
      ;;
  esac

  log "Deployment done (${MODE})"
}

main
