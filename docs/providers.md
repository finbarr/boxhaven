# Cloud Providers

A single backend can serve multiple cloud providers at once. DigitalOcean and
Hetzner Cloud are implemented: each is enabled by its credentials
(`DIGITALOCEAN_ACCESS_TOKEN` or `HCLOUD_TOKEN`), and
`BOXHAVEN_BACKEND_PROVIDER` selects the default for creates that do not
request one. When unset, the first configured provider is the default
(DigitalOcean when both are configured).

An exe.dev adapter is also implemented and has passed the live provider smoke.
It uses a prepared OCI image and backend WebSocket transport. E2B,
Daytona, Blaxel, and Boat remain planned.

## All providers in Boxes

Open **Boxes** in the web console to see all of your team's boxes across configured
providers, including boxes created by teammates. Choose **New box**, select a
provider, size, and optional image, then create it in the active team. The provider
menu lists the adapters configured on your backend; new adapters use the same flow. Updates sync between browsers through the backend. Each resource has
a stable link that survives renames, plus the same sharing controls regardless
of provider. The owner and team administrators can grant operator access to the
whole team or individual members. Viewers can see metadata; operators can run
commands and access files on the resource.
Resources remain with the team when their creator leaves; the creator loses
access through both Boxes and the CLI until they are a team member again.

The resource link requires team membership. Preview access remains controlled
by the existing preview transport: VM previews are public, and exe.dev previews
use BoxHaven team access through the backend relay. Obtain a private preview
link in Boxes or with `bh preview work`; the desktop requests one automatically.
Session request history records what the backend confirmed; it does not report
live agent activity. Desktop team subscriptions and the additional sandbox
adapters are still being implemented.

`GET /v1/providers` lists what a backend has configured, and `bh create`
picks the backend default unless a provider is requested explicitly:

```bash
bh create work --provider hetzner
bh create work --provider digitalocean --region sfo3
bh create work --provider hetzner --region fsn1 --image 12345678
```

`--region` is passed through to the provider. `--image` accepts a name or ID from the target team’s image list. Set a
project-wide default with the `provider` key under `[remote]` in
`.boxhaven.toml` or the global config.

## DigitalOcean

| Variable | Description |
| --- | --- |
| `DIGITALOCEAN_ACCESS_TOKEN` | API token, enables the provider |
| `DIGITALOCEAN_REGION` | Default `nyc3` |
| `DIGITALOCEAN_SIZE` | Provider plan behind the built-in `small` size, default `s-2vcpu-4gb` |
| `DIGITALOCEAN_IMAGE` | Base image fallback, default `ubuntu-24-04-x64` |
| `DIGITALOCEAN_TAGS` | Comma-separated tags, default `boxhaven` |
| `DIGITALOCEAN_VPC_UUID` | Optional VPC UUID |
| `BOXHAVEN_REMOTE_IMAGE_DIGITALOCEAN` or `BOXHAVEN_REMOTE_IMAGE` | Golden snapshot id for new boxes |

Built-in sizes map to DigitalOcean standard plans: `small` is 2 vCPU / 4 GB,
`medium` is 4 vCPU / 8 GB, and `large` is 8 vCPU / 16 GB. `bh size plans`
lists every currently available Droplet plan, including GPU plans. Numeric
DigitalOcean snapshot ids are sent as image IDs when creating Droplets.

If DigitalOcean rejects a newly registered temporary SSH key, BoxHaven briefly
retries that rejected request. A definitive create rejection removes the failed
provisioning record so you can try again. Timeouts and server errors retain a
recovery record because a Droplet might exist; destroy that record before
recreating the box.

## Hetzner Cloud

| Variable | Description |
| --- | --- |
| `HCLOUD_TOKEN` | API token, enables the provider |
| `HETZNER_LOCATION` | Default `nbg1` (also `fsn1`, `hel1`, `sin`) |
| `HETZNER_SERVER_TYPE` | Provider plan behind the built-in `small` size, default `cpx22` |
| `HETZNER_IMAGE` | Base image fallback, default `ubuntu-24.04` |
| `BOXHAVEN_REMOTE_IMAGE_HETZNER` | Golden snapshot id for new boxes |

Built-in sizes map to `cpx22` (small), `cpx32` (medium), and `cpx42` (large).
Availability is validated against the selected location. Use `bh size plans`
to compare hardware and effective prices before creating a team shortcut for
any other server type.

## exe.dev

Set `EXE_DEV_SIGNING_KEY` to the backend's dedicated registered SSH signing key
and `BOXHAVEN_REMOTE_IMAGE_EXEDEV` to a prepared OCI image. Set
`BOXHAVEN_BACKEND_PROVIDER=exedev` to make it the default.
For a private image registry, set `EXE_DEV_REGISTRY_AUTH` to a pull-only
`USERNAME:PASSWORD` credential. Register the signing key with the `boxhaven` tag
scope to restrict it to VMs managed by this adapter.

```bash
bh create work --provider exedev
bh run work codex
# Disconnect: Ctrl-b, then d.
bh connect work
```

The backend manages lifecycle, authorization, and shared team metadata. Terminal
and file traffic passes through BoxHaven's backend, then exe.dev's authenticated
WebSocket proxy to the guest's certificate-authenticated SSH service. No public IPv4 is needed.
The account key stays on the backend. Expiring grants close active connections
after 15 minutes by default; reconnect to reattach the persistent session.

The built-in sizes request 2/4/8 CPUs and 4/8/16 GB RAM with 20 GB disks. Billing
depends on the account's capacity; hourly estimates are unavailable. exe.dev uses
the account's default region, so per-machine `--region` is rejected. Private previews require a configured BoxHaven preview domain and a team-scoped
15-minute lease. Image snapshots, pause,
and team-specific provider-account connections are not yet implemented.

The live smoke verifies creation, guest readiness, relayed certificate SSH and
file transfer, detached session recovery, active grant expiry, private previews,
and confirmed deletion. See the repository's
[image recipe and live smoke](https://github.com/finbarr/boxhaven/tree/master/deploy/exedev)
for operator setup and the current validation limits.

## Golden Snapshots

Providers create boxes from a prebuilt BoxHaven snapshot when the
`BOXHAVEN_REMOTE_IMAGE*` variable for that provider is configured, or when the
caller selects a team image with `bh create --image <name-or-id>`. Machines
created from these images are treated as backend-bootstrapped. Plain Ubuntu
fallback images are not considered fully bootstrapped for normal CLI use; the
CLI does not bootstrap plain hosts.

See [Images](/images) for managing images and
[Self-Hosting](/self-hosting) for the rest of the backend environment.
