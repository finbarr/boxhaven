# AGENTS.md

This file is the working agreement for changes in this repository.

## Workflow

1. Make the requested code or docs change directly.
2. Verify it thoroughly.
3. Commit the change before finishing.

When behavior, commands, defaults, docs, backend contracts, deployment scripts,
or VM runtime behavior change, update the matching user-facing surfaces:

- [README.md](README.md)
- [backend/README.md](backend/README.md)
- [deploy/digitalocean/README.md](deploy/digitalocean/README.md)
- the CLI in [cmd/bh](cmd/bh)

Do not stop at unit tests when behavior can be exercised for real. If full
end-to-end verification is blocked by the environment, state exactly what was
run, what was not run, and why.

## Build Commands

```bash
make build          # Build the bh binary
make test           # Run Go and backend tests
make lint           # Run go vet and golangci-lint when available
make backend-build  # Build the TypeScript backend and web app
make install        # Install bh to ~/.local/bin
make clean          # Remove built binary
```

## Verification Standard

For non-trivial CLI changes, start here:

```bash
make clean && make build && make test
make lint
./bh version
./bh help
./bh config
```

For backend changes, also run:

```bash
npm --prefix backend run build
npm --prefix backend test
```

For remote VM, SSH, sync, snapshot, or agent changes, unit tests are not enough.
Run a production or production-equivalent smoke before calling the change done:
create a machine from the active snapshot, sync a project, run a command over
direct SSH, restart the backend, run another command after the agent reconnect
window, then destroy the machine and verify provider cleanup.

## Code Map

- `cmd/bh`: lightweight CLI for `bh create`, `bh list`, `bh destroy`,
  `bh connect`, `bh run`, auth, sync, and config.
- `backend`: Fastify/Better Auth control plane and browser console.
- `deploy/digitalocean`: production and image-builder deployment scripts.

## Hard Learnings

- Remote backend auth should use Better Auth for users, passwords, and sessions.
  Do not hand-roll auth flows.
- CLI control-plane HTTP calls should stay on HTTP/1.x unless the production
  proxy path is proven safe for slow provisioning requests.
- Direct SSH must use backend-signed short-lived user certificates and
  persistent host-key pinning, not reusable private keys or blanket host-key
  suppression.
- The CLI should stay thin. Setup commands, command wrapping, and tmux lifecycle
  belong behind backend/VM-agent RPC endpoints.
- Remote project storage is `/opt/boxhaven/project`; sync copies bytes there,
  and command/session RPC runs from there.
- Remote VM runtime dependencies belong in the golden image. If expected tools
  are missing on a user-created VM, fail loudly and rebuild the image.
- Golden remote VM snapshots must be built from committed source or a pushed
  release ref. Before snapshotting, clean cloud-init state, machine identity,
  authorized keys, and SSH host keys.
- User VMs must not receive account-level cloud SSH keys. Use backend-issued
  short-lived SSH certificates for user access.
- VM agents must reconnect on WebSocket `error` as well as `close`, and should
  watchdog backend `pong`s.
