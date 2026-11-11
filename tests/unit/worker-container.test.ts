import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const compose = readFileSync("docker-compose.poc.yml", "utf8");
const dockerfile = readFileSync("Dockerfile", "utf8");
const worker = compose.slice(compose.indexOf("\n  worker:"), compose.indexOf("\n  migrate:"));

describe("the worker container", () => {
  it("ships the worker script in the image, beside the other tools", () => {
    expect(dockerfile).toMatch(/COPY scripts\/migrate\.mjs [^\n]*scripts\/worker\.mjs[^\n]* \.\/scripts\//);
  });
  it("runs the same image as the app, in worker mode, and comes back after a restart", () => {
    expect(worker).toContain("image: booster-rocket-app:current");
    expect(worker).toContain('command: ["node", "tools/scripts/worker.mjs"]');
    expect(worker).toContain("container_name: booster-rocket-worker");
    expect(worker).toContain("restart: unless-stopped");
    expect(worker).toContain("env_file: .env.poc");
    expect(worker).not.toContain("build:");
  });
  it("has no port, no tunnel network and no HTTP health check of its own", () => {
    expect(worker).toContain("networks: [internal]");
    expect(worker).not.toContain("edge");
    expect(worker).not.toContain("ports:");
    expect(worker).toMatch(/healthcheck:\s*\n\s+disable: true/);
  });
  it("waits for the app", () => {
    expect(worker).toMatch(/depends_on:\s*\n\s+app: \{ condition: service_healthy \}/);
  });
  it("attaches no input: no stdin_open and no tty", () => {
    expect(worker).not.toContain("stdin_open");
    expect(worker).not.toContain("tty:");
  });
});
