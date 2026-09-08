#!/usr/bin/env bash
# Run as root on a disposable golden-image builder immediately before snapshotting.
set -euo pipefail

if [ "$EUID" -ne 0 ] || [ ! -f /opt/boxhaven/remote/ready ]; then
  echo "image cleanup requires root on a prepared BoxHaven image builder" >&2
  exit 1
fi

if [ -d /etc/cloud/cloud.cfg.d ]; then
  cat > /etc/cloud/cloud.cfg.d/99-boxhaven-golden-image.cfg <<'EOF_CLOUD'
ssh_deletekeys: true
EOF_CLOUD
fi

rm -f /root/.bash_history /home/boxhaven/.bash_history
rm -f /root/.ssh/authorized_keys /home/boxhaven/.ssh/authorized_keys
rm -f /etc/ssh/ssh_host_*
find /tmp /var/tmp -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true

if command -v cloud-init >/dev/null 2>&1; then
  cloud-init clean --logs --machine-id
else
  truncate -s 0 /etc/machine-id
fi

# cloud-init clears /etc/machine-id, but Ubuntu can retain a separate D-Bus
# copy. systemd restores that stale ID on boot unless both identities are reset.
install -d /var/lib/dbus
rm -f /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id

sync
