import { CreateMachineRequest, defaultSSHUser } from "./types.js";

// Shared #cloud-config user data for first boot on any provider: write the
// machine agent credentials, ensure the SSH user, and trust the backend SSH CA.
export function agentCloudInitUserData(request: CreateMachineRequest): string {
  const token = request.agent_token?.trim();
  const backendURL = request.agent_backend_url?.trim().replace(/\/+$/, "");
  const userCA = request.ssh_user_ca_public_key?.trim();
  const principal = request.ssh_authorized_principal?.trim();
  if (!token || !backendURL) return "";
  return `#cloud-config
disable_root: false
ssh_pwauth: false
write_files:
  - path: /etc/boxhaven/agent.env
    owner: root:root
    permissions: '0600'
    content: |
      ${shellEnvAssignment("BOXHAVEN_AGENT_TOKEN", token)}
      ${shellEnvAssignment("BOXHAVEN_AGENT_BACKEND_URL", backendURL)}
runcmd:
  - [sh, -lc, ${cloudInitSingleQuote(ensureSudoUserCommand(request.ssh_user))}]
  - [sh, -lc, ${cloudInitSingleQuote(sshCertificateTrustCommand(userCA, principal, request.ssh_user))}]
  - [sh, -lc, 'systemctl enable --now boxhaven-agent || true']
`;
}

/** First boot on prebuilt OCI guests, where cloud-init is unavailable. */
export function agentSetupScript(request: CreateMachineRequest): string {
  if (!request.agent_token || !request.agent_backend_url || !request.ssh_user_ca_public_key || !request.ssh_authorized_principal) {
    throw new Error("Machine agent credentials and SSH trust are required");
  }
  const script = [
    "#!/bin/sh", "set -eu", "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "sudo /bin/sh <<'BOXHAVEN_SETUP'", "set -eu", "umask 077",
    "test -f /opt/boxhaven/remote/ready", "test -f /usr/local/lib/boxhaven/ssh-bridge.mjs",
    "install -d -m 0755 /etc/boxhaven",
    `printf '%s\\n' ${shellSingleQuote([
      shellEnvAssignment("BOXHAVEN_AGENT_TOKEN", request.agent_token),
      shellEnvAssignment("BOXHAVEN_AGENT_BACKEND_URL", request.agent_backend_url.replace(/\/+$/, "")),
      "BOXHAVEN_SSH_PORT=2222",
      "BOXHAVEN_SSH_BRIDGE_PORT=9898",
    ].join("\n"))} > /etc/boxhaven/agent.env`,
    "chmod 0600 /etc/boxhaven/agent.env", ensureSudoUserCommand(request.ssh_user),
    "ssh-keygen -A",
    "test -f /etc/boxhaven/ssh_host_ed25519_key || ssh-keygen -q -t ed25519 -N '' -f /etc/boxhaven/ssh_host_ed25519_key",
    sshCertificateTrustCommand(request.ssh_user_ca_public_key, request.ssh_authorized_principal, request.ssh_user),
    "systemctl daemon-reload", "systemctl enable boxhaven-agent boxhaven-ssh-bridge boxhaven-sshd",
    "sshd -t -f /etc/boxhaven/sshd_config",
    "systemctl restart boxhaven-sshd boxhaven-ssh-bridge",
    "systemctl restart boxhaven-agent", "BOXHAVEN_SETUP", "",
  ].join("\n");
  if (Buffer.byteLength(script) > 10 * 1024) throw new Error("Machine setup script exceeds exe.dev's 10 KiB limit");
  return script;
}

