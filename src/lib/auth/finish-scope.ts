// The one finish's scope (the sign-in release, slice SI-7a, the lead's decision 3): no library path can make a parent
// session. The parent instance's first `databaseHooks.session.create.before` (src/lib/auth/parent-auth.ts) refuses every
// session that is not being made inside the finish (finishParentSignin(), parent-signin-finish.ts), which alone enters
// this scope, around its own createSession and nowhere else (tests/unit/one-way-in.test.ts). So the passkey library's
// own verify-authentication (whose createSession then answers null, and which throws before it sets any cookie), every
// route of Better Auth's own and any later plugin's are refused before a session row exists, over HTTP or by auth.api.
// Server only.
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

const finishing = new AsyncLocalStorage<true>();

/** Runs `make` (the finish's createSession) inside the scope. Called by the finish alone. */
export function whileFinishing<T>(make: () => Promise<T>): Promise<T> {
  return finishing.run(true, make);
}

/** Whether the session being made now is the finish's own. The guard asks this and nothing else. */
export function isFinishing(): boolean {
  return finishing.getStore() === true;
}
