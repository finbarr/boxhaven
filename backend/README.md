# BoxHaven Backend

This is the open-source remote control plane. The CLI always talks to a backend;
it does not provision cloud machines locally. Self-hosters can run this package
with their own provider credentials and no external commercial service.

The browser app is built with TanStack Router and TanStack Query. It is the
console/auth surface only: login, signup, CLI device approval, invitations,
and authenticated box/team/image views. The paid-service website lives
outside this repository, and documentation lives in `docs/`, so a self-hosted
backend does not serve the marketing site.

In production the intended split is `boxhaven.dev` for the paid-service
website, `docs.boxhaven.dev` for documentation, `app.boxhaven.dev` for the
console/auth app, and `api.boxhaven.dev` for this API. The API also serves the
built console app from `dist-app` for simple self-hosted deployments.

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

For browser console changes, run the reusable seeded smoke:

```bash
npm run smoke:console
```

It starts a temporary fake-provider backend and Vite app, seeds teams, drives
Chrome with Playwright, saves screenshots under `backend/.artifacts/`, and fails
on expected access-page, navigation, Members, Teams, or mobile-overflow
regressions. Set `BOXHAVEN_PLAYWRIGHT_EXECUTABLE` if Chrome is not in a
standard location.

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
export BOXHAVEN_DOCS_URL=https://docs.example.internal

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

- `app.boxhaven.dev` for the browser console/auth app
- `api.boxhaven.dev` for API and Better Auth routes
- `docs.boxhaven.dev` for the static documentation site
- `*.at.boxhaven.dev` for generated machine preview URLs
- Caddy-managed TLS in front of the backend container
- a Caddy file-server mount for the built `docs/.vitepress/dist` artifact
- host-mounted backend and Caddy data under `/opt/boxhaven/data`
- a systemd timer that writes daily archives to `/opt/boxhaven/backups`

Enable DigitalOcean Droplet backups for machine-level recovery, then install the
repo backup timer for application state recovery. The backend data backup uses
SQLite's online backup command for `auth.sqlite` and includes `backend.json` plus
Caddy data.

Deploy the hosted production stack from the repository root:

```bash
npm run deploy:app
```

`npm run deploy:production` is a compatibility alias for the same fast
app/API/docs deploy. By default the command SSHes to `root@app.boxhaven.dev`,
fast-forwards `/opt/boxhaven/app` on `master`, builds the docs site, runs the
Compose deploy on the Droplet, and checks the public app, API, and docs health
endpoints. It forwards your SSH agent so the Droplet can fetch the private
GitHub repo without storing a GitHub token. On the Droplet itself, use
`npm run deploy:production:local`.

Then sign up or sign in from another shell. The CLI prints a browser URL, tries
to open it, and waits for the web app to grant access:

```bash
bh login --backend-url http://127.0.0.1:8787
```

Environment:

- `BETTER_AUTH_SECRET`: required signing secret for Better Auth sessions.
- `BETTER_AUTH_URL`: public auth base URL, default `http://<listen>/v1/auth`.
- `BETTER_AUTH_TRUSTED_ORIGINS`: comma-separated trusted browser origins.
- `BOXHAVEN_APP_URL`: public console/auth app URL, default derived from `BETTER_AUTH_URL` in direct runs and `http://127.0.0.1:8787` in Compose.
- `BOXHAVEN_API_URL`: public API URL, default derived from `BETTER_AUTH_URL` in direct runs and `http://127.0.0.1:8787` in Compose.
- `BOXHAVEN_DOCS_URL`: public documentation URL used by console footer links in Docker builds. Set this when self-hosting internal docs; otherwise the app links to `https://docs.boxhaven.dev`.
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
- `DIGITALOCEAN_ACCESS_TOKEN`: DigitalOcean token; setting it enables the DigitalOcean provider.
- `DIGITALOCEAN_REGION`: default `nyc3`.
- `DIGITALOCEAN_SIZE`: default provider size for creates without an explicit tier, default `s-2vcpu-4gb-amd`.
- Create-time tiers map to DigitalOcean AMD sizes: `small` is 2 vCPU / 4 GB, `medium` is 4 vCPU / 8 GB, and `large` is 8 vCPU / 16 GB.
- `BOXHAVEN_REMOTE_IMAGE_DIGITALOCEAN` or `BOXHAVEN_REMOTE_IMAGE`: provider image id, snapshot id, or slug for a prebuilt BoxHaven VM image. Numeric DigitalOcean snapshot ids are sent as image IDs when creating Droplets. Machines created from this image are treated as backend-bootstrapped. When unset, DigitalOcean falls back to `DIGITALOCEAN_IMAGE` and then `ubuntu-24-04-x64`; the CLI does not bootstrap plain hosts.
- `DIGITALOCEAN_IMAGE`: DigitalOcean image fallback, default `ubuntu-24-04-x64`.
- `DIGITALOCEAN_TAGS`: comma-separated tags, default `boxhaven`.
- `DIGITALOCEAN_VPC_UUID`: optional VPC UUID.
- `HCLOUD_TOKEN`: Hetzner Cloud token; setting it enables the Hetzner provider.
- `HETZNER_LOCATION`: default `nbg1`. The tier server types (`cpx22`/`cpx32`/`cpx42`) are also orderable in `fsn1`, `hel1`, and `sin`; the US locations `ash` and `hil` only offer other plans, so they need `HETZNER_SERVER_TYPE` set accordingly and creates without a tier.
- `HETZNER_SERVER_TYPE`: default server type for creates without an explicit tier, default `cpx22`. Tiers map to `cpx22` (small), `cpx32` (medium), and `cpx42` (large).
- `HETZNER_IMAGE`: Hetzner image fallback, default `ubuntu-24.04`.
- `BOXHAVEN_REMOTE_IMAGE_HETZNER`: Hetzner snapshot id for a prebuilt BoxHaven VM image. Machines created from it are treated as backend-bootstrapped.
- `BOXHAVEN_COMMERCIAL_POLICY_URL`: optional external policy service base URL. Unset uses the self-hosted allow-all implementation.
- `BOXHAVEN_COMMERCIAL_POLICY_TOKEN`: shared bearer credential for the external policy service; must be set with the URL.
- `BOXHAVEN_COMMERCIAL_POLICY_TIMEOUT_MS`: create-decision timeout, default `5000`.
- `BOXHAVEN_ACCOUNT_LABEL`: optional generic console action label such as `Account` or `Plan`; empty hides it.
- `RESEND_API_KEY`: Resend API key; setting it enables password reset and team invitation emails.
- `BOXHAVEN_EMAIL_FROM`: From address for transactional email, default `BoxHaven <noreply@boxhaven.dev>`.
- `BOXHAVEN_RESEND_API_URL`: Resend API base URL override for tests.

Team images are optional per-box overrides. When `POST /v1/machines` includes
`image`, the image must belong to the target team; otherwise the backend uses
the provider's configured `BOXHAVEN_REMOTE_IMAGE*` default.

Normal user VMs do not receive reusable DigitalOcean account SSH keys. The
backend uses a one-time no-login key during DigitalOcean create only to prevent
provider password emails, then deletes the account key. SSH access still goes
through short-lived backend-signed certificates and VM trust of the matching
user CA.

Use `npm run deploy:runtime` to build, activate, and verify a DigitalOcean
golden snapshot after changing the VM runtime or image-builder code. The normal
runtime release flow is: commit the runtime change, run the runtime deploy from
that commit or a pushed tag, smoke create a temporary remote, then keep the
previous snapshot id available for rollback until the smoke passes. Runtime
deploys build from the active `BOXHAVEN_REMOTE_IMAGE` snapshot by default; pass
`-- --full-base-image` only when changing base OS or heavyweight toolchain
dependencies.

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
- `POST /v1/account-link`
- `GET /v1/providers`
- `GET /v1/preview/tls-check`
- `GET /v1/preview/proxy/:hostname/*` for HTTP and WebSocket preview traffic
- `POST|PUT|PATCH|DELETE|OPTIONS /v1/preview/proxy/:hostname/*`
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
- `POST /v1/machines/:name/move`
- `DELETE /v1/machines/:name`

`GET /v1/auth/whoami` returns the authenticated user plus the session's teams:
`team` is the session's active team (`{id, name, slug}`, or `null` before the
default team exists) and `teams` lists every team the user belongs to.

The optional commercial policy boundary is vendor-neutral and versioned. With
no policy URL and token, `POST /v1/machines` is allowed normally and lifecycle
facts are no-ops. When configured, the backend calls:

- `POST <policy-url>/contract/v1/entitlements/create` before provisioning.
- `POST <policy-url>/contract/v1/events` after creates, moves, and destroys.
- `POST <policy-url>/contract/v1/account-link` from the authenticated generic
  `POST /v1/account-link` endpoint when `BOXHAVEN_ACCOUNT_LABEL` is set.

