#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -m 0755 "${script_dir}/backup-backend.sh" /usr/local/bin/boxhaven-backend-backup
install -m 0755 "${script_dir}/../../scripts/verify-backend-backup-restore.sh" /usr/local/bin/boxhaven-verify-backend-backup
install -m 0644 "${script_dir}/boxhaven-backend-backup.service" /etc/systemd/system/boxhaven-backend-backup.service
install -m 0644 "${script_dir}/boxhaven-backend-backup.timer" /etc/systemd/system/boxhaven-backend-backup.timer

systemctl daemon-reload
systemctl enable --now boxhaven-backend-backup.timer
systemctl start boxhaven-backend-backup.service
