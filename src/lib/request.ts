import { headers } from "next/headers";
import { isIP } from "node:net";
import { env } from "@/env";

/**
 * The address a request came from. This is the one place it is read; the audit log, the sign-in limits and both
 * Better Auth set-ups get it from here.
 *
 * The portal never sees the client's connection, only what the proxy in front of it says, in a request header. Which
 * header that is depends on where the portal is hosted, so it is a deployment setting: CLIENT_IP_HEADER (src/env.ts,
 * .env.example). Only that one header is read. Any other header that names an address is something the client can
 * send itself, to dodge the sign-in limits or to put a false address in the audit log.
 *
 * A header that holds a list (X-Forwarded-For: "client, proxy, proxy") is read from the right: each proxy adds the
 * address it was reached from at the end, so the last entry is the one the proxy next to the portal wrote, and
 * everything before it may have been sent by the client. An entry that is not an address makes the whole header
 * unusable; it is never skipped to reach the entry before it. With no usable header the address is unknown (null).
 */
export function clientIpFrom(h: Pick<Headers, "get">, header: string = env.CLIENT_IP_HEADER): string | null {
  if (header === "none") return null;
  const entries = (h.get(header) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return addressOf(entries.at(-1));
}

/** One entry as an address. Some hosts add the client's port ("203.0.113.7:51234", "[2001:db8::1]:51234"); it is dropped. */
function addressOf(entry: string | undefined): string | null {
  if (!entry) return null;
  if (isIP(entry)) return entry.toLowerCase();
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(entry)?.[1];
  if (v4 && isIP(v4) === 4) return v4;
  const v6 = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/i.exec(entry)?.[1];
  return v6 && isIP(v6) === 6 ? v6.toLowerCase() : null;
}

export async function requestIp(): Promise<string | null> {
  return clientIpFrom(await headers());
}

/**
 * The header Better Auth is told to read the address from (src/lib/auth/staff-auth.ts, parent-auth.ts). Better Auth
 * takes a header's value whole and can't read a list from the right, so it is never pointed at the deployment's own
 * header: the portal works the address out above and hands it over under this name. stampClientIp() writes it on
 * every request before Better Auth sees it, and removes one a client sent.
 */
export const CLIENT_IP_STAMP = "x-booster-client-ip";

/** A copy of a request's headers for Better Auth: the stamp says what clientIpFrom() found, or is absent when it found nothing. */
export function stampClientIp(h: Headers): Headers {
  const out = new Headers(h);
  const ip = clientIpFrom(h);
  if (ip) out.set(CLIENT_IP_STAMP, ip); else out.delete(CLIENT_IP_STAMP);
  return out;
}

/** The same for a whole request, for Better Auth's handler. */
export function withClientIp(req: Request): Request {
  return new Request(req, { headers: stampClientIp(req.headers) });
}