All contract bodies contain `version: 1` and calls use the configured bearer
token. A missing or invalid create decision returns `503 entitlement_unavailable`
without provisioning. A denied decision returns `403 entitlement_denied`.
Existing box list, connect, run, sync, move, and destroy operations do not wait
for the policy service; lifecycle delivery failures are logged. See
[`docs/operator-policy.md`](../docs/operator-policy.md) for the payload contract.

Transactional email (enabled by setting `RESEND_API_KEY`) sends password
reset links and team invitation links (`<app_url>/invite?id=<invitation-id>`)
through Resend from `BOXHAVEN_EMAIL_FROM`. Without it, both hooks log to the
backend console instead, and invitation links remain copyable from the team
console.

Image management routes:

- `GET /v1/images` — list images owned by the caller's active team, optionally filtered with `?provider=<name>`.
- `POST /v1/images` — snapshot one of the caller's machines in the active team; the backend prefixes the image name with `boxhaven-remote-`.
- `DELETE /v1/images/:id?provider=<name>` — delete an image owned by the active team; returns `409` while the provider image id is not known yet.

Team routes (Better Auth organization plugin, mounted under `/v1/auth`):

- `POST /v1/auth/organization/create`
- `GET /v1/auth/organization/list`
- `GET /v1/auth/organization/list-members`
- `POST /v1/auth/organization/invite-member`
- `GET /v1/auth/organization/list-invitations`
- `GET /v1/auth/organization/get-invitation`
- `POST /v1/auth/organization/accept-invitation`
- `POST /v1/auth/organization/cancel-invitation`
- `POST /v1/auth/organization/remove-member`
- `POST /v1/auth/organization/update-member-role`
- `POST /v1/auth/organization/set-active`
- `POST /v1/auth/organization/leave`

Roles are `owner`, `admin`, and `member`. Invite links take the form
`<app_url>/invite?id=<invitation-id>` and are accepted by the signed-in user
whose email matches the invitation. When `RESEND_API_KEY` is set the backend
emails that link to the invitee; otherwise the link is shared manually from
the console.

Each session has an active team. `POST /v1/auth/organization/set-active`
switches it for that session only — CLI login sessions and browser sessions
are independent — and accepting an invitation also switches that session's
active team to the joined team.

Org-scoped machine routes:

- `GET /v1/orgs/:orgID/machines` — list the boxes that belong to that team with owner email/name plus the caller's role; available to any member. Boxes a member owns in other teams are not included.
- `DELETE /v1/orgs/:orgID/machines/:userID/:name` — destroy a team box; owners and admins only (`403` for members), and `404` when the box does not belong to that team.

Preview requests arrive at Caddy over HTTPS for
`*.BOXHAVEN_PREVIEW_BASE_DOMAIN`, are rewritten through the backend preview
proxy, and then are fetched from the machine over plain HTTP on
`BOXHAVEN_PREVIEW_TARGET_PORT`. The VM runtime exposes this configuration to
agent sessions through `BOXHAVEN_PREVIEW_URL`, `BOXHAVEN_PREVIEW_HOSTNAME`,
`BOXHAVEN_PREVIEW_TARGET_PORT`, `BOXHAVEN_WEB_PORT`, `BOXHAVEN_WEB_BIND`, and
`/run/boxhaven/context.json`. The remote image also installs a Codex skill named
`boxhaven-web-preview` that describes how web apps should bind and report their
public URL.

Machines are owned by the authenticated Better Auth user, belong to exactly one
team, and are one-to-one with a remote VM. Every account automatically gets a
default team on its first authenticated request, and machine JSON carries
`org_id` plus `team_id`, `team_slug`, and `team_name` decorations on list
items, single-machine and connect responses, the create response, and the move
response. `POST /v1/machines` accepts an optional `team` (slug, id, or name of
a team the caller belongs to; `400` otherwise) and defaults to the session's
active team. `POST /v1/machines/:name/move` with `{ "team": ... }` moves the
caller's box to another of their teams and returns the updated machine.
The backend imports provider-owned machines when listing, so the UI
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
Project sync excludes common dependency/cache directories by default and reads
additional rsync-style exclude patterns from `.boxhavenignore`. Sync completion
reports elapsed time, network bytes, changed bytes, and file counts.

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
