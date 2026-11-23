# A CI runner of the club's own

The CI workflow (`.github/workflows/ci.yml`) and the release workflow (`.github/workflows/release.yml`) run on
GitHub's hosted runners unless the repository variable `CI_RUNNER_LABELS` names a runner of the club's own, as a JSON
list of its labels: `["self-hosted","br-ci"]` for the one in this folder. Delete the variable and they go back to the
hosted runners.

This repository no longer uses it: it is public, so the hosted runners are free, `CI_RUNNER_LABELS` is unset, and the
runner this folder once ran for it was stopped and removed from GitHub on 2026-11-23. The folder stays for a fork, or a
club with a private repository, that wants a runner of its own.

**Never use it for a public repository.** A pull request from a fork would run its code on the machine the runner
lives on. (Fork pull requests also need the owner's approval before workflows run, but approval is not a defence.)

**Only for code the club trusts.** A job on this runner can start a privileged container in the runner's own Docker
daemon, and so become root on the machine the runner lives on. Use it only for a private repository whose code and
dependencies the club trusts; keep "Run workflows from fork pull requests" switched off in the repository's Actions
settings; never point a public repository at it. Dependabot's pull requests always run on GitHub's hosted runners,
whatever the variable says, since they bring code from elsewhere.

This folder is that runner, for a Linux machine with Docker:

- `compose.yml`: two containers in the compose project `br-ci`. `br-ci-dind` is the CI's own Docker daemon, so the
  containers a job starts never sit beside the machine's own, and `br-ci-runner` is GitHub's runner, which talks only
  to that daemon. Nothing is published on the machine and the machine's Docker socket is never mounted. Each may use up
  to three cores at a quarter of the usual weight, so anything else on the machine wins when they compete; memory is
  capped at 4 GB and 5 GB, swap included. Every container, volume and network is named `br-ci-*`.
- `Dockerfile`: GitHub's runner image plus shellcheck, PowerShell, the docker compose plugin and the GitHub CLI.
- `entrypoint.sh`: registers the runner (`register`) or runs it.
- `job-started.sh`: before each job, empties the shared `/tmp` and removes whatever an earlier job left in the CI's
  daemon (containers, networks,
  volumes; once a week unused images and old build cache), stops a server a cancelled job left running and gives the
  work folder back to the runner. It refuses to touch any daemon but `br-ci-dind`.

On four slow cores a run took about 22 minutes, the two jobs one after the other (the tests about 20, the image about
2); the first run takes longer while the images and caches fill.

## Bring it up

On the machine, as a user in the `docker` group (no sudo needed):

1. Copy this folder to `~/br-ci` and make `~/br-ci/.env` with one line naming the repository:
   `RUNNER_URL=https://github.com/<owner>/<repository>`
2. Build the runner's image: `cd ~/br-ci && docker compose build`
3. Register it, from a machine where the GitHub CLI is signed in as an admin of the repository. The token lasts an hour,
   goes straight into the container on stdin and is never written down:

   ```
   gh api -X POST repos/<owner>/<repository>/actions/runners/registration-token --jq .token \
     | ssh <host> 'cd ~/br-ci && docker compose run --rm -T br-ci-runner register'
   ```

4. Start it: `ssh <host> 'cd ~/br-ci && docker compose up -d'`
5. Check that GitHub sees it online:
   `gh api repos/<owner>/<repository>/actions/runners --jq '.runners[] | [.name, .status] | @tsv'`
6. Point CI at it: `gh variable set CI_RUNNER_LABELS -R <owner>/<repository> -b '["self-hosted","br-ci"]'`

A pull request then runs on it. CI doesn't run on pushes to `main`: before publishing a release, run it there by hand
(`gh workflow run ci.yml --ref main`) and wait for it to finish green, since the release workflow publishes only a
commit CI has passed on.

## Look after it

- Its state: `docker compose ps` and `docker stats --no-stream br-ci-dind br-ci-runner` in `~/br-ci`.
- What the CI's daemon holds, and freeing it: `docker exec br-ci-dind docker system df`, and
  `docker exec br-ci-dind docker system prune -af --volumes` (only while no job runs). Never prune the machine's own
  daemon for the CI's sake: its images, volumes and networks are the machine's other work.
- The runner updates itself. The two images are pinned by version and digest in `Dockerfile` and `compose.yml`, with
  the tools' versions and checksums beside them, and nothing proposes new ones: bump them by hand now and then, then
  `docker compose build && docker compose up -d`. The registration is kept in the volume `br-ci-state`, so a rebuilt
  container doesn't register again.

## Stop it, or take it away

- Stop it for a while: `docker compose stop` in `~/br-ci`. Delete the variable first if pull requests should run on
  GitHub's runners meanwhile: `gh variable delete CI_RUNNER_LABELS -R <owner>/<repository>`.
- Take it away: delete the variable; in `~/br-ci`, `docker compose down -v` (removes the two containers and the
  `br-ci-*` volumes and network, nothing else) and `docker image rm br-ci-runner:local`; then remove the runner from
  GitHub: `gh api -X DELETE repos/<owner>/<repository>/actions/runners/<id>`, its id from the list in step 5's
  command (`--jq '.runners[] | [.id, .name] | @tsv'`).
