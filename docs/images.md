# Golden Images

Golden images carry the BoxHaven VM runtime so new boxes boot ready to use:
the agent runtime, tmux, Docker, the GitHub credential helper, and the
BoxHaven machine agent are already installed. Plain Ubuntu fallback images
are not considered fully bootstrapped for normal CLI use.

Providers create boxes from a prebuilt BoxHaven snapshot when
`BOXHAVEN_REMOTE_IMAGE_DIGITALOCEAN` (or legacy `BOXHAVEN_REMOTE_IMAGE`) or
`BOXHAVEN_REMOTE_IMAGE_HETZNER` is configured, or when a backend admin has
activated a managed golden image for that provider with `bh image activate`.

## Managed Images

Backend admins, listed by email in `BOXHAVEN_ADMIN_EMAILS`, can manage golden
images from the CLI or the console Images view without rerunning the image
builder. Non-admin users get a `403` from the image endpoints.

```bash
bh image ls
bh image create work            # snapshot the box "work" into a golden image
bh image activate <image-id>
bh image deactivate
bh image rm <image-id>
```

`bh image create` snapshots one of your own boxes; the backend prefixes the
image name with `boxhaven-remote-`. The snapshot starts in `creating` status
and can only be activated once it is `available`.

Activation makes the image the default for new boxes on that provider,
overriding the env-configured `BOXHAVEN_REMOTE_IMAGE*` default until the
image is deactivated with `bh image deactivate`. An active image cannot be
deleted (`bh image rm` returns a conflict).

Without `--provider`, image commands use the backend's default provider.

After activating a new image, run the remote lifecycle smoke before relying
on it, and keep the previous image around for rollback until the smoke
passes.

## Checking Which Image Is Active

A managed image activated with `bh image activate` overrides the env default
per provider at runtime through backend state, so check `bh image ls` for an
active image before assuming new boxes use the env-configured snapshot. Run
`bh image deactivate` to fall back to the env default.

## Rebuilding The Image From Source

Remote runtime dependencies belong in the golden VM image. Self-hosters and
operators rebuild it with the image builder after changing
`cmd/bh/assets/remote-vm-install.sh`; see
[Self-Hosting](/self-hosting#golden-image-rotation) for the builder workflow.
