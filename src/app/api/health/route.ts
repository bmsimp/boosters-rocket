import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

const headers = { "content-type": "application/json", "cache-control": "no-store" };

/** Liveness for Docker and the deploy script. Reveals nothing beyond up/down. Not audited. */
export async function GET(): Promise<Response> {
  try {
    await db.execute(sql`select 1`);
    return new Response('{"ok":true}', { status: 200, headers });
  } catch {
    return new Response('{"ok":false}', { status: 503, headers });
  }
}
