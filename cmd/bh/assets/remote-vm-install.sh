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

disable_unattended_apt() {
  step "disabling unattended apt timers"
  systemctl disable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
  systemctl mask apt-daily.service apt-daily-upgrade.service apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
  if [ -f /etc/apt/apt.conf.d/20auto-upgrades ]; then
    sed -i \
      -e 's/^\s*APT::Periodic::Update-Package-Lists.*/APT::Periodic::Update-Package-Lists "0";/' \
      -e 's/^\s*APT::Periodic::Unattended-Upgrade.*/APT::Periodic::Unattended-Upgrade "0";/' \
      /etc/apt/apt.conf.d/20auto-upgrades || true
  fi
  cat > /etc/apt/apt.conf.d/99-boxhaven-no-unattended-upgrades <<'EOF'
APT::Periodic::Enable "0";
APT::Periodic::Update-Package-Lists "0";
APT::Periodic::Download-Upgradeable-Packages "0";
APT::Periodic::AutocleanInterval "0";
APT::Periodic::Unattended-Upgrade "0";
EOF
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

install_terminal_compat() {
  step "installing terminal compatibility"
  cat > /tmp/boxhaven-extra-terminfo.src <<'EOF'
xterm-ghostty|Ghostty terminal emulator,
  use=xterm-256color,
EOF
  install -d -m 0755 /usr/share/terminfo
  tic -x -o /usr/share/terminfo /tmp/boxhaven-extra-terminfo.src
  rm -f /tmp/boxhaven-extra-terminfo.src
  infocmp xterm-ghostty >/dev/null
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
    @openai/codex@0.144.1 \
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
  # The installer drops a versioned binary under /root, which other users
  # cannot traverse. Copy the resolved binary somewhere world-readable;
  # symlinking into /root breaks claude for the boxhaven user.
  claude_real="$(readlink -f /root/.local/bin/claude 2>/dev/null || true)"
  if [ -n "$claude_real" ] && [ -x "$claude_real" ]; then
    install -D -m 0755 "$claude_real" /usr/local/lib/boxhaven/claude
    ln -sf /usr/local/lib/boxhaven/claude /usr/local/bin/claude
  fi
}

verify_agents_for_boxhaven_user() {
  step "verifying agents run as the boxhaven user"
  for agent in claude codex; do
    if ! sudo -u boxhaven -i env BOXHAVEN_NO_FULL_AUTO=1 "$agent" --version >/dev/null 2>&1; then
      echo "$agent is not runnable by the boxhaven user" >&2
      exit 1
    fi
  done
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
  usermod -aG sudo boxhaven || true
  if getent group docker >/dev/null 2>&1; then
    usermod -aG docker boxhaven || true
  fi
  echo "boxhaven ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/boxhaven
  # Pre-trust the project path so codex does not stop at an interactive
  # trust prompt on first run, which would block detached agent sessions.
  install -d -o boxhaven -g boxhaven -m 0700 /home/boxhaven/.codex
  if [ ! -f /home/boxhaven/.codex/config.toml ]; then
    cat > /home/boxhaven/.codex/config.toml <<'CODEX_TRUST'
[projects."/opt/boxhaven/project"]
trust_level = "trusted"
CODEX_TRUST
    chown boxhaven:boxhaven /home/boxhaven/.codex/config.toml
    chmod 0600 /home/boxhaven/.codex/config.toml
  fi
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

install_tmux_config() {
  step "writing tmux config"
  cat > /etc/tmux.conf <<'EOF'
set -g mouse on
set -g history-limit 100000
EOF
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
export BOXHAVEN_PREVIEW_TARGET_PORT="${BOXHAVEN_PREVIEW_TARGET_PORT:-80}"
export BOXHAVEN_PREVIEW_BIND_HOST="${BOXHAVEN_PREVIEW_BIND_HOST:-0.0.0.0}"

runtime_dir="$(dirname "$BOXHAVEN_CONTEXT_FILE")"
if [ ! -d "$runtime_dir" ] || [ ! -w "$runtime_dir" ]; then
  sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0700 "$runtime_dir" >/dev/null 2>&1 || true
fi
mkdir -p "$workdir" "$home_dir/.npm-global"
if [ ! -e /workspace ] || [ -L /workspace ]; then
  sudo ln -sfn "$workdir" /workspace >/dev/null 2>&1 || true
fi
git config --global --get-all safe.directory | grep -Fx "$workdir" >/dev/null 2>&1 || \
  git config --global --add safe.directory "$workdir" >/dev/null 2>&1 || true
docker network create boxhaven-net >/dev/null 2>&1 || true

if command -v jq >/dev/null 2>&1; then
  gh_token_forwarded=false
  if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    gh_token_forwarded=true
  fi
  preview_target_port="${BOXHAVEN_PREVIEW_TARGET_PORT:-80}"
  case "$preview_target_port" in
    ""|*[!0-9]*) preview_target_port=80 ;;
  esac
  jq -n \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg workdir "$workdir" \
    --arg home "$home_dir" \
    --arg preview_url "${BOXHAVEN_PREVIEW_URL:-}" \
    --arg preview_hostname "${BOXHAVEN_PREVIEW_HOSTNAME:-}" \
    --arg preview_bind_host "${BOXHAVEN_PREVIEW_BIND_HOST:-0.0.0.0}" \
    --argjson preview_target_port "$preview_target_port" \
    --argjson gh_token_forwarded "$gh_token_forwarded" \
    '{
      schema_version: 1,
      inside_boxhaven: true,
      remote: true,
      boxhaven_version: "remote-vm",
      generated_at: $generated_at,
      preview: {
        enabled: ($preview_url != ""),
        url: $preview_url,
        hostname: $preview_hostname,
        external_scheme: "https",
        upstream_scheme: "http",
        bind_host: $preview_bind_host,
        target_port: $preview_target_port
      },
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

install_boxhaven_skills() {
  step "installing boxhaven skills"
  install -d -m 0755 /etc/skel/.codex/skills/boxhaven-web-preview
  cat > /etc/skel/.codex/skills/boxhaven-web-preview/SKILL.md <<'EOF'
---
name: boxhaven-web-preview
description: Use when working inside a BoxHaven remote machine on an app with a web UI, preview URL, public HTTP/HTTPS access, server binding, or port configuration.
---

# BoxHaven Web Preview

BoxHaven exposes one public preview URL for this machine. Read it from
`$BOXHAVEN_PREVIEW_URL`; do not guess it.

Runtime details:

- Browser traffic reaches `https://$BOXHAVEN_PREVIEW_HOSTNAME`.
- TLS terminates at the BoxHaven control plane.
- The control plane proxies to this machine over plain HTTP/WebSocket on
  `$BOXHAVEN_PREVIEW_TARGET_PORT`, normally `80`. Do not run HTTPS inside the
  box for this preview path.
- Bind web servers to `$BOXHAVEN_WEB_BIND`, normally `0.0.0.0`, not `localhost`.
- Serve the public app on `$BOXHAVEN_WEB_PORT`, normally `80`.
- `/run/boxhaven/context.json` contains the same preview information under
  `.preview`.

If a framework's dev server normally uses a high port, either configure it to
listen on `$BOXHAVEN_WEB_BIND:$BOXHAVEN_WEB_PORT` or run a small reverse proxy
on `$BOXHAVEN_WEB_PORT` to the framework port. Binding to port 80 may need
`sudo`; the default `boxhaven` user has sudo access.
Framework dev-server WebSockets, including Vite HMR, should use the same public
preview URL; avoid separate tunnel or HTTPS setup unless the user asks for it.

Examples:

```bash
npm run dev -- --host "$BOXHAVEN_WEB_BIND" --port "$BOXHAVEN_WEB_PORT"
```

```bash
sudo python3 -m http.server "$BOXHAVEN_WEB_PORT" --bind "$BOXHAVEN_WEB_BIND"
```

When reporting success, show `$BOXHAVEN_PREVIEW_URL`.
EOF
  install -d -o boxhaven -g boxhaven -m 0755 /home/boxhaven/.codex/skills
  cp -R /etc/skel/.codex/skills/boxhaven-web-preview /home/boxhaven/.codex/skills/
  chown -R boxhaven:boxhaven /home/boxhaven/.codex
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
const defaultSSHUser = "boxhaven";
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
  const script = payload.run_as_root === true
    ? `set -euo pipefail
${commands.join("\n")}
`
    : `set -euo pipefail
${remoteCommandPrefix(payload)}
${commands.join("\n")}
`;
  const result = await runProcessForPayload(payload, "bash", ["-lc", script], { maxBuffer: 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function prepareSession(payload) {
  const attach = payload.attach === true;
  const exists = await tmuxSessionExists(payload);
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
  await runProcessForPayload(payload, "tmux", ["new-session", "-d", "-s", remoteSessionName, "-c", workPath, sessionCommand]);
  return {
    status: attach ? "started" : "started_detached",
    attach_command: attach ? tmuxAttachCommand() : "",
    record_command: true,
  };
}

function directCommand(payload) {
  return { command: `${remoteCommandPrefix(payload)}exec ${shellJoin(normalizeRemoteCommand(payload.command))}` };
}

async function tmuxSessionExists(payload) {
  const result = await runProcessForPayload(payload, "tmux", ["has-session", "-t", remoteSessionName], { reject: false });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  const error = new Error(result.stderr || `tmux has-session failed with exit ${result.code}`);
  error.code = "session_check_failed";
  throw error;
}

function tmuxAttachCommand() {
  return `tmux set-option -g mouse on >/dev/null 2>&1 || true; tmux attach-session -t ${shellQuote(remoteSessionName)}`;
}

function remoteCommandPrefix(payload) {
  const workPath = remoteWorkPath(payload);
  const previewPort = previewTargetPort(payload);
  const previewBindHost = previewBindHostForPayload(payload);
  const parts = [
    "export PATH=\"/opt/boxhaven/bin:/root/.npm-global/bin:/home/boxhaven/.npm-global/bin:/root/.local/bin:/home/boxhaven/.local/bin:/usr/local/go/bin:$PATH\"",
    "export NPM_CONFIG_PREFIX=\"${NPM_CONFIG_PREFIX:-$HOME/.npm-global}\"",
    "export GOPATH=\"${GOPATH:-$HOME/go}\"",
    "export GOCACHE=\"${GOCACHE:-$HOME/.cache/go-build}\"",
    "export GOMODCACHE=\"${GOMODCACHE:-$GOPATH/pkg/mod}\"",
    "export BOXHAVEN=1",
    "export BOXHAVEN_REMOTE=1",
    `export BOXHAVEN_PROJECT_PATH=${shellQuote(workPath)}`,
    `export BOXHAVEN_CONTEXT_FILE=${shellQuote(boxhavenContextFile)}`,
    `export BOXHAVEN_PREVIEW_TARGET_PORT=${shellQuote(String(previewPort))}`,
    `export BOXHAVEN_PREVIEW_BIND_HOST=${shellQuote(previewBindHost)}`,
    `export BOXHAVEN_WEB_PORT=${shellQuote(String(previewPort))}`,
    `export BOXHAVEN_WEB_BIND=${shellQuote(previewBindHost)}`,
  ];
  parts.push(`if [ -r ${shellQuote(sessionEnvFile)} ]; then . ${shellQuote(sessionEnvFile)}; fi`);
  const previewURL = String(payload.preview_url || "").trim();
  if (previewURL) {
    parts.push(`export BOXHAVEN_PREVIEW_URL=${shellQuote(previewURL)}`);
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

function previewTargetPort(payload) {
  const port = Number(payload.preview_target_port || 80);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return 80;
  return port;
}

function previewBindHostForPayload(payload) {
  const host = String(payload.preview_bind_host || "0.0.0.0").trim();
  return host || "0.0.0.0";
}

function runProcessForPayload(payload, command, args, options = {}) {
  if (payload.run_as_root === true) {
    return runProcess(command, args, options);
  }
  const user = remoteUser(payload);
  if (user === "root") {
    return runProcess(command, args, options);
  }
  return runProcess("sudo", ["-H", "-u", user, command, ...args], options);
}

function remoteUser(payload) {
  const user = String(payload.ssh_user || defaultSSHUser).trim();
  return /^[a-z_][a-z0-9_-]*[$]?$/i.test(user) ? user : defaultSSHUser;
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
if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
  export HOME
fi
export PATH="/opt/boxhaven/bin:/root/.npm-global/bin:/home/boxhaven/.npm-global/bin:/usr/local/go/bin:$PATH"
export BOXHAVEN=1
export BOXHAVEN_REMOTE=1
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$HOME/.npm-global}"
export GOPATH="${GOPATH:-$HOME/go}"
export GOCACHE="${GOCACHE:-$HOME/.cache/go-build}"
export GOMODCACHE="${GOMODCACHE:-$GOPATH/pkg/mod}"
EOF
}

disable_unattended_apt
apt_install
install_terminal_compat
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
install_tmux_config
install_git_credential_helper
install_remote_session
install_boxhaven_skills
install_boxhaven_agent
verify_agents_for_boxhaven_user
write_profile

step "marking remote runtime ready"
mkdir -p "$(dirname "$ready_marker")" /opt/boxhaven
install -d -o boxhaven -g boxhaven -m 0755 /opt/boxhaven/project
chmod 755 /opt /opt/boxhaven
date -u +%Y-%m-%dT%H:%M:%SZ > "$ready_marker"
step "complete"
