# BoxHaven Desktop

A desktop window for your remote BoxHaven machines. Select a box in the left
sidebar to attach to its persistent `boxhaven` tmux session on the right.
Switching boxes preserves each open terminal. Closing the app disconnects local
SSH clients; it does not stop remote tmux sessions or destroy boxes.

## Run on macOS

Requires Node.js 22.12 or later, npm, Go 1.23 or later, Xcode Command Line Tools,
and the system OpenSSH client. Native dependencies are rebuilt for Electron
during installation. This first desktop build is verified on macOS Apple Silicon.

From the repository root:

```sh
npm --prefix desktop ci
npm run desktop
```

The app bundles `bh` from this checkout. It uses the CLI's global configuration
and login (`~/.config/boxhaven/config.toml`, or `XDG_CONFIG_HOME`) and honors
`BOXHAVEN_BACKEND_URL` / `BOXHAVEN_TOKEN` when launched from an environment that
sets them. Commands run from your home directory, not a project checkout; project
`.boxhaven.toml` files are not selected by the app. Configure a self-hosted backend
with `bh login --backend-url https://api.example.com`, or use Connection settings
inside the app. First-time in-app login requires a backend URL.

Click **New box** in the sidebar, enter a name, and click **Create box**. The app
uses your configured provider and the backend's default size and region. New
boxes start empty: no local project directory is synced. When provisioning
finishes, the app selects the box and opens its terminal automatically. Clone a
repository and start your agent directly in that terminal.

You can close the creation dialog and keep working in another box. Progress and
errors remain accessible in the sidebar. Closing/reopening the window preserves
an in-progress creation; quitting waits for the creation request to finish.
Existing names are rejected rather than reused. If creation fails, refresh the
list before trying another name: the provider may already have allocated a box.
Project sync and deletion remain available through the CLI.

Select any existing box in the desktop sidebar to reattach. For an unused box,
`bh connect` starts its managed shell session. The app invokes exactly the same
command, including the CLI's existing credential-forwarding behavior, short-lived
SSH certificates, and host-key pinning.

The sidebar refreshes every 15 seconds. Its status is machine liveness from
`bh list --json`, not an inference about whether an agent is working or waiting
for approval. The terminal header describes the local terminal connection.

## Package

```sh
npm run desktop:package
open desktop/release/BoxHaven-darwin-arm64/BoxHaven.app
```

Output is `desktop/release/BoxHaven-<platform>-<arch>/`. The happy-box artwork is
reused from the console and converted into the macOS app icon during the build.
This is a local development build, not a signed/notarized public installer.
Packaging runs on the target platform/architecture so the CLI and native PTY
module match Electron. Public distribution/signing and Windows/Linux validation
are not part of this initial build.

## Verification

```sh
npm --prefix desktop test
npm --prefix desktop run smoke
npm --prefix desktop run smoke:remote
```

After packaging, `node desktop/scripts/smoke-remote.mjs --packaged` runs the
same remote checks against the actual macOS `.app` bundle. After building the
docs, `node desktop/scripts/smoke-docs.mjs` verifies and screenshots the desktop
guide in headless Chrome at desktop and mobile widths.

The first smoke launches real Electron and a real native PTY with a test CLI.
It checks switching, input/output, reconnection, resizing, delayed readiness,
refresh failures, empty states, settings, creation and automatic connection,
duplicate names, provider errors, and window reopening during creation.
Screenshots go to `.artifacts/`.
The fixture is only a test entry point and is excluded from packaged builds.

The remote smoke uses your configured backend and login, provisions one billable
temporary box through the app's **New box** dialog (using `--no-sync`), verifies
automatic connection, real SSH/tmux input and persistent shell
state across app restarts, then destroys that exact box and checks its absence.
It does not sync your checkout or run a model. Standard `bh connect` credential
forwarding still applies.

## Implementation

- Electron main process runs the bundled CLI and owns PTYs.
- A sandboxed, context-isolated renderer receives only box display records and
  terminal events through narrow, sender-validated IPC methods.
- xterm.js renders the terminal; output acknowledgements bound queued PTY output.
- No renderer network access, arbitrary process execution API, remote pages,
  backend changes, or additional credential store.
