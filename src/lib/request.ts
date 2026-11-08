import { headers } from "next/headers";
import { isIP } from "node:net";

const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t && isIP(t) ? t : null;
};

/**
 * The client's IP from request headers. The first X-Forwarded-For entry is whatever the
 * client sent, so it is never used: Cloudflare's own header wins, then x-real-ip, then the
 * last X-Forwarded-For hop (the one our proxy appended). Empty or malformed values count as absent.
 */
export function clientIpFrom(h: Pick<Headers, "get">): string | null {
  const cf = clean(h.get("cf-connecting-ip"));
  if (cf) return cf;
  const real = clean(h.get("x-real-ip"));
  if (real) return real;
  const hops = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return clean(hops.at(-1));
}

export async function requestIp(): Promise<string | null> {
  return clientIpFrom(await headers());
}
