# exe.dev connector

The backend adapter implements create, inventory, destruction, and VM-scoped
access. The CLI and desktop reuse the direct WebSocket SSH transport. The backend
retains lifecycle state, teams, and authorization; terminal and file bytes go
straight to exe.dev. No public IPv4 address is needed.

**Validation status:** lifecycle fixtures, real OpenSSH/TLS transport tests, and
the built OCI image's runtime/tool/identity checks pass locally. Live exe.dev
creation, prepared-image boot, authenticated agent callback, and deletion are
verified. Hosted authenticated WebSockets still require live validation before
a release. E2B, Daytona, Blaxel, and Boat
adapters remain separate work in [the proposal](../../SANDBOX-CONNECTORS.md).

## Backend credentials

Create a dedicated unencrypted Ed25519 signing key, register its public key with
your exe.dev account, and make the private key readable only by the backend user.
Scope the registered key to the `boxhaven` tag; the adapter applies that tag to
every VM it creates. This keeps access separate from your other exe.dev VMs.
Follow [exe.dev's local signing instructions](https://exe.dev/docs/https-api-local-key).
Never register BoxHaven's SSH user CA as the provider signing key.

Configure:

- `EXE_DEV_SIGNING_KEY`: absolute path to that private key **inside the backend**.
- `BOXHAVEN_REMOTE_IMAGE_EXEDEV`: your published prepared OCI image, preferably
  pinned by digest.
- `EXE_DEV_REGISTRY_AUTH`: optional `USERNAME:PASSWORD` for the image registry.
  Use a pull-only registry credential. It is sent to exe.dev during creation,
  and is excluded from machine metadata and error messages.
- `BOXHAVEN_BACKEND_PROVIDER=exedev` if it should be the default.

In the supplied Compose deployment, put the key in the already mounted private
backend data directory, use its `/data/...` path, and give it to the container's
`node` user with mode 0600. Include this key in encrypted operator backups.
The key stays on the backend. Each attachment receives an expiring VM token plus
a signed runtime grant and an SSH user certificate. Token minting happens locally,
without registering a new provider key or opening a backend data relay.

The first version uses one operator-configured exe.dev account. Team-specific
provider connections and credential-vault UI are not implemented yet.

Creation uses exe.dev's native SSH control interface because pulling a cold image
can exceed the HTTPS command API's 30-second limit. The backend needs outbound
TCP port 22 to `exe.dev`; its SSH host fingerprint is pinned to
[exe.dev's published key](https://exe.dev/docs/faq/host-key). Setup is sent over
the channel's stdin, and registry credentials stay out of OS process arguments.
Inventory, deletion, and preview-port configuration use the HTTPS command API.
A provisioning timeout preserves an unknown outcome for explicit reconciliation;
the adapter does not automatically retry creation.
The CLI allows 25 minutes for provisioning and guest readiness; the desktop's
creation process allows 30 minutes including local synchronization. A warm image
usually needs much less time. Closing the client does not cancel provider work;
inspect the resource before attempting another creation.

## Build the image

Use a clean committed checkout and an exeuntu base image pinned by digest:

```bash
EXEUNTU_IMAGE='ghcr.io/boldsoftware/exeuntu@sha256:your-verified-digest' \
BOXHAVEN_EXEDEV_IMAGE_TAG='your-registry/boxhaven-exedev:your-version' \
bash deploy/exedev/build-image.sh
```

Replace the image values with real registry references. Publish the resulting
image, then configure its immutable digest on the backend. The Docker build
context excludes credentials and unrelated repository files.

Before publishing, verify the actual local artifact:

```bash
bash deploy/exedev/verify-image.sh your-registry/boxhaven-exedev:your-version
```

This checks the installed runtime and tools, clean machine identity, and the
certificate-only SSH listener in a disposable container with networking disabled.

The image bakes agent tools, the BoxHaven runtime, tmux, and the authenticated
bridge. First boot only configures credentials, per-VM SSH host keys, certificate
trust, and services. BoxHaven's SSH listener binds to loopback port 2222; the bridge
listens on 9898, avoiding exeuntu's Shelley port 9999. exe.dev's gateway login remains separate. No user/account keys or
agent credentials are embedded in the image.

## Use and verify

After configuring a backend and logging in:

```bash
bh create work --provider exedev
bh run work codex
# Disconnect: Ctrl-b, then d.
bh connect work
```

Sizes are `small` (2 CPU/4 GB), `medium` (4 CPU/8 GB), and `large` (8 CPU/16 GB),
with 20 GB disks. Capacity and charges follow the exe.dev account; no fabricated
hourly price is shown. The account's default region applies. A per-machine
`--region` request is rejected without changing account settings.

Previews keep exe.dev's private URL and open its normal login flow. BoxHaven never
makes them public. Automatic desktop preview grants and snapshot/pause support
are not implemented. SSH attachments expire with their grant (15 minutes by
default); use `bh connect` to reattach. The remote tmux workload keeps running.

For local protocol checks:

```bash
make build
node backend/scripts/smoke-ssh-transport.mjs
```

For live validation against a backend configured with exe.dev, run
`bash deploy/exedev/smoke.sh`. It creates and destroys one uniquely named VM,
checks agent readiness, direct execution, file transfer, and detached session
persistence. Failed cleanup reports the exact VM name for explicit recovery.
This does not test desktop private-preview delegation or the OCI build itself.

For development, the isolated provider smoke needs no production backend or
published image. Build `bh`, verify the image, install the official `cloudflared`
binary, and run:

```bash
cd backend
EXE_DEV_SIGNING_KEY=/absolute/path/to/registered-key \
BOXHAVEN_EXEDEV_LOCAL_IMAGE=boxhaven-exedev:local-test \
node --import tsx scripts/smoke-exedev.mjs
```

It starts an isolated local backend and temporary Docker registry, then uses a
Cloudflare Quick Tunnel for authenticated image reads and agent callbacks. The
account and control APIs remain local. It creates one exe.dev VM, tests the shared
resource API, direct SSH/files, detached work, host pinning, private previews, and
active WebSocket expiry, then destroys the VM and local registry. Creating the
first VM can start an exe.dev trial; account capacity and billing rules apply.
`CLOUDFLARED` can specify the executable's absolute path. A failed cloud cleanup
reports the VM name and retains local recovery state.
