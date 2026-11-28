# Pull request previews on the test server

Status: built and approved by the owner (2026-11-28); not yet set up. Nothing has run on the test server or in
Cloudflare: the owner's setup steps are below, and until they are done the workflow fails at its first Cloudflare call
and the test server has no poll.

The goal (the owner's of 2026-11-28): each pull request gets its own short-lived address, `https://pr-<n>-br.rhinoautomator.com`,
running its branch on the e2e seed's test data, so it is clicked on a phone and a desktop before it is merged.
It is taken down when the pull request closes.

## How a preview is built

`scripts/poc/preview.sh up <n>`, run from the site's checkout on the test server (`~/booster-rocket`) by its poll:

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

## Addresses

Previews live on the site's own zone, `rhinoautomator.com` (the owner's decision of 2026-11-27), at first-level names
of a shape nothing else on the zone has: `pr-<n>-br.rhinoautomator.com`. First-level names are covered by Cloudflare's
free Universal SSL certificate (`*.rhinoautomator.com`); a name such as `pr-<n>.preview.rhinoautomator.com` would need
a paid certificate.

Access can't be given a pattern like `pr-*-br`: an application's wildcard covers a whole label (`*.rhinoautomator.com`),
which would gate the owner's other sites. So each preview gets an Access application of its own, for its one host
name, made through Cloudflare's API by the previews workflow (`scripts/poc/preview/cloudflare.sh`, run on GitHub's
runner) and deleted by it. Every application uses one
reusable Access policy the owner makes once (his email only). The order keeps a name from ever answering ungated:
opening makes the Access application, checks it is there, then makes the DNS name (a proxied `CNAME` to the tunnel);
closing deletes the DNS name, checks it is gone, then deletes the application. Each lookup and delete is by the
preview's own host name, so nothing else in the zone or the account is touched.

The tunnel needs one route for all previews: `*.rhinoautomator.com` to the previews' proxy, listed after every other
route on that tunnel. Only names that have a DNS record pointing at the tunnel ever reach it, and the proxy answers
only `pr-<n>-br` names that came through Access.

## How it is triggered

Only the owner starts a preview: **Actions > previews > Run workflow**, on `main`, with the pull request's number and
`up` (`.github/workflows/previews.yml`, `scripts/poc/preview/workflow.sh`). The workflow runs only for him (the
repository's owner, as both the actor and the one who triggered it) and only from `main`. It refuses a fork's pull
request, a closed one, or a third preview; then it opens the gate in Cloudflare and puts the label `preview` on the
pull request, with a comment giving the address.

The test server's poll (`preview.sh poll`, from cron every five minutes) asks GitHub for open pull requests with that
label, and builds each one whose label was put on last by the workflow (the Actions bot) or the owner, within the last
seven days. It rebuilds a preview when its branch moves. A label anyone else puts on counts for nothing, and a label
without the workflow's run has no gate, so its address doesn't resolve.

GitHub never reaches the test server, and the test server never holds the Cloudflare token: there is no self-hosted
runner (which a public repository must never have), no SSH key in GitHub, and no port opened. The workflow never runs a
pull request's code: it checks out `main`, and its Cloudflare token is in the GitHub environment `previews`, which only
`main` may use. The cost is up to five minutes between the run and the build starting, and a few minutes of build.

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
  owner can run the workflow that starts a preview. Someone with write access could change the workflow on a branch,
  but a run from a branch can't use the `previews` environment, so it gets no Cloudflare token, and its label isn't
  counted unless the Actions bot put it on (which only a run of the workflow does).
- A branch's code still runs at build time with network access (its `Dockerfile` and its package install). That is
  accepted: only write-access branches get there. At run time it has no way out.
- Every preview's address is behind Cloudflare Access, allowing only the owner's email. The proxy answers nothing that
  lacks the header Access adds (`Cf-Access-Jwt-Assertion`). No port is published on the host. The door is a sign-in shortcut, so this gate is what keeps
  it private.
- The proxy checks that Access's header is there, not its signature: the proxy has no way out to fetch Cloudflare's
  keys. What makes the header trustworthy is that a preview's name resolves only while its Access application exists
  (the order above), and no port is published, so the only way to the proxy is through Cloudflare for that name.
- The proxy answers only connections from the edge network, where the tunnel connector is (`remote_ip`, read by
  `init`), so a preview can't reach another preview, or its door, through the proxy it is joined to.
- Accepted, inside the write-access boundary: a branch's build and package install run with network access (they can
  reach the machine's published ports and the local network), and previews are same-site with the owner's other sites
  on `rhinoautomator.com`, so a branch's code could set cookies for the whole domain. Both need a branch pushed to this
  repository, which only the owner and his agents can do.
- The site's and the previews' cookies are host-only (no `Domain`), so a preview's cookie never reaches the site or
  another preview, and each preview signs its sessions with its own secret.
- The Cloudflare token can edit Access applications and the zone's DNS, nothing else; it lives only in GitHub's
  `previews` environment, and `cloudflare.sh` acts only on `pr-<n>-br` names.
- On a pull request's close the workflow runs as `pull_request_target`, which has the token. It checks out `main`
  and uses no text from the pull request but its number, so a fork's pull request can't run anything with it.

## How previews are cleaned up

- When a labeled pull request closes or merges, the workflow closes its gate at once (DNS name, then Access
  application) and the test server's next poll takes it down.
- Every day at 07:23 UTC the workflow takes down each labeled pull request that is closed, labeled by someone else, or
  older than seven days (with a comment saying so; running the workflow again brings it back), and closes any gate left
  without one. Every poll on the test server does the same for what is running there.
- **Actions > previews > Run workflow** with `down` takes one down by hand.
- On the test server, taking one down removes its containers, database, package volume, image, ref and folder. The
  shared package store and Docker's build cache are kept (the build cache is shared with the site's builds, so the
  script never prunes it; the owner can, with `docker builder prune --filter until=168h`, at a quiet time).

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
without starving the site. Cloudflare: free (Universal SSL covers the names; Access is free up to 50 users).

