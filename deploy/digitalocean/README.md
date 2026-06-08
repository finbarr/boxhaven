# DigitalOcean deployment

This bundle runs the BoxHaven console and API on a single DigitalOcean
Droplet. Caddy terminates TLS for `app.boxhaven.dev`, `api.boxhaven.dev`, and
generated preview hostnames under `at.boxhaven.dev`, then proxies those
hostnames to the backend container. Backend state is stored on the host under
`/opt/boxhaven/data/backend` so it can be backed up outside Docker.

## Provision

Create an Ubuntu 24.04 Droplet with `cloud-init.yml`. Enable DigitalOcean
Droplet backups for machine-level restore coverage.

Required DNS records:

```text
app.boxhaven.dev.  A  <droplet-ip>
api.boxhaven.dev.  A  <droplet-ip>
*.at.boxhaven.dev.  A  <droplet-ip>
```

## Configure

Copy `env.production.example` to `.env.production` on the server and fill in the
secret values:

```bash
cp deploy/digitalocean/env.production.example deploy/digitalocean/.env.production
```

`BETTER_AUTH_SECRET` must be a long random value. The backend also needs
`DIGITALOCEAN_ACCESS_TOKEN` so it can create remote VMs for users. Normal user
VMs do not receive reusable DigitalOcean account SSH keys; the backend uses a
one-time no-login key during create only to prevent provider password emails,
then deletes the account key. Cloud-init configures VMs to trust short-lived
boxhaven SSH certificates instead. The backend SSH user CA is stored at
`/opt/boxhaven/data/backend/ssh_ca_ed25519` and is included in the backend data
backups.
Set `BOXHAVEN_PREVIEW_BASE_DOMAIN` to the wildcard domain above. The default
preview target is port `80` on each remote machine; change
`BOXHAVEN_PREVIEW_TARGET_PORT` if the machine runtime should receive preview
traffic somewhere else.

Remote apps do not need to manage public TLS for the preview URL. Caddy
terminates HTTPS on the control-plane Droplet, the backend maps the preview
hostname back to the owning machine, and the backend fetches
`http://<machine-public-ip>:BOXHAVEN_PREVIEW_TARGET_PORT`. Inside the box,
agents and shells can read the public URL and target-port details from
`BOXHAVEN_PREVIEW_URL`, `BOXHAVEN_WEB_PORT`, `BOXHAVEN_WEB_BIND`, and
`/run/boxhaven/context.json`.

## Deploy

From the repository root on your workstation:

```bash
npm run deploy:app
```

`npm run deploy:production` is kept as a compatibility alias for the same fast
app/API deploy. These commands SSH to `root@app.boxhaven.dev`, fast-forward
`/opt/boxhaven/app` on `master`, run the Docker Compose deploy on the Droplet,
and check `https://api.boxhaven.dev/healthz` plus
`https://app.boxhaven.dev/healthz`. They do not rebuild the remote VM image.

After changing the VM runtime or image-builder code, explicitly rebuild and
activate the remote VM image:

```bash
npm run deploy:runtime
```

The runtime deploy creates a temporary builder Droplet, snapshots it, updates
`BOXHAVEN_REMOTE_IMAGE` in `.env.production`, and restarts/verifies the backend
so future boxes use the new image. By default, it builds from the current active
`BOXHAVEN_REMOTE_IMAGE` snapshot when one exists, so runtime script changes do
not reinstall the full OS/toolchain from Ubuntu.

Both remote deploy commands forward your SSH agent so the Droplet can fetch the
private GitHub repo without storing a GitHub token. For self-hosted installs,
override the SSH target or checkout path:

```bash
BOXHAVEN_DEPLOY_TARGET=root@<control-plane-ip> \
BOXHAVEN_DEPLOY_DIR=/opt/boxhaven/app \
BOXHAVEN_PRODUCTION_API_HEALTH_URL=https://api.example.com/healthz \
BOXHAVEN_PRODUCTION_APP_HEALTH_URL=https://app.example.com/healthz \
npm run deploy:production
```

From the repository root on the Droplet, run the local variant:

```bash
npm run deploy:production:local
```

Run only the production container and health checks with:

