# E2B, Daytona, and Blaxel

These adapters plug into the existing backend. Boxes, team roles, stable resource
links, SSH certificates, file transfer, persistent sessions, and private previews
use the same control plane. Desktop and CLI traffic goes through the backend.
Provider account credentials never go to desktop clients or into machine records.

Each backend currently configures one account per provider. Separate provider
accounts per team, snapshot management, and manual pause controls are not included.

## Prepare the runtime

Build dependencies into an image once. The adapter only writes the individual
box's agent credentials, SSH trust, and service configuration at creation time.
It runs a small supervisor because sandbox providers do not all use systemd.
The SSH bridge listens on 9898 and forwards to certificate-only SSH on loopback
port 2222. Web previews use 8081; applications should use `$HOST` and `$PORT`.

Use committed source for image builds. Keep credentials, SSH host keys, machine
identity, and project files out of images. Publish and deploy only after reviewing
and authorizing the release separately.

### E2B

From `backend`, with an E2B project key in the environment:

```bash
export BOXHAVEN_RUNTIME_REF=<full-published-commit-sha>
node scripts/build-e2b-template.mjs
```

The script prints `BOXHAVEN_REMOTE_IMAGE_E2B=<template-id>` when the build
succeeds. Set that value and `E2B_API_KEY` on the backend. CPU and memory are
fixed by the template: the build defaults to 2 CPU and 4096 MiB. If you change
`BOXHAVEN_E2B_TEMPLATE_CPU` or `BOXHAVEN_E2B_TEMPLATE_MEMORY_MB`, use the same
values on the backend. Optional `BOXHAVEN_E2B_TEMPLATE_DISK_GB` reports the
template's disk capacity; leaving it unset shows provider-managed storage.

E2B's image preparation requires its own Ubuntu/systemd setup, so this recipe
starts from Ubuntu rather than the exe.dev image. BoxHaven extends the running
lease every 15 minutes from agent heartbeats. If the backend remains unavailable
past the one-hour lease, E2B pauses with memory preserved. An authenticated
runtime operation resumes it and waits for the agent to reconnect.

### Daytona

Set `DAYTONA_API_KEY`, `DAYTONA_TARGET` if you need a specific region, and
`BOXHAVEN_REMOTE_IMAGE_DAYTONA` to a prepared OCI image. The published
`ghcr.io/finbarr/boxhaven-exedev:v0.5.1` contains the runtime dependencies; the
adapter starts its services without relying on that image's systemd entrypoint.

The adapter offers 2 CPU / 4 GiB and 4 CPU / 8 GiB, each with a 10 GiB disk.
Account quotas may restrict those plans. Automatic stop, pause, and deletion are
disabled so detached sessions can continue. Preview tokens remain on the backend.

Daytona must permit outbound HTTPS/WebSocket access to your backend domain.
Tier 1 and Tier 2 apply an organization firewall that sandbox settings cannot
override. Ask Daytona support to allow your backend domain, or use an account
with suitable network access. The adapter checks connectivity during setup and
reports this requirement if it cannot connect; destroy the recovery box before
retrying. See [Daytona network limits](https://www.daytona.io/docs/en/network-limits/).

### Blaxel

Log in with the official `bl` CLI, then run from the repository root:

```bash
bash deploy/sandboxes/build-blaxel.sh --workspace YOUR_WORKSPACE
```

This builds a private image without creating a sandbox. The script packages only
the Dockerfile and `blaxel.toml` from an isolated directory. The Dockerfile pins
the BoxHaven source revision and Blaxel sandbox API binary. It uses a smaller
Ubuntu base because the exe.dev image exceeds Blaxel's image builder disk limit.

Set `BL_API_KEY`, `BL_WORKSPACE`, and `BOXHAVEN_REMOTE_IMAGE_BLAXEL` to the
resulting image ID; optionally set `BL_REGION`. The adapter uses Blaxel's returned
regional runtime endpoint. Both declared ports have private previews. The runtime
uses `keepAlive: true` and `timeout: 0` so unattended agent work keeps running.
The adapter requests no automatic deletion, but Blaxel enforces maximum lifetimes
on lower account tiers: seven days on Tier 0 and 30 days on Tier 1. Boxes and
`bh status` show the returned expiry. Save your work before that date. See
[Blaxel expiration policies](https://docs.blaxel.ai/Sandboxes/Expiration).

Blaxel assigns CPU from memory, and writable storage uses memory. The adapter
offers 4096, 8192, and 16384 MiB; provision capacity appropriate to your workload.
Provider previews have a 15-minute connection limit. Reconnect to attach to the
same persistent session. Destroy unused boxes to stop compute charges.

## Use the adapters

```bash
bh create work --provider e2b
bh run work codex
# Disconnect: Ctrl-b, then d.
bh connect work
bh preview work
bh destroy work
```

Use `--provider daytona` or `--provider blaxel` for the same workflow, or choose
the provider under **Boxes → New box**. A provider is available when its required
credentials and prepared runtime are configured. Prices are left unspecified;
consult the provider's account usage and billing.

## Real integration verification

Build `bh`, install the official `cloudflared` CLI (or set `CLOUDFLARED` to its
path), and configure the provider credentials and image in your environment.
From `backend`:

```bash
BOXHAVEN_SMOKE_PROVIDER=e2b node --import tsx scripts/smoke-sandbox.mjs
BOXHAVEN_SMOKE_PROVIDER=daytona node --import tsx scripts/smoke-sandbox.mjs
BOXHAVEN_SMOKE_PROVIDER=blaxel node --import tsx scripts/smoke-sandbox.mjs
```

Each run creates an isolated local backend and one disposable provider sandbox.
The tunnel exposes only authenticated agent callbacks and scoped SSH relay
upgrades. It checks signed SSH, host pinning, a 2 MiB round-trip file transfer,
detached work, backend restart and reconnect, E2B memory pause/resume, grant
expiry, private HTTP and WebSocket previews,
browser preview login, anonymous rejection, membership revocation, and deletion.
Screenshots go to `backend/.artifacts/<provider>-relay/`. Failed runs retain
local diagnostics with mode 0600 and report any cleanup that needs attention.
An ambiguous create is reconciled by exact team ownership metadata before deletion.

For a Daytona account with blocked backend access, verify the setup error and
recovery cleanup separately:

```bash
BOXHAVEN_SMOKE_PROVIDER=daytona node --import tsx scripts/smoke-sandbox.mjs --expect-backend-network-blocked
```

This check does not run the relay, session, or preview tests. Run the full smoke
after Daytona permits outbound access to the backend.

## Validation status (October 3, 2026)

- E2B and Blaxel passed the full live smoke, including backend restart, private
  previews, access revocation, and confirmed deletion. E2B also passed memory
  pause/resume with the existing session and pinned SSH host identity intact.
- Daytona created a real sandbox from the prepared image, installed the per-box
  configuration, and started the runtime. The test account's Tier 1 network
  policy blocked the backend domain. Its full relay/session/preview smoke still
  requires backend egress permission. Failed test sandboxes were deleted.
