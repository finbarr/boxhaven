# BoxHaven Desktop

Keep your boxes together in one desktop window. The left sidebar shows your
boxes and their machine status. Select a box to attach to its persistent tmux
session in the right pane.

You can switch between boxes without closing their terminals. Closing the app
leaves your remote sessions running. Reopen the app to return to the selected box.

## Build and open

The initial app is available as a source build, verified on macOS Apple Silicon.
Install Node.js 22.12 or later, Go 1.23 or later, and Xcode Command Line Tools.
From a BoxHaven checkout:

```sh
npm --prefix desktop ci
npm run desktop
```

To build a local `.app` bundle:

```sh
npm run desktop:package
open desktop/release/BoxHaven-darwin-arm64/BoxHaven.app
```

The output path includes the build machine's architecture. Local builds are
not signed or notarized for public distribution.

## Connect your account

The app bundles the CLI and uses its global login and configuration. If you
already use `bh`, your boxes appear automatically. Project-specific
`.boxhaven.toml` settings are not used by the desktop app.

Use the gear button to sign in through your browser. For a first login, enter
`https://api.boxhaven.dev` or your own backend API URL. You can also configure
a self-hosted backend using `bh login --backend-url https://api.example.com`.
The desktop app needs no additional backend services or deployment changes.

## Start some work

Click **New box** in the sidebar, name it, and click **Create box**. On an empty
account, you can also click **Create your first box**. BoxHaven creates the box
and opens its terminal automatically when it is ready.

New boxes use your configured provider and the backend's default size and region.
They start empty; creating a box does not upload local project files. Clone your
repository and start an agent directly in the box's terminal.

You can close the dialog and work in another box while provisioning continues.
Click the progress notice in the sidebar to see its status or any error. Closing
and reopening the window preserves creation progress; quitting waits for the
request to finish. If creation fails, check the refreshed sidebar before trying
another name, since the provider may already have allocated the box.

Select an existing box to reattach to its session. The sidebar refreshes every
15 seconds; use the refresh button or **⌘R** for an immediate update. Use **⌘K**
to find a box. **Detach** closes that terminal connection, and **Reconnect**
reattaches to the remote session.

The sidebar's `online`, `offline`, and `creating` labels describe the machine's
heartbeat and setup state. They do not indicate agent progress or completion.
Project sync and deletion are available through the CLI.

Connections use `bh connect`, including its existing credential forwarding,
short-lived SSH certificates, and pinned host keys. See the [security model](./security).
