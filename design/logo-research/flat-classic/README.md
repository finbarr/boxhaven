# Flat classic preview

The standalone logo remains unchanged. The revised desktop preview uses its
**visible bounds** at 80% of the white tile width, leaving a 10% white inset on
each side. Previously, an 82% image size compounded with the SVG's 52/64 visible
width: only 66.625% actual artwork and a 16.6875% border per side. The revision
makes the mark about 20% wider and reduces the white inset about 40%.

`padding.html` compares that previous scale with 80% (recommended) and 84%.
`mark-tight.svg` is generated from `mark.svg`; it crops only transparent SVG
canvas margins. Run `node design/logo-research/flat-classic/render.mjs` to rebuild
both previews and PNGs. This is a design preview, not a production icon change.

## Guidance checked September 27, 2026

- [Apple App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons):
  simple recognizable forms, centered content, and a 1024×1024 layout. The guidance
  does not specify a mandatory percentage of white space around a glyph.
- [Apple Icon Composer](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer):
  use the current [Apple templates](https://developer.apple.com/design/resources/)
  for grids, canvas size, and system masking. Outer canvas/mask allowances are
  separate from the white border *inside* our icon tile. Our Electron app currently
  packages a flattened ICNS; a layered Icon Composer migration is a separate task.
- Visual comparison with the user's September 27 Dock screenshot: Chrome and
  Notion occupy more of their white tiles than the previous BoxHaven preview.
  The recommended 80% is an optical design judgment, not a ratio mandated by Apple.

No gradients, depth, texture, or shadows are added to any of these variants.
