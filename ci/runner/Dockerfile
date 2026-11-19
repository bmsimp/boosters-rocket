# A GitHub Actions runner for this repository's CI, on a club's own machine (ci/runner/README.md).
# GitHub's own runner image, plus what .github/workflows/ci.yml and release.yml expect of ubuntu-latest that it lacks:
# shellcheck, PowerShell (pwsh), the docker compose plugin, the GitHub CLI (gh) and libatomic1, without which the Node
# that actions/setup-node downloads doesn't start. Node, pnpm and Playwright's browser come from the workflow's own steps. Every version and checksum is pinned here and bumped by hand (no Dependabot entry).
FROM ghcr.io/actions/actions-runner:2.338.2@sha256:6d0b2d80d80f143f77dcb676e50920100bbb547e39e883454d57f45ab8c31300

ARG PWSH_VERSION=7.7.0
ARG PWSH_SHA256=sha256:becb565095ba0569e1b6d18055ce1114a426523145e6e5ac856928f6b9b013c4
ARG GH_VERSION=2.105.0
ARG GH_SHA256=sha256:1dac939af3e84fb3861927c984b357531341be9403b889e4aa86e8822145a09d
ARG COMPOSE_VERSION=5.8.0
ARG COMPOSE_SHA256=sha256:b8840f5008c447f41fce0a57ae3adeab42c89b1eb6e6012524bcabbfb4ffbaf6

USER root
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates libatomic1 shellcheck; \
    curl -fsSLo /tmp/pwsh.deb "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell_${PWSH_VERSION}-1.deb_amd64.deb"; \
    echo "${PWSH_SHA256#sha256:}  /tmp/pwsh.deb" | sha256sum -c -; \
    curl -fsSLo /tmp/gh.deb "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.deb"; \
    echo "${GH_SHA256#sha256:}  /tmp/gh.deb" | sha256sum -c -; \
    apt-get install -y --no-install-recommends /tmp/pwsh.deb /tmp/gh.deb; \
    curl -fsSLo /usr/local/lib/docker/cli-plugins/docker-compose "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-x86_64"; \
    echo "${COMPOSE_SHA256#sha256:}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c -; \
    chmod 755 /usr/local/lib/docker/cli-plugins/docker-compose; \
    rm -rf /var/lib/apt/lists/* /tmp/*.deb; \
    shellcheck --version >/dev/null; pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion' >/dev/null; gh --version >/dev/null; docker compose version >/dev/null

# The runner's registration lives in /state (a volume), so the container can be made again without registering again.
# The work folder and /tmp are volumes shared with the CI's own Docker daemon (br-ci-dind) at the same paths.
RUN install -d -o runner -g runner /state /home/runner/_work
COPY --chmod=755 entrypoint.sh job-started.sh /opt/br-ci/

ENV ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/br-ci/job-started.sh
USER runner
ENTRYPOINT ["/opt/br-ci/entrypoint.sh"]
CMD ["run"]