/** Configure the prepared runtime without assuming systemd is PID 1. No package installs. */
export function sandboxSetupScript(request: CreateMachineRequest): string {
  if (!request.agent_token || !request.agent_backend_url || !request.ssh_user_ca_public_key || !request.ssh_authorized_principal) {
    throw new Error("Machine agent credentials and SSH trust are required");
  }
  const supervisor = [
    "#!/bin/bash", "set -eu", "exec 9>/run/boxhaven-runtime.lock", "flock -n 9 || exit 0",
    "set -a; . /etc/boxhaven/agent.env; set +a",
    "trap 'kill $(jobs -pr) 2>/dev/null || true; wait' EXIT",
    "(while :; do install -d -m 0755 /run/sshd; /usr/sbin/sshd -D -e -f /etc/boxhaven/sshd_config || true; sleep 1; done) &",
    "(while :; do node /usr/local/lib/boxhaven/ssh-bridge.mjs || true; sleep 1; done) &",
    "(while :; do node /usr/local/lib/boxhaven/agent.mjs || true; sleep 1; done) &", "wait", "",
  ].join("\n");
  return [
    "#!/bin/bash", "set -eu", "umask 077", "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "test -f /opt/boxhaven/remote/ready", "test -f /usr/local/lib/boxhaven/ssh-bridge.mjs", "test -f /usr/local/lib/boxhaven/agent.mjs",
    "command -v node; command -v tmux; command -v rsync; command -v flock; command -v sshd",
    "install -d -m 0755 /etc/boxhaven /run/sshd",
    `printf '%s\\n' ${shellSingleQuote([
      shellEnvAssignment("BOXHAVEN_AGENT_TOKEN", request.agent_token),
      shellEnvAssignment("BOXHAVEN_AGENT_BACKEND_URL", request.agent_backend_url.replace(/\/+$/, "")),
      "BOXHAVEN_SSH_PORT=2222", "BOXHAVEN_SSH_BRIDGE_PORT=9898",
    ].join("\n"))} > /etc/boxhaven/agent.env`,
    "chmod 0600 /etc/boxhaven/agent.env", ensureSudoUserCommand(request.ssh_user), "ssh-keygen -A",
    "test -f /etc/boxhaven/ssh_host_ed25519_key || ssh-keygen -q -t ed25519 -N '' -f /etc/boxhaven/ssh_host_ed25519_key",
    sshCertificateTrustCommand(request.ssh_user_ca_public_key, request.ssh_authorized_principal, request.ssh_user, false),
    `printf '%s\\n' ${shellSingleQuote([
      "Port 2222", "ListenAddress 127.0.0.1", "HostKey /etc/boxhaven/ssh_host_ed25519_key", "PidFile /run/boxhaven-sshd.pid",
      "TrustedUserCAKeys /etc/ssh/boxhaven_user_ca_keys", "AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u",
      "AuthorizedKeysFile none", "AuthenticationMethods publickey", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
      "PermitRootLogin no", "UsePAM yes", "AllowUsers boxhaven", "Subsystem sftp internal-sftp",
    ].join("\n"))} > /etc/boxhaven/sshd_config`,
    "install -d -m 0755 /run/sshd", "sshd -t -f /etc/boxhaven/sshd_config",
    `printf '%s\\n' ${shellSingleQuote(supervisor)} > /etc/boxhaven/run-sandbox.sh`,
    "chmod 0700 /etc/boxhaven/run-sandbox.sh", "",
  ].join("\n");
}

function shellEnvAssignment(name: string, value: string): string {
  return `${name}='${value.replace(/'/g, "'\"'\"'")}'`;
}

function ensureSudoUserCommand(sshUser: string | undefined): string {
  const user = safeLinuxUser(sshUser || defaultSSHUser);
  if (user === "root") return "true";
  return [
    `if ! id -u ${shellSingleQuote(user)} >/dev/null 2>&1; then useradd -m -s /bin/bash ${shellSingleQuote(user)}; fi`,
    `usermod -aG sudo ${shellSingleQuote(user)} || true`,
    `if getent group docker >/dev/null 2>&1; then usermod -aG docker ${shellSingleQuote(user)} || true; fi`,
    `printf '%s\\n' ${shellSingleQuote(`${user} ALL=(ALL) NOPASSWD:ALL`)} > /etc/sudoers.d/${shellSingleQuote(user)}`,
    `chmod 0440 /etc/sudoers.d/${shellSingleQuote(user)}`,
    `install -d -o ${shellSingleQuote(user)} -g ${shellSingleQuote(user)} -m 0755 /home/${shellSingleQuote(user)}`,
    `install -d -o ${shellSingleQuote(user)} -g ${shellSingleQuote(user)} -m 0755 /opt/boxhaven/project`,
  ].join(" && ");
}

function sshCertificateTrustCommand(userCA: string | undefined, principal: string | undefined, sshUser: string | undefined, reload = true): string {
  if (!userCA || !principal) return "true";
  const user = safeLinuxUser(sshUser || defaultSSHUser);
  return [
    "install -d -m 0755 /run/sshd /etc/ssh/auth_principals /etc/ssh/sshd_config.d",
    `printf '%s\\n' ${shellSingleQuote(userCA)} > /etc/ssh/boxhaven_user_ca_keys`,
    "chmod 0644 /etc/ssh/boxhaven_user_ca_keys",
    `printf '%s\\n' ${shellSingleQuote(principal)} > /etc/ssh/auth_principals/${shellSingleQuote(user)}`,
    `chmod 0644 /etc/ssh/auth_principals/${shellSingleQuote(user)}`,
    "printf '%s\\n' 'TrustedUserCAKeys /etc/ssh/boxhaven_user_ca_keys' 'AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' > /etc/ssh/sshd_config.d/90-boxhaven-user-ca.conf",
    ...(reload ? ["sshd -t", "(systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || systemctl restart ssh >/dev/null 2>&1 || systemctl restart sshd >/dev/null 2>&1 || pkill -HUP sshd >/dev/null 2>&1 || true)"] : []),
  ].join(" && ");
}

function safeLinuxUser(value: string): string {
  return /^[a-z_][a-z0-9_-]*[$]?$/i.test(value) ? value : defaultSSHUser;
}

function cloudInitSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function machineResourceName(name: string): string {
  return `boxhaven-${sanitizeResourceName(name)}`;
}

export function sanitizeResourceName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
}

export function imageNameIsBoxHavenRemote(image: string | undefined): boolean {
  return Boolean(image?.trim().toLowerCase().startsWith("boxhaven-remote-"));
}
