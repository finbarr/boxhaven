#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

ready_marker="${BOXHAVEN_REMOTE_READY_MARKER:-/opt/boxhaven/remote/ready}"

if [ -f "$ready_marker" ]; then
  exit 0
fi

if command -v cloud-init >/dev/null 2>&1; then
  echo "remote setup: waiting for cloud-init"
  cloud-init status --wait >/dev/null 2>&1 || true
fi

install_log="${BOXHAVEN_REMOTE_INSTALL_LOG:-/var/log/boxhaven-remote-install.log}"
mkdir -p "$(dirname "$install_log")"
: > "$install_log"
exec 3>&1
trap 'status=$?; if [ "$status" -ne 0 ]; then echo "BoxHaven VM installer failed; recent log follows (${install_log})" >&3; tail -n 80 "$install_log" >&3 || true; fi; exit "$status"' EXIT
exec >>"$install_log" 2>&1

step() {
  echo "remote setup: $*" >&3
}

apt_install() {
  step "installing base packages"
  apt-get update
  apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    wget \
    git \
    sudo \
    build-essential \
    make \
    cmake \
    pkg-config \
    python3 \
    python3-pip \
    python3-venv \
    jq \
    rsync \
    ripgrep \
    fd-find \
    bat \
    eza \
    fzf \
    tree \
    htop \
    vim \
    nano \
    less \
    openssh-client \
    gnupg \
    unzip \
    zip \
    tzdata \
    libssl-dev \
    ncurses-bin \
    tmux
  ln -sf /usr/bin/batcat /usr/local/bin/bat 2>/dev/null || true
  ln -sf /usr/bin/fdfind /usr/local/bin/fd 2>/dev/null || true
}

install_node() {
  step "checking Node.js"
  local major
  major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
  if [ "${major:-0}" -ge 22 ] 2>/dev/null; then
    return 0
  fi
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
}

install_gh() {
  step "checking GitHub CLI"
  if command -v gh >/dev/null 2>&1; then
    return 0
  fi
  install -m 0755 -d /usr/share/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update
  apt-get install -y gh
}

install_docker() {
  step "checking Docker Engine"
  if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable docker >/dev/null 2>&1 || true
  systemctl start docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
  docker network create boxhaven-net >/dev/null 2>&1 || true
}

install_go() {
  step "checking Go"
  if command -v go >/dev/null 2>&1; then
    return 0
  fi
  local go_version arch tarball tmp
  go_version="${BOXHAVEN_REMOTE_GO_VERSION:-1.25.6}"
  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) return 0 ;;
  esac
  tarball="go${go_version}.linux-${arch}.tar.gz"
  tmp="$(mktemp -d)"
  curl -fsSL "https://go.dev/dl/${tarball}" -o "${tmp}/${tarball}"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "${tmp}/${tarball}"
  rm -rf "$tmp"
  ln -sf /usr/local/go/bin/go /usr/local/bin/go
  ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
}

install_bun() {
  step "checking Bun"
  if command -v bun >/dev/null 2>&1; then
    return 0
  fi
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash
  ln -sf /opt/bun/bin/bun /usr/local/bin/bun
  ln -sf /opt/bun/bin/bun /usr/local/bin/bunx
}

install_uv() {
  step "checking uv"
  if command -v uv >/dev/null 2>&1 && command -v uvx >/dev/null 2>&1; then
    return 0
  fi
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
}

install_ai_clis() {
  step "installing AI CLIs"
  NPM_CONFIG_PREFIX="" npm install -g --no-audit --no-fund \
    @google/gemini-cli \
    @openai/codex \
    opencode-ai \
    @github/copilot \
    @earendil-works/pi-coding-agent
  NPM_CONFIG_PREFIX="" npm cache clean --force >/dev/null 2>&1 || true
}

install_claude() {
  step "checking Claude Code"
  if ! command -v claude >/dev/null 2>&1; then
    curl -fsSL https://claude.ai/install.sh | bash
  fi
  if [ -x /root/.local/bin/claude ]; then
    ln -sf /root/.local/bin/claude /usr/local/bin/claude
  fi
}

install_rtk() {
  step "checking RTK"
  if command -v rtk >/dev/null 2>&1; then
    return 0
  fi
  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/develop/install.sh | RTK_INSTALL_DIR=/usr/local/bin sh
}

