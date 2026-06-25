# Self-Hosting

The open-source backend is the remote control plane. The CLI always talks to
a backend; it does not provision cloud machines locally. The same backend
that powers the hosted `app.boxhaven.dev` self-hosts with your own provider
credentials and no built-in limits.

The browser app is built with TanStack Router and TanStack Query. It is the
console/auth surface only: login, signup, CLI device approval, invitations,
and authenticated box/team/image/billing views. Public website and
documentation content lives in the docs site, not in the backend-served app,
so a self-hosted server can run with only the login and console UI.

In production the intended split is `app.boxhaven.dev` for the console/auth
app and `api.boxhaven.dev` for the API. The API also serves the built console
app from `dist-app` for simple self-hosted deployments.

## Run Locally

```bash
cd backend
npm ci
BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
DIGITALOCEAN_ACCESS_TOKEN=dop_v1_example \
npm run dev
```

Run the web app during development from a second shell:

```bash
npm run dev:app
```

By default the server listens on `127.0.0.1:8787` and stores state at
`~/.local/state/boxhaven/backend.json`. Better Auth users and sessions are
stored in SQLite at `~/.local/state/boxhaven/auth.sqlite`.

Then point the CLI at it:

```bash
bh login --backend-url http://127.0.0.1:8787
bh create work
```

## Run With Docker Compose

From the repository root:

```bash
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export DIGITALOCEAN_ACCESS_TOKEN=dop_v1_example
docker compose -f docker-compose.backend.yml up --build
```

The Compose service publishes `127.0.0.1:8787` by default and persists
backend state in the `boxhaven-backend-data` Docker volume. Override the host
bind with `BOXHAVEN_BACKEND_PORT`, for example
`BOXHAVEN_BACKEND_PORT=127.0.0.1:8877`. When the public URL changes, also set
`BETTER_AUTH_URL`, `BOXHAVEN_APP_URL`, and `BOXHAVEN_API_URL` so browser
login links point at the reachable host.

A dummy `DIGITALOCEAN_ACCESS_TOKEN` is enough for build, startup, health, and
read-only API checks. Creating boxes from this stack still requires a real
DigitalOcean token and a CLI login token for the local backend.

## Environment Variables

- `BETTER_AUTH_SECRET`: required signing secret for Better Auth sessions.
- `BETTER_AUTH_URL`: public auth base URL, default `http://<listen>/v1/auth`.
- `BETTER_AUTH_TRUSTED_ORIGINS`: comma-separated trusted browser origins.
- `BOXHAVEN_APP_URL`: public console/auth app URL, default derived from `BETTER_AUTH_URL` in direct runs and `http://127.0.0.1:8787` in Compose.
- `BOXHAVEN_API_URL`: public API URL, default derived from `BETTER_AUTH_URL` in direct runs and `http://127.0.0.1:8787` in Compose.
- `BOXHAVEN_BACKEND_CORS_ORIGINS`: comma-separated browser origins allowed to call the API.
- `BOXHAVEN_PREVIEW_BASE_DOMAIN`: optional base domain for generated machine preview hosts, such as `at.boxhaven.dev`.
- `BOXHAVEN_PREVIEW_TARGET_PORT`: machine port that preview hosts proxy to, default `80`.
- `BOXHAVEN_BACKEND_AUTH_DB`: SQLite auth database path.
- `BOXHAVEN_BACKEND_LISTEN`: listen address, default `127.0.0.1:8787`.
- `BOXHAVEN_BACKEND_STATE`: JSON state file path.
- `BOXHAVEN_SSH_CA_KEY`: backend SSH user CA private key path, default beside `BOXHAVEN_BACKEND_STATE`.
- `BOXHAVEN_ADMIN_EMAILS`: comma-separated emails granted admin access to the image-management endpoints.
- `BOXHAVEN_MAX_MACHINES_PER_USER`: per-user cap on concurrently existing boxes; `0` or unset means unlimited. When the cap is reached, `POST /v1/machines` returns `403` with `{ "id": "limit_reached" }`. The hosted control plane sets this; self-hosted deployments normally leave it unset.
- `BOXHAVEN_BACKEND_PROVIDER`: default provider for creates that do not request one explicitly. When unset, the first configured provider is the default (DigitalOcean when both are configured).

Provider credentials and image variables (`DIGITALOCEAN_*`, `HCLOUD_TOKEN`,
`HETZNER_*`, `BOXHAVEN_REMOTE_IMAGE*`) are documented on the
[Cloud Providers](/providers) page.

## Production DigitalOcean Deployment

The repository includes a production bundle in `deploy/digitalocean/` for the
hosted split:

- `app.boxhaven.dev` for the browser console/auth app
- `api.boxhaven.dev` for API and Better Auth routes
- `*.at.boxhaven.dev` for generated machine preview URLs
- Caddy-managed TLS in front of the backend container
- host-mounted backend and Caddy data under `/opt/boxhaven/data`
- a systemd timer that writes daily archives to `/opt/boxhaven/backups`

### Provision

Create an Ubuntu 24.04 Droplet with `deploy/digitalocean/cloud-init.yml`.
Enable DigitalOcean Droplet backups for machine-level restore coverage.

Required DNS records:

```text
app.boxhaven.dev.  A  <droplet-ip>
api.boxhaven.dev.  A  <droplet-ip>
*.at.boxhaven.dev.  A  <droplet-ip>
```

### Configure

Copy `env.production.example` to `.env.production` on the server and fill in
the secret values:

```bash
cp deploy/digitalocean/env.production.example deploy/digitalocean/.env.production
```

`BETTER_AUTH_SECRET` must be a long random value. The backend also needs
`DIGITALOCEAN_ACCESS_TOKEN` so it can create remote VMs for users. The
backend SSH user CA is stored at `/opt/boxhaven/data/backend/ssh_ca_ed25519`
and is included in the backend data backups. Set
`BOXHAVEN_PREVIEW_BASE_DOMAIN` to the wildcard domain above.

