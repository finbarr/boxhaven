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

For a release tag `$TAG` (e.g. `v0.3.0`), the orchestrator:

1. Downloads `SHA256SUMS` from the release:

   ```bash
   curl -fsSL -o SHA256SUMS \
     "https://github.com/finbarr/boxhaven/releases/download/${TAG}/SHA256SUMS"
   ```

2. Extracts one checksum per platform and substitutes the placeholders:

   ```bash
   sum() { awk -v f="bh_${TAG}_$1.tar.gz" '$2 == f {print $1}' SHA256SUMS; }

   sed -e "s/__VERSION__/${TAG#v}/g" \
       -e "s/__SHA256_DARWIN_AMD64__/$(sum darwin_amd64)/" \
       -e "s/__SHA256_DARWIN_ARM64__/$(sum darwin_arm64)/" \
       -e "s/__SHA256_LINUX_AMD64__/$(sum linux_amd64)/" \
       -e "s/__SHA256_LINUX_ARM64__/$(sum linux_arm64)/" \
       packaging/homebrew/boxhaven.rb > boxhaven.rb
   ```

3. Verifies no `__` placeholders survived, then commits the result to the
   tap repository as `Formula/boxhaven.rb`:

   ```bash
   ! grep -q '__' boxhaven.rb
   ```

`brew audit --strict boxhaven` and `brew test boxhaven` (which runs
`bh version`) are the recommended checks before pushing the tap commit.