install_boxhaven_user() {
  step "configuring boxhaven user"
  if ! id -u boxhaven >/dev/null 2>&1; then
    useradd -m -s /bin/bash boxhaven
  fi
  echo "boxhaven ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/boxhaven
  chmod 0440 /etc/sudoers.d/boxhaven
}

install_wrappers() {
  step "writing boxhaven command wrappers"
  mkdir -p /opt/boxhaven/bin
  cat > /opt/boxhaven/wrapper-template <<'EOF'
#!/bin/bash
WRAPPER_DIR=/opt/boxhaven/bin
CMD=$(basename "$0")
CLEAN_PATH=$(printf "%s" "$PATH" | tr ":" "\n" | grep -v "^$WRAPPER_DIR$" | tr "\n" ":" | sed 's/:$//')
REAL_BIN=$(PATH="$CLEAN_PATH" command -v "$CMD" 2>/dev/null || true)
if [ -z "$REAL_BIN" ]; then
  echo "Error: $CMD not found" >&2
  exit 1
fi
if [ "${BOXHAVEN_NO_FULL_AUTO:-}" = "1" ]; then
  exec "$REAL_BIN" "$@"
fi
EOF

  cp /opt/boxhaven/wrapper-template /opt/boxhaven/bin/claude
  echo 'exec "$REAL_BIN" --dangerously-skip-permissions "$@"' >> /opt/boxhaven/bin/claude

  cp /opt/boxhaven/wrapper-template /opt/boxhaven/bin/codex
  echo 'exec "$REAL_BIN" --ask-for-approval never --sandbox danger-full-access "$@"' >> /opt/boxhaven/bin/codex

  cp /opt/boxhaven/wrapper-template /opt/boxhaven/bin/gemini
  echo 'exec "$REAL_BIN" "$@"' >> /opt/boxhaven/bin/gemini

  cp /opt/boxhaven/wrapper-template /opt/boxhaven/bin/opencode
  echo 'exec "$REAL_BIN" "$@"' >> /opt/boxhaven/bin/opencode

  cp /opt/boxhaven/wrapper-template /opt/boxhaven/bin/copilot
  echo 'exec "$REAL_BIN" "$@"' >> /opt/boxhaven/bin/copilot

  cp /opt/boxhaven/wrapper-template /opt/boxhaven/bin/pi
  echo 'exec "$REAL_BIN" "$@"' >> /opt/boxhaven/bin/pi

  cat > /opt/boxhaven/bin/open <<'EOF'
#!/bin/bash
if [ "$#" -ne 1 ]; then
  echo "usage: open <url>" >&2
  exit 2
fi
echo "Open this URL in your browser: $1" >&2
EOF
  ln -sf open /opt/boxhaven/bin/xdg-open

  chmod +x /opt/boxhaven/bin/*
}

install_git_credential_helper() {
  step "writing Git credential helper"
  cat > /opt/boxhaven/bin/git-credential-github-token <<'EOF'
#!/bin/sh
case "${1:-}" in
  get) ;;
  *) exit 0 ;;
esac
protocol=""
host=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    protocol=*) protocol=${line#protocol=} ;;
    host=*) host=${line#host=} ;;
  esac
done
[ "$protocol" = "https" ] || exit 0
[ "$host" = "github.com" ] || exit 0
token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
[ -n "$token" ] || exit 0
printf "username=x-access-token\n"
printf "password=%s\n" "$token"
EOF
  chmod +x /opt/boxhaven/bin/git-credential-github-token
  git config --system --add credential.https://github.com.helper "" || true
  git config --system --add credential.https://github.com.helper "!/opt/boxhaven/bin/git-credential-github-token" || true
  git config --system --get-all safe.directory | grep -Fx /opt/boxhaven/project >/dev/null 2>&1 || \
    git config --system --add safe.directory /opt/boxhaven/project || true
  git config --system --get-all safe.directory | grep -Fx /workspace >/dev/null 2>&1 || \
    git config --system --add safe.directory /workspace || true
}

install_remote_session() {
  step "writing remote session launcher"
  cat > /usr/local/bin/boxhaven-remote-session <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

workdir="${1:-${BOXHAVEN_PROJECT_PATH:-$(pwd)}}"
home_dir="${HOME:-/root}"

export HOME="$home_dir"
export BOXHAVEN=1
export BOXHAVEN_REMOTE=1
export BOXHAVEN_PROJECT_PATH="$workdir"
export BOXHAVEN_CONTEXT_FILE="${BOXHAVEN_CONTEXT_FILE:-/run/boxhaven/context.json}"
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-${home_dir}/.npm-global}"

mkdir -p "$workdir" "$home_dir/.npm-global" /run/boxhaven
ln -sfn "$workdir" /workspace
git config --global --get-all safe.directory | grep -Fx "$workdir" >/dev/null 2>&1 || \
  git config --global --add safe.directory "$workdir" >/dev/null 2>&1 || true
docker network create boxhaven-net >/dev/null 2>&1 || true

if command -v jq >/dev/null 2>&1; then
  gh_token_forwarded=false
  if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    gh_token_forwarded=true
  fi
  jq -n \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg workdir "$workdir" \
    --arg home "$home_dir" \
    --argjson gh_token_forwarded "$gh_token_forwarded" \
    '{
      schema_version: 1,
      inside_boxhaven: true,
      remote: true,
      boxhaven_version: "remote-vm",
      generated_at: $generated_at,
      runtime: {
        configured: "remote-vm",
        selected: "remote-vm",
        apple_container: false,
        rootless_podman: false
      },
      launch: {
        interactive: true,
        command: [],
        working_dir: $workdir,
        context_file: "/run/boxhaven/context.json",
        auto_passthrough_env_keys: (if $gh_token_forwarded then ["GH_TOKEN", "GITHUB_TOKEN"] else [] end),
        gh_token_forwarded: $gh_token_forwarded
      },
      paths: {
        project: $workdir,
        home: $home
      },
      config: {
        runtime: "remote-vm",
        image: "boxhaven-vm",
        container_name: "",
        default_harness: "none",
        mounts: [],
        env_keys: [],
        exclude: [],
        copy_as: [],
        ssh_agent: false,
        readonly_project: false,
        no_project: false,
        no_network: false,
        no_env_passthrough: false,
        network: "host",
        pod: "",
        no_full_auto: false,
        scratch: false,
        claude_config: false,
        codex_config: false,
        gemini_config: false,
        opencode_config: false,
        pi_config: false,
        git_config: false,
        gh_token: $gh_token_forwarded,
        rtk: false,
        copy_agent_instructions: false,
        docker: true,
        clipboard: false,
        open_bridge: false,
        cpus: "",
        memory: "",
        shm_size: "",
        gpus: "",
        devices: [],
        cap_add: [],
        cap_drop: [],
        runtime_args: [],
        customize: {
          packages: [],
          dockerfile: ""
        }
      }
    }' > "$BOXHAVEN_CONTEXT_FILE"
fi

if [ -f "$home_dir/.claude.json" ] || command -v jq >/dev/null 2>&1; then
  claude_json="$home_dir/.claude.json"
  if [ ! -f "$claude_json" ]; then
    echo '{"projects":{}}' > "$claude_json"
  fi
  tmp="$(mktemp)"
  jq --arg path "$workdir" '.projects[$path] = (.projects[$path] // {}) + {"hasTrustDialogAccepted": true}' "$claude_json" > "$tmp" && mv "$tmp" "$claude_json" || rm -f "$tmp"
fi
EOF
  chmod +x /usr/local/bin/boxhaven-remote-session
}

install_boxhaven_agent() {
  step "writing boxhaven machine agent"
  install -d -m 0755 /etc/boxhaven
  if [ ! -f /etc/boxhaven/agent.env ]; then
    install -m 0600 /dev/null /etc/boxhaven/agent.env
  fi
  install -d -m 0755 /usr/local/lib/boxhaven
  cat > /usr/local/lib/boxhaven/agent.mjs <<'EOF'
#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const backendURL = (process.env.BOXHAVEN_AGENT_BACKEND_URL || "").replace(/\/+$/, "");
const token = process.env.BOXHAVEN_AGENT_TOKEN || "";
const heartbeatInterval = Number(process.env.BOXHAVEN_AGENT_HEARTBEAT_INTERVAL || 30_000);
const heartbeatTimeout = Math.max(heartbeatInterval * 2, 10_000);
const defaultProjectPath = "/opt/boxhaven/project";
const remoteSessionName = "boxhaven";
const remoteSessionScript = "/usr/local/bin/boxhaven-remote-session";
const boxhavenContextFile = "/run/boxhaven/context.json";
const sessionEnvFile = "/run/boxhaven/session.env";

if (!backendURL || !token) {
  console.error("boxhaven agent token/backend URL is not configured");
  process.exit(0);
}

let socket;
let lastPongAt = 0;

connect();

function connectionURL() {
  const url = new URL(backendURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/agent/connect";
  url.search = "";
  return url;
}

function connect(delay = 1000) {
  const ws = new WebSocket(connectionURL(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  socket = ws;

  let heartbeat;
  let reconnecting = false;
  function reconnect() {
    if (reconnecting) return;
    reconnecting = true;
    if (heartbeat) clearInterval(heartbeat);
    if (socket === ws) socket = undefined;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {}
    setTimeout(() => connect(Math.min(delay * 2, 15000)), delay);
  }

  ws.addEventListener("open", () => {
    lastPongAt = Date.now();
    heartbeat = setInterval(() => {
      if (Date.now() - lastPongAt > heartbeatTimeout) {
        reconnect();
        return;
      }
      send({ type: "ping" }, ws);
    }, heartbeatInterval);
    send({ type: "ping" }, ws);
  });

  ws.addEventListener("message", (event) => {
    handleMessage(event.data).catch((error) => {
      console.error(`boxhaven agent message failed: ${error.message}`);
    });
  });

  ws.addEventListener("close", reconnect);

  ws.addEventListener("error", reconnect);
}

async function handleMessage(data) {
  const message = JSON.parse(typeof data === "string" ? data : Buffer.from(await data.arrayBuffer()).toString("utf8"));
  switch (message.type) {
  case "pong":
    lastPongAt = Date.now();
    return;
  case "rpc":
    handleRPC(message).catch((error) => {
      send({
        type: "rpc_result",
        rpc_id: message.rpc_id || "",
        ok: false,
        code: error.code || "agent_rpc_failed",
        message: error.message || String(error),
      });
    });
    return;
  }
}

async function handleRPC(message) {
  const id = message.rpc_id || "";
  if (!id) return;
  try {
    const payload = message.payload || {};
    let result;
    switch (message.action) {
    case "run_setup":
      result = await runSetup(payload);
      break;
    case "prepare_session":
      result = await prepareSession(payload);
      break;
    case "direct_command":
      result = directCommand(payload);
      break;
    default: {
      const error = new Error(`unknown agent action: ${message.action || ""}`);
      error.code = "unknown_action";
      throw error;
    }
    }
    send({ type: "rpc_result", rpc_id: id, ok: true, result });
  } catch (error) {
    send({
      type: "rpc_result",
      rpc_id: id,
      ok: false,
      code: error.code || "agent_rpc_failed",
      message: error.message || String(error),
    });
  }
}

async function runSetup(payload) {
  const commands = normalizeStringArray(payload.commands);
  if (commands.length === 0) return { skipped: true };
  const workPath = remoteWorkPath(payload);
  const script = `set -euo pipefail
${remoteCommandPrefix(payload)}
${commands.join("\n")}
`;
  const result = await runProcess("bash", ["-lc", script], { maxBuffer: 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function prepareSession(payload) {
  const attach = payload.attach === true;
  const exists = await tmuxSessionExists();
  if (exists) {
    if (!attach) {
      const error = new Error(`remote session ${remoteSessionName} is already running; run bh connect ${payload.name || ""} from a terminal to attach`);
      error.code = "session_exists";
      throw error;
    }
    return {
      status: "exists",
      attach_command: tmuxAttachCommand(),
      record_command: false,
    };
  }

  const command = normalizeRemoteCommand(payload.command);
  const workPath = remoteWorkPath(payload);
  const sessionCommand = `${remoteCommandPrefix(payload)}exec ${shellJoin(command)}`;
  await runProcess("tmux", ["new-session", "-d", "-s", remoteSessionName, "-c", workPath, sessionCommand]);
  return {
    status: attach ? "started" : "started_detached",
    attach_command: attach ? tmuxAttachCommand() : "",
    record_command: true,
  };
}

function directCommand(payload) {
  return { command: `${remoteCommandPrefix(payload)}exec ${shellJoin(normalizeRemoteCommand(payload.command))}` };
}

async function tmuxSessionExists() {
  const result = await runProcess("tmux", ["has-session", "-t", remoteSessionName], { reject: false });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  const error = new Error(result.stderr || `tmux has-session failed with exit ${result.code}`);
  error.code = "session_check_failed";
  throw error;
}

function tmuxAttachCommand() {
  return `tmux attach-session -t ${shellQuote(remoteSessionName)}`;
}

function remoteCommandPrefix(payload) {
  const workPath = remoteWorkPath(payload);
  const parts = [
    "export PATH=\"/opt/boxhaven/bin:/root/.npm-global/bin:/home/boxhaven/.npm-global/bin:/root/.local/bin:/home/boxhaven/.local/bin:/usr/local/go/bin:$PATH\"",
    "export NPM_CONFIG_PREFIX=\"${NPM_CONFIG_PREFIX:-$HOME/.npm-global}\"",
    "export BOXHAVEN=1",
    "export BOXHAVEN_REMOTE=1",
    `export BOXHAVEN_PROJECT_PATH=${shellQuote(workPath)}`,
    `export BOXHAVEN_CONTEXT_FILE=${shellQuote(boxhavenContextFile)}`,
  ];
  parts.push(`if [ -r ${shellQuote(sessionEnvFile)} ]; then . ${shellQuote(sessionEnvFile)}; fi`);
  if (String(payload.preview_url || "").trim()) {
    parts.push(`export BOXHAVEN_PREVIEW_URL=${shellQuote(String(payload.preview_url).trim())}`);
  }
  if (String(payload.preview_hostname || "").trim()) {
    parts.push(`export BOXHAVEN_PREVIEW_HOSTNAME=${shellQuote(String(payload.preview_hostname).trim())}`);
  }
  parts.push(`if [ -x ${shellQuote(remoteSessionScript)} ]; then ${shellQuote(remoteSessionScript)} ${shellQuote(workPath)}; fi`);
  parts.push(`cd ${shellQuote(workPath)}`);
  return `${parts.join("; ")}; `;
}

function remoteWorkPath(payload) {
  return cleanAbsolutePath(payload.project_path) || defaultProjectPath;
}

function cleanAbsolutePath(value) {
  value = String(value || "").trim();
  if (!value || !value.startsWith("/") || value === "/") return "";
  const cleaned = path.posix.normalize(value);
  if (!cleaned || cleaned === "/" || !cleaned.startsWith("/")) return "";
  return cleaned;
}

function normalizeRemoteCommand(value) {
  const command = normalizeStringArray(value);
  if (command.length === 0) return ["bash"];
  switch (path.posix.basename(command[0])) {
  case "shell":
    return ["bash"];
  case "run":
    return command.length === 1 ? ["bash"] : command.slice(1);
  default:
    return command;
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function shellJoin(args) {
  return args.map((arg) => shellQuote(String(arg))).join(" ");
}

function shellQuote(value) {
  value = String(value || "");
  if (value === "") return "''";
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      cwd: options.cwd || "/",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = { stdout: [], stderr: [] };
    const maxBuffer = options.maxBuffer || 256 * 1024;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) chunks.stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) chunks.stderr.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code: code ?? 0,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      };
      if (result.code !== 0 && options.reject !== false) {
        const error = new Error(result.stderr || `${command} exited with status ${result.code}`);
        error.code = "process_failed";
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function send(message, target = socket) {
  if (target?.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify(message));
  }
}
EOF
  chmod +x /usr/local/lib/boxhaven/agent.mjs

  cat > /etc/systemd/system/boxhaven-agent.service <<'EOF'
[Unit]
Description=BoxHaven machine agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-/etc/boxhaven/agent.env
ExecStart=/usr/bin/env node /usr/local/lib/boxhaven/agent.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable boxhaven-agent >/dev/null 2>&1 || true
  systemctl restart boxhaven-agent >/dev/null 2>&1 || true
}

write_profile() {
  step "writing shell profile"
  cat > /etc/profile.d/boxhaven-remote.sh <<'EOF'
export PATH="/opt/boxhaven/bin:/root/.npm-global/bin:/home/boxhaven/.npm-global/bin:/usr/local/go/bin:$PATH"
export BOXHAVEN=1
export BOXHAVEN_REMOTE=1
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$HOME/.npm-global}"
EOF
}

apt_install
install_node
install_gh
install_docker
install_go
install_bun
install_uv
install_ai_clis
install_claude
install_rtk
install_boxhaven_user
install_wrappers
install_git_credential_helper
install_remote_session
install_boxhaven_agent
write_profile

step "marking remote runtime ready"
mkdir -p "$(dirname "$ready_marker")" /opt/boxhaven/project
chmod 755 /opt /opt/boxhaven /opt/boxhaven/project
date -u +%Y-%m-%dT%H:%M:%SZ > "$ready_marker"
step "complete"
