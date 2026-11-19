import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The release workflow (v1 spec §14): every release passes CI before `stable` moves. The image is built and pushed only
 * after a job has found CI's own run, finished green, on the release's commit.
 */
const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const release = read(".github/workflows/release.yml");
/** One job's block of the workflow: from its name to the next job's. */
const job = (name: string) => {
  const at = release.indexOf(`\n  ${name}:\n`);
  if (at < 0) throw new Error(`no job "${name}"`);
  const next = release.slice(at + 1).search(/\n {2}[a-z-]+:\n/);
  return release.slice(at, next < 0 ? undefined : at + 1 + next);
};

describe("a release publishes only a commit CI has passed on", () => {
  it("has a first job that asks GitHub for a green run of ci.yml on the release's own commit, and stops when there is none", () => {
    const gate = job("ci-passed");
    expect(gate).toContain("actions/workflows/ci.yml/runs?head_sha=${GITHUB_SHA}&status=success");
    expect(gate).toMatch(/if \[ "\$passed" -lt 1 \]; then[\s\S]*exit 1/);
    expect(gate).toMatch(/permissions:\n\s+actions: read/);
  });

  it("builds and pushes the image, stable among its tags, only after that job", () => {
    const image = job("image");
    expect(image).toMatch(/\n {4}needs: ci-passed\n/);
    expect(image).toContain("tags+=(stable)");
    expect(image).toMatch(/packages: write/);
    // Writing packages is the image job's alone.
    expect(release.slice(0, release.indexOf("\njobs:"))).not.toContain("packages: write");
  });

  it("can find CI's run for a commit on main: CI runs there by hand, as the release's own steps say", () => {
    // CI runs on pull requests and by hand only (no run on a push to main), so a release asks for one on main first.
    expect(read(".github/workflows/ci.yml")).toMatch(/\non:\n {2}pull_request:\n {2}workflow_dispatch:\n(?! )/);
    for (const doc of [".github/workflows/release.yml", "docs/runbooks/before-the-first-family.md", "ci/runner/README.md"]) {
      expect(read(doc), doc).toContain("gh workflow run ci.yml --ref main");
    }
  });
});
