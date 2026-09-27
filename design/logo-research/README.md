# BoxHaven smiling-box research

Design review · 27 September 2026. Open [the gallery](index.html).

Latest: [H face colors](h-colors.html) compares unchanged white H against warm cream, pale sage, and muted sage. PNGs and imagegen prompts are saved in `h-colors/`; rebuild with `python3 design/logo-research/build-h-colors.py`. Color swatches are prompt targets rather than exact sampled pixels.

**H** centers the face on the front panel of G. The first comparison row normalizes D, E, and H to a 220px front-panel width using measured source bounds in `build-refinements.py`; image files remain unscaled. The prompt is in `refinements/prompts-round-five.json`.

**G** matches the shared box portrait geometry in `backend/src/box-art.ts`: front width 35, right side extension 5, zero vertical offset, with a small contact shadow underneath. The generated concept approximates the 14.3% ratio; final vectors should enforce it. Source and correction prompts are in `refinements/prompts-round-four.json`. The reference render is reproducible with `node design/logo-research/render-box-reference.mjs`.

**F** in [Classic refinements](refinements.html) combines soft matte depth with the deeper printed shadow. The image and prompt are saved in `refinements/classic-depth-shadow.png` and `refinements/prompts-round-three.json`.

The comparison also includes a slightly deeper printed shadow (targeting a 4% offset) and subtle matte depth on Classic itself. Both are plain paper proofs, with prompts recorded in `refinements/prompts-round-two.json`. The page also compares the unchanged Classic baseline, Classic with a shallow printed shadow, and Sage with subtle depth. The shadow targets roughly a 2% offset rather than the earlier deep offset. New PNGs and prompts are in `refinements/`. Rebuild with `python3 design/logo-research/build-refinements.py`.

Eight standalone studies refine the normal smiling square. The logo has no white Dock tile; that belongs only to the separately packaged desktop app icon. The original simple mark remains a candidate. No production logo, website, or desktop packaging was changed. These are imagegen concept PNGs, not final vector artwork or Icon Composer exports.

## Recommendation

Start with **01 Classic** and **02 Square & calm**. Classic preserves the original personality; 02 is a little more restrained. **05 Paper box** is the strongest alternative for the paper-themed product, but needs a heavier small-size treatment. **04 Printed shadow** is worth comparing for depth without shiny material effects. I would keep the 07 material treatment optional for a desktop rendition rather than making it part of the core logo.

These are design judgments from the reference comparison and rendered studies, not user research. The generated studies also vary their internal scale slightly: the next vector pass should normalize padding before selecting final proportions.

## Findings from the references

