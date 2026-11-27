# Pull request previews on the test server

Status: draft, the owner's to approve. Nothing here has run on the test server, and nothing is wired to run: no
workflow, no timer installed, no route, no DNS record.

The goal (the owner's of 2026-11-28): each pull request gets its own short-lived address, `https://pr-<n>.<preview
domain>`, running its branch on the e2e seed's test data, so it is clicked on a phone and a desktop before it is merged.
It is taken down when the pull request closes.

## How a preview is built

`scripts/poc/preview.sh up <n>`, run from the site's checkout on the test server (`~/booster-rocket`):

1. Asks GitHub for pull request `<n>` and refuses unless it is open, into this repository, and its head is a branch of
   this repository (a fork's is refused, whoever asks; see Security).
2. Fetches that branch by name (never the pull request's own ref, which a fork writes) into a clone of its own,
   `~/booster-rocket-preview/repo`, checks it is at the commit GitHub just named, and unpacks that commit with
   `git archive` into `~/booster-rocket-preview/pr-<n>/src`.
3. Builds the branch's image (`booster-rocket-preview-app:pr-<n>`) with the branch's own `Dockerfile`, while any
   earlier build of that preview keeps running.
4. Drops the preview's database, installs the branch's packages for the seed, runs the branch's `scripts/seed-e2e.ts`
   (migrate, empty, seed), starts the app, waits for it to be healthy, then starts its worker, mailbox and door, and
   joins the shared proxy to the preview's network.

Each preview is a compose project of its own, `booster-rocket-pr-<n>` (`docker-compose.preview.yml`): app, worker,
Postgres 18, mailpit, the door, and two one-off services for the seed. One shared proxy
(`docker-compose.preview-edge.yml`, Caddy, `scripts/poc/preview/Caddyfile`) serves every preview's host. The compose
files, the proxy's configuration, the door and the script always come from the site's checkout, never from the branch.

The data is the e2e seed's alone: made-up families at `example.com` addresses, made-up QuickBooks tokens and ids that
QuickBooks would refuse. Never a copy of the site's data. `/__preview/` is the door: it signs the visitor in as the
seed's Admin or its parent Zelda by setting the cookie for the session the seed made (`scripts/poc/preview/door.mjs`),
since staff sign-in needs the club's Microsoft or Google app, which a preview can't have. `/__preview/mail/` is the
preview's mailbox, where sign-in codes and club messages land.

## How it is triggered

Only the owner starts a preview, in one of two ways:

- **A label.** He adds the label `preview` to a pull request. `preview.sh poll`, run every five minutes by a user
  timer on the test server (`scripts/poc/preview/booster-rocket-preview-poll.{service,timer}`, not installed), brings up
  each open pull request with that label, rebuilds it when its head moves, and takes it down when the label goes. A
  label counts only when the owner (`PREVIEW_OWNER`) put it on, read from the pull request's events.
- **By hand.** `preview.sh up <n>` over SSH, by the owner or by the lead on his word.

The test server asks GitHub; GitHub never reaches the test server. No GitHub workflow is involved, so there is no
self-hosted runner (which a public repository must never have), no deploy key or SSH secret stored in GitHub, and no
port opened. The cost is up to five minutes between the label and the build starting.

## How previews are kept apart

- **From the outside world.** Every service that runs a branch's code is only on that preview's network
  (`booster-rocket-pr-<n>-internal`), made `internal`: no route off the machine. The seed's mail settings point at the
  preview's mailpit, which relays nothing; QuickBooks, the relay and Documenso can't be reached. The one service with a
  way out installs packages and holds no secret and no database address.
- **From the site.** Nothing of the site's is named, mounted or read: its own containers, volumes, image, networks
  and folder (`~/booster-rocket-preview/pr-<n>`, private). Each preview's secrets are made fresh in its `pr.env`, and
  the script refuses to run if any is the site's. The script removes only names that start with `booster-rocket-pr-<n>`
  and never prunes.
- **From each other.** Each preview has its own network, database, secrets and cookies; only the proxy is joined to
  every running preview's network.
- **From the machine.** Memory, CPU and process caps on every service; one preview command at a time; no build while
  the site is deploying.

## Security

The repository is public. The rule: no fork's code ever runs on the test server.

- `preview.sh` refuses a pull request whose head repository isn't this repository, or is gone (a deleted fork). It
  fetches `refs/heads/<branch>` of this repository and checks the commit matches what GitHub named, so a fork can't
  slip a commit in through the pull request's own ref.
- Only people with write access can push a branch here (today the owner and the agents working for him), and only the
  owner's label starts a preview.
- A branch's code still runs at build time with network access (its `Dockerfile` and its package install). That is
  accepted: only write-access branches get there. At run time it has no way out.
- Every preview's address is behind Cloudflare Access, allowing only the owner's email. The proxy answers nothing that
  lacks the header Access adds (`Cf-Access-Jwt-Assertion`), and the tunnel route checks the Access token itself
  ("Protect with Access"). No port is published on the host. The door is a sign-in shortcut, so this gate is what keeps
  it private.
- Previews live on a domain of their own (recommended; see the decision below), so their cookies can't touch the
  site's.

## How previews are cleaned up

- `preview.sh sweep` (part of every poll) takes down each preview whose pull request is closed or merged, and any
  older than `PREVIEW_TTL_DAYS` (7) since its last build.
- A poll also takes down a preview whose label was removed.
- `preview.sh down <n>` removes the preview's containers, database, package volume, image, ref and folder. The shared
  package store and Docker's build cache are kept (the build cache is shared with the site's builds, so the script never
  prunes it; the owner can, with `docker builder prune --filter until=168h`, at a quiet time).

## What it costs

Measured on the test server on 2026-11-27 (read only): 4 cores, 15 GB of memory with about 8.3 GB available and 3 of
4 GB of swap in use, 63 GB of disk free.

| | Per running preview | Notes |
| --- | --- | --- |
| Memory in use | about 300 MB | app about 110 MB, as the site's; Postgres about 50 MB; the rest 20 to 40 MB each |
| Memory caps | about 1.6 GB | app 768 MB, Postgres 512 MB, worker and mailbox 128 MB each, door 96 MB |
| A build | a few minutes, 2 to 4 cores | one at a time, never beside a site deploy |
| Disk | about 2 GB | image about 470 MB, the seed's packages about 1 GB; plus about 1 GB of shared package store |

`PREVIEW_MAX` holds it to 2 previews at once (about 600 MB in use, 3.2 GB at the caps), which the machine can take
without starving the site. Cloudflare: free (Access is free up to 50 users); a separate domain is about $10 a year.

## What Brian does

Once, in this order, after the decision below:

1. Add the preview domain to Cloudflare as a zone of its own (or pick the name under the existing one).
2. DNS: a proxied `CNAME` record `*` pointing at the tunnel's `<tunnel id>.cfargotunnel.com` (wildcard records aren't
   made by the tunnel's route screen).
3. Access: **Zero Trust > Access controls > Applications > Create new application > Self-hosted**, domain `*.<preview
   domain>`, a policy allowing only your email, One-time PIN, a session of a week. Copy its **Application Audience (AUD)
   Tag**.
4. Tunnel: on linuxdev's tunnel, **Routes > Add route > Published application**, hostname `*.<preview domain>`,
   service `http://booster-rocket-preview-proxy:8080`, **Protect with Access** on with your team name and the AUD tag.
5. GitHub: create the label `preview`, and a fine-grained token, read-only, this repository alone (pull requests and
   issues: read), for `GITHUB_TOKEN` in `.env.preview`. Without it GitHub allows 60 questions an hour, which a poll
   every five minutes with two previews can pass; `up <n>` by hand works without it.
6. On linuxdev (the lead can do this on your word): `scripts/poc/preview.sh init <preview domain>
   Cf-Access-Jwt-Assertion <your login>`, add `booster-rocket-preview-edge` to cloudflared's networks in its compose
   file and recreate cloudflared at a quiet time; install the timer when you want labels to work.
7. Check in a private window: `https://pr-1.<preview domain>` asks for your email and a code, then says no preview is
   there.

## Decision for the owner

Previews need a wildcard name: a separate domain (about $10 a year; recommended, since a wildcard Access application
on `rhinoautomator.com` would also gate every other site on it) or names under `rhinoautomator.com`.

## Left undone

Nothing has run on the test server. The poll timer isn't installed. No comment with the address is posted on the pull
request (it would need a token that can write). Build cache grows until pruned by hand.
