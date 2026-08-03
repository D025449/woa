#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="26.4.0"
PM2_VERSION="6.0.14"
APP_USER="${APP_USER:-ec2-user}"
SWAP_SIZE_GIB="${SWAP_SIZE_GIB:-2}"
NODE_PLATFORM="linux-arm64"
NODE_INSTALL_DIR="/opt/node-v${NODE_VERSION}-${NODE_PLATFORM}"
PG_DATA_DIR="/var/lib/pgsql/data"

log() {
  printf '[bootstrap] %s\n' "$*"
}

fail() {
  printf '[bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ "${EUID}" -eq 0 ]] || fail "Run this script as root (sudo)."
}

verify_platform() {
  [[ -r /etc/os-release ]] || fail "Cannot identify the operating system."
  # shellcheck disable=SC1091
  source /etc/os-release

  [[ "${ID:-}" == "amzn" && "${VERSION_ID:-}" == "2023" ]] \
    || fail "Amazon Linux 2023 is required."

  case "$(uname -m)" in
    aarch64|arm64) ;;
    *) fail "ARM64 is required; detected $(uname -m)." ;;
  esac

  id "${APP_USER}" >/dev/null 2>&1 || fail "User ${APP_USER} does not exist."
}

expand_root_filesystem() {
  local root_source
  local root_disk_name
  local root_partition_name
  local root_partition_number
  local root_fs_type

  root_source="$(findmnt -no SOURCE /)"
  root_disk_name="$(lsblk -no PKNAME "${root_source}")"
  root_partition_name="$(basename "${root_source}")"
  root_partition_number="$(cat "/sys/class/block/${root_partition_name}/partition" 2>/dev/null || true)"
  root_fs_type="$(findmnt -no FSTYPE /)"

  if [[ -z "${root_disk_name}" || -z "${root_partition_number}" ]]; then
    log "Root filesystem is not on a detectable partition; skipping expansion"
    return
  fi

  log "Expanding root partition to the available EBS volume size"
  growpart "/dev/${root_disk_name}" "${root_partition_number}" || true

  case "${root_fs_type}" in
    xfs) xfs_growfs / ;;
    ext4) resize2fs "${root_source}" ;;
    *) fail "Unsupported root filesystem for automatic expansion: ${root_fs_type}" ;;
  esac
}

install_packages() {
  log "Updating Amazon Linux packages"
  dnf upgrade -y

  log "Installing PostgreSQL, Valkey, Nginx, Certbot, and build tools"
  dnf install -y \
    ca-certificates \
    gcc \
    gcc-c++ \
    git \
    libatomic \
    make \
    nginx \
    postgresql15 \
    postgresql15-contrib \
    postgresql15-server \
    python3-certbot-nginx \
    tar \
    unzip \
    valkey \
    xz
}

install_node() {
  local archive="node-v${NODE_VERSION}-${NODE_PLATFORM}.tar.xz"
  local base_url="https://nodejs.org/dist/v${NODE_VERSION}"
  local work_dir
  local checksum

  if [[ -x "${NODE_INSTALL_DIR}/bin/node" ]] \
    && [[ "$("${NODE_INSTALL_DIR}/bin/node" --version)" == "v${NODE_VERSION}" ]]; then
    log "Node.js v${NODE_VERSION} is already installed"
  else
    work_dir="$(mktemp -d)"
    trap 'rm -rf "${work_dir:-}"' RETURN

    log "Downloading official Node.js v${NODE_VERSION} ARM64 distribution"
    curl --fail --location --silent --show-error \
      --output "${work_dir}/${archive}" "${base_url}/${archive}"
    curl --fail --location --silent --show-error \
      --output "${work_dir}/SHASUMS256.txt" "${base_url}/SHASUMS256.txt"

    checksum="$(awk -v archive="${archive}" '$2 == archive { print $1 }' "${work_dir}/SHASUMS256.txt")"
    [[ -n "${checksum}" ]] || fail "Node.js checksum was not found."
    printf '%s  %s\n' "${checksum}" "${work_dir}/${archive}" | sha256sum --check --status \
      || fail "Node.js checksum verification failed."

    rm -rf "${NODE_INSTALL_DIR}"
    tar -xJf "${work_dir}/${archive}" -C /opt
    rm -rf "${work_dir}"
    trap - RETURN
  fi

  ln -sfn "${NODE_INSTALL_DIR}/bin/node" /usr/local/bin/node
  ln -sfn "${NODE_INSTALL_DIR}/bin/npm" /usr/local/bin/npm
  ln -sfn "${NODE_INSTALL_DIR}/bin/npx" /usr/local/bin/npx
  ln -sfn "${NODE_INSTALL_DIR}/bin/corepack" /usr/local/bin/corepack

  log "Installing PM2 ${PM2_VERSION} for Node.js v${NODE_VERSION}"
  "${NODE_INSTALL_DIR}/bin/npm" install --global --prefix /usr/local "pm2@${PM2_VERSION}"
}

configure_swap() {
  local swap_file="/swapfile"

  if [[ ! -f "${swap_file}" ]]; then
    log "Creating ${SWAP_SIZE_GIB} GiB swap file"
    fallocate -l "${SWAP_SIZE_GIB}G" "${swap_file}"
    chmod 600 "${swap_file}"
    mkswap "${swap_file}"
  fi

  if ! swapon --show=NAME --noheadings | grep -Fxq "${swap_file}"; then
    swapon "${swap_file}"
  fi

  if ! grep -Eq '^/swapfile[[:space:]]' /etc/fstab; then
    printf '/swapfile swap swap defaults 0 0\n' >> /etc/fstab
  fi
}

configure_postgresql() {
  local hba_file="${PG_DATA_DIR}/pg_hba.conf"
  local hba_marker="# WOA local TCP password authentication"
  local hba_tmp

  if [[ ! -s "${PG_DATA_DIR}/PG_VERSION" ]]; then
    log "Initializing the PostgreSQL cluster"
    postgresql-setup --initdb
  fi

  if ! grep -Fq "${hba_marker}" "${hba_file}"; then
    log "Enabling SCRAM password authentication on PostgreSQL loopback connections"
    hba_tmp="$(mktemp)"
    {
      printf '%s\n' "${hba_marker}"
      printf 'host all all 127.0.0.1/32 scram-sha-256\n'
      printf 'host all all ::1/128 scram-sha-256\n'
      cat "${hba_file}"
    } > "${hba_tmp}"
    install -o postgres -g postgres -m 600 "${hba_tmp}" "${hba_file}"
    rm -f "${hba_tmp}"
  fi

  systemctl enable postgresql
  systemctl restart postgresql
}

configure_services() {
  log "Enabling Valkey and Nginx"
  systemctl enable --now valkey
  systemctl enable --now nginx
}

print_summary() {
  log "Bootstrap completed"
  printf '\n'
  printf 'Architecture: %s\n' "$(uname -m)"
  printf 'Node.js:     %s\n' "$(node --version)"
  printf 'npm:         %s\n' "$(npm --version)"
  printf 'PM2:         %s\n' "$(node -p "require('/usr/local/lib/node_modules/pm2/package.json').version")"
  printf 'PostgreSQL:  %s\n' "$(psql --version)"
  printf 'Valkey:      %s\n' "$(valkey-server --version)"
  printf 'Nginx:       %s\n' "$(nginx -v 2>&1)"
  printf '\nNo application database, role, schema, or migration was created.\n'
}

main() {
  require_root
  verify_platform
  expand_root_filesystem
  install_packages
  install_node
  configure_swap
  configure_postgresql
  configure_services
  print_summary
}

main "$@"
