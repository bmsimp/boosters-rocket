// The portal's address as its passkeys know it (the sign-in release, slices SI-7a and SI-9b): one place that both the
// passkey library's relying party (parentPasskeys(), parent-auth.ts) and the portal's own record of each passkey's
// origin (addMyPasskey(), src/lib/parents/passkey-settings.ts; oldAddressPasskeys(), signin-reset.ts) read, so the
// origin a registration is verified against and the one stamped on its row can never differ. It imports only the env,
// so the parent instance and the passkeys module both import it with no cycle between them.
import { env } from "@/env";

/** The portal's address, whose host is the passkeys' relying party id and whose origin is the only one they work at. */
export const portal = () => new URL(env.APP_URL);

/** The origin a passkey is made for and works at now: APP_URL's. */
export const passkeyOrigin = () => portal().origin;
