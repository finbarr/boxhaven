# BoxHaven brand

`boxhaven.svg` is the production master of the selected H3 study: a forest-green
box with pale-sage (`#CAD9BB`) eyes and smile. Its face is centered on the front
panel. Shallow depth extends to the right without a vertical offset, with light
from the upper left and a quiet contact shadow below. The standalone mark is
transparent; the white rounded tile belongs only to the desktop application icon.

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
