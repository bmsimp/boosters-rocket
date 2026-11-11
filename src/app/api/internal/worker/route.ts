import { isWorkerRequest } from "@/lib/jobs/worker-token";
import { runDueJobs } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404 });

/**
 * The worker container calls this every minute (scripts/worker.mjs). It runs whichever scheduled jobs are due.
 * The token is what protects this endpoint. A POST without it gets a bare 404 that says nothing about why.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isWorkerRequest(req.headers.get("authorization"))) return notFound();
  const { ran } = await runDueJobs();
  return Response.json({ ok: true, ran }, { headers: { "cache-control": "no-store" } });
}

/** A GET gets the same bare 404, with or without the token; only a POST runs anything. */
export async function GET(): Promise<Response> {
  return notFound();
}
