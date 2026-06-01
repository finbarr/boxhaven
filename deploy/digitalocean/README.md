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
$EDITOR deploy/digitalocean/.env.production
make validate-production-env
make validate-production-compose
```

`BETTER_AUTH_SECRET` must be a long random value. The backend also needs
`DIGITALOCEAN_ACCESS_TOKEN` so it can create remote VMs for users. Normal user
VMs do not receive reusable DigitalOcean account SSH keys; the backend uses a
one-time no-login key during create only to prevent provider password emails,
then deletes the account key. Cloud-init configures VMs to trust short-lived
boxhaven SSH certificates instead. The backend SSH user CA is stored at
`/opt/boxhaven/data/backend/ssh_ca_ed25519` and is included in the backend data
backups.

Production Compose requires signup and quota guardrails. Keep
`BOXHAVEN_SIGNUP_MODE=invite` and set `BOXHAVEN_SIGNUP_INVITE_CODES` before
deploying, or set `BOXHAVEN_SIGNUP_MODE=disabled` after the initial accounts are
created. Review `BOXHAVEN_MAX_MACHINES_PER_USER`,
`BOXHAVEN_MAX_MACHINES_TOTAL`, `BOXHAVEN_IDLE_MACHINE_TTL_HOURS`, and
`BOXHAVEN_STALE_CREATE_TTL_SECONDS` against the account's expected budget.
Leave `BOXHAVEN_BACKEND_TRUST_PROXY=1` for the Caddy deployment so auth and
machine-create rate limits use the real client IP from forwarded headers.

Set `BOXHAVEN_PREVIEW_BASE_DOMAIN` to the wildcard domain above. The default
preview target is port `80` on each remote machine; change
`BOXHAVEN_PREVIEW_TARGET_PORT` if the machine runtime should receive preview
traffic somewhere else. `BOXHAVEN_PREVIEW_PROXY_TIMEOUT_SECONDS` bounds preview
upstream requests, and Caddy checks every on-demand preview certificate hostname
with the backend before issuance.

## Deploy

From the repository root on the Droplet:

```bash
docker compose --env-file deploy/digitalocean/.env.production \
  -f deploy/digitalocean/docker-compose.yml up -d --build
```

Install and start the backup timer:

```bash
sudo deploy/digitalocean/install-backups.sh
```

The installer deploys both the backup command and the restore verifier. Each
backup run verifies the new archive before old archives are pruned.

## Build the Remote VM Image

New remote machines should come from a prebuilt BoxHaven snapshot instead of a
plain Ubuntu image. The image builder creates a temporary Droplet, installs the
remote VM runtime, cleans cloud-init and SSH host identity, powers it off,
snapshots it, deletes the builder Droplet, and prints the snapshot id.
Production env and Compose validation require `BOXHAVEN_REMOTE_IMAGE` to be set
to the active snapshot id or `boxhaven-remote-*` image name before deploy.

The snapshot contains the GitHub HTTPS credential helper and machine-agent
runtime that sources `/run/boxhaven/session.env` for setup commands, direct
commands, and tmux sessions. Rebuild and activate a new snapshot after changing
`cmd/bh/assets/remote-vm-install.sh`; otherwise newly created boxes will keep
the previous runtime behavior.

From a clean, committed checkout:

```bash
deploy/digitalocean/build-remote-image.sh \
  --env-file deploy/digitalocean/.env.production \
  --set-active
```

The builder Droplet still needs an SSH key for the temporary image build. Use
`DIGITALOCEAN_SSH_KEYS` only when the matching private key is available to the
host running the script. Otherwise set `BOXHAVEN_IMAGE_BUILDER_SSH_PUBLIC_KEY`
and pass the matching private key with `--ssh-key`. If the builder script
registers a missing key itself, it deletes that temporary account key during
cleanup unless `--keep-builder` is set. Quote
`BOXHAVEN_IMAGE_BUILDER_SSH_PUBLIC_KEY` in `.env.production` because OpenSSH
public keys contain spaces.

`--set-active` writes `BOXHAVEN_REMOTE_IMAGE=<snapshot-id>` plus metadata back to
the env file. Restart the backend after that so future creates use the snapshot:

```bash
docker compose --env-file deploy/digitalocean/.env.production \
  -f deploy/digitalocean/docker-compose.yml up -d --build --force-recreate backend
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
make production-check
docker compose --env-file deploy/digitalocean/.env.production \
  -f deploy/digitalocean/docker-compose.yml ps
