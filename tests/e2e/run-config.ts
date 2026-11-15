/**
 * What one browser-test run uses, so two trees can run at once: the app's port (E2E_PORT, default 3100), the mail
 * sink's port (E2E_MAIL_PORT, default 2465) and the database (DATABASE_URL). playwright.config.ts, scripts/seed-e2e.ts
 * and the specs all ask here; nothing under src/ does. With nothing set the run is the one CI makes.
 */
import path from "node:path";
import { assertOwnDatabaseInWorktree, assertTestDatabase } from "../setup/database-url";

type Env = Record<string, string | undefined>;

/** The tree these files are in: the main tree, or one git worktree. */
const TREE = path.resolve(__dirname, "../..");

export const DEFAULT_E2E_PORT = 3100;
export const DEFAULT_E2E_MAIL_PORT = 2465;

function portFrom(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1024 && port <= 65535)) {
    throw new Error(`The browser tests refuse to run: ${name} must be a port number from 1024 to 65535 (it is "${raw}").`);
  }
  return port;
}

/** The port the app is started on and the tests open. */
export const e2ePort = (env: Env = process.env) => portFrom(env, "E2E_PORT", DEFAULT_E2E_PORT);

/** The port the mail sink listens on: scripts/seed-e2e.ts writes it into the mail settings, tests/e2e/parent-sign-in.spec.ts starts the sink there. */
export const e2eMailPort = (env: Env = process.env) => portFrom(env, "E2E_MAIL_PORT", DEFAULT_E2E_MAIL_PORT);

/** The address the tests open. */
export const e2eBaseUrl = (env: Env = process.env) => `http://localhost:${e2ePort(env)}`;

/**
 * The app sends its redirects to APP_URL and writes it into the addresses it shows. If that were another tree's
 * address, this run's browser would walk into the other tree's server, on the other tree's database.
 */
export function assertAppUrlIsThisRun(env: Env = process.env): void {
  const base = e2eBaseUrl(env), app = (env.APP_URL ?? "").replace(/\/+$/, "");
  if (e2eMailPort(env) === e2ePort(env)) {
    throw new Error(`The browser tests refuse to run: E2E_PORT and E2E_MAIL_PORT are both ${e2ePort(env)}. The app and the mail sink each need a port.`);
  }
  if (app !== base) {
    throw new Error(`The browser tests refuse to run: APP_URL must be ${base}, the address this run starts the app on (it is "${app}"). `
      + `Set APP_URL and E2E_PORT together: the app sends its redirects to APP_URL.`);
  }
}

/**
 * The database a browser-test run migrates, seeds and reads: named for tests, and never the shared one in a git
 * worktree, as for vitest (tests/setup/database-url.ts). The address holds a password and is not echoed.
 */
export function assertE2eDatabase(url: string, root = TREE, linkedWorktree?: boolean): void {
  try {
    assertTestDatabase(url);
    assertOwnDatabaseInWorktree(root, url, linkedWorktree);
  } catch (e) {
    throw new Error(`${(e as Error).message}\nThe browser tests (scripts/seed-e2e.ts, pnpm e2e) take their database from DATABASE_URL, not TEST_DATABASE_URL: `
      + `name the same private database in both.`);
  }
}
