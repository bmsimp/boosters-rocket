import { CLIENT_IP_STAMP, withClientIp } from "@/lib/request";
import { env } from "@/env";

/**
 * How both Better Auth set-ups learn a visitor's address: from the portal, never from a header of their own choosing.
 * Better Auth reads CLIENT_IP_STAMP and nothing else (its own rate limiter, and the address it stores on a session),
 * and every request it is handed has been through withClientIp() first, which writes that header from the deployment's
 * trusted one (src/lib/request.ts) and removes one a visitor sent. Session reads from a page go through
 * stampClientIp() the same way (identity.ts).
 *
 * When the deployment says no header can be trusted (CLIENT_IP_HEADER is none), Better Auth is told so: its limiter
 * would otherwise put every visitor in one bucket per path, and a stranger's few requests would close the staff door
 * (three requests in ten seconds on its sign-in paths) and the parent door for everyone. The portal's own limits per
 * email address and per code still hold (signin-codes.ts). Read when each set-up is built.
 */
export const clientAddress = () => ({
  ipAddressHeaders: [CLIENT_IP_STAMP],
  ...(env.CLIENT_IP_HEADER === "none" ? { disableIpTracking: true } : {}),
});

/** The same Better Auth instance, with the address stamped on each request before its handler (and so its rate limiter) sees it. */
export function stampingHandler<A extends { handler: (req: Request) => Promise<Response> }>(auth: A): A {
  const handler = auth.handler;
  auth.handler = (req: Request) => handler(withClientIp(req));
  return auth;
}
