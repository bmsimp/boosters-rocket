import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { ROSTER_LOCK } from "@/lib/roster/shape";

/** Holds the roster lock, as a running refresh does, from when it resolves until release() is called. */
export async function holdTheRosterLock(): Promise<{ release: () => Promise<void> }> {
  let release!: () => void, taken!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const isTaken = new Promise<void>((r) => { taken = r; });
  const held = db.transaction(async (tx) => { await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`); taken(); await released; });
  await isTaken;
  return { release: async () => { release(); await held; } };
}
