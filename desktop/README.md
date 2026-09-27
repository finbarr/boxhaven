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

Click **New box** in the sidebar, enter a name, and choose a provider, region,
and size. Available sizes include hardware details and hourly/monthly estimates
from your backend's catalog for the CLI's active team. Backend billing quotes
take precedence over provider prices; monthly estimates use 730 hours when no
monthly price is supplied. Click **Create box** to provision it. New
boxes start empty: no local project directory is synced. When provisioning
finishes, the app selects the box and opens its terminal automatically. Clone a
repository and start your agent directly in that terminal.

You can close the creation dialog and keep working in another box. Progress and
errors remain accessible in the sidebar. Closing/reopening the window preserves
an in-progress creation; quitting waits for the creation request to finish.
Existing names are rejected rather than reused. If creation fails, refresh the
list before trying another name: the provider may already have allocated a box.
Project sync remains available through the CLI.

Open a box’s sidebar overflow menu and choose **Rename box**. The active terminal stays
connected, and the sidebar and selected box update to the new name.

Use **Open preview** in the selected box's header to open its backend-assigned
web URL in your default browser. The button is disabled when no preview URL is
configured. The box still needs a web server listening on its preview port.

Choose **Destroy box…** from the overflow menu to permanently delete the selected remote VM, its files,
and running sessions. A native confirmation dialog defaults to Cancel. Save work
you need before confirming. The app refreshes the list and closes that terminal
after deletion; other boxes keep running. Closing the window does not cancel an
accepted deletion, and quitting waits for it to finish. **Close local connections** in Connection settings closes
local connections without stopping remote sessions. The current backend has no stop/resume operation that
preserves the VM.

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

Output is `desktop/release/BoxHaven-<platform>-<arch>/`. The original happy-box cabin artwork sits on a white rounded tile with a soft
shadow for the Dock. The app uses light-paper surfaces and compact portraits;
each box keeps its accessory across renames and changes expression with machine
state. Creator initials use backend metadata when available.
This is a local development build, not a signed/notarized public installer.
Packaging runs on the target platform/architecture so the CLI and native PTY
module match Electron. The [release workflow](RELEASING.md) has produced a signed,
Apple-notarized Apple Silicon DMG for version 0.1.0. It remains a draft pending
final installation review. Windows/Linux distribution is not included.

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

For a downloaded release, `node desktop/scripts/smoke-dmg.mjs /path/to/BoxHaven.dmg --remote`
verifies its adjacent `.sha256` file, signatures, notarization tickets, installation
layout, and native terminal, then exercises one disposable remote box using the
app and CLI copied from that DMG. Omit `--remote` for local-only verification.

The first smoke launches real Electron and a real native PTY with a test CLI.
It checks switching, input/output, reconnection, resizing, delayed readiness,
refresh failures, empty states, settings, creation and automatic connection,
provider/region/size selection and pricing, catalog failures and retry, duplicate
names, provider errors, and window reopening during creation. Renaming checks
duplicate names, stale targets, failures, and input through the existing PTY.
It also checks preview URL validation/opening, missing previews, deletion
confirmation and cancellation, provider failures, and stale deletion targets.
Native browser opening and confirmation responses are intercepted at the OS
boundary in the fixture test; the packaged remote smoke opens a real browser.
Screenshots go to `.artifacts/`.
The fixture is only a test entry point and is excluded from packaged builds.

The remote smoke uses your configured backend and login, provisions one billable
temporary box through the app's **New box** dialog (using `--no-sync`), verifies
creation settings, rename with the terminal still connected, real SSH/tmux input and persistent shell
state across app restarts, opens its live preview, then destroys that exact box
through the app and checks its absence. The remote test supplies the native
confirmation response for its own disposable box; failure cleanup uses the CLI.
It does not sync your checkout or run a model. Standard `bh connect` credential
forwarding still applies.

## Implementation

- Electron main process runs the bundled CLI and owns PTYs.
- A sandboxed, context-isolated renderer receives only box display records and
  terminal events through narrow, sender-validated IPC methods.
- xterm.js renders the terminal; output acknowledgements bound queued PTY output.
- No renderer network access, arbitrary process execution API, remote pages,
  backend changes, or additional credential store.

To regenerate the Dock tile after changing the original cabin asset, install
Playwright Chromium and run `node desktop/scripts/icon.mjs`. Normal builds use
the checked-in tile and do not require a browser.

## Updates

Installed macOS builds from 0.1.1 check for desktop updates at startup and every
ten minutes. Updates download in the background; choose **Restart to update**
when ready, or **Later**. Use **BoxHaven → Check for Updates…** to check manually.
The signed app and bundled CLI update together. Box mutations finish before
restart and remote sessions keep running. The initial 0.1.0 draft must be replaced
with a newer DMG manually because it predates the updater.