## What Brian does

Once, in this order. Each step is one action, then how to tell it worked.

1. Cloudflare, **Zero Trust > Access controls > Policies > Add a policy**: name `Boosters Rocket previews`, action
   Allow, include **Emails** with your email, then Save. It worked: the policy is listed; copy its id from its address.
2. Cloudflare, **My Profile > API Tokens > Create Token > Custom token**: **Account > Access: Apps and Policies > Edit**
   for your account, and **Zone > DNS > Edit** for `rhinoautomator.com` only. It worked: the summary page says the token
   is active; copy the token.
3. Cloudflare: copy the **Account ID** and **Zone ID** from the right column of `rhinoautomator.com`'s overview, and
   the linuxdev tunnel's id from **Networks > Tunnels**. It worked: three ids in hand.
4. GitHub, **Settings > Environments > New environment** `previews`; under **Deployment branches and tags** choose
   **Selected branches and tags** and add `main`. It worked: `previews` shows "1 branch rule".
5. GitHub, in `previews`: add the secrets `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_TUNNEL_ID` and
   `CF_ACCESS_POLICY_ID` (steps 1 to 3), and the variable `PREVIEW_DOMAIN` = `rhinoautomator.com`. It worked: five
   secrets and one variable listed.
6. GitHub, **Issues > Labels > New label** `preview`. It worked: the label is listed.
7. GitHub, **Settings > Developer settings > Fine-grained tokens > Generate**: this repository only, **Pull requests:
   Read** and **Issues: Read**, a year's expiry; give it to the lead for the test server. It worked: the token is shown
   once.
8. Merge this pull request and say "deploy". It worked: **Actions** lists the workflow `previews`, and the site is up.
9. Approve the test server's changes below; the lead makes them. It worked: `docker ps` there shows
   `booster-rocket-preview-proxy`, and your other sites on the tunnel still open.
10. Cloudflare, linuxdev's tunnel, **Routes > Add route > Published application**: hostname `*.rhinoautomator.com`,
    service `http://booster-rocket-preview-proxy:8080`, and move it to the **bottom** of the list. If Cloudflare made a
    DNS record named `*`, delete it (each preview makes its own). It worked: the route is last, there is no `*` record,
    and your other sites still open.
11. GitHub, **Actions > previews > Run workflow** on `main`, an open pull request's number, `up`. It worked: the run
    is green and the pull request has the label and a comment; within about ten minutes its address, in a private
    window, asks for your email and a code, then shows the preview's door at `/__preview/`.
12. The same with `down`. It worked: the label is gone, the address no longer opens, and its application is gone from
    **Access controls > Applications**.

## What the setup changes on the test server

- `~/booster-rocket` moves to `main` with the usual deploy (step 8), which brings the scripts; nothing of the site
  changes.
- `scripts/poc/preview.sh init rhinoautomator.com Cf-Access-Jwt-Assertion bmsimp` makes `~/booster-rocket-preview`
  (private) holding `.env.preview` (mode 600: the domain, the gate's header, the repository, the owner, the label, at
  most 2 previews, 7 days, and the read-only GitHub token of step 7, added by hand), a clone of the repository with no
  checkout, the Docker network `booster-rocket-preview-edge` (internal), and the container
  `booster-rocket-preview-proxy` (Caddy, pinned by digest, 96 MB, no port on the host).
- `~/n8n/docker-compose.yml`: `booster-rocket-preview-edge` added to cloudflared's `networks:` and as
  `booster-rocket-preview-edge: { external: true }` under the top-level `networks:`, then cloudflared recreated
  (`docker compose up -d cloudflared` in `~/n8n`), at a quiet time: every site on the tunnel drops for a few seconds.
  That network must stay while the file names it, or cloudflared's weekly update fails.
- One crontab line: `*/5 * * * * cd "$HOME/booster-rocket" && scripts/poc/preview.sh poll >>
  "$HOME/booster-rocket-preview/poll.log" 2>&1`.
- While a preview is up: the containers `booster-rocket-pr-<n>-app`, `-worker`, `-mailpit`, `-door` and its
  Postgres, the volumes `booster-rocket-pr-<n>-db` and `-node-modules`, the image `booster-rocket-preview-app:pr-<n>`,
  the networks `booster-rocket-pr-<n>-internal` and `-outside`, and `~/booster-rocket-preview/pr-<n>`; all removed when
  it comes down. Kept between previews: the volume `booster-rocket-preview-pnpm-store`, the pulled images (Postgres 18,
  Node 26, mailpit) and the build cache.

## Left undone

The Cloudflare API calls follow its documentation and are tested against a stand-in, not the real account. The
build cache grows until pruned by hand. A preview's seven days count from the workflow's first run; to restart them,
take it down and run it again.
