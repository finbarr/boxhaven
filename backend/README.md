# BoxHaven Backend

This is the open-source remote control plane. The CLI always talks to a backend;
it does not provision cloud machines locally. The hosted backend can offer a free
account/control-plane layer, let users attach their own cloud credentials, and
gate BoxHaven-owned VMs behind paid plans. Self-hosters can run this package with
their own provider credentials.

The browser app is built with TanStack Router and TanStack Query. In production
the intended split is `app.boxhaven.dev` for the console and `api.boxhaven.dev`
for this API. The API also serves the built app from `dist-app` for simple
self-hosted deployments.

## Run Locally

```bash
npm ci
BETTER_AUTH_SECRET=replace-with-a-random-secret-at-least-32-bytes \
DIGITALOCEAN_ACCESS_TOKEN=dop_v1_example \
npm run dev
```

Run the web app during development from a second shell:

```bash
npm run dev:app
```

By default the server listens on `127.0.0.1:8787` and stores state at
`~/.local/state/boxhaven/backend.json`. Better Auth users and sessions are stored
in SQLite at `~/.local/state/boxhaven/auth.sqlite`.

## Run With Docker Compose

From the repository root:

```bash
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export DIGITALOCEAN_ACCESS_TOKEN=dop_v1_example
docker compose -f docker-compose.backend.yml up --build
```

The Compose service publishes `127.0.0.1:8787` by default and persists backend
state in the `boxhaven-backend-data` Docker volume. Override the host bind with
`BOXHAVEN_BACKEND_PORT`, for example `BOXHAVEN_BACKEND_PORT=127.0.0.1:8877`.
When the public URL changes, also set `BETTER_AUTH_URL`, `BOXHAVEN_APP_URL`, and
`BOXHAVEN_API_URL` so browser login links point at the reachable host.

Use the local stack as a backend smoke after backend, browser, auth, or compose
changes:

```bash
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-$(openssl rand -hex 32)}"
export DIGITALOCEAN_ACCESS_TOKEN="${DIGITALOCEAN_ACCESS_TOKEN:-dop_v1_local_smoke}"
export BOXHAVEN_BACKEND_PORT=127.0.0.1:8877
export BETTER_AUTH_URL=http://127.0.0.1:8877/v1/auth
export BOXHAVEN_APP_URL=http://127.0.0.1:8877
export BOXHAVEN_API_URL=http://127.0.0.1:8877

docker compose -f docker-compose.backend.yml up -d --build
docker compose -f docker-compose.backend.yml ps
curl -fsS http://127.0.0.1:8877/healthz
curl -fsS http://127.0.0.1:8877/v1/providers
BOXHAVEN_BACKEND_URL=http://127.0.0.1:8877 ./bh config
```

A dummy `DIGITALOCEAN_ACCESS_TOKEN` is enough for build, startup, health, and
read-only API checks. Creating boxes from this stack still requires a real
DigitalOcean token and a CLI login token for the local backend.

## Production DigitalOcean Deployment

The repository includes a production bundle in `deploy/digitalocean/` for the
hosted split:

- `app.boxhaven.dev` for the browser console
- `api.boxhaven.dev` for API and Better Auth routes
- `*.at.boxhaven.dev` for generated machine preview URLs
- Caddy-managed TLS in front of the backend container
- host-mounted backend and Caddy data under `/opt/boxhaven/data`
- a systemd timer that writes daily archives to `/opt/boxhaven/backups`

Enable DigitalOcean Droplet backups for machine-level recovery, then install the
repo backup timer for application state recovery. The backend data backup uses
SQLite's online backup command for `auth.sqlite` and includes `backend.json` plus
Caddy data.

Deploy the hosted production stack from the repository root:

```bash
npm run deploy:production
```

