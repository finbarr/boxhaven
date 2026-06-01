# BoxHaven

BoxHaven gives AI coding agents and developer shells a named Linux machine that
keeps running after your laptop disconnects.

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
commands run over direct SSH.

## Install From Source

```bash
go build -o bh ./cmd/bh
./bh version
```

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
