# Cloud Providers

A single backend can serve multiple cloud providers at once. DigitalOcean and
Hetzner Cloud are implemented: each is enabled by its credentials
(`DIGITALOCEAN_ACCESS_TOKEN` or `HCLOUD_TOKEN`), and
`BOXHAVEN_BACKEND_PROVIDER` selects the default for creates that do not
request one. When unset, the first configured provider is the default
(DigitalOcean when both are configured).

`GET /v1/providers` lists what a backend has configured, and `bh create`
picks the backend default unless a provider is requested explicitly:

```bash
bh create work --provider hetzner
bh create work --provider digitalocean --region sfo3
bh create work --provider hetzner --region fsn1 --image 12345678
```

`--region` and `--image` are passed through to the provider verbatim. Set a
project-wide default with the `provider` key under `[remote]` in
`.boxhaven.toml` or the global config.

## DigitalOcean

| Variable | Description |
| --- | --- |
| `DIGITALOCEAN_ACCESS_TOKEN` | API token, enables the provider |
| `DIGITALOCEAN_REGION` | Default `nyc3` |
| `DIGITALOCEAN_SIZE` | Default provider size for creates without an explicit tier, default `s-2vcpu-4gb-amd` |
| `DIGITALOCEAN_IMAGE` | Base image fallback, default `ubuntu-24-04-x64` |
| `DIGITALOCEAN_TAGS` | Comma-separated tags, default `boxhaven` |
| `DIGITALOCEAN_VPC_UUID` | Optional VPC UUID |
| `BOXHAVEN_REMOTE_IMAGE_DIGITALOCEAN` (or legacy `BOXHAVEN_REMOTE_IMAGE`) | Golden snapshot id for new boxes |

Create-time tiers map to DigitalOcean AMD sizes: `small` is 2 vCPU / 4 GB,
`medium` is 4 vCPU / 8 GB, and `large` is 8 vCPU / 16 GB. Numeric
DigitalOcean snapshot ids are sent as image IDs when creating Droplets.

## Hetzner Cloud

| Variable | Description |
| --- | --- |
| `HCLOUD_TOKEN` | API token, enables the provider |
| `HETZNER_LOCATION` | Default `nbg1` (also `fsn1`, `hel1`, `sin`) |
| `HETZNER_SERVER_TYPE` | Default server type for creates without an explicit tier, default `cpx22` |
| `HETZNER_IMAGE` | Base image fallback, default `ubuntu-24.04` |
| `BOXHAVEN_REMOTE_IMAGE_HETZNER` | Golden snapshot id for new boxes |

Tiers map to `cpx22` (small), `cpx32` (medium), and `cpx42` (large). The tier
server types are not orderable in the US locations `ash` and `hil`; to use
those, set `HETZNER_SERVER_TYPE` to a plan Hetzner offers there and create
boxes without `--tier`.

## Golden Snapshots

Providers create boxes from a prebuilt BoxHaven snapshot when the
`BOXHAVEN_REMOTE_IMAGE*` variable for that provider is configured, or when the
caller selects a team image with `bh create --image <image-id>`. Machines
created from these images are treated as backend-bootstrapped. Plain Ubuntu
fallback images are not considered fully bootstrapped for normal CLI use; the
CLI does not bootstrap plain hosts.

See [Images](/images) for managing images and
[Self-Hosting](/self-hosting) for the rest of the backend environment.
