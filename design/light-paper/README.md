# BoxHaven: shared light-paper design

Review concepts only. No application code or production assets were changed.

Open `index.html` for seven imagegen studies: desktop, website, web console,
creation, box details, interaction details, and the Dock icon. Click a screen
to enlarge it. Exact prompts are in `prompts.json`.

## Direction

- Independent remote boxes for unrelated tasks, controlled together and shared
  with a team. No Review / Build / Test pipeline, staged order, or connecting wires.
- Paper ivory surfaces, evergreen text and controls, sage selections, quiet oat
  borders. Desktop, website, and console use the same palette and components.
- Keep the existing cabin logo source unchanged. Imagegen renditions are visual
  references; implementation must place the original asset, not replace it with
  a generated reconstruction.
- Distinct box portraits in the desktop sidebar and console rows. Sprouts,
  glasses, antennas, and cat ears make them recognizable without competing with
  names. Portrait identity stays stable through renames, status, and team moves.
- Reduce in-app logo and portrait dimensions roughly 35% from the first pass.
  Target 26–30 px list portraits, 32–36 px header portraits, and a 36 px brand mark
  at ordinary desktop scale. Keep interaction targets at least 32 px.
- Status remains a separate labelled dot. A character's appearance does not
  imply agent progress, readiness, or completion.
- Creation keeps visible size/spec/price rows. Support all actual backend sizes,
  including team-defined sizes; the three mockup rows are illustrative.
- Team context and member access should be visible; this is not a promise of
  shared storage or collaborative text editing. Desktop team selection is a
  proposed interaction, not a claim about the currently implemented app.

## Small moments

Use a quiet sage hover wash and a persistent selected-row indicator. A portrait
may rise 1 px on hover, but does not continually bob or animate. A copied command
briefly shows a check. Rename opens a compact anchored popover. A new box can
settle into its row with a short fade; never manufacture provisioning progress.
Honor reduced-motion settings and do not encode status in animation alone.

The empty state can have a tiny box peeking above the New box button. Keep useful
labels, validation, and errors; omit promotional descriptions from product flows.

## Dock icon

Place the original cabin on an opaque white rounded-square tile with a soft
neutral drop shadow and transparent exterior. Preserve comfortable internal
padding. The Dock tile keeps normal system icon scale; the 35% reduction applies
to in-app artwork. The imagegen output is a concept, not the installed icon.

## Review notes

Images are raster proposals, not pixel-perfect implementation specifications.
Prices, team initials, and machine data are illustrative. Use live backend prices
and actual authorization rules in implementation. Keep the original logo file
and share a common avatar family across all implementations.
