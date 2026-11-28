#!/usr/bin/env node
// The preview's front page, /__preview/ (docker-compose.preview.yml, service door; docs/runbooks/pr-previews.md).
// Preview tooling only: it lives outside src/ and never ships in a club's image. It signs the visitor in as one of
// the two people scripts/seed-e2e.ts gives a live session (the Admin, and Zelda, a parent), by setting the cookie for
// that session the way tests/e2e/staff-session.ts and parent-session.ts make it: "<token>.<base64 HMAC-SHA256 of the
// token, keyed by BETTER_AUTH_SECRET>", URI-encoded, under "__Secure-" when the address is https. The secret is the
// preview's own (.env.preview); the access gate in front of the tunnel decides who reaches this page at all.
import { createServer } from "node:http";
import { createHmac } from "node:crypto";

const secret = process.env.BETTER_AUTH_SECRET ?? "";
if (secret.length < 32) { console.error("BETTER_AUTH_SECRET is required."); process.exit(2); }
const secure = new URL(process.env.APP_URL ?? "http://localhost").protocol === "https:";
const ref = process.env.PREVIEW_REF || "an unnamed branch";
const commit = process.env.APP_COMMIT || "";

const SESSIONS = {
  staff: { cookie: "br_staff.session_token", token: "e2e-staff-session-token", to: "/staff" },
  parent: { cookie: "br_parent.session_token", token: "e2e-parent-session-token", to: "/" },
};
const WEEK = 7 * 86_400;
const PORT = Number(process.env.PREVIEW_DOOR_PORT || 8080);

const cookieName = (name) => `${secure ? "__Secure-" : ""}${name}`;
const signed = (token) => encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);
const setCookie = (name, value, maxAge) => `${cookieName(name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const page = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Preview</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 1.5rem 1rem; max-width: 36rem; margin-inline: auto; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; } p { margin: .5rem 0 1rem; }
  form { margin: 0 0 .75rem; } a { display: inline-block; min-height: 48px; line-height: 48px; }
  button { font: inherit; width: 100%; min-height: 56px; border-radius: 28px; border: 1px solid currentColor; padding: 0 1.5rem; cursor: pointer; }
  code { font-size: .9em; }
</style></head><body>
<h1>Preview of ${escape(ref)}</h1>
<p>${commit ? `Commit <code>${escape(commit)}</code>. ` : ""}Test data from the e2e seed: no real family, no QuickBooks, and mail goes only to the preview's mailbox.</p>
<form method="post" action="/__preview/staff"><button type="submit">Sign in as the Admin (staff)</button></form>
<form method="post" action="/__preview/parent"><button type="submit">Sign in as Zelda (parent)</button></form>
<form method="post" action="/__preview/sign-out"><button type="submit">Sign out of both</button></form>
<p><a href="/__preview/mail/">Open the preview's mailbox</a></p>
<p>Zelda's password, for trying sign-in itself, is in tests/e2e/signin-seed.ts; her code arrives in the mailbox.</p>
</body></html>`;

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  res.setHeader("cache-control", "no-store");
  if (req.method === "GET" && (path === "/__preview" || path === "/__preview/")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" });
    res.end(page());
    return;
  }
  const which = req.method === "POST" ? path.replace(/^\/__preview\//, "") : "";
  if (Object.hasOwn(SESSIONS, which)) {
    const s = SESSIONS[which];
    res.writeHead(303, { "set-cookie": setCookie(s.cookie, signed(s.token), WEEK), location: s.to });
    res.end();
    return;
  }
  if (which === "sign-out") {
    res.writeHead(303, { "set-cookie": Object.values(SESSIONS).map((s) => setCookie(s.cookie, "", 0)), location: "/__preview/" });
    res.end();
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not here.");
});

server.listen(PORT, "0.0.0.0", () => console.log(`The preview's door is listening on ${PORT}.`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
