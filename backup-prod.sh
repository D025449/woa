#!/usr/bin/env bash
set -euo pipefail

SSH_TARGET="${BACKUP_SSH_TARGET:-cwa24-ec2}"
REMOTE_APP_DIR="${BACKUP_APP_DIR:-/home/ec2-user/woa}"

log() {
  echo "[backup-prod] $*"
}

fail() {
  echo "[backup-prod] ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

usage() {
  cat <<EOF
Usage: npm run backup:prod
   or: ./backup-prod.sh

Optional environment overrides:
  BACKUP_SSH_TARGET=cwa24-ec2
  BACKUP_APP_DIR=/home/ec2-user/woa
EOF
}

main() {
  case "${1:-}" in
    -h|--help|help)
      usage
      exit 0
      ;;
    "")
      ;;
    *)
      usage >&2
      fail "Unknown argument: $1"
      ;;
  esac

  require_cmd ssh

  log "Starting production backup on ${SSH_TARGET}"
  ssh "$SSH_TARGET" "cd '$REMOTE_APP_DIR' && NODE_ENV=production npm run backup:create"
  log "Production backup completed successfully"
}

main "$@"
