# Images

Images carry the BoxHaven VM runtime so new boxes boot ready to use: the
agent runtime, tmux, Docker, the GitHub credential helper, and the BoxHaven
machine agent are already installed. Plain Ubuntu fallback images are not
considered fully bootstrapped for normal CLI use.

Providers create boxes from the backend's configured default snapshot:
`BOXHAVEN_REMOTE_IMAGE_DIGITALOCEAN` or `BOXHAVEN_REMOTE_IMAGE` for
DigitalOcean, and `BOXHAVEN_REMOTE_IMAGE_HETZNER` for Hetzner. Team images are
optional overrides selected when creating a box.

## Team Images

Images belong to the active team. Snapshot one of the team's boxes from the
console Images page or the CLI:

```bash
bh image ls
bh image create work --name dev-tools
bh create work-clone --image dev-tools
bh image rm dev-tools --force
```

`bh image create` snapshots one of your own boxes in the active team; the
name is used without a BoxHaven prefix. Names are unique within a team, across
providers. Images remain private to their owning team; different teams may
independently use the same name. Duplicate names return a conflict,
including while a snapshot is being created. Without `--name`, a name is generated
from the box name and timestamp. Names are normalized to lowercase with
unsupported characters replaced by hyphens, and must start with a letter or
number. Names such as `.dev` or `_dev` are rejected before a snapshot is created.
If a reference matches one image's name and another image's ID, selecting or
deleting it returns a conflict; use an unambiguous name or ID from `bh image ls`.
The snapshot starts in
`creating` status and can be selected for new boxes after the provider reports
it as `available`.

Without `--provider`, image commands use the backend's default provider. When
creating a box without `--image`, BoxHaven uses the provider's configured
default image. Without `--force`, `bh image rm` prompts before deleting the
image and refuses to continue in noninteractive terminals.

Keep the previous image around until a new box has been created from the new
image and verified.

## Rebuilding The Default Image

Remote runtime dependencies belong in the golden VM image. Self-hosters and
operators rebuild the default image with the image builder after changing
`cmd/bh/assets/remote-vm-install.sh`; see
[Self-Hosting](/self-hosting#golden-image-rotation) for the builder workflow.
The checked-in installer pins Codex CLI `0.153.3`, which supports
`gpt-6-astra`. Rebuild the image and create new boxes to use the updated CLI.
It also installs a pinned, checksummed Chrome for Testing headless shell and the
shared libraries needed by the seeded Playwright console smoke.