### Deploy

Deploy the hosted production stack from the repository root:

```bash
npm run deploy:app
```

`npm run deploy:production` is a compatibility alias for the same fast
app/API deploy. By default the command SSHes to `root@app.boxhaven.dev`,
fast-forwards `/opt/boxhaven/app` on `master`, runs the Compose deploy on the
Droplet, and checks both public health endpoints. It forwards your SSH agent
so the Droplet can fetch the private GitHub repo without storing a GitHub
token. Override the SSH target with
`BOXHAVEN_DEPLOY_TARGET=root@<control-plane-ip>` or `-- --target user@host`
for self-hosted installs. On the Droplet itself, use
`npm run deploy:production:local`.

### Health Checks And Backups

```bash
npm run deploy:production:verify
sudo systemctl status boxhaven-backend-backup.timer --no-pager
```

Backups are installed through `deploy/digitalocean/install-backups.sh` and
write archives under `/opt/boxhaven/backups`. The backend data backup uses
SQLite's online backup command for `auth.sqlite` and includes `backend.json`
plus Caddy data.

## Golden Image Rotation

Remote runtime dependencies belong in the golden VM image. After changing
`cmd/bh/assets/remote-vm-install.sh`, build and activate a new snapshot from a
clean committed checkout or pushed ref:

```bash
deploy/digitalocean/build-remote-image.sh \
  --env-file deploy/digitalocean/.env.production \
  --set-active
```

Or use the checked-in npm entrypoint:

```bash
npm run deploy:runtime
```

Each build snapshots a fresh image and prunes older `boxhaven-remote-*`
snapshots beyond the newest two (the new image plus one rollback). Set
`BOXHAVEN_IMAGE_KEEP` to keep more, or `0` to disable pruning.

The runtime deploy creates and snapshots a temporary DigitalOcean builder
Droplet, updates `BOXHAVEN_REMOTE_IMAGE`, then restarts and verifies the
backend so new boxes use the image. When an active `BOXHAVEN_REMOTE_IMAGE`
exists, the builder starts from that snapshot by default instead of
reinstalling the full OS/toolchain from Ubuntu. Use
`npm run deploy:runtime -- --full-base-image` only for base OS or runtime
dependency rebuilds.

`npm run deploy:runtime` writes `BOXHAVEN_REMOTE_IMAGE` to the env file as
the env-configured default. Team images do not override that default globally;
they are selected per box with `bh create --image <image-id>` or the console
create form.

Keep the previous snapshot id until the remote lifecycle smoke passes.

## Remote Lifecycle Smoke

Run the reusable remote lifecycle smoke against the backend after remote VM,
SSH, sync, snapshot, preview, or agent changes:

```bash
BOXHAVEN_TOKEN=... \
GH_TOKEN=... \
BOXHAVEN_SMOKE_GIT_REMOTE=https://github.com/<org>/<smoke-repo>.git \
make smoke-remote
```

The default smoke is intentionally fast: it creates one box from the active
snapshot, syncs a temporary Git project, verifies runtime tools, fetches the
preview URL, optionally pushes and deletes a temporary GitHub smoke branch,
and destroys the box unless `BOXHAVEN_SMOKE_KEEP=1` is set.

Useful options:

```bash
BOXHAVEN_SMOKE_BACKEND_URL=https://api.boxhaven.dev
BOXHAVEN_SMOKE_TIER=small
BOXHAVEN_SMOKE_PREFIX=my-smoke
BOXHAVEN_SMOKE_KEEP=1
BOXHAVEN_SMOKE_REQUIRE_PREVIEW=0
```

Use `make smoke-remote-full` with `BOXHAVEN_SMOKE_RESTART_BACKEND_CMD` when
the agent reconnect path needs coverage. Use `make smoke-remote-two-box` only
for concurrency, provider import, or multiple-machine behavior.

## Web Preview

Each hosted box receives a public preview URL when the backend is configured
with a preview base domain. The backend warms the preview URL during machine
create so Caddy has already completed on-demand certificate issuance before the
URL is shown. Public HTTPS and WebSocket traffic terminate at the BoxHaven
control plane (Caddy terminates HTTPS on the control-plane Droplet), then the
backend proxies plain HTTP/WebSocket traffic to the machine's
`BOXHAVEN_PREVIEW_TARGET_PORT`, default `80`. Remote apps do not need to
manage public TLS for the preview URL.

Inside the box, commands receive:

- `BOXHAVEN_PREVIEW_URL`: the browser URL to share.
- `BOXHAVEN_PREVIEW_HOSTNAME`: the public hostname.
- `BOXHAVEN_PREVIEW_TARGET_PORT` / `BOXHAVEN_WEB_PORT`: the machine port to serve, normally `80`.
- `BOXHAVEN_WEB_BIND`: the bind address to use, normally `0.0.0.0`.
- `/run/boxhaven/context.json`: structured runtime context with the same preview details under `.preview`.

Apps should bind HTTP to `0.0.0.0:$BOXHAVEN_WEB_PORT` or run a reverse proxy
on that port to the app's internal dev-server port. Framework dev-server
WebSockets, including Vite HMR, use the same preview URL. The default
`boxhaven` user has sudo access if binding to port 80 is required.

## Hosted Versus Self-Hosted

`app.boxhaven.dev` is the hosted control plane run by the BoxHaven operators.
Hosted boxes are provisioned from the operators' cloud provider accounts, and
the operators can cap boxes per account with
`BOXHAVEN_MAX_MACHINES_PER_USER`. The same open-source backend self-hosts
with your own provider credentials and no built-in limits.
