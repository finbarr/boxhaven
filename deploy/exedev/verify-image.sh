#!/usr/bin/env bash
set -euo pipefail
image="${1:?Usage: deploy/exedev/verify-image.sh IMAGE}"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
expected_codex="$(sed -nE 's/.*@openai\/codex@([0-9.]+).*/\1/p' "$repo_root/cmd/bh/assets/remote-vm-install.sh")"
test -n "$expected_codex"

# Check the actual artifact without starting provider services or using network
# access. Live boot, callback, and proxy checks still belong to smoke.sh.
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" == linux/amd64 ]]
[[ "$(docker image inspect --format '{{index .Config.Labels "exe.dev/login-user"}}' "$image")" == exedev ]]
[[ "$(docker image inspect --format '{{index .Config.Labels "exe.dev/install-shelley"}}' "$image")" == false ]]
docker run --rm --platform linux/amd64 --network none --env "BOXHAVEN_VERIFY_CODEX_VERSION=$expected_codex" --entrypoint /bin/bash -i "$image" -seu <<'VERIFY'
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
test -s /opt/boxhaven/remote/ready
test -s /usr/local/lib/boxhaven/agent.mjs
test -s /usr/local/lib/boxhaven/ssh-bridge.mjs
test -x /usr/local/bin/init
node --check /usr/local/lib/boxhaven/agent.mjs
node --check /usr/local/lib/boxhaven/ssh-bridge.mjs
for service in boxhaven-agent boxhaven-ssh-bridge boxhaven-sshd; do
  systemctl is-enabled "$service" >/dev/null
done
for tool in tmux rsync git node ssh ssh-keygen; do command -v "$tool" >/dev/null; done
for agent in codex claude; do
  sudo -u boxhaven -i env BOXHAVEN_NO_FULL_AUTO=1 "$agent" --version
done
test "$(sudo -u boxhaven -i env BOXHAVEN_NO_FULL_AUTO=1 codex --version)" = "codex-cli $BOXHAVEN_VERIFY_CODEX_VERSION"
sudo -u boxhaven test -w /opt/boxhaven/project

# The image must not clone machine identities or access credentials into VMs.
test ! -s /etc/machine-id
test ! -s /etc/boxhaven/agent.env
test "$(stat -c '%a' /etc/boxhaven/agent.env)" = 600
test -z "$(find /etc/ssh /etc/boxhaven -maxdepth 1 -name 'ssh_host_*' -print)"
for user in /root /home/boxhaven /home/exedev; do
  test ! -s "$user/.ssh/authorized_keys"
done

# Generate throwaway trust inside this disposable container to validate sshd's
# effective configuration, including the separate certificate-only listener.
install -d -m 0755 /run/sshd /etc/ssh/auth_principals
ssh-keygen -q -t ed25519 -N '' -f /etc/boxhaven/ssh_host_ed25519_key
ssh-keygen -q -t ed25519 -N '' -f /tmp/test-ca
cp /tmp/test-ca.pub /etc/ssh/boxhaven_user_ca_keys
sshd -t -f /etc/boxhaven/sshd_config
config="$(sshd -T -f /etc/boxhaven/sshd_config)"
for expected in 'port 2222' 'listenaddress 127.0.0.1:2222' 'passwordauthentication no' \
  'kbdinteractiveauthentication no' 'authorizedkeysfile none' 'allowusers boxhaven' \
  'trustedusercakeys /etc/ssh/boxhaven_user_ca_keys'; do
  grep -Fxq "$expected" <<< "$config"
done
echo 'PASS: runtime, tools, clean identity, and certificate-only SSH image contract'
VERIFY