By default the command SSHes to `root@app.boxhaven.dev`, fast-forwards
`/opt/boxhaven/app` on `master`, runs the Compose deploy on the Droplet, and
checks both public health endpoints. It forwards your SSH agent so the Droplet
can fetch the private GitHub repo without storing a GitHub token. On the Droplet
itself, use `npm run deploy:production:local`.

Then sign up or sign in from another shell. The CLI prints a browser URL, tries
to open it, and waits for the web app to grant access:

```bash
bh login --backend-url http://127.0.0.1:8787
```

Environment:

- `BETTER_AUTH_SECRET`: required signing secret for Better Auth sessions.
- `BETTER_AUTH_URL`: public auth base URL, default `http://<listen>/v1/auth`.
- `BETTER_AUTH_TRUSTED_ORIGINS`: comma-separated trusted browser origins.
- `BOXHAVEN_APP_URL`: public app URL, default derived from `BETTER_AUTH_URL` in direct runs and `http://127.0.0.1:8787` in Compose.
- `BOXHAVEN_API_URL`: public API URL, default derived from `BETTER_AUTH_URL` in direct runs and `http://127.0.0.1:8787` in Compose.
- `BOXHAVEN_BACKEND_CORS_ORIGINS`: comma-separated browser origins allowed to call the API.
- `BOXHAVEN_PREVIEW_BASE_DOMAIN`: optional base domain for generated machine preview hosts, such as `at.boxhaven.dev`.
- `BOXHAVEN_PREVIEW_TARGET_PORT`: machine port that preview hosts proxy to, default `80`.
- `BOXHAVEN_BACKEND_AUTH_DB`: SQLite auth database path.
- `BOXHAVEN_BACKEND_LISTEN`: listen address, default `127.0.0.1:8787`.
- `BOXHAVEN_BACKEND_STATE`: JSON state file path.
- `BOXHAVEN_SSH_CA_KEY`: backend SSH user CA private key path, default beside `BOXHAVEN_BACKEND_STATE`.
- `BOXHAVEN_BACKEND_PROVIDER`: provider adapter, default `digitalocean`.
- `DIGITALOCEAN_ACCESS_TOKEN`: DigitalOcean token for self-hosted provisioning.
- `DIGITALOCEAN_REGION`: default `nyc3`.
- `DIGITALOCEAN_SIZE`: default provider size for creates without an explicit tier, default `s-2vcpu-4gb-amd`.
- Create-time tiers map to DigitalOcean AMD sizes: `small` is 2 vCPU / 4 GB, `medium` is 4 vCPU / 8 GB, and `large` is 8 vCPU / 16 GB.
- `BOXHAVEN_REMOTE_IMAGE`: provider image id, snapshot id, or slug for a prebuilt BoxHaven VM image. Numeric DigitalOcean snapshot ids are sent as image IDs when creating Droplets. Machines created from this image are treated as backend-bootstrapped. When unset, DigitalOcean falls back to `DIGITALOCEAN_IMAGE` and then `ubuntu-24-04-x64`; the CLI does not bootstrap plain hosts.
- `DIGITALOCEAN_IMAGE`: DigitalOcean image fallback, default `ubuntu-24-04-x64`.
- `DIGITALOCEAN_TAGS`: comma-separated tags, default `boxhaven`.
- `DIGITALOCEAN_VPC_UUID`: optional VPC UUID.

Normal user VMs do not receive reusable DigitalOcean account SSH keys. The
backend uses a one-time no-login key during DigitalOcean create only to prevent
provider password emails, then deletes the account key. SSH access still goes
through short-lived backend-signed certificates and VM trust of the matching
user CA.

Use `deploy/digitalocean/build-remote-image.sh` to build and rotate the
DigitalOcean golden snapshot. The normal release flow is: commit the runtime
change, build a snapshot from that commit or a pushed tag with `--set-active`,
restart the backend, smoke create a temporary remote, then keep the previous
snapshot id available for rollback until the smoke passes.

## API

Machine endpoints and `GET /v1/auth/whoami` require a Better Auth bearer
session:

