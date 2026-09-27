# BoxHaven brand

`boxhaven.svg` is the production master of the flat classic mark: a solid
forest-green (`#085747`) box with pale-sage (`#CAD9BB`) eyes and smile.
The face is centered; there are no gradients, side depth, or shadows. The
standalone mark is transparent. Only the desktop icon has a white rounded tile,
with the visible mark filling 80% of its width: a 10% white border on each side.
The Dock renderer crops the SVG's transparent margins before scaling it so
padding is not applied twice. The tile has no baked-in shadow.

Regenerate the checked-in assets after installing desktop dependencies:

```sh
node scripts/render-brand.mjs
node desktop/scripts/icon.mjs
```

This updates the console, docs, favicons, and desktop Dock artwork. The desktop
build converts its PNG to the macOS iconset. The hosted console consumes the
backend's exported logo and public assets. Copy `backend/app/src/assets/boxhaven-logo.png`
to `../boxhaven-website/assets/logo.png` and `backend/app/public/favicon.png` to
`../boxhaven-website/assets/favicon.png` for the separate marketing repository.

Review `.artifacts/brand/sizes.png` at native resolution as well as screenshots of
the real surfaces. Earlier raster experiments in `design/logo-research` are
archival studies, not production assets. Per-machine character portraits remain
a separate identity system in `backend/src/box-art.ts`.

After deployment, run `node scripts/smoke-brand.mjs` with an existing production
CLI login. This read-only check verifies the served logo and favicon hashes,
opens the authenticated console, and captures the website, console, and docs at
desktop and mobile widths in `.artifacts/brand/production`.
