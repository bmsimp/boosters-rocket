import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";

/** The shared secret between the app and its worker, derived from BETTER_AUTH_SECRET, which both containers already hold. `scripts/worker.mjs` derives the same value. */
export function workerToken(): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update("booster-rocket-worker:v1").digest("hex");
}

export function isWorkerRequest(authorization: string | null): boolean {
  const given = Buffer.from((authorization ?? "").startsWith("Bearer ") ? (authorization ?? "").slice(7) : ""), want = Buffer.from(workerToken());
  return given.length === want.length && timingSafeEqual(given, want);
}
