#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMIT_MESSAGE="${1:-}"
REMOTE_NAME="${GIT_REMOTE:-origin}"
RELEASE_BRANCH="${RELEASE_BRANCH:-main}"
SSH_TARGET="${DEPLOY_SSH_TARGET:-cwa24-ec2}"
REMOTE_APP_DIR="${DEPLOY_APP_DIR:-/home/ec2-user/woa}"

log() {
  echo "[release] $*"
}

fail() {
  echo "[release] ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

usage() {
  cat <<EOF
Usage: npm run deploy:prod -- "commit message"
   or: ./release-prod.sh "commit message"

Optional environment overrides:
  SKIP_RELEASE_CHECKS=1       Skip npm test and npm run check
  GIT_REMOTE=origin          Git remote to push
  RELEASE_BRANCH=main        Branch deployed by the server
  DEPLOY_SSH_TARGET=cwa24-ec2
  DEPLOY_APP_DIR=/home/ec2-user/woa
EOF
}

main() {
  if [[ -z "${COMMIT_MESSAGE// }" || "$COMMIT_MESSAGE" == "-h" || "$COMMIT_MESSAGE" == "--help" ]]; then
    usage
    [[ -n "$COMMIT_MESSAGE" ]] && exit 0
    exit 1
  fi

  require_cmd git
  require_cmd npm
  require_cmd ssh
  cd "$ROOT_DIR"

  local branch
  branch="$(git branch --show-current)"
  [[ "$branch" == "$RELEASE_BRANCH" ]] \
    || fail "Current branch is '$branch'; production deploys '$RELEASE_BRANCH'"

  git remote get-url "$REMOTE_NAME" >/dev/null 2>&1 \
    || fail "Git remote '$REMOTE_NAME' does not exist"

  if [[ "${SKIP_RELEASE_CHECKS:-0}" != "1" ]]; then
    log "Running tests"
    npm test
    log "Running checks"
    npm run check
  else
    log "Skipping tests and checks (SKIP_RELEASE_CHECKS=1)"
  fi

  log "Staging repository changes"
  git add --all
  git diff --cached --quiet && fail "No changes to commit"
  git diff --cached --check

  log "Creating commit: $COMMIT_MESSAGE"
  git commit -m "$COMMIT_MESSAGE"

  log "Pushing $REMOTE_NAME/$RELEASE_BRANCH"
  git push "$REMOTE_NAME" "$RELEASE_BRANCH"

  log "Deploying code-only on $SSH_TARGET"
  ssh "$SSH_TARGET" "cd '$REMOTE_APP_DIR' && ./deploy.sh code-only"

  log "Production deployment completed successfully"
}

main "$@"