```bash
npm run deploy:production:verify
```

Install and start the backup timer:

```bash
sudo deploy/digitalocean/install-backups.sh
```

## Build the Remote VM Image

New remote machines should come from a prebuilt BoxHaven snapshot instead of a
plain Ubuntu image. The image builder creates a temporary Droplet, installs the
remote VM runtime, cleans cloud-init and SSH host identity, powers it off,
snapshots it, deletes the builder Droplet, and prints the snapshot id.

The snapshot contains the GitHub HTTPS credential helper and machine-agent
runtime that sources `/run/boxhaven/session.env` for setup commands, direct
commands, and tmux sessions. Rebuild and activate a new snapshot after changing
`cmd/bh/assets/remote-vm-install.sh`; otherwise newly created boxes will keep
the previous runtime behavior.

When `BOXHAVEN_REMOTE_IMAGE` is already set in the env file, the builder starts
from that active snapshot by default. This keeps dependency-heavy image builds
incremental: changing BoxHaven runtime scripts updates the existing image instead
of reinstalling Node, Docker, Go, Bun, uv, Codex, Claude, gh, and related
packages from Ubuntu. Use `--full-base-image` only when changing base OS or
toolchain dependencies, or when the active snapshot is intentionally being
replaced from scratch.

From a clean, committed checkout:

```bash
npm run deploy:runtime
```

Force a full Ubuntu/base rebuild:

```bash
npm run deploy:runtime -- --full-base-image
```

The builder Droplet still needs an SSH key for the temporary image build. Use
`DIGITALOCEAN_SSH_KEYS` only when the matching private key is available to the
host running the script. Otherwise set `BOXHAVEN_IMAGE_BUILDER_SSH_PUBLIC_KEY`
and pass the matching private key with `--ssh-key`. Quote
`BOXHAVEN_IMAGE_BUILDER_SSH_PUBLIC_KEY` in `.env.production` because OpenSSH
public keys contain spaces.

`--set-active` writes `BOXHAVEN_REMOTE_IMAGE=<snapshot-id>` plus metadata back to
the env file. Restart the backend after that so future creates use the snapshot:

```bash
npm run deploy:production:local
```

For a release-grade image, build from a pushed tag or commit:

```bash
deploy/digitalocean/build-remote-image.sh \
  --env-file deploy/digitalocean/.env.production \
  --ref v0.19.0 \
  --set-active
```

When running the builder on the production Droplet, use SSH agent forwarding if
the matching private key lives on your laptop:

```bash
ssh -A root@<control-plane-ip> \
  'cd /opt/boxhaven/app && deploy/digitalocean/build-remote-image.sh --env-file deploy/digitalocean/.env.production --set-active'
```

Keep at least the previous snapshot id until a production smoke create succeeds.
Rollback is just setting `BOXHAVEN_REMOTE_IMAGE` back to the previous snapshot id
and recreating the backend container.

## Verify

```bash
npm run deploy:production:verify
sudo systemctl status boxhaven-backend-backup.timer --no-pager
sudo systemctl start boxhaven-backend-backup.service
ls -lh /opt/boxhaven/backups
```

After changing the CLI remote path, VM runtime, SSH certificate flow, sync, or
agent reconnect behavior, run the reusable lifecycle smoke from a machine with a
valid BoxHaven session token:

```bash
BOXHAVEN_TOKEN=... \
GH_TOKEN=... \
BOXHAVEN_SMOKE_GIT_REMOTE=https://github.com/<org>/<smoke-repo>.git \
make smoke-remote
```

`make smoke-remote` is the fast one-box smoke. It creates one machine from the
active snapshot, syncs a temporary project, verifies direct SSH/runtime/preview
behavior, and destroys the machine. Use `make smoke-remote-two-box` only when
concurrency, provider import, or multiple-machine behavior needs coverage.

For reconnect coverage, pass a backend restart command:

```bash
BOXHAVEN_SMOKE_RESTART_BACKEND_CMD="ssh root@<control-plane-ip> 'cd /opt/boxhaven/app && docker compose --env-file deploy/digitalocean/.env.production -f deploy/digitalocean/docker-compose.yml restart backend'" \
make smoke-remote-full
```