make smoke-production-http
sudo systemctl status boxhaven-backend-backup.timer --no-pager
sudo systemctl start boxhaven-backend-backup.service
ls -lh /opt/boxhaven/backups
scripts/verify-backend-backup-restore.sh /opt/boxhaven/backups/<archive>.tar.gz
make ensure-uptime
BOXHAVEN_ALERT_EMAILS=<ops-email> make ensure-alerts
BOXHAVEN_TRUSTED_SSH_CIDRS=<trusted-cidrs> make ensure-firewalls
BOXHAVEN_REMOTE_IMAGE=<active-snapshot-id> make audit-digitalocean
BOXHAVEN_DO_ACCOUNT_EXPECTED_DROPLETS=<expected-droplet-names> \
  BOXHAVEN_DO_ACCOUNT_EXPECTED_PROJECTS=<expected-project-names> \
  BOXHAVEN_DO_ACCOUNT_DROPLET_PROJECTS=<droplet=project-pairs> \
  BOXHAVEN_DO_ACCOUNT_REQUIRE_DEFAULT_PROJECT_EMPTY=1 \
  BOXHAVEN_DO_ACCOUNT_REQUIRE_FIREWALL_COVERAGE=1 \
  BOXHAVEN_DO_ACCOUNT_MAX_MONTH_TO_DATE_USAGE=<budget-dollars> \
  BOXHAVEN_DO_ACCOUNT_CLEANUP_DROPLETS=web \
  BOXHAVEN_DO_ACCOUNT_CLEANUP_SNAPSHOT_IDS=160948396,160956820 \
  make audit-digitalocean-account
BOXHAVEN_BACKUP_STORAGE_TARGETS=boxhaven=/opt/boxhaven/backups make audit-backup-storage
BOXHAVEN_REMOTE_IMAGE=<active-snapshot-id> make prune-snapshots
BOXHAVEN_REMOTE_IMAGE=<active-snapshot-id> BOXHAVEN_DO_SNAPSHOT_PRUNE_IDS=160948396,160956820 make prune-snapshots
BOXHAVEN_REMOTE_IMAGE=<active-snapshot-id> BOXHAVEN_DO_SNAPSHOT_PRUNE_APPLY=1 make prune-snapshots
```

`make audit-digitalocean` also requires `BOXHAVEN_REMOTE_IMAGE` so the read-only
audit proves the deployed backend is pointing at an existing active snapshot.
`make audit-digitalocean-account` is a separate read-only account cleanup audit
for known legacy Droplets and old manual snapshots.
`make audit-backup-storage` is a read-only audit for backup directory size and
top-level file count.

After changing the CLI remote path, VM runtime, SSH certificate flow, sync, or
agent reconnect behavior, run the reusable lifecycle smoke from a machine with a
valid BoxHaven session token:

```bash
BOXHAVEN_TOKEN=... \
GH_TOKEN=... \
BOXHAVEN_SMOKE_GIT_REMOTE=https://github.com/<org>/<smoke-repo>.git \
BOXHAVEN_SMOKE_PRODUCTION=1 \
BOXHAVEN_SMOKE_RESTART_BACKEND_CMD="ssh root@<control-plane-ip> 'cd /opt/boxhaven/app && docker compose --env-file deploy/digitalocean/.env.production -f deploy/digitalocean/docker-compose.yml restart backend'" \
make smoke-remote
```

For reconnect coverage, pass a backend restart command:

```bash
BOXHAVEN_SMOKE_RESTART_BACKEND_CMD="ssh root@<control-plane-ip> 'cd /opt/boxhaven/app && docker compose --env-file deploy/digitalocean/.env.production -f deploy/digitalocean/docker-compose.yml restart backend'" \
make smoke-remote
```
