import { CLIENT_IP_STAMP, withClientIp } from "@/lib/request";

/**
 * How both Better Auth set-ups learn a visitor's address: from the portal, never from a header of their own choosing.
 * Better Auth reads CLIENT_IP_STAMP and nothing else (its own rate limiter, and the address it stores on a session),
 * and every request it is handed has been through withClientIp() first, which writes that header from the deployment's
 * trusted one (src/lib/request.ts) and removes one a visitor sent. Session reads from a page go through
 * stampClientIp() the same way (identity.ts).
 */
export const CLIENT_ADDRESS = { ipAddressHeaders: [CLIENT_IP_STAMP] };

/** The same Better Auth instance, with the address stamped on each request before its handler (and so its rate limiter) sees it. */
export function stampingHandler<A extends { handler: (req: Request) => Promise<Response> }>(auth: A): A {
  const handler = auth.handler;
  auth.handler = (req: Request) => handler(withClientIp(req));
  return auth;
}
