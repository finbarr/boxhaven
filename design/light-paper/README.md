# BoxHaven: shared light-paper design

Review concepts only. No application code or production assets were changed.

Open `index.html` for eight imagegen studies: desktop, website, web console,
creation, box details, 24 box identities, lifecycle expressions, and the Dock
icon. Click a screen to enlarge it. Revision 3 exact prompts are in
`prompts-v3.json`; earlier images and prompts remain as review history.

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
  names. Base identity stays stable through renames and team moves, while
  expressions and lights evolve with the machine state.
- Reduce in-app logo and portrait dimensions roughly 35% from the first pass.
  Target 26–30 px list portraits, 32–36 px header portraits, and a 36 px brand mark
  at ordinary desktop scale. Keep interaction targets at least 32 px.
- Status remains a separate labelled dot. Expressions reflect verified machine
  lifecycle state, never inferred agent progress or task completion.
- Creation keeps visible size/spec/price rows. Support all actual backend sizes,
  including team-defined sizes; the three mockup rows are illustrative.
- Team context and member access should be visible; this is not a promise of
  shared storage or collaborative text editing. Desktop team selection is a
  proposed interaction, not a claim about the currently implemented app.
- Show who created each box consistently in the homepage preview, desktop rows,
  console table, and details sidebar using small pastel initials circles only.
  Place circles at the right of sidebar rows and beside selected box names;
  omit repeated creator phrases and spelled-out names. Full creator names and
  attribution belong in accessible labels and hover/focus tooltips. Creator is
  not current operator or owner.
- Keep rename in the desktop sidebar row menu and the console details sidebar.
  Remove inline rename from the table and main terminal header.
- Remove the toolbar Disconnect action. Destroy box lives in the overflow menu
  and opens confirmation before deleting the remote machine. Closing a local
  connection and destroying a machine are different actions.
- Keep Members in navigation; remove the redundant shortcut by the team selector.

## Character family and state

The 24 identities explore accessories, silhouette, and subtle body variations:
sprout, spectacles, antenna, cat ears, beanie, daisy, mushroom, headphones, bow
tie, sailor, moon, comet, cactus, acorn, goggles, crown, duck, bunny, pixel,
stripe, freckles, snail, beret, and Saturn. The reference boards enlarge them
for inspection; product portrait sizes remain unchanged.

Each identity supports creating (curious, orange), online (awake, green), offline
(peacefully asleep, closed curved eyes, dim light), recovery required (concerned,
red light and accents), and destroying (brief fade). Offline expressions should
feel relaxed, never grumpy or annoyed.
The state sheet is the expression reference; screen mockups illustrate placement.
Offline means unavailable, not necessarily powered off or free of charges.
Destroying appears only after confirmed deletion starts; remove the row only
after verified deletion. Preserve recognizable accessories in every state.

## Small moments

Use a quiet sage hover wash and a persistent selected-row indicator. A portrait
may rise 1 px on hover, but does not continually bob or animate. A copied command
briefly shows a check. Sidebar rename opens a compact anchored input. A new box can
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
