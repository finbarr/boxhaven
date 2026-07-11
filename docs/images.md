# Images

Images carry the BoxHaven VM runtime so new boxes boot ready to use: the
agent runtime, tmux, Docker, the GitHub credential helper, and the BoxHaven
machine agent are already installed. Plain Ubuntu fallback images are not
considered fully bootstrapped for normal CLI use.

Providers create boxes from the backend's configured default snapshot:
`BOXHAVEN_REMOTE_IMAGE_DIGITALOCEAN` (or legacy `BOXHAVEN_REMOTE_IMAGE`) for
DigitalOcean, and `BOXHAVEN_REMOTE_IMAGE_HETZNER` for Hetzner. Team images are
optional overrides selected when creating a box.

## Team Images

Images belong to the active team. Snapshot one of the team's boxes from the
console Images page or the CLI:

```bash
bh image ls
bh image create work            # snapshot the box "work" into a team image
bh create work-clone --image <image-id>
bh image rm <image-id> --force
```

`bh image create` snapshots one of your own boxes in the active team; the
backend prefixes the image name with `boxhaven-remote-`. The snapshot starts in
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
The checked-in installer pins Codex CLI `0.144.1` for deterministic
compatibility with the configured `gpt-5.6-sol` model.
