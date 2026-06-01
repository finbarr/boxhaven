# BoxHaven

BoxHaven gives development teams a standard way to run AI coding agents and
developer shells on named remote Linux boxes. Each box keeps running after a
laptop disconnects, has a managed tmux session for long-running Codex, Claude,
Gemini, or shell work, and can sync the current project to and from the remote
machine.

BoxHaven is built for the workflow many teams are assembling by hand today:
remote dev boxes for individual developers, persistent agent sessions, direct
SSH access, project sync, GitHub pushes from the box, and a self-hostable
control plane.

The CLI is intentionally small:

```bash
bh login
bh create work
bh list
bh run work codex
bh connect work
bh destroy work
```

`bh create` asks the backend for a machine, waits for it to be reachable, and
syncs the current project into `/opt/boxhaven/project` by default. `bh run`
syncs the current project before starting the command on the existing machine.
Interactive commands attach to the machine's managed tmux session; noninteractive
commands run over direct SSH. Sync excludes the local root `./bh` build artifact
so platform-specific CLI binaries are not copied between the workstation and the
remote box.

## What It Provides

- Named remote boxes: create, list, inspect, connect, sync, run, and destroy.
- Project sync to `/opt/boxhaven/project` with explicit sync up/down commands.
- A managed tmux session per box for long-running AI agent sessions.
- Direct SSH using backend-signed short-lived user certificates.
- GitHub HTTPS credential forwarding from local `GH_TOKEN` or `GITHUB_TOKEN`.
- Optional preview hostnames for HTTP services running on the box.
- An open-source Fastify/Better Auth backend with a DigitalOcean provider.

## Docs

- [Overview](docs/overview.md)
- [Getting Started](docs/getting-started.md)
- [Operations](docs/operations.md)

## Install From Source

```bash
go build -o bh ./cmd/bh
./bh version
```

## Install From Release

```bash
curl -fsSL https://raw.githubusercontent.com/finbarr/boxhaven/master/scripts/install-bh.sh | bash
```

Pin a version with `BOXHAVEN_INSTALL_VERSION=v0.1.0`.

## Release Archives

Build signed-by-checksum CLI archives for Linux and macOS:

```bash
make dist VERSION=v0.1.0
```

The archives and SHA-256 checksum file are written to `dist/`.

## Configuration

BoxHaven reads global config from `~/.config/boxhaven/config.toml` and project
config from `.boxhaven.toml`.

```toml
[remote]
backend_url = "https://api.boxhaven.dev"
token = "browser-granted-session-token"
ssh_user = "root"
setup = [
  "docker compose up -d db"
]
```

Environment overrides:

- `BOXHAVEN_BACKEND_URL`
- `BOXHAVEN_TOKEN`
- `GH_TOKEN` or `GITHUB_TOKEN` for GitHub repository access inside remote boxes

Production backends should gate signup with `BOXHAVEN_SIGNUP_MODE=invite` or
`disabled`, set machine quotas and rate limits, expose `/metrics` to monitoring,
protect `/metrics` with `BOXHAVEN_METRICS_BEARER_TOKEN`, pass
`make production-check` locally, validate `.env.production` with
`make validate-production-env` and `make validate-production-compose`, create
provider uptime checks and alerts, restrict SSH ingress with
`make ensure-firewalls`, prune old non-active remote snapshots after smoke, and
run `make audit-digitalocean` against hosted deployments. See
[backend/README.md](backend/README.md), [docs/operations.md](docs/operations.md), and
[deploy/digitalocean/README.md](deploy/digitalocean/README.md).

## GitHub Repository Access

When the current project's `origin` points at GitHub and `GH_TOKEN` or
`GITHUB_TOKEN` is set locally, `bh create`, `bh run`, `bh connect`, and
`bh sync up` forward that token to the remote box in
`/run/boxhaven/session.env`. The file is root-only, lives in tmpfs, and is
replaced or removed by the CLI on the next command. The remote image includes a
Git credential helper that uses those variables, so agents and shells inside the
box can push to HTTPS GitHub remotes.

For the smoothest agent workflow, use an HTTPS GitHub origin and export a token
with the repository scopes your team allows before starting the remote session.

## Backend

The open-source backend in [backend](backend) provides:

- Better Auth browser/device login
- per-user machine ownership
- DigitalOcean provisioning
- backend-signed short-lived SSH certificates
- VM agent RPC for setup commands and tmux session lifecycle
- generated preview hostnames and a browser console

Run it locally:

```bash
cd backend
npm ci
BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
DIGITALOCEAN_ACCESS_TOKEN=dop_v1_example \
npm run dev
```

Then point the CLI at it:

```bash
bh login --backend-url http://127.0.0.1:8787
bh create work
```

## DigitalOcean Deployment

Production deployment and golden-image tooling live in
[deploy/digitalocean](deploy/digitalocean).

## Production Smoke

Run the reusable remote lifecycle smoke against the hosted backend after remote
VM, SSH, sync, snapshot, or agent changes:

```bash
BOXHAVEN_TOKEN=... \
GH_TOKEN=... \
BOXHAVEN_SMOKE_GIT_REMOTE=https://github.com/<org>/<smoke-repo>.git \
BOXHAVEN_SMOKE_PRODUCTION=1 \
BOXHAVEN_SMOKE_RESTART_BACKEND_CMD="ssh root@<control-plane-ip> 'cd /opt/boxhaven/app && docker compose --env-file deploy/digitalocean/.env.production -f deploy/digitalocean/docker-compose.yml restart backend'" \
make smoke-remote
```

The smoke creates two boxes, syncs a temporary Git project, verifies runtime
tools on both boxes, fetches their preview URLs, optionally pushes and deletes
temporary GitHub smoke branches, and destroys both boxes unless
`BOXHAVEN_SMOKE_KEEP=1` is set. Set `BOXHAVEN_SMOKE_RESTART_BACKEND_CMD` to a
shell command that restarts the backend when the agent reconnect path needs to
be exercised.
