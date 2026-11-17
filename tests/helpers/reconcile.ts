import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { reconcileAccess, type ReconcileResult } from "@/lib/parents/reconcile";

/** The reconcile on its own, as a refresh or a staff decision runs it: its own transaction, under the roster lock. */
export async function runReconcile(o: { cause: string }): Promise<ReconcileResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    return reconcileAccess(tx, o);
  });
}

/** Holds the roster lock, as a running refresh does, from when it resolves until release() is called. */
export async function holdTheRosterLock(): Promise<{ release: () => Promise<void> }> {
  let release!: () => void, taken!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const isTaken = new Promise<void>((r) => { taken = r; });
  const held = db.transaction(async (tx) => { await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`); taken(); await released; });
  await isTaken;
  return { release: async () => { release(); await held; } };
}
