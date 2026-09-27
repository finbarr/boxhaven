BoxHaven for macOS Apple Silicon.

Download the DMG, open it, and drag BoxHaven into Applications. The app bundles
its CLI and terminal runtime; Node.js, Go, Homebrew, and Xcode are not required.
Sign in from Connection settings with `https://api.boxhaven.dev` or your own backend.

The release workflow requires Developer ID signing, Apple notarization, signature
and ticket verification, and a packaged app/CLI/PTY smoke before creating a draft.
Before publishing, verify installation on another Mac using a browser-downloaded
DMG and run the packaged remote smoke against a disposable box.

Intel Macs, automatic updates, and Mac App Store distribution are not included
in this initial desktop release.
