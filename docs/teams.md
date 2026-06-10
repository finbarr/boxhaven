# Teams

Teams are Better Auth organizations with `owner`, `admin`, and `member`
roles. Every box belongs to a team. Each account automatically gets a
personal team named `<name>'s team`, so personal boxes work with no setup.

On the hosted service, [billing](/billing) also attaches to teams: personal
teams include one free box, while shared teams need a team subscription.

## Create A Team

Create a shared team in the console or from the CLI:

```bash
bh team create acme
```

Creating a team makes it your session's active team, as does selecting a team
in the console's Team view.

## Invite Teammates

Invite teammates by shareable link. `bh team invite <email>` (or the console
Teams view) creates an invitation and prints an invite URL such as
`https://app.boxhaven.dev/invite?id=<invitation-id>`; send that link to the
teammate, who accepts it after signing in with the invited email address.
BoxHaven does not send invitation emails.

```bash
bh team invite teammate@example.com
bh team invite teammate@example.com --role admin
```

Accepting an invitation also switches that session's active team to the
joined team. Pending invitations can be cancelled by the inviter or a team
admin before they are accepted.

## Where New Boxes Land

New boxes land in the session's active team: `bh login` pins it to your
personal team until you join or switch to another one. When you belong to
more than one team, control where boxes go explicitly:

```bash
bh create work --team acme   # create a box directly in a team
bh team switch acme          # change the CLI default team for new boxes
bh move work acme            # move one of your boxes to another of your teams
```

Each session has an active team, and CLI login sessions and browser sessions
are independent: switching teams in the console does not change the CLI
default, and vice versa.

## Visibility And Roles

Members have one of three roles: `owner`, `admin`, or `member`. Team members
see exactly the boxes in that team and who owns each one; boxes in your other
teams stay invisible to them.

Owners and admins can destroy team boxes; members can only destroy their own.
Owners and admins can remove a teammate's box with:

```bash
bh team destroy <box> --force [--team <slug>]
```

or from the console.

## Inspect Teams From The CLI

```bash
bh team list                 # teams you belong to
bh team status               # your session's active team
bh team members              # members and roles
bh team boxes                # boxes in the team with their owners
```

`--team <slug-or-id>` selects a team explicitly; it is optional when you
belong to exactly one team.

## Leaving A Team

When you leave a team (or are removed), your boxes in it move back to your
active team the next time you list them; until that next listing, the old
team can still see and destroy them.

## Sharing A Box Setup

Moving or sharing never copies a box. To hand a teammate a box like yours,
snapshot it and create a new box from the resulting image — snapshotting is
admin-gated today (`BOXHAVEN_ADMIN_EMAILS`):

```bash
bh image create work
bh create work-clone --image <image-id>
```

See [Golden Images](/images) for image management.