| Reference | What to study | Implication for BoxHaven |
| --- | --- | --- |
| [Notion](https://notion.notion.site/Media-Kit-205535b1d9c4440497a3d7a2ac096286) | Heavy edges and a recognizable box silhouette | The box needs a strong silhouette, not tiny hardware details. |
| [GitHub](https://brand.github.com/foundations/logo) | A character simplified into an identifiable one-color mark | Keep a stable brand face; let individual VM portraits be more elaborate. |
| [Discord](https://discord.com/branding) | A compact face with generous negative space | Eye spacing can carry personality without additional decoration. |
| [Docker](https://www.docker.com/company/newsroom/media-resources/) | Familiar character plus product metaphor | The smiling box already combines friendliness and remote machines. |
| [Linear](https://linear.app/brand) | Geometric mark distinct from its rendered app icon | Separate the core mark from the desktop tile and surface effects. |
| [Raycast](https://www.raycast.com/press) | Flat brand geometry and a more dimensional desktop rendition | A restrained icon finish can coexist with a flat website mark. |
| [Zed](https://zed.dev/brand) | Separate logo and app-icon assets, strong dark/light contrast | Specify each output deliberately rather than reusing one image everywhere. |
| [VS Code](https://code.visualstudio.com/brand) | Consistent silhouette across color and depth treatments | Shape should remain recognizable when shading disappears. |
| [Figma](https://www.figma.com/using-the-figma-brand/) | Simple repeated geometric forms | Few well-proportioned shapes can be enough. |
| [Ghostty](https://ghostty.org/) | Actual 32px favicon | Judge at the delivered size, not only on a presentation board. |
| [Slack](https://slack.com/media-kit) | Repeated shapes and careful spacing | Consistent geometry makes the mark feel intentional. |

Downloaded originals retain their colors and proportions. Discord's white mark is displayed on a dark panel. Ghostty is intentionally shown at its native 32px size; the downloaded source is a favicon, not a high-resolution master. Slack's download is a media-kit reference image rather than a standalone vector mark.

## Desktop icon guidance

**Apple:** current guidance uses a 1024×1024 layout for iOS, iPadOS, and macOS. It favors simple geometry and vector foreground layers, with an opaque background. In the layered Icon Composer workflow, the system supplies masking and effects; avoid baking equivalent effects into the layers. Keep features consistent across appearances. [App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons), [Icon Composer](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer), [templates](https://developer.apple.com/design/resources/).

**Windows:** design on a 48×48 grid with a clear silhouette. Supply at least 16, 24, 32, 48, and 256px assets for the common Win32 icon cases; packaged application requirements add other target sizes and theme variants. Do not treat a single large PNG as the complete Windows deliverable. [Design](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-design), [construction and dimensions](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction).

**GNOME:** the full-color template is 128×128, commonly viewed at 64 or 32; provide a separate symbolic rendition. Its style has its own baseline, perspective, and shadow conventions, so the macOS white tile should not automatically become the Linux asset. [App icons](https://developer.gnome.org/hig/guidelines/app-icons.html).

**Logo construction:** the brand guides reinforce clear space, consistent proportions, legibility, and distinct mark/wordmark uses. These are useful principles, not universal numeric rules. BoxHaven's own clear-space and minimum-size values need to be established from its selected artwork.

## Dimensions and deliverables

| Surface | Dimensions / format | Source or status |
| --- | --- | --- |
| Core mark | SVG; one-color and reversed | Proposed BoxHaven deliverable after selection |
| macOS layered master | 1024×1024 layout; separate vector foreground layers | Current Apple HIG / Icon Composer |
| Current BoxHaven desktop pipeline | 16, 32, 128, 256, 512 points at 1× and 2×, packed into `.icns` | Verified in `desktop/scripts/build.mjs`; physical PNG sizes include 16, 32, 64, 128, 256, 512, 1024 |
| Windows Win32 minimum | 16, 24, 32, 48, 256px | Microsoft construction guidance; additional packaged-app sizes apply |
| GNOME full-color / symbolic | 128×128 master; separate symbolic | GNOME HIG; normal checks at 64 and 32 |
| Web favicon | 16 and 32px plus SVG | Proposed BoxHaven test/export targets, not a platform mandate |
| Sidebar / header | Test at 24, 32, 40px | Proposed product-specific checks |
| Review contact sheets | PNG concepts at CSS 16, 24, 32, 48, 64, 128px | Browser-scaled previews; not individually hinted production icons |

BoxHaven currently generates flattened PNGs and `.icns` through Electron packaging. The current white tile is baked into that artwork. Adopting Icon Composer would be a separate packaging change that must be tested on supported macOS releases; this research does not silently change that pipeline. For a future layered export, the tile and shadow in these PNG mockups must not be reused as pre-masked foreground layers.

## Eight controlled directions

1. **Classic:** original-like forest body, round eyes, generous curved smile.
2. **Square & calm:** tighter corners, upright eyes, quieter smile.
3. **Wide smile:** more expressive face and broader mouth.
4. **Printed shadow:** crisp sage offset under/right; no appendage above the head.
5. **Paper box:** forest outline and positive face with a transparent interior.
6. **Sage:** light sage body and dark face.
7. **Soft depth:** diffuse matte shading without a shiny highlight band.
8. **Charcoal:** dark neutral body with pale sage facial features.

All use a normal square body without a Dock tile. No roof, sprouts, clipped corner, second box, pipeline, or extra mascot accessories. The standalone PNGs are in `marks/`; five have transparent backgrounds. 02, 04, and 08 are paper-background proofs because repeated generated cutouts introduced visible blemishes. Those studies need clean vector exports before use on other backgrounds.

The correction prompts are saved in [logo-prompts.json](logo-prompts.json), with source paths in [logo-generation-sources.json](logo-generation-sources.json). The earlier white-tile desktop explorations remain archived in `concepts/` with their original [prompts.json](prompts.json); they are not the logo artwork shown in the gallery.

## Local research collection

`downloads/` contains 15 documentation/guide files, three official logo packs, and the individual reference images. [Manifest](downloads/manifest.json) records source URLs, redirects, SHA-256 hashes, content types, and sizes. Files belong to their respective owners and are local research references; they are not bundled into the app or republished in this repository. The gallery's reference downloads are optional on a fresh checkout and show source links when absent.

Recreate the research downloads:

```sh
python3 design/logo-research/download-references.py
```

Build and verify the review page (uses the repository's existing Playwright dependency):

```sh
python3 design/logo-research/build-gallery.py
node design/logo-research/verify-gallery.mjs
```

Verification covers image loading, no horizontal overflow, actual CSS preview dimensions, background controls, comparison selection, modal enlargement, keyboard dismissal, and desktop/mobile screenshots. Generated alpha edges remain concept-quality; a chosen mark needs clean vector construction and separately checked small-size exports before shipping.
