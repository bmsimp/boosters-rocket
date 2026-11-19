import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * One way in (the sign-in release, slice SI-3a; AGENTS.md, "Sign-in release" and the checklist "Page or action before
 * sign-in"): a parent's sign-in is finished only by finishParentSignin() (src/lib/auth/parent-signin-finish.ts), which
 * makes the session, asks signinStands() and completeParentSignin(), and sets the cookie, in that order. Nothing else
 * under src/ makes a parent session, sets its cookie or calls Better Auth's own sign-in or sign-up, and only the parent
 * code plugin's endpoints call the finish. A new way in goes through the finish, never beside it.
 */
const root = path.resolve(__dirname, "../..");
const FINISH = "src/lib/auth/parent-signin-finish.ts";
const PLUGIN = "src/lib/auth/parent-code-plugin.ts";

const files = readdirSync(path.join(root, "src"), { recursive: true }).map((f) => `src/${String(f).replaceAll("\\", "/")}`)
  .filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f));
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
/** The code without its comments, so a comment that names a function is not taken for a call of it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

/** What only the finish may do: make a session, set a (signed) cookie, write a session row, or sign in through the library. */
const MAKES_A_SESSION: { what: string; pattern: RegExp }[] = [
  { what: "createSession(", pattern: /\bcreateSession\s*\(/ },
  { what: "setSessionCookie(", pattern: /\bsetSessionCookie\s*\(/ },
  { what: "setSignedCookie(", pattern: /\bsetSignedCookie\s*\(/ },
  { what: "an insert into parentAuthSession", pattern: /\.insert\(\s*parentAuthSession\b/ },
  { what: "an insert into parent_auth_session", pattern: /insert\s+into\s+"?parent_auth_session\b/i },
  { what: "Better Auth's sign-in API", pattern: /\.api\s*\.\s*signIn/ },
  { what: "Better Auth's sign-up API", pattern: /\.api\s*\.\s*signUp/ },
];

describe("one way in", () => {
  it("nothing under src/ makes a parent session or sets its cookie but the finish", () => {
    const found: string[] = [];
    for (const f of files) {
      if (f === FINISH) continue;
      const s = code(read(f));
      for (const m of MAKES_A_SESSION) if (m.pattern.test(s)) found.push(`${f}: ${m.what}`);
    }
    expect(found, `Only ${FINISH} may make a parent session or set its cookie (AGENTS.md, "Sign-in release"): a new way in calls the finish.`).toEqual([]);
  });

  it("the patterns catch each way of making a session or setting its cookie", () => {
    const lines = ["await ctx.context.internalAdapter.createSession(user.id, false)", "await setSessionCookie(ctx, s)", "await ctx.setSignedCookie(name, v, secret)",
      "await tx.insert(parentAuthSession).values(row)", "await db.execute(sql`INSERT INTO parent_auth_session (id) VALUES (1)`)",
      "await auth.api.signInEmail({ body })", "await auth.api.signUpEmail({ body })"];
    lines.forEach((line, i) => expect(line).toMatch(MAKES_A_SESSION[i]!.pattern));
    expect(code("// await setSessionCookie(ctx, s)\nconst a = 1; /* createSession( */")).not.toMatch(/setSessionCookie\s*\(|createSession\s*\(/);
  });

  it("the finish is called only by the parent code plugin's endpoints", () => {
    const callers = files.filter((f) => f !== FINISH && /\bfinishParentSignin\s*\(/.test(code(read(f))));
    expect(callers, `Only ${PLUGIN} may call finishParentSignin() (AGENTS.md, "Sign-in release").`).toEqual([PLUGIN]);
    // The code door finishes through it.
    expect(code(read(PLUGIN)).match(/\bfinishParentSignin\s*\(/g)).toHaveLength(1);
  });

  it("the Set-Cookie of a sign-in is copied onto a server action's answer in one place only", () => {
    const copiers = files.filter((f) => /\bgetSetCookie\s*\(|\bparseSetCookieHeader\s*\(/.test(code(read(f))));
    expect(copiers).toEqual([]);
  });

  it("the finish still makes the session, asks signinStands() and completeParentSignin(), and sets the cookie, in that order", () => {
    const s = code(read(FINISH));
    const body = s.slice(s.indexOf("export async function finishParentSignin("));
    const at = (call: string) => {
      const i = body.search(new RegExp(`\\b${call}\\s*\\(`));
      expect(i, `${FINISH} no longer calls ${call}()`).toBeGreaterThan(-1);
      return i;
    };
    const steps = ["findUserById", "createSession", "signinStands", "deleteSession", "completeParentSignin", "setSessionCookie", "landingPath"].map(at);
    expect([...steps].sort((a, b) => a - b), `${FINISH}: the steps of a sign-in are out of order`).toEqual(steps);
    // The session is made with no family chosen, and the cookie with the long life the code door gives it.
    expect(body).toMatch(/createSession\(\s*user\.id,\s*false,\s*\{\s*familyId:\s*null\s*\}\s*\)/);
    expect(body).toMatch(/setSessionCookie\(ctx,\s*\{\s*session,\s*user\s*\},\s*false,\s*\{\s*maxAge:\s*PARENT_SESSION_COOKIE_SECONDS\s*\}\s*\)/);
    // A session refused by the last check, or ended before the end, gets no cookie.
    expect(body.slice(at("completeParentSignin"), at("setSessionCookie"))).toMatch(/if\s*\(\s*sessionEnded\s*\)\s*return/);
  });
});
