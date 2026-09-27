# Signed macOS releases

The `Desktop Release` workflow builds an Apple Silicon DMG from a
`desktop-vX.Y.Z` tag matching `desktop/package.json`. It signs the app and all
nested executables with Developer ID, notarizes and staples the app, verifies
its signature and native PTY, then signs, notarizes, staples, and verifies the
DMG. Only successful builds can create a **draft** GitHub release. Missing
credentials fail the release; it never publishes an unsigned fallback.

The first signed release still requires Apple credentials and an end-to-end
signing run. Until a verified draft is published, source builds remain the
available installation method. Intel builds and auto-updates are separate work.

## One-time Apple setup

1. Use an active Apple Developer Program membership. In Xcode → Settings →
   Accounts → Manage Certificates, create a **Developer ID Application**
   certificate for the intended team. An Apple Development certificate is not
   sufficient for direct public distribution.
2. Export that certificate **with its private key** from Keychain Access as a
   password-protected `.p12`. Keep the original in your secure credential store.
3. Use an Apple ID **app-specific password** for notarization, plus that account's
   Apple Developer team ID. This is the approach already used by Yolobox.
4. In `finbarr/boxhaven`, create a GitHub Actions environment named
   `desktop-release`. Restrict it to desktop release tags and trusted maintainers.
   Add the same five secrets used by `finbarr/yolobox`:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE_BASE64` | Base64 of the exported `.p12` including its private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting that export |
| `APPLE_ID` | Apple account email used for notarization |
| `APPLE_ID_PASSWORD` | Apple app-specific password, not the account password |
| `APPLE_TEAM_ID` | Developer team ID matching the certificate |

The Developer ID certificate is reusable across apps from the same developer.
GitHub cannot return existing secret values, so copy the originals from your
secure credential store. If they are lost, restore the certificate and private
key from a backup, or generate a new certificate and app-specific password.
Never paste private keys into chat, commit them, or put them in the application.

`gh secret set --env desktop-release NAME` accepts values via stdin or its hidden
interactive prompt. For example, from a private directory:

```sh
base64 < DeveloperID.p12 | tr -d '\n' | gh secret set --repo finbarr/boxhaven --env desktop-release APPLE_CERTIFICATE_BASE64
gh secret set --repo finbarr/boxhaven --env desktop-release APPLE_CERTIFICATE_PASSWORD
gh secret set --repo finbarr/boxhaven --env desktop-release APPLE_ID
gh secret set --repo finbarr/boxhaven --env desktop-release APPLE_ID_PASSWORD
gh secret set --repo finbarr/boxhaven --env desktop-release APPLE_TEAM_ID
```

The runner imports the certificate into an ephemeral keychain and stores its
notarization profile there. It restores the original keychain search list and
deletes the temporary keychain and key files after the release command, even
when that command fails. GitHub disposes of the runner if the job is terminated.

## Release

1. Update `desktop/package.json` and its lockfile version, and edit
   `desktop/RELEASE-NOTES.md` for the final shipped behavior. Commit and push.
2. Push a new matching tag from a verified master commit, for example:

   ```sh
   git tag desktop-v0.1.0
   git push origin desktop-v0.1.0
   ```

3. Check the `Desktop Release` run and its draft. Do not move a release tag.
   A rerun refuses to overwrite an existing release; investigate and resolve
   a partial draft explicitly rather than replacing a published artifact.
4. Download the draft DMG in a browser on another Apple Silicon Mac. Open it,
   drag BoxHaven to Applications, launch normally, sign in, and verify a real
   create/connect/reconnect/preview/destroy cycle. Maintainers can also use
   `node desktop/scripts/smoke-remote.mjs --packaged` against the built bundle.
5. Publish the verified draft and change the website's desktop CTA from setup
   to the actual versioned DMG URL. Do not link `/releases/latest/download`:
   CLI releases share this repository and can become the latest release.

Users install only the app. It bundles Electron, the CLI, and native terminal
code, and uses macOS's system SSH. They do not need Go, Node, npm, Homebrew,
or Xcode. Existing CLI configuration is shared; new users sign in inside the app.

## Local verification

```sh
npm --prefix desktop test
npm --prefix desktop run smoke
npm --prefix desktop run package
node desktop/scripts/smoke-package.mjs desktop/release/BoxHaven-darwin-arm64/BoxHaven.app
```

Local packaging remains a developer build. `npm --prefix desktop run release`
requires the matching release tag environment, a Developer ID identity in
`BOXHAVEN_SIGN_KEYCHAIN`, and a valid `BOXHAVEN_NOTARY_PROFILE`; it performs real
Apple submissions. The GitHub workflow configures these through `ci-sign.py`.

References: [Apple Developer ID](https://developer.apple.com/developer-id/),
[Electron signing](https://www.electronforge.io/guides/code-signing/code-signing-macos),
and [Electron notarization](https://github.com/electron/notarize).
