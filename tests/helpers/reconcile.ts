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
