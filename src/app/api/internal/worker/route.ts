import { isWorkerRequest } from "@/lib/jobs/worker-token";
import { runDueJobs } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404 });

/**
 * The worker container calls this every minute (scripts/worker.mjs). It runs whichever scheduled jobs are due.
 * Anything without the worker's token gets the same "Not found" as a path that doesn't exist.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isWorkerRequest(req.headers.get("authorization"))) return notFound();
  const { ran } = await runDueJobs();
  return Response.json({ ok: true, ran }, { headers: { "cache-control": "no-store" } });
}

/** Only POST does anything; every other method is "Not found" too, rather than Next's 405. */
export async function GET(): Promise<Response> {
  return notFound();
}
