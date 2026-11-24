import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { scratchDatabase } from "../setup/database-url";
import { dropScratchDatabase, makeScratchDatabase } from "../setup/worker-databases";

/**
 * Migration 0059 (Connect through Boosters Rocket's slice 1; found here by its tag, so a renumbering at a merge
 * doesn't break it): the table `qbo_relay`, and on `qbo_connection` the two modes and the pending state's, with the
 * Intuit app's keys and their environment nullable under a check, and the relay's environment in its own column. A connection made before it is the club's own app's: its modes are filled
 * `own_app`, its tokens and any connect in progress too, and nothing else of the row changes. An empty database takes
 * it as well, and a row made after it defaults to the relay.
 */
const DATABASE_WORK = 300_000;
const NAMES = { held: scratchDatabase("migrate_relay"), empty: scratchDatabase("migrate_relay_empty") };
const folders: string[] = [];

function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-relay-"));
  folders.push(folder);
  cpSync("drizzle", folder, { recursive: true });
  const journal = path.join(folder, "meta", "_journal.json");
  const j = JSON.parse(readFileSync(journal, "utf8")) as { entries: { idx: number; tag: string }[] };
  j.entries = j.entries.filter((e) => e.idx <= last);
  writeFileSync(journal, JSON.stringify(j));
  return folder;
}
const indexOf = (tag: string) => {
  const j = JSON.parse(readFileSync(path.join("drizzle", "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const e = j.entries.find((x) => x.tag.endsWith(tag));
  if (!e) throw new Error(`no migration ${tag}`);
  return e.idx;
};
const q = async <T>(url: string, f: (pg: postgres.Sql) => Promise<T>) => {
  const pg = postgres(url, { max: 1, onnotice: () => {} });
  try { return await f(pg); } finally { await pg.end(); }
};
const migrateWith = (url: string, folder: string) => q(url, (pg) => migrate(drizzle(pg), { migrationsFolder: folder }));

const HELD = NAMES.held.url, EMPTY = NAMES.empty.url;
const OLD_COLUMNS = `id, environment, client_id, client_secret_ciphertext, client_secret_key_id, state_hash, state_staff_user_id, state_expires_at, realm_id, company_name,
  access_token_ciphertext, access_token_key_id, access_expires_at, refresh_token_ciphertext, refresh_token_key_id, refresh_expires_at, connected_at, connected_by,
  last_token_refresh_at, last_error, last_error_at, updated_at`;
const oldRow = () => q(HELD, (pg) => pg.unsafe(`SELECT ${OLD_COLUMNS} FROM qbo_connection`));
const modes = (url: string) => q(url, (pg) => pg`SELECT connect_mode, token_mode, state_mode FROM qbo_connection`);

describe("migration 0059: Connect through Boosters Rocket's data", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_relay");
    await makeScratchDatabase("migrate_relay_empty");
    const before = migrationsUpTo(indexOf("_connect_relay") - 1);
    await migrateWith(HELD, before);
    await migrateWith(EMPTY, before);
    // An own-app connection to a company, with a connect in progress (an Admin signing in again to renew it).
    await q(HELD, (pg) => pg`INSERT INTO qbo_connection (environment, client_id, client_secret_ciphertext, client_secret_key_id, state_hash, state_expires_at,
        realm_id, company_name, access_token_ciphertext, access_token_key_id, access_expires_at, refresh_token_ciphertext, refresh_token_key_id, refresh_expires_at, connected_at)
      VALUES ('production', 'ABclientid1234567890', 'sealed-secret', 'k1', 'abc123', now() + interval '5 minutes',
        '9130000000000001', 'Boosters', 'sealed-at', 'k1', now() + interval '1 hour', 'sealed-rt', 'k1', now() + interval '100 days', now())`);
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAMES.held.name);
    await dropScratchDatabase(NAMES.empty.name);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("fills an own-app connection's modes own_app, its tokens' and its pending state's, and changes nothing else of the row", async () => {
    const before = await oldRow();
    expect(before).toHaveLength(1);
    await migrateWith(HELD, path.resolve("drizzle"));
    expect(await oldRow()).toEqual(before);
    expect(await modes(HELD)).toEqual([{ connect_mode: "own_app", token_mode: "own_app", state_mode: "own_app" }]);
    // The environment stays the own app's; the relay's own column is empty until a relay connect chooses one.
    expect(await q(HELD, (pg) => pg`SELECT environment, relay_environment FROM qbo_connection`)).toEqual([{ environment: "production", relay_environment: null }]);
    expect(await q(HELD, (pg) => pg`SELECT count(*)::int AS n FROM qbo_relay`)).toEqual([{ n: 0 }]);
  });

  it("leaves a configured row with no tokens and no connect in progress own_app with neither mode", async () => {
    await q(HELD, (pg) => pg`UPDATE qbo_connection SET token_mode = NULL, state_mode = NULL, refresh_token_ciphertext = NULL, refresh_token_key_id = NULL, state_hash = NULL`);
    // The check holds the keys to an own-app row from here on.
    await expect(q(HELD, (pg) => pg`UPDATE qbo_connection SET client_id = NULL`)).rejects.toThrow(/qbo_connection_own_app_keys/);
  });

  it("applies to an empty database, where a new row is the relay's and needs no keys", async () => {
    await migrateWith(EMPTY, path.resolve("drizzle"));
    await q(EMPTY, (pg) => pg`INSERT INTO qbo_connection (relay_environment) VALUES ('sandbox')`);
    expect(await modes(EMPTY)).toEqual([{ connect_mode: "relay", token_mode: null, state_mode: null }]);
    // Tokens issued through the relay need its environment.
    await expect(q(EMPTY, (pg) => pg`UPDATE qbo_connection SET token_mode = 'relay', relay_environment = NULL`)).rejects.toThrow(/qbo_connection_relay_environment/);
    const columns = await q(EMPTY, (pg) => pg`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'qbo_relay' ORDER BY ordinal_position`);
    expect(columns.map((c) => `${c.column_name as string}:${c.is_nullable as string}`)).toEqual([
      "id:NO", "public_key:NO", "private_key_ciphertext:NO", "private_key_key_id:NO", "key_made_at:NO", "key_made_by:YES",
      "portal_id:YES", "portal_id_saved_at:YES", "portal_id_saved_by:YES", "updated_at:NO"]);
  });
});
