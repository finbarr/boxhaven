# Homebrew Packaging

`boxhaven.rb` is the formula template for the `finbarr/tap` Homebrew tap.
Users install with:

```bash
brew install finbarr/tap/boxhaven
```

## Filling The Template

Every release built by `.github/workflows/release.yml` publishes four
archives plus a `SHA256SUMS` file:

```
bh_<tag>_darwin_amd64.tar.gz
bh_<tag>_darwin_arm64.tar.gz
bh_<tag>_linux_amd64.tar.gz
bh_<tag>_linux_arm64.tar.gz
SHA256SUMS
```

where `<tag>` is the full Git tag including the leading `v` (e.g.
`v0.3.0`). The template's `__VERSION__` placeholder is the version
*without* the leading `v`; the formula re-adds it when building download
URLs (`releases/download/v#{version}/bh_v#{version}_<os>_<arch>.tar.gz`).

For a release tag `$TAG` (e.g. `v0.3.0`), the release operator:

1. Downloads `SHA256SUMS` from the release:

   ```bash
   curl -fsSL -o SHA256SUMS \
     "https://github.com/finbarr/boxhaven/releases/download/${TAG}/SHA256SUMS"
   ```

2. Generates the formula with the checked-in renderer, which requires exactly
   one valid checksum for each expected archive and rejects leftover
   placeholders:

   ```bash
   scripts/render-homebrew-formula.sh \
     "$TAG" SHA256SUMS /path/to/homebrew-tap/Formula/boxhaven.rb
   ```

3. Audits, fetches, installs, and tests the generated formula from a local tap
   checkout before committing it:

   ```bash
   HOMEBREW_NO_AUTO_UPDATE=1 brew audit --strict --online finbarr/tap/boxhaven
   HOMEBREW_NO_AUTO_UPDATE=1 brew fetch --force finbarr/tap/boxhaven
   HOMEBREW_NO_AUTO_UPDATE=1 brew install finbarr/tap/boxhaven
   HOMEBREW_NO_AUTO_UPDATE=1 brew test finbarr/tap/boxhaven
   ```

Never update the live tap before the matching GitHub release exists and passes
`scripts/verify-published-release.sh`. See [RELEASING.md](../../RELEASING.md)
for the exact release, tap update, clean install, and production smoke runbook.
