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

function sshCertificateTrustCommand(userCA: string | undefined, principal: string | undefined, sshUser: string | undefined): string {
  if (!userCA || !principal) return "true";
  const user = safeLinuxUser(sshUser || defaultSSHUser);
  return [
    "install -d -m 0755 /run/sshd /etc/ssh/auth_principals /etc/ssh/sshd_config.d",
    `printf '%s\\n' ${shellSingleQuote(userCA)} > /etc/ssh/boxhaven_user_ca_keys`,
    "chmod 0644 /etc/ssh/boxhaven_user_ca_keys",
    `printf '%s\\n' ${shellSingleQuote(principal)} > /etc/ssh/auth_principals/${shellSingleQuote(user)}`,
    `chmod 0644 /etc/ssh/auth_principals/${shellSingleQuote(user)}`,
    "printf '%s\\n' 'TrustedUserCAKeys /etc/ssh/boxhaven_user_ca_keys' 'AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' > /etc/ssh/sshd_config.d/90-boxhaven-user-ca.conf",
    "sshd -t",
    "(systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || systemctl restart ssh >/dev/null 2>&1 || systemctl restart sshd >/dev/null 2>&1 || pkill -HUP sshd >/dev/null 2>&1 || true)",
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
