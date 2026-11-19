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
/** Where the Set-Cookie of a sign-in finished on the server is copied onto a server action's answer (an action has no endpoint of its own). */
const COPY = "src/lib/auth/parent-link-signin.ts";
/** The copy's pure part, which reads each cookie of a `Set-Cookie` header (tested on its own: session-cookie-copy.test.ts). */
const COPY_RULE = "src/lib/auth/session-cookie-copy.ts";
/** The one other file that sets a cookie through Next's cookies(): first-run setup's own session, before any parent exists. */
const SETUP_COOKIE = "src/lib/setup/session.ts";
/** Where the parent Better Auth instance is built: its plugins are the only library code that can make a session. */
const PARENT_AUTH = "src/lib/auth/parent-auth.ts";
/** The form of a set-up or reset link: the one place a link's sign-in starts (after the set that spent the link). */
const ACTION = "src/app/sign-in/password-actions.ts";

const files = readdirSync(path.join(root, "src"), { recursive: true }).map((f) => `src/${String(f).replaceAll("\\", "/")}`)
  .filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f));
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
/**
 * The code without its comments, so a comment that names a function is not taken for a call of it. A comment marker
 * inside a one-line string (a glob such as "src/**" + "/*.ts", an address) is broken first, so it can't hide the code after it.
 */
const code = (s: string) => s.replace(/(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g, (lit) => lit.replace(/\/(?=[*/])/g, "/ "))
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

/** What only the finish may do: make a session, set a (signed) cookie, write a session row, or sign in through the library. */
const MAKES_A_SESSION: { what: string; pattern: RegExp }[] = [
  { what: "createSession(", pattern: /\bcreateSession\s*\(/ },
  { what: "setSessionCookie(", pattern: /\bsetSessionCookie\s*\(/ },
  { what: "setSignedCookie(", pattern: /\bsetSignedCookie\s*\(/ },
  { what: "an insert into parentAuthSession", pattern: /\.insert\(\s*(?:[\w$]+\.)*parentAuthSession\b/ },
  { what: "an insert into parent_auth_session", pattern: /insert\s+into\s+"?parent_auth_session\b/i },
  { what: "Better Auth's sign-in API", pattern: /\.api\s*(?:\.\s*|\[\s*["'`])signIn/ },
  { what: "Better Auth's sign-up API", pattern: /\.api\s*(?:\.\s*|\[\s*["'`])signUp/ },
  { what: "createSession by name", pattern: /\[\s*["'`]createSession["'`]\s*\]/ },
  { what: "an adapter's create of a session", pattern: /\.create\(\s*\{\s*model:\s*["'`]session["'`]/ },
  { what: "an SQL insert into the session table by name", pattern: /insert\s+into\s+\$\{\s*(?:[\w$]+\.)*parentAuthSession\s*\}/i },
  { what: "setCookie(", pattern: /\.setCookie\s*\(/ },
  { what: "a Set-Cookie header written or read", pattern: /["'`]set-cookie["'`]/i },
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
      "await tx.insert(schema.parentAuthSession).values(row)", "await db.execute(sql`INSERT INTO parent_auth_session (id) VALUES (1)`)",
      "await auth.api[\"signInEmail\"]({ body })", "await auth.api.signUpEmail({ body })", "await ctx.context.internalAdapter[\"createSession\"](id)",
      "await ctx.context.adapter.create({ model: \"session\", data })", "await tx.execute(sql`insert into ${parentAuthSession} (id) values (1)`)",
      "ctx.setCookie(name, token, attributes)", "res.headers.get(\"set-cookie\")"];
    expect(lines).toHaveLength(MAKES_A_SESSION.length);
    lines.forEach((line, i) => expect(line).toMatch(MAKES_A_SESSION[i]!.pattern));
    expect(code("// await setSessionCookie(ctx, s)\nconst a = 1; /* createSession( */")).not.toMatch(/setSessionCookie\s*\(|createSession\s*\(/);
    // A comment marker inside a string hides nothing after it.
    expect(code('const glob = "src/**/*.ts"; await createSession(id); const end = "*/";')).toMatch(/createSession\s*\(/);
    expect(code('const site = "https://example.org"; await setSessionCookie(ctx, s);')).toMatch(/setSessionCookie\s*\(/);
  });

  it("the finish is called only by the parent code plugin's endpoints", () => {
    const callers = files.filter((f) => f !== FINISH && /\bfinishParentSignin\s*\(/.test(code(read(f))));
    expect(callers, `Only ${PLUGIN} may call finishParentSignin() (AGENTS.md, "Sign-in release").`).toEqual([PLUGIN]);
    // The code door and the set-up link's server-only endpoint both finish through it.
    expect(code(read(PLUGIN)).match(/\bfinishParentSignin\s*\(/g)).toHaveLength(2);
  });

  it("a set-up link's sign-in is started only by the link's form action, and only the copy names the server-only endpoint", () => {
    // The proof a link's sign-in takes is built by the set that spent the link (choosePasswordFromLink()); a caller that
    // built one from rows read out of the database could sign a person in with no password typed.
    const starters = files.filter((f) => f !== COPY && /\bsignInFromLink\s*\(/.test(code(read(f))));
    expect(starters, `Only ${ACTION} may call signInFromLink() (AGENTS.md, "Sign-in release").`).toEqual([ACTION]);
    const naming = files.filter((f) => /\bfinishLinkSignin\b/.test(code(read(f))));
    expect(naming, `Only ${PLUGIN} (which defines it) and ${COPY} may name finishLinkSignin.`).toEqual([PLUGIN, COPY].sort());
  });

  it("the Set-Cookie of a sign-in is copied onto a server action's answer in one place only", () => {
    const copiers = files.filter((f) => /\bgetSetCookie\s*\(|\bparseSetCookieHeader\s*\(/.test(code(read(f))));
    expect(copiers).toEqual([COPY, COPY_RULE].sort());
    // Next's cookies() is set only there and by first-run setup's own cookie, which no parent ever holds.
    const setters = files.filter((f) => { const s = code(read(f)); return /\bcookies\s*\(\s*\)/.test(s) && /\.set\s*\(/.test(s); });
    expect(setters).toEqual([COPY, SETUP_COOKIE].sort());
    expect(code(read(SETUP_COOKIE))).not.toMatch(/br_parent/);
  });

  it("the parent Better Auth instance has the parent code plugin and no other, so no library route makes a session", () => {
    // A plugin's routes run in node_modules, where the scans above can't read: one added here (a passkey's, say) could
    // make a session with no last check. Adding one is a decision, and its sign-in goes through the finish.
    expect([...code(read(PARENT_AUTH)).matchAll(/\bplugins\s*:\s*\[([^\]]*)\]/g)].map((m) => m[1]!.trim())).toEqual(["parentCodePlugin()"]);
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
    // Each refusal returns before the next step: no user, no session; a last check that says no, no family and no
    // cookie; a session ended before the end, no cookie.
    expect(body.slice(at("findUserById"), at("createSession"))).toMatch(/if\s*\(\s*!\s*user\s*\)\s*return\s+REFUSED\b/);
    expect(body.slice(at("createSession"), at("completeParentSignin"))).toMatch(/if\s*\(\s*!\s*\(\s*await\s+signinStands\s*\(/);
    expect(body.slice(at("deleteSession"), at("completeParentSignin"))).toMatch(/\breturn\s+REFUSED\b/);
    expect(body.slice(at("completeParentSignin"), at("setSessionCookie"))).toMatch(/if\s*\(\s*sessionEnded\s*\)\s*return/);
  });
});