```http
Authorization: Bearer <token>
```

Routes:

- `GET /healthz`
- `POST /v1/auth/sign-up/email`
- `POST /v1/auth/sign-in/email`
- `POST /v1/auth/sign-out`
- `POST /v1/auth/device/code`
- `GET /v1/auth/device`
- `POST /v1/auth/device/approve`
- `POST /v1/auth/device/deny`
- `POST /v1/auth/device/token`
- `GET /v1/auth/whoami`
- `GET /v1/providers`
- `GET /v1/preview/tls-check`
- `ANY /v1/preview/proxy/:hostname/*`
- `POST /v1/agent/heartbeat`
- `GET /v1/agent/connect`
- `POST /v1/machines`
- `GET /v1/machines`
- `GET /v1/machines/:name`
- `GET /v1/machines/:name/connect`
- `PATCH /v1/machines/:name`
- `POST /v1/machines/:name/ssh-cert`
- `POST /v1/machines/:name/setup`
- `POST /v1/machines/:name/sync-complete`
- `POST /v1/machines/:name/sessions/boxhaven/prepare`
- `POST /v1/machines/:name/commands/ssh`
- `POST /v1/machines/:name/commands/record`
- `DELETE /v1/machines/:name`

Machines are scoped to the authenticated Better Auth user and are one-to-one with
a remote VM. The backend imports provider-owned machines when listing, so the UI
and CLI can see machines already present in the authenticated account. There are
no multiple backend workspaces or named sessions per machine; the backend and VM
agent own one project path and one tmux session on the VM. Bootstrap status is
provider-owned. `POST /v1/machines` creates a new machine and returns `409` when
the authenticated user already has that name. `PATCH /v1/machines/:name` renames
the authenticated user's BoxHaven machine record while keeping the underlying
provider VM, preview hostname, SSH principal, and agent identity unchanged.

Every machine created by the backend gets a server-generated 48-byte random
machine-agent token. The backend stores only a hash of that token and passes the
plaintext token to the provider as VM user data for `/etc/boxhaven/agent.env`.
Machine-agent endpoints authenticate only that bearer token; they do not accept
or trust a machine name claimed by the VM. `POST /v1/agent/heartbeat` maps the
token back to the one machine that owns it, records `agent_last_seen_at`, and
never returns the stored token hash. The persistent `/v1/agent/connect`
connection carries backend RPC for setup commands, command wrapping, and the
single managed tmux session.

Every backend-created machine also trusts the backend SSH user CA. The backend
persists the CA private key, passes the CA public key plus a per-machine
authorized principal to provider user data, and signs temporary CLI public keys
through `POST /v1/machines/:name/ssh-cert` only after authenticating the machine
owner. The CLI uses the returned OpenSSH certificate with local `ssh` and
`rsync` directly against the VM public IP. User SSH bytes do not flow through the
backend. CLI-side host-key pinning lives in `~/.boxhaven/remote_known_hosts`.

The remote image also includes a GitHub HTTPS credential helper. When the CLI
detects a GitHub project, it writes GitHub auth over direct SSH to
`/run/boxhaven/session.env` on the VM. `GH_TOKEN` or `GITHUB_TOKEN` are used when
set; otherwise the CLI falls back to the local GitHub CLI via `gh auth token`.
The machine agent sources that tmpfs file before setup commands, direct
commands, and tmux session launches. The file is readable only by the remote SSH
user and root. The backend does not persist those GitHub tokens.

The CLI also forwards selected local Codex and Claude login/config files over
direct SSH when a remote session is created, connected, run, or synced up. Those
files are written into the remote SSH user's home so users do not need to repeat
agent login flows on every new VM. The backend does not receive or store these
files.

The CLI also forwards only the effective local Git author identity,
`user.name` and `user.email`, into the remote SSH user's global Git config. It
does not copy the full local Git config.
