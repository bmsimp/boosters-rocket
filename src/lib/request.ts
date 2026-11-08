import { headers } from "next/headers";
import { isIP } from "node:net";

export async function requestIp(): Promise<string | null> {
  const h = await headers();
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip")?.trim() ?? null;
  return first && isIP(first) ? first : null;
}
