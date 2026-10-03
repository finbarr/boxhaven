# exe.dev connector

The backend adapter implements create, inventory, destruction, and VM-scoped
access. The CLI and desktop reuse the direct WebSocket SSH transport. The backend
retains lifecycle state, teams, and authorization; terminal and file bytes go
straight to exe.dev. No public IPv4 address is needed.

**Validation status:** lifecycle fixtures and real OpenSSH/TLS transport tests
pass locally. The OCI build and exe.dev's hosted authenticated WebSocket path
still require live validation before a release. E2B, Daytona, Blaxel, and Boat
adapters remain separate work in [the proposal](../../SANDBOX-CONNECTORS.md).

## Backend credentials

Create a dedicated unencrypted Ed25519 signing key, register its public key with
your exe.dev account, and make the private key readable only by the backend user.
Follow [exe.dev's local signing instructions](https://exe.dev/docs/https-api-local-key).
Never register BoxHaven's SSH user CA as the provider signing key.

Configure:

- `EXE_DEV_SIGNING_KEY`: absolute path to that private key **inside the backend**.
- `BOXHAVEN_REMOTE_IMAGE_EXEDEV`: your published prepared OCI image, preferably
  pinned by digest.
- `BOXHAVEN_BACKEND_PROVIDER=exedev` if it should be the default.

In the supplied Compose deployment, put the key in the already mounted private
backend data directory, use its `/data/...` path, and give it to the container's
`node` user with mode 0600. Include this key in encrypted operator backups.
The key stays on the backend. Each attachment receives an expiring VM token plus
a signed runtime grant and an SSH user certificate. Token minting happens locally,
without registering a new provider key or opening a backend data relay.

The first version uses one operator-configured exe.dev account. Team-specific
provider connections and credential-vault UI are not implemented yet.

## Build the image

Use a clean committed checkout and an exeuntu base image pinned by digest:

```bash
EXEUNTU_IMAGE='your-registry/exeuntu@sha256:your-verified-digest' \
BOXHAVEN_EXEDEV_IMAGE_TAG='your-registry/boxhaven-exedev:your-version' \
bash deploy/exedev/build-image.sh
```

Replace the image values with real registry references. Publish the resulting
image, then configure its immutable digest on the backend. The Docker build
context excludes credentials and unrelated repository files.

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
