import { env } from "@/env";

/**
 * Where Boosters Rocket Connect, the relay, lives: QBO_RELAY_URL, an origin with no trailing slash (src/env.ts). A
 * function so integration tests can replace it (vi.mock) with the fake relay, as qboEndpoints() is replaced with the
 * Intuit stub; the app has no other switch.
 */
export function qboRelayUrl(): string { return env.QBO_RELAY_URL; }
