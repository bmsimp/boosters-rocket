# Parent Email-Code Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parents sign in on the portal's own page with their email and a 6-digit code the portal sends, each parent is one
person record that can belong to several families, and the Microsoft Entra External ID parent door is removed.

**Architecture:** Code issue, checking, hashing, single use, tries and database rate limits live in portal code
(`src/lib/parents/*`) against the new `signin_code` and `rate_limit_event` tables. Better Auth's `email-otp` plugin is
**not** used: it keys codes by email in `parent_auth_verification`, counts tries in the same row, rate-limits in memory, and
signs in by email lookup, so wrapping it would mean replacing its storage, its checks and its sign-in step anyway (see
"Rulings" at the end). A small Better Auth plugin (`parent-code-plugin.ts`) exposes two endpoints that call the portal
code and then use Better Auth's own `createSession` and `setSessionCookie`, so sessions, cookies and sign-out stay Better
Auth's. Outgoing mail (Microsoft Graph with the staff app's certificate, or SMTP through nodemailer) is a new
`src/lib/mail/*` module with its settings in the `setting` table.

**Tech Stack:** Next.js 16.4.5, React 19, TypeScript strict, Drizzle 0.45 + Postgres 16, Better Auth 1.7.18, `jose` 6,
`@peculiar/x509` 3, nodemailer 10.2.1 (new), smtp-server 3.21.1 (new, dev only), Vitest, Playwright, PowerShell 7 with
the ExchangeOnlineManagement module.

**Spec:** `docs/superpowers/specs/2026-11-10-parent-email-code-sign-in-design.md`

## Global Constraints

- The code: 6 digits from `crypto.randomInt`, valid **10 minutes**, stored only as an HMAC-SHA256 hash
  (key `BETTER_AUTH_SECRET`, input `signin-code:<parent id>:<code>`), **single use**, a new code replaces any earlier
  unused code for that person, **5 wrong tries** end it, **Resend code** works 60 seconds after the last send.
- A code is sent only to a person who isn't blocked and has at least one guardian row that isn't disabled.
- Rate limits, counted in the database: codes sent to one email **3 per 15 minutes**; code requests from one IP
  **10 per 15 minutes**; code checks from one IP **30 per 15 minutes**.
- Copy, verbatim: after Send code, *"If this email belongs to a family in the club, we've sent a 6-digit code. It can take
  a minute. Check your spam folder too."*; a code check over the limit, *"Too many tries. Wait a few minutes and request a
  new code."*; before mail works, *"Parent sign-in isn't available yet."*; a parent's change to an address in use,
  *"That address is already in use. Ask the club to help."*
- Code email subject: `Your <club name> sign-in code: 123456`. The body repeats the code, says it expires in 10 minutes,
  says to ignore it if you didn't ask. **No link.** Plain text and simple HTML, club name and color, no images.
- Welcome email: *"You can now sign in to <club name> at <portal URL> with this email address. We'll email you a code each
  time."* It has no code.
- Every address is trimmed and lowercased before it is stored, matched or logged, with `normalizeEmail` from
  `src/lib/setup/state.ts`.
- Parent session: **7 days from sign-in**, never extended (`expiresIn: 604800`, `disableSessionRefresh: true`, no cookie
  cache). It holds the Better Auth user (linked one to one to `parent.id`) and `familyQboId`, nothing else. Blocking the
  person, disabling their last enabled guardian row, and changing their email delete every session they have.
- Audit actions: `signin.code_sent`, `signin.code_refused` (reasons `unknown_email`, `blocked`, `no_enabled_guardian`,
  `rate_limited`, `mail_failed`), `signin.code_wrong` (with the try number), `signin.code_expired`, `signin` (with the
  family entered), `signin.family_switch`, `signout`, `signin.refused`, `guardian.activate`, `guardian.create`,
  `guardian.remove`, `guardian.disable`, `guardian.reenable`, `guardian.welcome_sent`, `parent.create`, `parent.block`,
  `parent.unblock`, `parent.email_change`, `parent.email_change_request`, `parent.email_change_refused`,
  `parent.email_change.quickbooks_failed`, `settings.mail.save`, `settings.mail.test`, `mail.failed`. Parent actor:
  `{ door: "parent", id: parent.id, label: email }`. No audit row ever holds a code or a message body.
- **Message bodies and codes are never logged or audited.** nodemailer runs with `logger: false, debug: false`. Mail
  errors are reduced to a code and a fixed sentence before they are stored.
- `Settings.Mail.ReadWrite` is Admin-only (on `ADMIN_ONLY`).
- Graph sending: token from `https://login.microsoftonline.com/<staff tenant>/oauth2/v2.0/token`, `client_credentials`,
  `scope=https://graph.microsoft.com/.default`, `client_assertion` signed with the staff certificate
  (`signEntraAssertion`); then `POST https://graph.microsoft.com/v1.0/users/<mailbox>/sendMail`, JSON, `saveToSentItems:
  false`, expecting `202`.
- SMTP security is `starttls` (nodemailer `requireTLS: true`) or `tls` (`secure: true`), TLS 1.2 or later. There is no
  plaintext option. The password is sealed with `secretBox()`, AAD `mail:smtp-password`, and never sent to the browser.
- Dependencies: `nodemailer@10.2.1` (published 2026-10-22, MIT-0, ships its own types) and dev `smtp-server@3.21.1`
  (published 2026-10-22, MIT-0, ships its own types). Both are pinned exactly. Today's latest releases (10.5.0, 3.21.4)
  are under two weeks old and are not used.
- There is **no test-only mail path in the app**. Integration tests replace `buildSender` with `vi.mock`, or point the
  real senders at stub servers through function arguments. The e2e run sends real SMTP over TLS to a local sink whose
  certificate the e2e server process trusts through `NODE_EXTRA_CA_CERTS`. Production never sets either, and no
  environment variable switches the app to another transport.
- Next.js 16 differs from training data: before writing a page, layout, route handler or server action, read the
  matching guide in `node_modules/next/dist/docs/` (AGENTS.md).
- Every server action module under `src/app/staff/` exports only `staffAction`-wrapped functions
  (`tests/integration/invariants.test.ts`).
- US English. Times stored UTC; shown with `LocalTime` (instants) or `CalendarDate` (dates); no zone in display code.
- Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, and the build with
  `DATABASE_URL=postgres://booster:booster@localhost:5433/booster_test APP_URL=http://localhost:3100 BETTER_AUTH_SECRET=ci-fake-secret-ci-fake-secret-1234567890 SETTINGS_ENCRYPTION_KEY=Y2ktZmFrZS1rZXktY2ktZmFrZS1rZXktY2ktZmFrZSE= pnpm build`.
  E2E: `pnpm db:migrate`, `pnpm tsx scripts/seed-e2e.ts`, `pnpm e2e` (same environment). The test Postgres is the one
  already on `localhost:5433`; don't start another.
- Commit trailer, exactly: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A known email makes the server send mail, which takes a second or more, while an unknown one returns at once. The
   Send code answer must not wait for the send, or its timing tells a stranger the address is on file (Task 5 test
   "answers before the email is sent"; Task 6 test "answers the same for known, unknown, blocked and all-disabled").
2. Someone types an unknown address, goes to the code screen and enters any 6 digits. They must see the same message as a
   known parent with a wrong code; "no code was sent" must not be a different answer (Task 6 test "a code check answers
   the same for an unknown email and a wrong code").
3. A parent types ` Ana@Example.com ` on the email screen, and the code screen posts the same text again. It must work,
   and the limits must count it as `ana@example.com` (Task 5 test "matches case and spaces the same on both steps").
4. A parent double-taps **Send code** or taps **Resend code** twice. Exactly one code is live afterward, and both
   answers look the same (Task 5 test "two requests at once leave exactly one live code").
5. Staff remove the family a parent is looking at while the parent still has another family. The next request takes the
   parent to the family chooser, not to the old family and not out of the portal (Task 6 test "sends a parent back to
   choose when the chosen family goes away and another is left").

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/db/schema.ts` | `parent`, reshaped `guardian`, `signin_code`, `rate_limit_event`, `parent_email_change`; parent Better Auth user `parent_id` and session `family_qbo_id`. |
| `drizzle/0004_*.sql`, `drizzle/0005_*.sql` | Additive tables plus converting old guardian rows; then dropping the External ID columns. |
| `src/lib/parents/sessions.ts` | End all of a person's sessions; list their enabled guardian rows. |
| `src/lib/parents/people.ts` | Create or link a guardian, remove, block, unblock, students changed, resend welcome, staff email change. |
| `src/lib/parents/email-change.ts` | A parent's own email change: request, confirm, and the QuickBooks seam. |
| `src/lib/parents/rate-limit.ts` | Database rate limits by kind and subject. |
| `src/lib/parents/signin-codes.ts` | Issue and check sign-in codes. |
| `src/lib/parents/signin-copy.ts` | The sign-in page's fixed sentences (no server imports, so client code can use it). |
| `src/lib/parents/family-choice.ts` | First sign-in bookkeeping, choosing and switching family. |
| `src/lib/mail/*` | Mail types, settings, config hash, Graph and SMTP senders, sender factory, messages, `sendMail`. |
| `src/lib/auth/parent-code-plugin.ts` | Better Auth endpoints `/portal-code/send` and `/portal-code/verify`. |
| `src/lib/auth/parent-auth.ts`, `resolve.ts`, `identity.ts`, `src/lib/guards.ts` | Parent door wiring, session resolution, page and action guards. |
| `src/app/sign-in/*`, `src/app/choose-family/*`, `src/app/(parent)/layout.tsx` | Parent sign-in, family chooser, Switch family. |
| `src/app/setup/*`, `src/app/components/mail-settings/*`, `src/app/staff/(app)/settings/mail/*` | Outgoing mail step and Settings → Mail. |
| `scripts/setup/New-BoosterRocketStaffApp.ps1` | The optional mail part. |
| `tests/helpers/{db,tls,mail-sink}.ts`, `tests/e2e/*` | Seeds, a localhost TLS certificate, an SMTP sink, the e2e parent flow. |

---

### Task 1: Remove the External ID parent door

Spec §4. Afterward the parent door is closed (no way to sign in as a parent) until Task 6 opens the new one; `/sign-in`
says *"Parent sign-in isn't available yet."* Setup goes straight from staff sign-in to the first Admin until Task 7 adds
the mail step. No schema change here: the `parent-oidc` value only leaves the TypeScript enums, and leftover rows are
ignored until Task 2's migration deletes them.

**Files:**
- Delete: `src/lib/auth/parent-object-id.ts`, `src/lib/auth/parent-provider-id.ts`,
  `scripts/setup/New-BoosterRocketParentApp.ps1`, `src/app/sign-in/sign-in-button.tsx`,
  `tests/integration/parent-object-id.test.ts`, `tests/integration/parent-auth-hooks.test.ts`
- Create: `src/app/staff/sign-in/sign-in-button.tsx`
- Modify: `src/lib/db/schema.ts` (two enums), `src/lib/auth/provider-fields.ts`, `src/lib/auth/providers.ts`,
  `src/lib/auth/provider-checks.ts`, `src/lib/auth/certificates.ts`, `src/lib/auth/parent-auth.ts`,
  `src/lib/auth/resolve.ts`, `src/lib/auth/identity.ts`, `src/lib/auth/client.ts`, `src/lib/setup/state.ts`,
  `src/app/setup/{actions.ts,steps.tsx,page.tsx,instructions.tsx,setup-buttons.tsx}`,
  `src/app/setup/scripts/[name]/route.ts`, `src/app/staff/(app)/settings/sign-in/page.tsx`,
  `src/app/components/sign-in-settings/{labels.ts,provider-form.tsx}`, `src/app/sign-in/page.tsx`,
  `src/app/staff/sign-in/page.tsx`
- Test: `tests/integration/providers.test.ts`, `tests/integration/certificates.test.ts`,
  `tests/integration/auth-rebuild.test.ts`, `tests/integration/resolve.test.ts`,
  `tests/integration/setup-certificates-route.test.ts`, `tests/integration/setup-scripts-route.test.ts`,
  `tests/integration/setup-state.test.ts`, `tests/integration/bootstrap.test.ts`, `tests/unit/provider-parse.test.ts`,
  `tests/unit/secret-expiry.test.ts`, `tests/unit/setup-scripts.test.ts`

**Interfaces:**
- Produces:
  - `PROVIDER_KEYS = ["staff-microsoft", "staff-google"] as const`; `CertificateProviderKey = "staff-microsoft"`.
  - `SETUP_STEPS = ["staff", "admin"] as const`, `type SetupStep = (typeof SETUP_STEPS)[number]`,
    `isSetupStep(s: unknown): s is SetupStep` in `src/lib/setup/state.ts`. Task 7 adds `"mail"` between them.
  - `getParentAuth(): Promise<ParentAuth>` keeps its signature (no providers now).
  - `getParentIdentity()` always resolves `null` until Task 6.
  - `SignInButton({ provider, label, primary })` in `src/app/staff/sign-in/sign-in-button.tsx`, staff only.

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/providers.test.ts`, inside `describe("stored providers: Microsoft (certificate)", …)`, and
delete the tests `"loads the parent provider with its certificate"` (line 218) and
`"removes the parent provider freely, retiring its certificate"` (line 264):

```ts
  it("ignores a leftover parent-oidc row from before the parent door was removed", async () => {
    await db.execute(sql`INSERT INTO auth_provider (key, config) VALUES ('parent-oidc', '{"tenantSubdomain":"x","tenantId":"t","clientId":"c"}')`);
    invalidateProviders();
    const p = await loadProviders();
    expect(p.staffMicrosoft).toBeNull();
    expect(Object.keys(p).sort()).toEqual(["staffGoogle", "staffMicrosoft", "version"]);
    expect((await providerSummaries()).map((s) => s.key)).toEqual([]);
  });
```

Add `sql` from `drizzle-orm` and `invalidateProviders` from `@/lib/auth/providers` to that file's imports if missing.

Add to `tests/integration/setup-state.test.ts`:

```ts
  it("reads an old or unknown step as the staff step", async () => {
    await db.insert(setting).values({ key: "setup.state", value: { status: "open", step: "parent", adminEmail: null, finishedAt: null } })
      .onConflictDoUpdate({ target: setting.key, set: { value: { status: "open", step: "parent", adminEmail: null, finishedAt: null } } });
    expect((await getSetupState()).step).toBe("staff");
  });
```

Add to `tests/integration/setup-scripts-route.test.ts`:

```ts
  it("no longer serves the parent script", async () => {
    state.setup = true;
    expect((await call("New-BoosterRocketParentApp.ps1")).status).toBe(404);
  });
```

Replace the parent assertions in `tests/integration/certificates.test.ts` `"maps file names both ways and refuses anything else"`:

```ts
    expect(certificateFileName("staff-microsoft")).toBe("booster-rocket-staff.cer");
    expect(certificateKeyForFile("booster-rocket-staff.cer")).toBe("staff-microsoft");
    expect(certificateKeyForFile("booster-rocket-parents.cer")).toBeNull();
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/integration/providers.test.ts tests/integration/setup-state.test.ts tests/integration/setup-scripts-route.test.ts tests/integration/certificates.test.ts`
Expected: FAIL. The parent row loads as Microsoft (or `parent` appears in the keys), the step reads `"parent"`, the parent
script is served, and `booster-rocket-parents.cer` maps to `parent-oidc`.

- [ ] **Step 3: Narrow the provider keys**

`src/lib/db/schema.ts`: in `authProvider`, `key: text("key", { enum: ["staff-microsoft", "staff-google"] })`; in
`providerCertificate`, `providerKey: text("provider_key", { enum: ["staff-microsoft"] })`, and change its doc comment to
`/** App-generated certificates for Microsoft staff sign-in. The private key is sealed. */`.

Run: `pnpm db:generate`
Expected: `No schema changes, nothing to migrate` (text enums are TypeScript-only). If a file is generated, delete it and
its snapshot and journal entry; nothing in the database changes here.

`src/lib/auth/provider-fields.ts`, whole file:

```ts
export const PROVIDER_KEYS = ["staff-microsoft", "staff-google"] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];
export const isProviderKey = (s: string): s is ProviderKey => (PROVIDER_KEYS as readonly string[]).includes(s);
/** `replaced`: a Microsoft save switched to a replacement certificate, so the old one can come off the app registration. */
export type SaveOutcome = { ok: true; replaced?: true } | { ok: false; errors: string[] };

/** The non-secret fields each provider's form has, in display order. */
export const PROVIDER_FIELDS: Record<ProviderKey, readonly ("tenantId" | "clientId")[]> = {
  "staff-microsoft": ["tenantId", "clientId"],
  "staff-google": ["clientId"],
};

/** The sign-ins that use an app-generated certificate instead of a client secret. */
export const CERTIFICATE_PROVIDERS: readonly ProviderKey[] = ["staff-microsoft"];
export const usesCertificate = (key: ProviderKey) => CERTIFICATE_PROVIDERS.includes(key);
```

`src/lib/auth/certificates.ts`: replace the type, the predicate, `FILES` and `audience`:

```ts
export type CertificateProviderKey = "staff-microsoft";
export const isCertificateProvider = (key: ProviderKey): key is CertificateProviderKey => key === "staff-microsoft";
// …
const FILES: Record<CertificateProviderKey, "booster-rocket-staff.cer"> = { "staff-microsoft": "booster-rocket-staff.cer" };
// …
const newCertificate = (key: CertificateProviderKey) => generateCertificate(`Booster Rocket staff (${new URL(env.APP_URL).hostname})`);
```

Delete the `audience` helper. Keep the `key` parameter on `newCertificate` (the callers pass it).

`src/lib/auth/providers.ts`:
- Delete `ParentConfig`, `parentDiscoveryUrl`, the `tenantSubdomain` schema, the `"parent-oidc"` entries in `ConfigFor`,
  `ProviderDraft`, `CheckedDraft` and `SCHEMAS`, and `parent` in `LoadedProviders`.
- `readProviders` starts with `const out: LoadedProviders = { version: v, staffMicrosoft: null, staffGoogle: null };` and,
  after the Google branch, skips anything that isn't Microsoft:

```ts
    // A parent-oidc row left from before the External ID door was removed (Task 2's migration deletes it).
    if ((r.key as string) !== "staff-microsoft") continue;
    const credential = await activeAssertion(r.key, box);
    if (credential === null) {
      console.error(`[sign-in] The certificate for ${r.key} is missing or can't be decrypted; treating it as not set up.`);
      continue;
    }
    out.staffMicrosoft = { key: r.key, config: r.config as MicrosoftConfig, ...credential };
```

- `providerSummaries`: at the top of its loop add `if (!isProviderKey(r.key)) continue;`. (`removeProvider` already
  looks only at `STAFF_KEYS` and the key it was given, so it needs no change.)

`src/lib/auth/provider-checks.ts`: delete `checkParent`, `isTrustedTokenEndpoint` and the `parentDiscoveryUrl`/`ParentConfig`
imports. `checkFor` keeps two cases:

```ts
export function checkFor(draft: CheckedDraft, f: FetchFn = defaultFetch): Promise<CheckResult> {
  switch (draft.key) {
    case "staff-microsoft": return checkMicrosoft(draft.config, draft.assertion, f);
    case "staff-google": return checkGoogle();
  }
}
```

`src/app/components/sign-in-settings/labels.ts`: `PROVIDER_LABELS` keeps the two staff entries; `FIELD_LABELS` becomes
`Record<"tenantId" | "clientId", string>` without `tenantSubdomain`.

`src/app/components/sign-in-settings/provider-form.tsx`: `const fileName = "booster-rocket-staff.cer";`.

- [ ] **Step 4: Close the parent door**

`src/lib/auth/parent-auth.ts`, whole file:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/lib/db/client";
import { recordSignin, recordSignout } from "./signin-audit";
import { parentAuthUser, parentAuthSession, parentAuthAccount, parentAuthVerification } from "@/lib/db/schema";
import { env } from "@/env";

// The External ID door is gone; the portal's own email-code door replaces it (Task 6 of the email-code plan).
function buildParentAuth() {
  return betterAuth({
    appName: "Boosters Rocket",
    baseURL: env.APP_URL,
    basePath: "/api/auth/parent",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: parentAuthUser, session: parentAuthSession, account: parentAuthAccount, verification: parentAuthVerification },
    }),
    emailAndPassword: { enabled: false },
    account: { accountLinking: { enabled: false } },
    // Behind Cloudflare: the tunnel sets cf-connecting-ip and the app port is never published, so only that header is trusted.
    advanced: { cookiePrefix: "br_parent", ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    databaseHooks: {
      session: {
        create: { after: (session, ctx) => recordSignin("parent", session, ctx) },
        delete: { after: (session, ctx) => recordSignout("parent", session, ctx) },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
  });
}

export type ParentAuth = ReturnType<typeof buildParentAuth>;
let built: ParentAuth | null = null;

/** The parent Better Auth instance. */
export async function getParentAuth(): Promise<ParentAuth> {
  built ??= buildParentAuth();
  return built;
}
```

`src/lib/auth/resolve.ts`: delete `resolveGuardian` and the now-unused `guardian` and `parentAuthUser` imports. Keep the
`ParentIdentity` type as it is (Task 6 replaces it).

`src/lib/auth/identity.ts`: replace `getParentIdentity` and drop the `resolveGuardian` import:

```ts
/** No parent can sign in until the email-code door opens (Task 6 of the email-code plan replaces this). */
export async function getParentIdentity(): Promise<ParentIdentity | null> {
  return null;
}
```

`src/lib/auth/client.ts`: replace the parent comment with
`// The parent door signs in through the portal's own /portal-code endpoints; this client is used for sign-out.`

`src/app/sign-in/page.tsx`, whole file:

```tsx
import { getClubSettings } from "@/lib/settings/club";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function ParentSignIn() {
  const club = await getClubSettings();
  return (
    <main className="wrap signin">
      <h1 className="page-title">{club.name}</h1>
      <p role="status">Parent sign-in isn&apos;t available yet.</p>
      <p className="lede"><a href="/staff/sign-in">Board and staff sign in here</a></p>
    </main>
  );
}
```

`src/app/staff/sign-in/sign-in-button.tsx` (new; the old shared button loses its parent branch):

```tsx
"use client";
import { useState } from "react";
import { staffAuthClient } from "@/lib/auth/client";

const FAILED = "We couldn't start sign-in just then. Please try again in a moment.";

export function SignInButton({ provider, label, primary }: { provider: "microsoft" | "google"; label: string; primary?: boolean }) {
  const [failed, setFailed] = useState(false);
  const go = async () => {
    setFailed(false);
    try {
      const r = await staffAuthClient.signIn.social({ provider, callbackURL: "/staff", errorCallbackURL: "/refused" });
      if (r?.error) setFailed(true);
    } catch {
      setFailed(true);
    }
  };
  return (
    <>
      <button type="button" className={primary ? "btn" : "btn btn-line"} onClick={go}>{label}</button>
      {failed && <p role="alert" className="errors inline-alert">{FAILED}</p>}
    </>
  );
}
```

In `src/app/staff/sign-in/page.tsx` import it from `./sign-in-button` and drop the `door="staff"` props. Delete
`src/app/sign-in/sign-in-button.tsx`.

- [ ] **Step 5: Take the Parent step out of setup and Settings**

`src/lib/setup/state.ts`: replace the `SetupStep` type and `getSetupState`:

```ts
export const SETUP_STEPS = ["staff", "admin"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const isSetupStep = (s: unknown): s is SetupStep => (SETUP_STEPS as readonly unknown[]).includes(s);
// …
export async function getSetupState(tx?: Tx): Promise<SetupState> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, SETUP_STATE_KEY));
  const merged = { ...DEFAULT_STATE, ...((row?.value as Partial<SetupState> | undefined) ?? {}) };
  // A step this version doesn't have (for example the removed "parent" step) reads as the first step.
  return { ...merged, step: isSetupStep(merged.step) ? merged.step : "staff" };
}
```

`src/app/setup/actions.ts`: delete nothing but `goToStepAction`'s body, which becomes:

```ts
export const goToStepAction = setupAction(async (step: SetupStep): Promise<void> => {
  if (!isSetupStep(step)) redirect("/setup");
  if (step !== "staff") {
    const staffReady = (await providerSummaries()).some((s) => s.readable);
    if (!staffReady) redirect("/setup?step=staff&error=staff_first");
  }
  await updateSetupState({ step });
  redirect(`/setup?step=${step}`);
});
```

(import `isSetupStep` from `@/lib/setup/state`). `FIELD_NAMES` loses `"tenantSubdomain"` here and in
`src/app/staff/(app)/settings/sign-in/actions.ts`.

`src/app/setup/page.tsx`: `STEPS` is `[{ step: "staff", label: "1. Staff sign-in" }, { step: "admin", label: "2. First Admin" }]`;
`const step: SetupStep = isSetupStep(asked) ? asked : state.step;`; drop the `ParentStep` import and line.

`src/app/setup/steps.tsx`: delete `ParentStep`, the `ParentSteps`/`SetupParentTest` imports and the `"parent-oidc"` case of
`certificateActions` (its parameter type becomes `"staff-microsoft"`). `StaffStep` ends with
`<form action={goToStepAction.bind(null, "admin")}><button className="btn" disabled={!ready}>Next: first Admin</button></form>`;
`AdminStep`'s heading is `Step 2: First Admin` and its last form is
`<form action={goToStepAction.bind(null, "staff")}><button className="btn btn-line">Back to staff sign-in</button></form>`.

`src/app/setup/instructions.tsx`: delete `ParentSteps`. `src/app/setup/setup-buttons.tsx`: delete `SetupParentTest` and the
`parentAuthClient` and `PARENT_PROVIDER_ID` imports.

`src/app/setup/scripts/[name]/route.ts`: `SCRIPTS` holds only `["New-BoosterRocketStaffApp.ps1", "staff-microsoft"]`.

`src/app/staff/(app)/settings/sign-in/page.tsx`: drop `ParentSteps`; `steps` has the two staff keys; `scripts` is
`{ "staff-microsoft": "New-BoosterRocketStaffApp.ps1" } as const`; the lede reads *"How staff sign in. Microsoft sign-in
uses a certificate Boosters Rocket made; Google uses a client secret, which is never shown again once saved."*

Delete `scripts/setup/New-BoosterRocketParentApp.ps1`, `src/lib/auth/parent-object-id.ts`,
`src/lib/auth/parent-provider-id.ts`, `tests/integration/parent-object-id.test.ts`,
`tests/integration/parent-auth-hooks.test.ts`.

- [ ] **Step 6: Update the remaining tests**

- `tests/integration/resolve.test.ts`: delete `describe("resolveGuardian", …)` and the unused imports.
- `tests/integration/auth-rebuild.test.ts`: delete `"turns the parent door on when the parent provider is stored"` and, in
  `"has no providers before setup"`, the `getParentAuth` line and import.
- `tests/integration/certificates.test.ts`: replace every remaining `"parent-oidc"` with `"staff-microsoft"` (lines 31,
  32, 63–66, 98, 120, 122).
- `tests/integration/setup-certificates-route.test.ts` `"serves the active certificate when nothing is pending"`: use
  `seedCertificate("staff-microsoft", "active")` and `call("booster-rocket-staff.cer")`.
- `tests/integration/bootstrap.test.ts` line 24: `await updateSetupState({ step: "staff" });`.
- `tests/unit/provider-parse.test.ts`: delete `"accepts a parent provider…"` and `"builds the documented discovery URL"`.
- `tests/unit/secret-expiry.test.ts`: the helper's key type is `"staff-microsoft"` and lines 17–18 use
  `"staff-microsoft"`.
- `tests/unit/setup-scripts.test.ts`: drop `parent` and every `[["staff", staff], ["parent", parent]]` becomes
  `[["staff", staff]]`; delete `"uses the redirect URIs…"`'s parent line, `"parent script requests Domain.Read.All…"` and
  `"turns sign-up off and uses email one-time passcode"`.
- `tests/integration/signin-audit.test.ts` stays as it is in this task.

- [ ] **Step 7: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. `grep -rn "parent-oidc\|parentDiscoveryUrl\|tenantSubdomain\|ParentApp" src tests scripts` finds only
the two lines in `providers.ts` comments and the new providers test.

Run the build command from Global Constraints. Expected: it builds.

- [ ] **Step 8: Commit**

```bash
git add -A src tests scripts
git commit -m "feat(auth): remove the External ID parent door

Parents will sign in with portal email codes instead. Until that door opens, /sign-in says parent
sign-in isn't available yet, and setup goes from staff sign-in to the first Admin.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: People as records, and the migration

Spec §2 (data), §5. Adds `parent`, reshapes `guardian`, adds `signin_code`, `rate_limit_event` and
`parent_email_change`, links the parent Better Auth user to `parent.id` and gives its session a `family_qbo_id`. The
migration turns every old guardian row into a person plus a guardian row (merging by normalized email) and deletes the
External ID data. Two generated migrations are needed, because `drizzle-kit generate` asks interactively whether a new
column is a rename when one table gains and loses columns at once; the additive step never drops, the second only drops.

**Files:**
- Modify: `src/lib/db/schema.ts`, `tests/helpers/db.ts`, `scripts/seed-e2e.ts`, `scripts/seed-poc-guardian.mjs`,
  `tests/integration/seed-poc-guardian.test.ts`, `tests/integration/signin-audit.test.ts`
- Create: `drizzle/0004_parents_additive.sql` (generated, then appended), `drizzle/0005_parents_finish.sql` (generated),
  their snapshots and journal entries
- Test: `tests/integration/migrate-parents.test.ts`, `tests/integration/schema.test.ts`

**Interfaces:**
- Produces (schema): `parent`, `guardian` (columns `id, familyQboId, parentId, isPrimary, status, disabledReason,
  statusBeforeDisable, createdAt, updatedAt`), `signinCode`, `rateLimitEvent`, `parentEmailChange`; `parentAuthUser`
  gains `parentId` (uuid, not null, unique, FK `parent.id` on delete cascade); `parentAuthSession` gains
  `familyQboId` (text, null).
- Produces (types): `type GuardianStatus = "invited" | "active" | "disabled"`,
  `type DisabledReason = "no_active_students" | "removed"` exported from `schema.ts`.
- Produces (`tests/helpers/db.ts`):
  - `seedParent(o: { name: string; email?: string; phone?: string | null; blocked?: boolean }): Promise<ParentRow & { authUserId: string }>`
  - `seedGuardian(o: { parentId: string; familyQboId: string; status?: GuardianStatus; isPrimary?: boolean; disabledReason?: DisabledReason | null; statusBeforeDisable?: "invited" | "active" | null }): Promise<GuardianRow>`
  - `seedParentSession(authUserId: string, o?: { familyQboId?: string | null; expiresAt?: Date }): Promise<{ id: string; token: string }>`

- [ ] **Step 1: Write the failing migration test**

`tests/integration/migrate-parents.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const ADMIN_URL = "postgres://booster:booster@localhost:5433/postgres";
const NAME = "booster_migrate_parents_test";
const DB_URL = `postgres://booster:booster@localhost:5433/${NAME}`;
let oldFolder = "";

async function migrateWith(folder: string) {
  const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
  await migrate(drizzle(pg), { migrationsFolder: folder });
  await pg.end();
}

describe("migration to person records", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${NAME}`);
    await admin.end();
    // The database as it was before this plan: migrations up to 0003 only.
    oldFolder = mkdtempSync(path.join(tmpdir(), "br-migrate-"));
    cpSync("drizzle", oldFolder, { recursive: true });
    const journal = path.join(oldFolder, "meta", "_journal.json");
    const j = JSON.parse(readFileSync(journal, "utf8")) as { entries: { idx: number }[] };
    j.entries = j.entries.filter((e) => e.idx <= 3);
    writeFileSync(journal, JSON.stringify(j));
    await migrateWith(oldFolder);

    const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
    await pg`INSERT INTO guardian (id, family_qbo_id, name, email, phone, is_primary, identity_object_id, status, created_at) VALUES
      ('00000000-0000-0000-0000-000000000001', 'F1', 'Ana Ramirez', ' Ana@Example.com ', '555-0100', true,  'oid-a',  'active',   '2026-11-01T00:00:00Z'),
      ('00000000-0000-0000-0000-000000000002', 'F2', 'Ana R',       'ana@example.com',   null,       false, 'oid-a2', 'invited',  '2026-11-02T00:00:00Z'),
      ('00000000-0000-0000-0000-000000000003', 'F1', 'Ana Again',   'ANA@example.com',   null,       false, null,     'invited',  '2026-11-03T00:00:00Z'),
      ('00000000-0000-0000-0000-000000000004', 'F3', 'Ben Lee',     'ben@example.com',   null,       true,  null,     'disabled', '2026-11-01T00:00:00Z')`;
    await pg`INSERT INTO parent_auth_user (id, name, email, email_verified, object_id) VALUES ('old-1', 'Ana', 'ana@example.com', true, 'oid-a')`;
    await pg`INSERT INTO auth_provider (key, config) VALUES ('parent-oidc', ${pg.json({ tenantSubdomain: "x", tenantId: "t", clientId: "c" })})`;
    await pg`INSERT INTO setting (key, value) VALUES ('setup.state', ${pg.json({ status: "open", step: "parent", adminEmail: null, finishedAt: null })})`;
    await pg.end();

    await migrateWith(path.resolve("drizzle"));
  });

  afterAll(async () => {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
    rmSync(oldFolder, { recursive: true, force: true });
  });

  const q = async <T>(f: (pg: postgres.Sql) => Promise<T>) => {
    const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
    try { return await f(pg); } finally { await pg.end(); }
  };

  it("makes one person per normalized email, from that email's earliest row", async () => {
    const rows = await q((pg) => pg`SELECT name, email, phone, blocked FROM parent ORDER BY email`);
    expect(rows).toEqual([
      { name: "Ana Ramirez", email: "ana@example.com", phone: "555-0100", blocked: false },
      { name: "Ben Lee", email: "ben@example.com", phone: null, blocked: false },
    ]);
  });

  it("keeps one guardian row per family and person, all pointing at the same person", async () => {
    const rows = await q((pg) => pg`SELECT g.id, g.family_qbo_id, g.status, g.is_primary, p.email
      FROM guardian g JOIN parent p ON p.id = g.parent_id ORDER BY p.email, g.family_qbo_id`);
    expect(rows.map((r) => [r.email, r.family_qbo_id, r.status, r.is_primary])).toEqual([
      ["ana@example.com", "F1", "active", true],
      ["ana@example.com", "F2", "invited", false],
      ["ben@example.com", "F3", "disabled", true],
    ]);
    expect(rows[0]!.id).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("gives an old disabled row a reason, so adding the guardian back restores it", async () => {
    const [r] = await q((pg) => pg`SELECT disabled_reason, status_before_disable FROM guardian WHERE id = '00000000-0000-0000-0000-000000000004'`);
    expect(r).toEqual({ disabled_reason: "removed", status_before_disable: "invited" });
  });

  it("drops External ID data and gives each person exactly one sign-in user", async () => {
    const users = await q((pg) => pg`SELECT u.id, u.email, u.parent_id, p.email AS parent_email FROM parent_auth_user u JOIN parent p ON p.id = u.parent_id`);
    expect(users.map((u) => u.email).sort()).toEqual(["ana@example.com", "ben@example.com"]);
    expect(users.every((u) => u.email === u.parent_email)).toBe(true);
    expect(users.some((u) => u.id === "old-1")).toBe(false);
    const cols = await q((pg) => pg`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('guardian', 'parent_auth_user')`);
    const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
    for (const gone of ["guardian.name", "guardian.email", "guardian.phone", "guardian.identity_object_id", "parent_auth_user.object_id"]) expect(names).not.toContain(gone);
    expect(await q((pg) => pg`SELECT key FROM auth_provider WHERE key = 'parent-oidc'`)).toHaveLength(0);
  });

  it("moves an open setup from the old parent step to the mail step", async () => {
    const [s] = await q((pg) => pg`SELECT value->>'step' AS step FROM setting WHERE key = 'setup.state'`);
    expect(s!.step).toBe("mail");
  });

  it("refuses a second row for the same person in the same family", async () => {
    await expect(q((pg) => pg`INSERT INTO guardian (family_qbo_id, parent_id, status)
      SELECT 'F1', parent_id, 'invited' FROM guardian WHERE id = '00000000-0000-0000-0000-000000000001'`)).rejects.toThrow(/guardian_family_parent_uq/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/integration/migrate-parents.test.ts`
Expected: FAIL, because there is no `parent` table.

- [ ] **Step 3: Add the new tables and columns (additive)**

In `src/lib/db/schema.ts`, add `integer` to the `drizzle-orm/pg-core` import and `type PgColumnBuilderBase` (a separate
`import type { PgColumnBuilderBase } from "drizzle-orm/pg-core";`). If drizzle 0.45 names that type differently, check
`node_modules/drizzle-orm/pg-core/columns/common.d.ts` and use its base column-builder type.

Before `guardian`, add:

```ts
export type GuardianStatus = "invited" | "active" | "disabled";
export type DisabledReason = "no_active_students" | "removed";

/** One record per parent, whatever families they're in (spec §2). Everything refers to the id, never to the email. */
export const parent = pgTable("parent", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(), // stored trimmed + lower-cased
  phone: text("phone"),
  blocked: boolean("blocked").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [uniqueIndex("parent_email_uq").on(t.email)]);
```

Change `guardian` for now to (old columns kept until Step 6; `parentId` nullable until the data is converted):

```ts
/** "This person is a guardian in this family." */
export const guardian = pgTable("guardian", {
  id: uuid("id").primaryKey().defaultRandom(),
  familyQboId: text("family_qbo_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  isPrimary: boolean("is_primary").notNull().default(false),
  identityObjectId: text("identity_object_id"),
  parentId: uuid("parent_id").references(() => parent.id, { onDelete: "restrict" }),
  status: text("status", { enum: ["invited", "active", "disabled"] }).notNull().default("invited"),
  disabledReason: text("disabled_reason", { enum: ["no_active_students", "removed"] }),
  statusBeforeDisable: text("status_before_disable", { enum: ["invited", "active"] }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("guardian_object_uq").on(t.identityObjectId),
  index("guardian_family_ix").on(t.familyQboId),
  index("guardian_parent_ix").on(t.parentId),
]);
```

After `guardian`, add:

```ts
/** Sign-in codes (spec §1). Only the hash is stored; only the latest unused code per person exists. */
export const signinCode = pgTable("signin_code", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentId: uuid("parent_id").notNull().references(() => parent.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  tries: integer("tries").notNull().default(0),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: created(),
}, (t) => [uniqueIndex("signin_code_one_live").on(t.parentId).where(sql`used_at IS NULL`)]);

/** One row per counted event; rate-limit.ts counts rows in a sliding window (spec §1 Rate limits). */
export const rateLimitEvent = pgTable("rate_limit_event", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").notNull(),
  subject: text("subject").notNull(), // a normalized email or an IP address
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("rate_limit_event_ix").on(t.kind, t.subject, t.at)]);

/** A parent's own email change waiting for the confirm link (spec §2 Email changes). The token is stored hashed. */
export const parentEmailChange = pgTable("parent_email_change", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentId: uuid("parent_id").notNull().references(() => parent.id, { onDelete: "cascade" }),
  newEmail: text("new_email").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: created(),
}, (t) => [
  uniqueIndex("parent_email_change_token_uq").on(t.tokenHash),
  uniqueIndex("parent_email_change_one_live").on(t.parentId).where(sql`used_at IS NULL`),
]);
```

Change `authTables` to take extra session columns too, with a builder type wide enough for a uuid foreign key:

```ts
function authTables<
  U extends Record<string, PgColumnBuilderBase> = Record<never, never>,
  S extends Record<string, PgColumnBuilderBase> = Record<never, never>,
>(prefix: "staff_auth" | "parent_auth", extraUser: U = {} as U, extraSession: S = {} as S) {
```

and spread `...extraSession,` in the session table after `userAgent`. The parent call becomes, for now:

```ts
const parentAuth = authTables("parent_auth",
  { objectId: text("object_id"), parentId: uuid("parent_id").unique().references(() => parent.id, { onDelete: "cascade" }) },
  { familyQboId: text("family_qbo_id") });
```

Update the `auditLog.actorId` comment to `// staff_user.id, parent.id, or null for system`.

Run: `pnpm db:generate --name parents_additive`
Expected: `drizzle/0004_parents_additive.sql` creating `parent`, `signin_code`, `rate_limit_event`,
`parent_email_change`, and adding `guardian.parent_id`, `guardian.disabled_reason`, `guardian.status_before_disable`,
`parent_auth_user.parent_id` (with its unique constraint), `parent_auth_session.family_qbo_id`, and the foreign keys. No
prompt appears and no `DROP` is in the file.

- [ ] **Step 4: Append the data conversion to 0004**

At the end of `drizzle/0004_parents_additive.sql` (after the last generated statement), add:

```sql
--> statement-breakpoint
-- Spec §5: each old guardian row becomes one person (merged by normalized email; the earliest row names them) plus its row.
INSERT INTO "parent" ("name", "email", "phone", "created_at", "updated_at")
SELECT DISTINCT ON (lower(btrim("email"))) "name", lower(btrim("email")), "phone", "created_at", "updated_at"
FROM "guardian" ORDER BY lower(btrim("email")), "created_at";
--> statement-breakpoint
UPDATE "guardian" g SET "parent_id" = p."id" FROM "parent" p WHERE p."email" = lower(btrim(g."email"));
--> statement-breakpoint
-- One row per person per family: keep the enabled one, then the primary one, then the oldest.
DELETE FROM "guardian" g USING (
  SELECT "id", row_number() OVER (PARTITION BY "family_qbo_id", "parent_id"
    ORDER BY ("status" <> 'disabled') DESC, "is_primary" DESC, "created_at") AS n
  FROM "guardian"
) d WHERE g."id" = d."id" AND d.n > 1;
--> statement-breakpoint
UPDATE "guardian" SET "disabled_reason" = 'removed', "status_before_disable" = 'invited' WHERE "status" = 'disabled';
--> statement-breakpoint
-- External ID accounts can't sign in any more; their sessions and accounts go with them (cascade).
DELETE FROM "parent_auth_user";
--> statement-breakpoint
INSERT INTO "parent_auth_user" ("id", "name", "email", "email_verified", "parent_id")
SELECT gen_random_uuid()::text, "name", "email", true, "id" FROM "parent";
--> statement-breakpoint
DELETE FROM "provider_certificate" WHERE "provider_key" = 'parent-oidc';
--> statement-breakpoint
DELETE FROM "auth_provider" WHERE "key" = 'parent-oidc';
--> statement-breakpoint
UPDATE "setting" SET "value" = jsonb_set("value", '{step}', '"mail"') WHERE "key" = 'setup.state' AND "value"->>'step' = 'parent';
```

Editing a generated migration before it has been applied anywhere is safe: the migrator records a hash when it applies
a file, and nothing has applied 0004 yet.

- [ ] **Step 5: Drop the External ID columns (second migration)**

In `src/lib/db/schema.ts`, the final `guardian`:

```ts
/** "This person is a guardian in this family." Name, email and phone live on the person (`parent`). */
export const guardian = pgTable("guardian", {
  id: uuid("id").primaryKey().defaultRandom(),
  familyQboId: text("family_qbo_id").notNull(),
  parentId: uuid("parent_id").notNull().references(() => parent.id, { onDelete: "restrict" }),
  isPrimary: boolean("is_primary").notNull().default(false),
  status: text("status", { enum: ["invited", "active", "disabled"] }).notNull().default("invited"),
  disabledReason: text("disabled_reason", { enum: ["no_active_students", "removed"] }),
  statusBeforeDisable: text("status_before_disable", { enum: ["invited", "active"] }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("guardian_family_parent_uq").on(t.familyQboId, t.parentId),
  index("guardian_family_ix").on(t.familyQboId),
  index("guardian_parent_ix").on(t.parentId),
]);
```

and the final parent Better Auth tables:

```ts
const parentAuth = authTables("parent_auth",
  { parentId: uuid("parent_id").notNull().unique().references(() => parent.id, { onDelete: "cascade" }) },
  { familyQboId: text("family_qbo_id") });
```

Run: `pnpm db:generate --name parents_finish`
Expected: `drizzle/0005_parents_finish.sql` that drops `guardian.name`, `email`, `phone`, `identity_object_id`, the
`guardian_object_uq` index and `parent_auth_user.object_id`, sets `NOT NULL` on `guardian.parent_id` and
`parent_auth_user.parent_id`, and creates `guardian_family_parent_uq`. No prompt appears. If drizzle-kit does prompt
(it shouldn't: no table gains and loses a column in this step), answer "create column" for every new name.

- [ ] **Step 6: Update the test helpers and seeds**

`tests/helpers/db.ts`: add `"parent", "signin_code", "rate_limit_event", "parent_email_change"` to `TABLES`, import
`parent, parentAuthUser, parentAuthSession` and the two types from the schema, and replace `seedGuardian`:

```ts
export type ParentRow = typeof parent.$inferSelect;
export type GuardianRow = typeof guardian.$inferSelect;

export async function seedParent(o: { name: string; email?: string; phone?: string | null; blocked?: boolean }): Promise<ParentRow & { authUserId: string }> {
  const email = (o.email ?? `${o.name.toLowerCase().replace(/\s+/g, ".")}@example.com`).trim().toLowerCase();
  const [p] = await db.insert(parent).values({ name: o.name, email, phone: o.phone ?? null, blocked: o.blocked ?? false }).returning();
  const [u] = await db.insert(parentAuthUser).values({ id: crypto.randomUUID(), name: o.name, email, emailVerified: true, parentId: p!.id }).returning();
  return { ...p!, authUserId: u!.id };
}

export async function seedGuardian(o: {
  parentId: string; familyQboId: string; status?: GuardianStatus; isPrimary?: boolean;
  disabledReason?: DisabledReason | null; statusBeforeDisable?: "invited" | "active" | null;
}): Promise<GuardianRow> {
  const [g] = await db.insert(guardian).values({
    parentId: o.parentId, familyQboId: o.familyQboId, status: o.status ?? "active", isPrimary: o.isPrimary ?? false,
    disabledReason: o.disabledReason ?? null, statusBeforeDisable: o.statusBeforeDisable ?? null,
  }).returning();
  return g!;
}

/** A live parent session row, as Better Auth would store it. */
export async function seedParentSession(authUserId: string, o: { familyQboId?: string | null; expiresAt?: Date } = {}) {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  await db.insert(parentAuthSession).values({ id, token, userId: authUserId, familyQboId: o.familyQboId ?? null,
    expiresAt: o.expiresAt ?? new Date(Date.now() + 7 * 86_400_000) });
  return { id, token };
}
```

`tests/integration/signin-audit.test.ts`: the three `db.insert(parentAuthUser).values({ id: "p1", … })` lines become
`const p = await seedParent({ name: "Ana", email: "ana@example.com" });`, and `"p1"` in those tests becomes
`p.authUserId` (import `seedParent` from `../helpers/db`).

`tests/integration/schema.test.ts`: add, next to the staff email test,

```ts
  it("rejects two people with the same email", async () => {
    await seedParent({ name: "Ana", email: "ana@example.com" });
    await expect(seedParent({ name: "Ana Again", email: " ANA@example.com " })).rejects.toThrow();
  });
```

(import `seedParent` from `../helpers/db`).

`scripts/seed-e2e.ts`: replace the guardian insert with:

```ts
  const [p] = await sql`INSERT INTO parent (name, email) VALUES ('Zelda Quetzalcoatl', 'zelda@example.com')
          ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
  await sql`INSERT INTO parent_auth_user (id, name, email, email_verified, parent_id)
          VALUES (${crypto.randomUUID()}, 'Zelda Quetzalcoatl', 'zelda@example.com', true, ${p!.id}) ON CONFLICT (parent_id) DO NOTHING`;
  await sql`INSERT INTO guardian (family_qbo_id, parent_id, is_primary, status) VALUES ('E2E-FAMILY', ${p!.id}, true, 'active')
          ON CONFLICT (family_qbo_id, parent_id) DO NOTHING`;
```

`scripts/seed-poc-guardian.mjs`, whole file:

```js
// Seeds one test guardian for the proof of concept: the person (made once per email) and their row in one family.
// Refuses anywhere but portaltest. It sends no email; the tester signs in at /sign-in with a code.
import postgres from "postgres";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";

const USAGE = "Usage: node scripts/seed-poc-guardian.mjs --name <name> --email <email> --family <family-id>";
const fail = (msg) => { console.error(msg); process.exit(1); };

const { DATABASE_URL, APP_URL } = process.env;
if (!DATABASE_URL) fail("DATABASE_URL is not set");
if (!APP_URL || !APP_URL.includes("portaltest")) fail("This script only runs against the portaltest proof of concept (APP_URL must contain 'portaltest').");

let values;
try {
  ({ values } = parseArgs({ options: { name: { type: "string" }, email: { type: "string" }, family: { type: "string" } } }));
} catch {
  fail(USAGE);
}
const name = values.name?.trim();
const email = values.email?.trim().toLowerCase();
const family = values.family?.trim();
if (!name || !email || !family) fail(USAGE);

class AlreadyThere extends Error {}
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {}, connect_timeout: 10 });
const actor = "seed-poc-guardian";
try {
  const id = await sql.begin(async (tx) => {
    let [p] = await tx`select id from parent where email = ${email}`;
    if (!p) {
      [p] = await tx`insert into parent (name, email) values (${name}, ${email}) returning id`;
      await tx`insert into parent_auth_user (id, name, email, email_verified, parent_id) values (${randomUUID()}, ${name}, ${email}, true, ${p.id})`;
      await tx`insert into audit_log (door, actor_label, action, target_type, target_id, after)
               values ('system', ${actor}, 'parent.seed', 'parent', ${p.id}, ${sql.json({ name, email })})`;
    }
    const [g] = await tx`insert into guardian (family_qbo_id, parent_id, is_primary, status) values (${family}, ${p.id}, true, 'invited')
                         on conflict (family_qbo_id, parent_id) do nothing returning id`;
    if (!g) throw new AlreadyThere();
    await tx`insert into audit_log (door, actor_label, action, target_type, target_id, after)
             values ('system', ${actor}, 'guardian.seed', 'guardian', ${g.id}, ${sql.json({ parentId: p.id, familyQboId: family, status: "invited" })})`;
    return g.id;
  });
  console.log(`seeded guardian ${id}`);
} catch (e) {
  if (e instanceof AlreadyThere) console.error("That person is already a guardian in that family. Nothing was changed.");
  else console.error("Seeding failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
```

`tests/integration/seed-poc-guardian.test.ts`: `ARGS` drops `--object-id …`; the first test expects one `parent` row
`{ name: "Test Parent", email: "test.parent@example.com" }`, one guardian row
`{ familyQboId: "POC-FAMILY-1", status: "invited", isPrimary: true, parentId: <that parent's id> }`, one
`parent_auth_user` row with that `parentId`, and audit actions `["parent.seed", "guardian.seed"]` in order. The third
test is renamed `"refuses a second row for the same person and family, plainly, and writes no audit row"`, expects
`"That person is already a guardian in that family"`, and expects 2 audit rows. Add:

```ts
  it("links the same person into a second family without a second person", async () => {
    expect(run("https://portaltest.rhinoautomator.com", ARGS).status).toBe(0);
    expect(run("https://portaltest.rhinoautomator.com", [...ARGS.slice(0, 4), "--family", "POC-FAMILY-2"]).status).toBe(0);
    expect(await db.select().from(parent)).toHaveLength(1);
    expect((await db.select().from(guardian)).map((g) => g.familyQboId).sort()).toEqual(["POC-FAMILY-1", "POC-FAMILY-2"]);
  });
```

(`ARGS.slice(0, 4)` is `--name … --email …`; import `parent` from the schema.)

- [ ] **Step 7: Run everything**

Run: `pnpm vitest run tests/integration/migrate-parents.test.ts tests/integration/migrate-script.test.ts tests/integration/seed-poc-guardian.test.ts`
Expected: PASS.

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/schema.ts drizzle tests scripts/seed-e2e.ts scripts/seed-poc-guardian.mjs
git commit -m "feat(db): parents are person records; guardian rows link a person to a family

Old guardian rows become one person per normalized email plus their rows; External ID columns,
accounts and the parent provider are dropped. Adds sign-in code, rate-limit and email-change tables.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Outgoing mail

Spec §3. Mail settings, the two senders, the messages, and one `sendMail` that every caller uses. The mail settings count
as working only when the last successful test was sent with exactly the settings now saved (a hash of the stored
config). A failure is audited as `mail.failed` with the provider's error, never the body, and raises the staff warning
until a later send succeeds. No UI in this task (Task 7).

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `.gitignore`, `tests/helpers/db.ts`
- Create: `src/lib/mail/types.ts`, `src/lib/mail/config-hash.ts`, `src/lib/mail/messages.ts`, `src/lib/mail/graph.ts`,
  `src/lib/mail/smtp.ts`, `src/lib/mail/senders.ts`, `src/lib/mail/settings.ts`, `src/lib/mail/send.ts`,
  `tests/helpers/tls.ts`, `tests/helpers/mail-sink.ts`
- Test: `tests/unit/mail-messages.test.ts`, `tests/unit/mail-form.test.ts`, `tests/integration/mail-graph.test.ts`,
  `tests/integration/mail-smtp.test.ts`, `tests/integration/mail-settings.test.ts`

**Interfaces:**
- Consumes: `signEntraAssertion`, `CLIENT_ASSERTION_TYPE`, `AssertionKey` (`client-assertion.ts`); `loadProviders`
  (`staffMicrosoft`); `secretBox`, `SecretBoxError`; `writeAudit`, `Actor`; `getClubSettings`; `normalizeEmail`.
- Produces (`types.ts`):
  - `type MailMessage = { to: string; subject: string; text: string; html: string }`
  - `type MailSender = (m: MailMessage) => Promise<void>` (throws `MailSendError`)
  - `class MailSendError extends Error` — its message is safe to show staff and to audit
  - `type SmtpSecurity = "starttls" | "tls"`
  - `type StoredMailConfig = { method: "graph"; mailbox: string } | { method: "smtp"; host: string; port: number; security: SmtpSecurity; username: string; from: string; passwordCiphertext: string; passwordKeyId: string }`
  - `type MailPurpose = "signin_code" | "welcome" | "email_change_confirm" | "email_change_notice" | "test"`
- Produces (`config-hash.ts`, no server imports): `mailConfigHash(c: StoredMailConfig): string`
- Produces (`messages.ts`): `type Brand = { clubName: string; color: string }`;
  `signinCodeMessage(b: Brand, to: string, code: string): MailMessage`;
  `welcomeMessage(b: Brand, to: string, o: { appUrl: string; familyLabel: string | null }): MailMessage`;
  `emailChangeConfirmMessage(b: Brand, to: string, o: { link: string }): MailMessage`;
  `emailChangeNoticeMessage(b: Brand, to: string, o: { byStaff: boolean }): MailMessage`;
  `testMessage(b: Brand, to: string): MailMessage`
- Produces (`graph.ts`): `type GraphEndpoints = { login: string; graph: string }`, `GRAPH_ENDPOINTS`,
  `createGraphSender(o: { tenantId: string; clientId: string; assertion: AssertionKey; mailbox: string; fromName: string; endpoints?: GraphEndpoints }): MailSender`,
  `clearGraphTokenCache(): void`
- Produces (`smtp.ts`): `createSmtpSender(o: { host: string; port: number; security: SmtpSecurity; username: string; password: string; from: string; fromName: string; tls?: { ca?: string } }): MailSender`
- Produces (`senders.ts`): `SMTP_PASSWORD_AAD = "mail:smtp-password"`;
  `buildSender(stored: StoredMailConfig, brand: Brand): Promise<MailSender>` — the one seam tests replace with
  `vi.mock("@/lib/mail/senders", …)`.
- Produces (`settings.ts`):
  - `MAIL_KEY = "mail"`, `MAIL_STATUS_KEY = "mail.status"`
  - `type MailStatus = { verifiedHash: string | null; verifiedAt: string | null; lastSuccessAt: string | null; lastFailureAt: string | null; lastError: string | null }`
  - `type MailDraft = { method: "graph"; mailbox: string } | { method: "smtp"; host: string; port: number; security: SmtpSecurity; username: string; from: string; password: string | null }`
  - `type MailConfigView = { method: "graph"; mailbox: string } | { method: "smtp"; host: string; port: number; security: SmtpSecurity; username: string; from: string }`
  - `type MailSummary = { config: MailConfigView | null; passwordSaved: boolean; passwordReadable: boolean; working: boolean; status: MailStatus; graphAvailable: boolean }`
  - `getStoredMailConfig(tx?: Tx): Promise<StoredMailConfig | null>`, `getMailStatus(tx?: Tx): Promise<MailStatus>`,
    `patchMailStatus(patch: Partial<MailStatus>, tx?: Tx): Promise<void>`
  - `mailWorking(): Promise<boolean>`, `mailSummary(): Promise<MailSummary>`
  - `parseMailForm(fields: Record<string, string>): { ok: true; draft: MailDraft } | { ok: false; errors: string[] }`
  - `saveMailSettings(draft: MailDraft, o: { actor: Actor; ip: string | null; permission?: string }): Promise<{ ok: true } | { ok: false; errors: string[] }>`
  - `type MailAttention = { kind: "not_set_up" | "not_tested" | "failing"; lastError: string | null; since: string | null }`,
    `mailAttention(): Promise<MailAttention | null>`
- Produces (`send.ts`):
  - `type SendOutcome = { ok: true } | { ok: false; error: string }`
  - `currentBrand(): Promise<Brand>`
  - `sendMail(m: MailMessage, o: { purpose: MailPurpose; actor?: Actor; ip?: string | null }): Promise<SendOutcome>`
  - `sendTestMail(rawTo: string, o: { actor: Actor; ip: string | null; permission?: string }): Promise<SendOutcome>`
- Produces (test helpers): `localhostCertificate(): Promise<{ key: string; cert: string }>` in `tests/helpers/tls.ts`;
  `startMailSink(o): Promise<MailSink>` in `tests/helpers/mail-sink.ts`;
  `seedWorkingMail(config?: StoredMailConfig): Promise<void>` in `tests/helpers/db.ts`.

- [ ] **Step 1: Add the dependencies**

Run: `pnpm add nodemailer@10.2.1 && pnpm add -D smtp-server@3.21.1`
Expected: `package.json` lists `"nodemailer": "10.2.1"` and, under devDependencies, `"smtp-server": "3.21.1"`. Pin both
exactly (remove any `^`). Both ship their own type definitions; add no `@types/*` package.

Add `/.e2e/` to `.gitignore` under `# testing`.

- [ ] **Step 2: Write the failing unit tests**

`tests/unit/mail-messages.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { signinCodeMessage, welcomeMessage, emailChangeConfirmMessage, emailChangeNoticeMessage, testMessage } from "@/lib/mail/messages";

const b = { clubName: "FZN <Band> Boosters", color: "#5b2a86" };

describe("mail messages", () => {
  it("puts the code in the subject and body, says 10 minutes, and has no link", () => {
    const m = signinCodeMessage(b, "ana@example.com", "482913");
    expect(m.subject).toBe("Your FZN <Band> Boosters sign-in code: 482913");
    expect(m.to).toBe("ana@example.com");
    for (const part of [m.text, m.html]) {
      expect(part).toContain("482913");
      expect(part).toMatch(/expires in 10 minutes/);
      expect(part).toMatch(/didn.t ask for this code/);
      expect(part).not.toMatch(/https?:\/\/|<a\b|<img\b/i);
    }
  });
  it("escapes the club name in HTML and uses the club color", () => {
    const m = signinCodeMessage(b, "ana@example.com", "482913");
    expect(m.html).toContain("FZN &lt;Band&gt; Boosters");
    expect(m.html).not.toContain("<Band>");
    expect(m.html).toContain("#5b2a86");
  });
  it("welcomes a new person with the portal address and no code", () => {
    const m = welcomeMessage(b, "ana@example.com", { appUrl: "https://portal.example.org", familyLabel: null });
    expect(m.text).toContain("You can now sign in to FZN <Band> Boosters at https://portal.example.org with this email address. We'll email you a code each time.");
    expect(m.text).not.toMatch(/\b\d{6}\b/);
  });
  it("names the family when an existing person is added to another one", () => {
    expect(welcomeMessage(b, "a@example.com", { appUrl: "https://p.example.org", familyLabel: "the Smith family" }).text)
      .toContain("You've been added as a guardian for the Smith family.");
  });
  it("puts the confirm link only in the confirm message, and none in the notice", () => {
    expect(emailChangeConfirmMessage(b, "new@example.com", { link: "https://p.example.org/email-change/confirm?token=abc" }).text)
      .toContain("https://p.example.org/email-change/confirm?token=abc");
    expect(emailChangeNoticeMessage(b, "old@example.com", { byStaff: false }).text).not.toMatch(/https?:\/\//);
    expect(emailChangeNoticeMessage(b, "old@example.com", { byStaff: true }).text).toMatch(/The club changed/);
  });
  it("has a plain test message", () => {
    expect(testMessage(b, "admin@example.org").subject).toBe("Test email from FZN <Band> Boosters");
  });
});
```

`tests/unit/mail-form.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db/client", () => ({ db: {} }));
import { parseMailForm } from "@/lib/mail/settings";

describe("parseMailForm", () => {
  it("accepts Microsoft 365 with one mailbox, normalized", () => {
    expect(parseMailForm({ method: "graph", mailbox: " Webmaster@FznBand.org " }))
      .toEqual({ ok: true, draft: { method: "graph", mailbox: "webmaster@fznband.org" } });
  });
  it("accepts SMTP and treats a blank password as keep-the-saved-one", () => {
    expect(parseMailForm({ method: "smtp", host: "smtp.example.org", port: "587", security: "starttls", username: "u", from: "Club@Example.org", password: "" }))
      .toEqual({ ok: true, draft: { method: "smtp", host: "smtp.example.org", port: 587, security: "starttls", username: "u", from: "club@example.org", password: null } });
  });
  it("refuses plaintext SMTP, a bad port and a host with a scheme", () => {
    const r = parseMailForm({ method: "smtp", host: "https://smtp.example.org", port: "70000", security: "none", username: "u", from: "c@example.org", password: "p" });
    expect(r).toEqual({ ok: false, errors: [
      "Host is a server name like smtp.example.org, without https:// or a path.",
      "Port must be a number from 1 to 65535.",
      "Choose STARTTLS or TLS. Boosters Rocket doesn't send mail unencrypted.",
    ] });
  });
  it("asks which way to send", () => {
    expect(parseMailForm({})).toEqual({ ok: false, errors: ["Choose how to send mail."] });
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run tests/unit/mail-messages.test.ts tests/unit/mail-form.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement the types, the hash and the messages**

`src/lib/mail/types.ts`:

```ts
export type MailMessage = { to: string; subject: string; text: string; html: string };
/** Sends one message; throws MailSendError. */
export type MailSender = (m: MailMessage) => Promise<void>;
/** A send failure. The message is a fixed sentence plus the provider's error code: safe to show staff and to audit, never the body. */
export class MailSendError extends Error {}
export type SmtpSecurity = "starttls" | "tls";
export type StoredMailConfig =
  | { method: "graph"; mailbox: string }
  | { method: "smtp"; host: string; port: number; security: SmtpSecurity; username: string; from: string; passwordCiphertext: string; passwordKeyId: string };
export type MailPurpose = "signin_code" | "welcome" | "email_change_confirm" | "email_change_notice" | "test";
```

`src/lib/mail/config-hash.ts` (no server imports, so `scripts/seed-e2e.ts` can use it):

```ts
import { createHash } from "node:crypto";
import type { StoredMailConfig } from "./types";

/** Identifies exactly these settings. A test send records it; any change to the settings changes it. */
export function mailConfigHash(c: StoredMailConfig): string {
  const sorted = Object.fromEntries(Object.entries(c).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
```

`src/lib/mail/messages.ts`:

```ts
import type { MailMessage } from "./types";

export type Brand = { clubName: string; color: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const COLOR = /^#[0-9a-f]{6}$/i;

/** Simple HTML: a colored bar with the club name, then paragraphs. No images, no remote content. */
function html(b: Brand, paragraphs: string[], big?: string): string {
  const color = COLOR.test(b.color) ? b.color : "#5b2a86";
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${esc(p)}</p>`).join("");
  const code = big ? `<p style="margin:0 0 16px;font-size:32px;letter-spacing:6px;font-weight:bold">${esc(big)}</p>` : "";
  return `<!doctype html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">`
    + `<div style="background:${color};color:#ffffff;padding:16px 24px;font-size:18px;font-weight:bold">${esc(b.clubName)}</div>`
    + `<div style="padding:24px">${code}${body}</div></body></html>`;
}
const text = (lines: string[]) => `${lines.join("\n\n")}\n`;

export function signinCodeMessage(b: Brand, to: string, code: string): MailMessage {
  const lines = [
    `Your ${b.clubName} sign-in code is ${code}.`,
    "It expires in 10 minutes.",
    "If you didn't ask for this code, you can ignore this email. Nobody can sign in without it.",
  ];
  return { to, subject: `Your ${b.clubName} sign-in code: ${code}`, text: text(lines), html: html(b, lines, code) };
}

export function welcomeMessage(b: Brand, to: string, o: { appUrl: string; familyLabel: string | null }): MailMessage {
  const lines = [
    ...(o.familyLabel ? [`You've been added as a guardian for ${o.familyLabel}.`] : []),
    `You can now sign in to ${b.clubName} at ${o.appUrl} with this email address. We'll email you a code each time.`,
  ];
  return { to, subject: `You can now sign in to ${b.clubName}`, text: text(lines), html: html(b, lines) };
}

export function emailChangeConfirmMessage(b: Brand, to: string, o: { link: string }): MailMessage {
  const lines = [
    `Someone asked to use this address to sign in to ${b.clubName}. If it was you, open this link within 24 hours to confirm:`,
    o.link,
    "If it wasn't you, ignore this email and nothing changes.",
  ];
  return { to, subject: `Confirm your new email for ${b.clubName}`, text: text(lines), html: html(b, lines) };
}

export function emailChangeNoticeMessage(b: Brand, to: string, o: { byStaff: boolean }): MailMessage {
  const lines = o.byStaff
    ? [`The club changed the email address you sign in to ${b.clubName} with. This address no longer works for signing in.`, "If this is a surprise, contact the club."]
    : [`Someone asked to change the email address you sign in to ${b.clubName} with. Nothing changes until the new address is confirmed.`, "If it wasn't you, contact the club."];
  return { to, subject: `Your ${b.clubName} sign-in email`, text: text(lines), html: html(b, lines) };
}

export function testMessage(b: Brand, to: string): MailMessage {
  const lines = [`This is a test from the ${b.clubName} portal. Outgoing mail works.`];
  return { to, subject: `Test email from ${b.clubName}`, text: text(lines), html: html(b, lines) };
}
```

- [ ] **Step 5: Write the failing sender tests**

`tests/helpers/tls.ts`:

```ts
import { webcrypto, randomBytes } from "node:crypto";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const pem = (label: string, der: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

/** A self-signed certificate for 127.0.0.1 and localhost, valid a week: for local TLS stubs only. */
export async function localhostCertificate(): Promise<{ key: string; cert: string }> {
  const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 } as const;
  const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: `01${randomBytes(8).toString("hex")}`, name: "CN=localhost",
    notBefore: new Date(now - 60_000), notAfter: new Date(now + 7 * 86_400_000),
    signingAlgorithm: alg, keys: keys as unknown as CryptoKeyPair,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment | x509.KeyUsageFlags.keyCertSign, true),
      new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: "localhost" }, { type: "ip", value: "127.0.0.1" }]),
    ],
  });
  return { cert: cert.toString("pem"), key: pem("PRIVATE KEY", await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)) };
}
```

`tests/helpers/mail-sink.ts`:

```ts
import type { AddressInfo } from "node:net";
import smtp from "smtp-server";

export type Captured = { from: string; to: string[]; user: string | null; raw: string };
export type MailSink = { port: number; messages: Captured[]; close(): Promise<void> };

/** A local SMTP server that requires TLS and a login, and keeps every message it gets. */
export async function startMailSink(o: { secure: boolean; key: string; cert: string; port?: number; user?: string; pass?: string; hideSTARTTLS?: boolean }): Promise<MailSink> {
  const messages: Captured[] = [];
  const user = o.user ?? "sender", pass = o.pass ?? "sink-password";
  const server = new smtp.SMTPServer({
    secure: o.secure, key: o.key, cert: o.cert, hideSTARTTLS: o.hideSTARTTLS ?? false, disableReverseLookup: true, logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === user && auth.password === pass) cb(null, { user: auth.username });
      else cb(Object.assign(new Error("Invalid username or password"), { responseCode: 535 }));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        messages.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          user: typeof session.user === "string" ? session.user : null,
          raw: Buffer.concat(chunks).toString("utf8"),
        });
        cb();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, "127.0.0.1", resolve));
  const port = (server.server.address() as AddressInfo).port;
  return { port, messages, close: () => new Promise<void>((r) => server.close(() => r())) };
}
```

If `smtp-server`'s types name the listening socket differently from `server.server`, or type `session.user`
differently, read `node_modules/smtp-server/dist/cjs/smtp-server.d.ts` and `types.d.ts` and match them.

`tests/integration/mail-graph.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { X509Certificate } from "node:crypto";
import { jwtVerify } from "jose";
import { generateCertificate } from "@/lib/auth/certificate-crypto";
import { createGraphSender, clearGraphTokenCache } from "@/lib/mail/graph";
import { MailSendError } from "@/lib/mail/types";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
const seen: Seen[] = [];
let reply: (s: Seen) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const s = { method: req.method!, url: req.url!, headers: req.headers, body };
      seen.push(s);
      const r = reply(s);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.status === 202 ? "" : JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { seen.length = 0; clearGraphTokenCache(); });

const TENANT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CLIENT = "11111111-2222-3333-4444-555555555555";
const okGraph = (s: Seen) => (s.url.includes("/oauth2/") ? { status: 200, body: { access_token: "tok-1", expires_in: 3600 } } : { status: 202, body: null });
const msg = { to: "ana@example.com", subject: "Your FZN Boosters sign-in code: 482913", text: "t", html: "<p>h</p>" };

async function sender() {
  const g = await generateCertificate("graph test");
  const assertion = { privateKeyPem: g.privateKeyPem, thumbprintS256: g.thumbprintS256, thumbprintSha1Base64Url: Buffer.from(g.thumbprintSha1, "hex").toString("base64url") };
  return { g, send: createGraphSender({ tenantId: TENANT, clientId: CLIENT, assertion, mailbox: "webmaster@fznband.org", fromName: "FZN Boosters", endpoints: { login: base, graph: base } }) };
}

describe("Graph sender", () => {
  it("gets an app-only token with the certificate, then sends as the one mailbox without saving a copy", async () => {
    reply = okGraph;
    const { g, send } = await sender();
    await send(msg);
    const [tokenReq, mailReq] = seen;
    expect(tokenReq!.url).toBe(`/${TENANT}/oauth2/v2.0/token`);
    const form = new URLSearchParams(tokenReq!.body);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(form.get("client_secret")).toBeNull();
    await jwtVerify(form.get("client_assertion")!, new X509Certificate(g.certificatePem).publicKey, { audience: `${base}/${TENANT}/oauth2/v2.0/token`, issuer: CLIENT });
    expect(mailReq!.method).toBe("POST");
    expect(mailReq!.url).toBe("/v1.0/users/webmaster%40fznband.org/sendMail");
    expect(mailReq!.headers.authorization).toBe("Bearer tok-1");
    expect(JSON.parse(mailReq!.body)).toEqual({
      message: { subject: msg.subject, body: { contentType: "HTML", content: msg.html }, toRecipients: [{ emailAddress: { address: "ana@example.com" } }],
        from: { emailAddress: { name: "FZN Boosters", address: "webmaster@fznband.org" } } },
      saveToSentItems: false,
    });
  });

  it("reuses the token for the next message", async () => {
    reply = okGraph;
    const { send } = await sender();
    await send(msg); await send(msg);
    expect(seen.filter((s) => s.url.includes("/oauth2/"))).toHaveLength(1);
  });

  it("says which mailbox Microsoft 365 refused, without the message", async () => {
    reply = (s) => (s.url.includes("/oauth2/") ? okGraph(s) : { status: 403, body: { error: { code: "ErrorAccessDenied", message: "Access is denied." } } });
    const { send } = await sender();
    const e = await send(msg).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailSendError);
    expect((e as Error).message).toContain("webmaster@fznband.org");
    expect((e as Error).message).toContain("ErrorAccessDenied");
    expect((e as Error).message).not.toContain("482913");
  });

  it("reports a refused token with its AADSTS code", async () => {
    reply = () => ({ status: 401, body: { error_codes: [700027] } });
    const { send } = await sender();
    await expect(send(msg)).rejects.toThrow(/AADSTS700027/);
  });

  it("drops a token Graph no longer accepts, so the next send gets a new one", async () => {
    let calls = 0;
    reply = (s) => (s.url.includes("/oauth2/") ? okGraph(s) : (calls++ === 0 ? { status: 401, body: { error: { code: "InvalidAuthenticationToken" } } } : { status: 202, body: null }));
    const { send } = await sender();
    await expect(send(msg)).rejects.toThrow(MailSendError);
    await send(msg);
    expect(seen.filter((s) => s.url.includes("/oauth2/"))).toHaveLength(2);
  });
});
```

`tests/integration/mail-smtp.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { localhostCertificate } from "../helpers/tls";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { createSmtpSender } from "@/lib/mail/smtp";
import { MailSendError } from "@/lib/mail/types";

let tls: { key: string; cert: string };
let sink: MailSink | null = null;
beforeAll(async () => { tls = await localhostCertificate(); });
afterEach(async () => { await sink?.close(); sink = null; });

const msg = { to: "ana@example.com", subject: "Your FZN Boosters sign-in code: 482913", text: "plain 482913", html: "<p>html 482913</p>" };
const sender = (port: number, security: "tls" | "starttls", password = "sink-password") =>
  createSmtpSender({ host: "127.0.0.1", port, security, username: "sender", password, from: "boosters@example.org", fromName: "FZN Boosters", tls: { ca: tls.cert } });

describe("SMTP sender", () => {
  it("sends over implicit TLS with a login, as the From address, with text and HTML parts", async () => {
    sink = await startMailSink({ secure: true, ...tls });
    await sender(sink.port, "tls")(msg);
    const [m] = sink.messages;
    expect(m).toMatchObject({ from: "boosters@example.org", to: ["ana@example.com"], user: "sender" });
    expect(m!.raw).toMatch(/^From: "?FZN Boosters"? <boosters@example\.org>/m);
    expect(m!.raw).toMatch(/Content-Type: text\/plain/);
    expect(m!.raw).toMatch(/Content-Type: text\/html/);
  });

  it("upgrades with STARTTLS", async () => {
    sink = await startMailSink({ secure: false, ...tls });
    await sender(sink.port, "starttls")(msg);
    expect(sink.messages).toHaveLength(1);
  });

  it("refuses to log in or send when the server doesn't offer STARTTLS", async () => {
    sink = await startMailSink({ secure: false, hideSTARTTLS: true, ...tls });
    await expect(sender(sink.port, "starttls")(msg)).rejects.toBeInstanceOf(MailSendError);
    expect(sink.messages).toHaveLength(0);
  });

  it("says plainly when the password is wrong, without the message", async () => {
    sink = await startMailSink({ secure: true, ...tls });
    const e = await sender(sink.port, "tls", "wrong")(msg).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailSendError);
    expect((e as Error).message).toBe("The mail server refused the username or password.");
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `pnpm vitest run tests/integration/mail-graph.test.ts tests/integration/mail-smtp.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 7: Implement the senders**

`src/lib/mail/graph.ts`:

```ts
import { signEntraAssertion, CLIENT_ASSERTION_TYPE, type AssertionKey } from "@/lib/auth/client-assertion";
import { MailSendError, type MailSender } from "./types";

export type GraphEndpoints = { login: string; graph: string };
export const GRAPH_ENDPOINTS: GraphEndpoints = { login: "https://login.microsoftonline.com", graph: "https://graph.microsoft.com" };
const TIMEOUT_MS = 15_000;

// App-only tokens, per token endpoint + app + certificate, kept until a minute before they expire.
const tokens = new Map<string, { value: string; expiresAt: number }>();
export function clearGraphTokenCache(): void { tokens.clear(); }

/**
 * Sends as one mailbox through Microsoft Graph with the staff app's certificate (spec §3). Exchange Online RBAC for
 * Applications limits the app to that mailbox. The message is JSON with an HTML body and no copy in Sent Items, so the
 * mailbox doesn't collect sign-in codes; Exchange adds the plain-text part when it sends.
 */
export function createGraphSender(o: { tenantId: string; clientId: string; assertion: AssertionKey; mailbox: string; fromName: string; endpoints?: GraphEndpoints }): MailSender {
  const ep = o.endpoints ?? GRAPH_ENDPOINTS;
  const tokenUrl = `${ep.login}/${encodeURIComponent(o.tenantId)}/oauth2/v2.0/token`;
  const cacheKey = `${tokenUrl}|${o.clientId}|${o.assertion.thumbprintS256}`;

  async function token(): Promise<string> {
    const hit = tokens.get(cacheKey);
    if (hit && hit.expiresAt > Date.now() + 60_000) return hit.value;
    const form = new URLSearchParams({
      grant_type: "client_credentials", client_id: o.clientId, scope: "https://graph.microsoft.com/.default",
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await signEntraAssertion({ ...o.assertion, clientId: o.clientId, tokenEndpoint: tokenUrl }),
    });
    let res: Response;
    try {
      res = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    } catch {
      throw new MailSendError("Couldn't reach Microsoft to get permission to send mail.");
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error_codes?: unknown };
    if (!res.ok || typeof body.access_token !== "string") {
      const codes = Array.isArray(body.error_codes) ? body.error_codes.filter((c): c is number => typeof c === "number") : [];
      throw new MailSendError(`Microsoft refused the request to send mail (${codes[0] ? `AADSTS${codes[0]}` : `HTTP ${res.status}`}). Check staff sign-in with Microsoft under Settings, Sign-in.`);
    }
    const ttl = typeof body.expires_in === "number" ? body.expires_in : 3600;
    tokens.set(cacheKey, { value: body.access_token, expiresAt: Date.now() + ttl * 1000 });
    return body.access_token;
  }

  return async (m) => {
    const url = `${ep.graph}/v1.0/users/${encodeURIComponent(o.mailbox)}/sendMail`;
    const payload = {
      message: {
        subject: m.subject, body: { contentType: "HTML", content: m.html },
        toRecipients: [{ emailAddress: { address: m.to } }], from: { emailAddress: { name: o.fromName, address: o.mailbox } },
      },
      saveToSentItems: false,
    };
    const bearer = await token();
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    } catch {
      throw new MailSendError("Couldn't reach Microsoft Graph to send mail.");
    }
    if (res.status === 202) return;
    if (res.status === 401) tokens.delete(cacheKey);
    const err = (await res.json().catch(() => ({}))) as { error?: { code?: unknown } };
    const code = typeof err.error?.code === "string" ? err.error.code : `HTTP ${res.status}`;
    throw new MailSendError(res.status === 403 || code === "ErrorAccessDenied"
      ? `Microsoft 365 refused to send as ${o.mailbox} (${code}). Check that mail was set up for this mailbox (the staff script's -SetUpMail part, or the steps by hand), and allow up to 2 hours after a change.`
      : `Microsoft Graph didn't accept the message (${code}).`);
  };
}
```

`src/lib/mail/smtp.ts`:

```ts
import nodemailer from "nodemailer";
import { MailSendError, type MailSender, type SmtpSecurity } from "./types";

/** A fixed sentence and the error code only: nodemailer's own message can quote the server's reply. */
function smtpError(e: unknown): string {
  const err = (e ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof err.code === "string" ? err.code : null;
  const rc = typeof err.responseCode === "number" ? err.responseCode : null;
  if (code === "EAUTH") return "The mail server refused the username or password.";
  if (code === "ETLS") return "Couldn't make an encrypted connection to the mail server. Check the port and the security setting.";
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "EDNS" || code === "ESOCKET") return "Couldn't reach the mail server over an encrypted connection. Check the host, port and security setting.";
  return `The mail server didn't accept the message (${[code, rc].filter((x) => x !== null).join(" ") || "no error code"}).`;
}

/** SMTP with STARTTLS or TLS only, TLS 1.2 or later. `tls.ca` is for tests against a local stub; the app never passes it. */
export function createSmtpSender(o: {
  host: string; port: number; security: SmtpSecurity; username: string; password: string; from: string; fromName: string; tls?: { ca?: string };
}): MailSender {
  return async (m) => {
    const transport = nodemailer.createTransport({
      host: o.host, port: o.port, secure: o.security === "tls", requireTLS: o.security === "starttls",
      auth: { user: o.username, pass: o.password },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000,
      tls: { minVersion: "TLSv1.2", ...(o.tls?.ca ? { ca: o.tls.ca } : {}) },
      logger: false, debug: false,
    });
    try {
      await transport.sendMail({ from: { name: o.fromName, address: o.from }, to: m.to, subject: m.subject, text: m.text, html: m.html });
    } catch (e) {
      throw new MailSendError(smtpError(e));
    } finally {
      transport.close();
    }
  };
}
```

If nodemailer 10 names any of these options differently (check `node_modules/nodemailer/dist/cjs/smtp-transport/index.d.ts`
and `smtp-connection/index.d.ts`), match them and keep every behavior the tests check.

`src/lib/mail/senders.ts`:

```ts
import { loadProviders } from "@/lib/auth/providers";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { createGraphSender } from "./graph";
import { createSmtpSender } from "./smtp";
import { MailSendError, type MailSender, type StoredMailConfig } from "./types";
import type { Brand } from "./messages";

export const SMTP_PASSWORD_AAD = "mail:smtp-password";

/** The sender for the saved settings. Tests replace this module with vi.mock; the app has no other transport. */
export async function buildSender(stored: StoredMailConfig, brand: Brand): Promise<MailSender> {
  if (stored.method === "graph") {
    const ms = (await loadProviders()).staffMicrosoft;
    if (!ms) throw new MailSendError("Staff sign-in with Microsoft isn't set up, so mail can't go through Microsoft 365.");
    return createGraphSender({ tenantId: ms.config.tenantId, clientId: ms.config.clientId, assertion: ms.assertion, mailbox: stored.mailbox, fromName: brand.clubName });
  }
  let password: string;
  try {
    password = secretBox().open({ ciphertext: stored.passwordCiphertext, keyId: stored.passwordKeyId }, SMTP_PASSWORD_AAD);
  } catch (e) {
    if (e instanceof SecretBoxError) throw new MailSendError("The saved SMTP password can't be read with this server's encryption key. Enter it again under Settings, Mail.");
    throw e;
  }
  return createSmtpSender({ host: stored.host, port: stored.port, security: stored.security, username: stored.username, password, from: stored.from, fromName: brand.clubName });
}
```

- [ ] **Step 8: Run the sender tests**

Run: `pnpm vitest run tests/integration/mail-graph.test.ts tests/integration/mail-smtp.test.ts tests/unit/mail-messages.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing settings and send tests**

Add to `tests/helpers/db.ts`:

```ts
import { mailConfigHash } from "@/lib/mail/config-hash";
import type { StoredMailConfig } from "@/lib/mail/types";

/** Mail settings that count as working (a test send recorded for exactly these settings). */
export async function seedWorkingMail(config: StoredMailConfig = { method: "graph", mailbox: "webmaster@example.org" }) {
  const status = { verifiedHash: mailConfigHash(config), verifiedAt: new Date().toISOString(), lastSuccessAt: null, lastFailureAt: null, lastError: null };
  await db.insert(setting).values([{ key: "mail", value: config }, { key: "mail.status", value: status }]);
}
```

(import `setting` from the schema if it isn't already).

`tests/integration/mail-settings.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const box = vi.hoisted(() => ({ fail: null as string | null, sent: [] as Msg[] }));
vi.mock("@/lib/mail/senders", async () => {
  const { MailSendError } = await import("@/lib/mail/types");
  return {
    SMTP_PASSWORD_AAD: "mail:smtp-password",
    buildSender: async () => async (m: Msg) => { if (box.fail) throw new MailSendError(box.fail); box.sent.push(m); },
  };
});

import { db } from "@/lib/db/client";
import { auditLog, setting } from "@/lib/db/schema";
import { saveMailSettings, mailWorking, mailSummary, mailAttention, getStoredMailConfig } from "@/lib/mail/settings";
import { sendMail, sendTestMail } from "@/lib/mail/send";
import { signinCodeMessage } from "@/lib/mail/messages";
import { resetDb, seedProvider } from "../helpers/db";

const actor = { door: "staff" as const, id: null, label: "admin@example.org" };
const o = { actor, ip: "203.0.113.5", permission: "Settings.Mail.ReadWrite" };
const smtp = { method: "smtp" as const, host: "smtp.example.org", port: 587, security: "starttls" as const, username: "u", from: "club@example.org" };
const cipher = async () => { const c = await getStoredMailConfig(); return c?.method === "smtp" ? c.passwordCiphertext : null; };

describe("mail settings", () => {
  beforeEach(async () => { await resetDb(); box.fail = null; box.sent.length = 0; });
  afterEach(() => vi.restoreAllMocks());

  it("seals the SMTP password, never returns it, and audits the save without it", async () => {
    expect(await saveMailSettings({ ...smtp, password: "hunter2-secret" }, o)).toEqual({ ok: true });
    expect(JSON.stringify(await getStoredMailConfig())).not.toContain("hunter2-secret");
    const summary = await mailSummary();
    expect(summary).toMatchObject({ config: smtp, passwordSaved: true, passwordReadable: true, working: false });
    expect(JSON.stringify(summary)).not.toMatch(/hunter2|Ciphertext/);
    const audits = await db.select().from(auditLog);
    expect(audits.map((a) => a.action)).toEqual(["settings.mail.save"]);
    expect(JSON.stringify(audits)).not.toContain("hunter2-secret");
    expect(audits[0]!.after).toMatchObject({ method: "smtp", passwordChanged: true });
  });

  it("asks for a password the first time and keeps the saved one when left blank", async () => {
    expect(await saveMailSettings({ ...smtp, password: null }, o)).toEqual({ ok: false, errors: ["Enter the SMTP password."] });
    await saveMailSettings({ ...smtp, password: "first" }, o);
    const before = await cipher();
    await saveMailSettings({ ...smtp, username: "u2", password: null }, o);
    expect(await cipher()).toBe(before);
  });

  it("offers Microsoft 365 only when staff sign-in with Microsoft is set up", async () => {
    expect(await saveMailSettings({ method: "graph", mailbox: "webmaster@example.org" }, o)).toEqual({ ok: false,
      errors: ["Sending through Microsoft 365 uses the staff sign-in app. Set up staff sign-in with Microsoft first, or use SMTP."] });
    await seedProvider("staff-microsoft", { tenantId: "0f8fad5b-d9cb-469f-a165-70867728950e", clientId: "11111111-2222-3333-4444-555555555555" });
    expect(await saveMailSettings({ method: "graph", mailbox: "webmaster@example.org" }, o)).toEqual({ ok: true });
    expect((await mailSummary()).graphAvailable).toBe(true);
  });

  it("works only after a test send, and needs a new test when the settings change", async () => {
    await saveMailSettings({ ...smtp, password: "p" }, o);
    expect(await mailWorking()).toBe(false);
    expect(await mailAttention()).toMatchObject({ kind: "not_tested" });
    expect(await sendTestMail(" Admin@Example.org ", o)).toEqual({ ok: true });
    expect(box.sent[0]!.to).toBe("admin@example.org");
    expect(await mailWorking()).toBe(true);
    expect(await mailAttention()).toBeNull();
    await saveMailSettings({ ...smtp, port: 465, security: "tls", password: null }, o);
    expect(await mailWorking()).toBe(false);
    expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(["settings.mail.save", "settings.mail.test", "settings.mail.save"]);
  });

  it("a failed test doesn't count as working", async () => {
    await saveMailSettings({ ...smtp, password: "p" }, o);
    box.fail = "The mail server refused the username or password.";
    expect(await sendTestMail("admin@example.org", o)).toEqual({ ok: false, error: "The mail server refused the username or password." });
    expect(await mailWorking()).toBe(false);
    expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(["settings.mail.save", "mail.failed", "settings.mail.test"]);
  });

  it("audits a failed send without the body, raises the warning, and a later success clears it", async () => {
    await saveMailSettings({ ...smtp, password: "p" }, o);
    await sendTestMail("admin@example.org", o);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    box.fail = "The mail server didn't accept the message (EENVELOPE 550).";
    const m = signinCodeMessage({ clubName: "FZN", color: "#5b2a86" }, "ana@example.com", "482913");
    expect(await sendMail(m, { purpose: "signin_code" })).toEqual({ ok: false, error: "The mail server didn't accept the message (EENVELOPE 550)." });
    const failed = (await db.select().from(auditLog)).filter((a) => a.action === "mail.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.after).toEqual({ purpose: "signin_code", method: "smtp", to: "ana@example.com", error: "The mail server didn't accept the message (EENVELOPE 550)." });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("482913");
    expect(JSON.stringify(await db.select().from(setting))).not.toContain("482913");
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain("482913");
    expect(await mailAttention()).toMatchObject({ kind: "failing", lastError: "The mail server didn't accept the message (EENVELOPE 550)." });
    box.fail = null;
    expect(await sendMail(m, { purpose: "signin_code" })).toEqual({ ok: true });
    expect(await mailAttention()).toBeNull();
  });

  it("says mail isn't set up when nothing is saved", async () => {
    expect(await mailAttention()).toMatchObject({ kind: "not_set_up" });
    expect(await sendMail({ to: "a@example.com", subject: "s", text: "t", html: "h" }, { purpose: "welcome" })).toEqual({ ok: false, error: "Outgoing mail isn't set up." });
  });
});
```

- [ ] **Step 10: Run them and watch them fail**

Run: `pnpm vitest run tests/integration/mail-settings.test.ts tests/unit/mail-form.test.ts`
Expected: FAIL, `@/lib/mail/settings` not found.

- [ ] **Step 11: Implement settings and send**

`src/lib/mail/settings.ts`:

```ts
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { loadProviders } from "@/lib/auth/providers";
import { normalizeEmail } from "@/lib/setup/state";
import { mailConfigHash } from "./config-hash";
import { SMTP_PASSWORD_AAD } from "./senders";
import type { SmtpSecurity, StoredMailConfig } from "./types";

export const MAIL_KEY = "mail";
export const MAIL_STATUS_KEY = "mail.status";

export type MailStatus = { verifiedHash: string | null; verifiedAt: string | null; lastSuccessAt: string | null; lastFailureAt: string | null; lastError: string | null };
const EMPTY_STATUS: MailStatus = { verifiedHash: null, verifiedAt: null, lastSuccessAt: null, lastFailureAt: null, lastError: null };
export type MailDraft =
  | { method: "graph"; mailbox: string }
  | { method: "smtp"; host: string; port: number; security: SmtpSecurity; username: string; from: string; password: string | null };
export type MailConfigView =
  | { method: "graph"; mailbox: string }
  | { method: "smtp"; host: string; port: number; security: SmtpSecurity; username: string; from: string };
export type MailSummary = { config: MailConfigView | null; passwordSaved: boolean; passwordReadable: boolean; working: boolean; status: MailStatus; graphAvailable: boolean };
export type MailAttention = { kind: "not_set_up" | "not_tested" | "failing"; lastError: string | null; since: string | null };
type StoredSmtp = Extract<StoredMailConfig, { method: "smtp" }>;

const storedSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("graph"), mailbox: z.string() }),
  z.object({ method: z.literal("smtp"), host: z.string(), port: z.number(), security: z.enum(["starttls", "tls"]), username: z.string(),
    from: z.string(), passwordCiphertext: z.string(), passwordKeyId: z.string() }),
]);

export async function getStoredMailConfig(tx?: Tx): Promise<StoredMailConfig | null> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, MAIL_KEY));
  const parsed = storedSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

export async function getMailStatus(tx?: Tx): Promise<MailStatus> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, MAIL_STATUS_KEY));
  return { ...EMPTY_STATUS, ...((row?.value as Partial<MailStatus> | undefined) ?? {}) };
}

/** Merges into the stored status in one statement, so two sends finishing together don't lose each other's fields. */
export async function patchMailStatus(patch: Partial<MailStatus>, tx?: Tx): Promise<void> {
  await (tx ?? db).insert(setting).values({ key: MAIL_STATUS_KEY, value: { ...EMPTY_STATUS, ...patch } })
    .onConflictDoUpdate({ target: setting.key, set: { value: sql`${setting.value} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() } });
}

export async function mailWorking(): Promise<boolean> {
  const [c, s] = await Promise.all([getStoredMailConfig(), getMailStatus()]);
  return c !== null && s.verifiedHash === mailConfigHash(c);
}

const view = (c: StoredMailConfig): MailConfigView => (c.method === "graph" ? { method: "graph", mailbox: c.mailbox }
  : { method: "smtp", host: c.host, port: c.port, security: c.security, username: c.username, from: c.from });
function passwordReadable(c: StoredMailConfig): boolean {
  if (c.method !== "smtp") return false;
  try { secretBox().open({ ciphertext: c.passwordCiphertext, keyId: c.passwordKeyId }, SMTP_PASSWORD_AAD); return true; }
  catch (e) { if (e instanceof SecretBoxError) return false; throw e; }
}

/** What the setup and Settings pages may show: never the password or its ciphertext. */
export async function mailSummary(): Promise<MailSummary> {
  const [c, status, providers] = await Promise.all([getStoredMailConfig(), getMailStatus(), loadProviders()]);
  return {
    config: c ? view(c) : null, passwordSaved: c?.method === "smtp", passwordReadable: c ? passwordReadable(c) : false,
    working: c !== null && status.verifiedHash === mailConfigHash(c), status, graphAvailable: providers.staffMicrosoft !== null,
  };
}

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function parseMailForm(f: Record<string, string>): { ok: true; draft: MailDraft } | { ok: false; errors: string[] } {
  const method = (f.method ?? "").trim();
  if (method === "graph") {
    const mailbox = normalizeEmail(f.mailbox ?? "");
    return mailbox ? { ok: true, draft: { method, mailbox } } : { ok: false, errors: ["Enter the mailbox to send from, like webmaster@yourclub.org."] };
  }
  if (method !== "smtp") return { ok: false, errors: ["Choose how to send mail."] };
  const errors: string[] = [];
  const host = (f.host ?? "").trim().toLowerCase();
  if (!HOST.test(host)) errors.push("Host is a server name like smtp.example.org, without https:// or a path.");
  const port = Number((f.port ?? "").trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("Port must be a number from 1 to 65535.");
  const security = (f.security ?? "").trim();
  if (security !== "starttls" && security !== "tls") errors.push("Choose STARTTLS or TLS. Boosters Rocket doesn't send mail unencrypted.");
  const username = (f.username ?? "").trim();
  if (!username) errors.push("Enter the SMTP username.");
  const from = normalizeEmail(f.from ?? "");
  if (!from) errors.push("Enter the From address, like boosters@yourclub.org.");
  const password = f.password ?? "";
  if (password.length > 1024) errors.push("That password is too long.");
  if (errors.length || !from) return { ok: false, errors };
  return { ok: true, draft: { method, host, port, security: security as SmtpSecurity, username, from, password: password === "" ? null : password } };
}

const LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('booster.mail_settings'))`;

export async function saveMailSettings(draft: MailDraft, o: { actor: Actor; ip: string | null; permission?: string }): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  if (draft.method === "graph" && !(await loadProviders()).staffMicrosoft) {
    return { ok: false, errors: ["Sending through Microsoft 365 uses the staff sign-in app. Set up staff sign-in with Microsoft first, or use SMTP."] };
  }
  return db.transaction(async (tx): Promise<{ ok: true } | { ok: false; errors: string[] }> => {
    await tx.execute(LOCK);
    const existing = await getStoredMailConfig(tx);
    let next: StoredMailConfig;
    if (draft.method === "graph") next = { method: "graph", mailbox: draft.mailbox };
    else {
      const { password, ...rest } = draft;
      if (password === null && existing?.method !== "smtp") return { ok: false, errors: ["Enter the SMTP password."] };
      const sealed = password !== null ? secretBox().seal(password, SMTP_PASSWORD_AAD)
        : { ciphertext: (existing as StoredSmtp).passwordCiphertext, keyId: (existing as StoredSmtp).passwordKeyId };
      next = { ...rest, passwordCiphertext: sealed.ciphertext, passwordKeyId: sealed.keyId };
    }
    await tx.insert(setting).values({ key: MAIL_KEY, value: next }).onConflictDoUpdate({ target: setting.key, set: { value: next, updatedAt: new Date() } });
    await writeAudit({ actor: o.actor, action: "settings.mail.save", permission: o.permission, targetType: "setting", targetId: MAIL_KEY,
      before: existing ? view(existing) : null,
      after: { ...view(next), ...(draft.method === "smtp" ? { passwordChanged: draft.password !== null } : {}) }, ip: o.ip }, tx);
    return { ok: true };
  });
}

/** For the staff warning: not set up, not tested with these settings, or the last send failed. */
export async function mailAttention(): Promise<MailAttention | null> {
  const [c, s] = await Promise.all([getStoredMailConfig(), getMailStatus()]);
  if (!c) return { kind: "not_set_up", lastError: null, since: null };
  if (s.verifiedHash !== mailConfigHash(c)) return { kind: "not_tested", lastError: null, since: null };
  if (s.lastFailureAt && (!s.lastSuccessAt || s.lastFailureAt > s.lastSuccessAt)) return { kind: "failing", lastError: s.lastError, since: s.lastFailureAt };
  return null;
}
```

(ISO-8601 UTC strings from `toISOString()` compare correctly as strings.)

`src/lib/mail/send.ts`:

```ts
import { db } from "@/lib/db/client";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getClubSettings } from "@/lib/settings/club";
import { normalizeEmail } from "@/lib/setup/state";
import { buildSender } from "./senders";
import { getStoredMailConfig, patchMailStatus, MAIL_KEY } from "./settings";
import { mailConfigHash } from "./config-hash";
import { testMessage, type Brand } from "./messages";
import { MailSendError, type MailMessage, type MailPurpose, type StoredMailConfig } from "./types";

export type SendOutcome = { ok: true } | { ok: false; error: string };
const MAIL_ACTOR: Actor = { door: "system", id: null, label: "mail" };

export async function currentBrand(): Promise<Brand> {
  const c = await getClubSettings();
  return { clubName: c.name, color: c.color };
}

async function deliver(stored: StoredMailConfig, m: MailMessage, o: { purpose: MailPurpose; actor?: Actor; ip?: string | null }): Promise<SendOutcome> {
  try {
    await (await buildSender(stored, await currentBrand()))(m);
  } catch (e) {
    // Only MailSendError's sentence is kept; any other error could carry anything, so it becomes a fixed sentence.
    const error = e instanceof MailSendError ? e.message : "Sending failed for an unexpected reason.";
    await patchMailStatus({ lastFailureAt: new Date().toISOString(), lastError: error });
    await writeAudit({ actor: o.actor ?? MAIL_ACTOR, action: "mail.failed", targetType: "setting", targetId: MAIL_KEY,
      after: { purpose: o.purpose, method: stored.method, to: m.to, error }, ip: o.ip ?? null });
    return { ok: false, error };
  }
  await patchMailStatus({ lastSuccessAt: new Date().toISOString() });
  return { ok: true };
}

/** Sends one message with the saved settings. Never throws for a send failure; the failure is audited without the body. */
export async function sendMail(m: MailMessage, o: { purpose: MailPurpose; actor?: Actor; ip?: string | null }): Promise<SendOutcome> {
  const stored = await getStoredMailConfig();
  if (!stored) return { ok: false, error: "Outgoing mail isn't set up." };
  return deliver(stored, m, o);
}

/** **Send test email**. A success marks exactly the settings it was sent with as working. */
export async function sendTestMail(rawTo: string, o: { actor: Actor; ip: string | null; permission?: string }): Promise<SendOutcome> {
  const to = normalizeEmail(rawTo);
  if (!to) return { ok: false, error: "Enter the address to send the test to." };
  const stored = await getStoredMailConfig();
  if (!stored) return { ok: false, error: "Save the mail settings first." };
  const r = await deliver(stored, testMessage(await currentBrand(), to), { purpose: "test", actor: o.actor, ip: o.ip });
  await db.transaction(async (tx) => {
    // If the settings changed while the test was out, the new ones stay untested.
    const now = await getStoredMailConfig(tx);
    if (r.ok && now && mailConfigHash(now) === mailConfigHash(stored)) {
      await patchMailStatus({ verifiedHash: mailConfigHash(stored), verifiedAt: new Date().toISOString() }, tx);
    }
    await writeAudit({ actor: o.actor, action: "settings.mail.test", permission: o.permission, targetType: "setting", targetId: MAIL_KEY,
      after: { to, ok: r.ok, ...(r.ok ? {} : { error: r.error }) }, ip: o.ip }, tx);
  });
  return r;
}
```

- [ ] **Step 12: Run everything**

Run: `pnpm vitest run tests/integration/mail-settings.test.ts tests/unit/mail-form.test.ts && pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add package.json pnpm-lock.yaml .gitignore src/lib/mail tests/helpers tests/unit/mail-messages.test.ts tests/unit/mail-form.test.ts tests/integration/mail-graph.test.ts tests/integration/mail-smtp.test.ts tests/integration/mail-settings.test.ts
git commit -m "feat(mail): outgoing mail through Microsoft 365 (Graph, staff certificate) or SMTP

Settings count as working only after a test send with exactly those settings. Failures are audited
as mail.failed with the provider's error, never the body, and raise a staff warning until a send succeeds.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: People and guardians

Spec §2. The library staff screens and the later roster/QuickBooks plan call. There are no staff roster pages in this
plan; this task is the API and its tests. Adding someone whose email is already a person is a two-step call: the first
returns `confirm_link` with that person's families, and only a second call carrying `confirmLinkParentId` links them.
A parent's own email change is request + confirm, with a named seam (`setPrimaryGuardianEmailHook`) where the roster
plan will update the primary email in QuickBooks; this plan leaves it a no-op. The parent-facing "change my email" form
and the confirm page are not in this plan (see Rulings).

**Files:**
- Create: `src/lib/parents/sessions.ts`, `src/lib/parents/people.ts`, `src/lib/parents/email-change.ts`
- Test: `tests/integration/parents-people.test.ts`, `tests/integration/parents-email-change.test.ts`

**Interfaces:**
- Consumes: `parent`, `guardian`, `parentAuthUser`, `parentAuthSession`, `signinCode`, `parentEmailChange` (Task 2);
  `sendMail`, `currentBrand` (Task 3); `welcomeMessage`, `emailChangeConfirmMessage`, `emailChangeNoticeMessage`
  (Task 3); `normalizeEmail`; `writeAudit`, `Actor`; `env.APP_URL`.
- Produces (`sessions.ts`):
  - `endParentSessions(parentId: string, tx?: Tx): Promise<number>` — deletes every session of the person; returns how many
  - `enabledGuardianRows(parentId: string, tx?: Tx): Promise<GuardianRow[]>` — rows that aren't disabled, ordered by `familyQboId`
  - `deleteUnusedSigninCodes(parentId: string, tx: Tx): Promise<void>`
  - `parentActor(p: { id: string; email: string }): Actor` — `{ door: "parent", id, label: email }`
- Produces (`people.ts`):
  - `type StaffOp = { actor: Actor; ip: string | null; permission?: string }`
  - `type GuardianInput = { familyQboId: string; familyLabel: string; name: string; email: string; phone?: string | null; isPrimary?: boolean }`
  - `type AddGuardianResult = { ok: true; outcome: "created" | "linked" | "reenabled"; parentId: string; guardianId: string; welcomeSent: boolean } | { ok: false; reason: "confirm_link"; parentId: string; name: string; familyQboIds: string[] } | { ok: false; reason: "blocked"; parentId: string; name: string } | { ok: false; reason: "already_in_family"; parentId: string; guardianId: string } | { ok: false; reason: "invalid"; errors: string[] }`
  - `createOrLinkGuardian(input: GuardianInput, o: StaffOp & { confirmLinkParentId?: string }): Promise<AddGuardianResult>`
  - `removeGuardian(guardianId: string, o: StaffOp): Promise<{ ok: true; sessionsEnded: number } | { ok: false; reason: "not_found" }>`
  - `blockPerson(parentId: string, o: StaffOp): Promise<{ ok: true; sessionsEnded: number } | { ok: false; reason: "not_found" }>`
  - `unblockPerson(parentId: string, o: StaffOp): Promise<{ ok: true } | { ok: false; reason: "not_found" }>`
  - `onFamilyStudentsChanged(familyQboId: string, hasActiveStudents: boolean, o: StaffOp): Promise<{ changed: number }>`
  - `resendWelcome(guardianId: string, familyLabel: string | null, o: StaffOp): Promise<{ ok: true } | { ok: false; reason: "not_found" | "disabled" | "blocked" | "mail_failed"; error?: string }>`
  - `changeParentEmailByStaff(parentId: string, rawEmail: string, o: StaffOp): Promise<{ ok: true; changed: boolean } | { ok: false; reason: "invalid" | "not_found" } | { ok: false; reason: "in_use"; heldBy: { parentId: string; name: string } }>`
- Produces (`email-change.ts`):
  - `EMAIL_CHANGE_TTL_MS = 86_400_000`, `PARENT_EMAIL_IN_USE = "That address is already in use. Ask the club to help."`
  - `type PrimaryEmailHook = (o: { parentId: string; email: string; familyQboIds: string[] }) => Promise<void>`
  - `setPrimaryGuardianEmailHook(h: PrimaryEmailHook): void` — **the QuickBooks seam**: the roster/QuickBooks plan sets
    it to update each family's primary email in QuickBooks and queue a failed write (v1 §6.2). Default: does nothing.
  - `emailChangeLink(token: string): string` — `${APP_URL}/email-change/confirm?token=<token>`
  - `requestParentEmailChange(parentId: string, rawEmail: string, o: { ip: string | null }): Promise<{ ok: true } | { ok: false; reason: "invalid" | "same" | "not_found" | "in_use" }>`
  - `confirmParentEmailChange(token: string, o: { ip: string | null }): Promise<{ ok: true; parentId: string } | { ok: false; reason: "invalid" | "in_use" }>`

- [ ] **Step 1: Write the failing tests**

`tests/integration/parents-people.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parent, parentAuthUser, parentAuthSession, signinCode } from "@/lib/db/schema";
import {
  createOrLinkGuardian, removeGuardian, blockPerson, unblockPerson, onFamilyStudentsChanged, resendWelcome, changeParentEmailByStaff,
} from "@/lib/parents/people";
import { enabledGuardianRows } from "@/lib/parents/sessions";
import { resetDb, seedParent, seedGuardian, seedParentSession, seedWorkingMail } from "../helpers/db";

const o = { actor: { door: "staff" as const, id: null, label: "board@club.org" }, ip: "203.0.113.5" };
const add = (email: string, familyQboId: string, extra: Partial<Parameters<typeof createOrLinkGuardian>[0]> = {}, confirmLinkParentId?: string) =>
  createOrLinkGuardian({ familyQboId, familyLabel: `the ${familyQboId} family`, name: "Ana Ramirez", email, ...extra }, { ...o, confirmLinkParentId });
const actions = async () => (await db.select().from(auditLog)).map((a) => a.action);
const pid = (r: Awaited<ReturnType<typeof createOrLinkGuardian>>) => ("parentId" in r ? r.parentId : "");
const sessionsOf = async (authUserId: string) => db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, authUserId));

describe("adding guardians", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); });

  it("makes a new person, their sign-in user and an invited row, and sends a welcome with no code", async () => {
    const r = await add(" Ana@Example.COM ", "F1");
    expect(r).toMatchObject({ ok: true, outcome: "created", welcomeSent: true });
    const [p] = await db.select().from(parent);
    expect(p).toMatchObject({ name: "Ana Ramirez", email: "ana@example.com", blocked: false });
    expect(await db.select().from(parentAuthUser)).toMatchObject([{ email: "ana@example.com", parentId: p!.id }]);
    expect(await db.select().from(guardian)).toMatchObject([{ familyQboId: "F1", parentId: p!.id, status: "invited" }]);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe("ana@example.com");
    expect(outbox[0]!.text).toContain("We'll email you a code each time.");
    expect(outbox[0]!.text).not.toMatch(/\b\d{6}\b/);
    expect(await actions()).toEqual(["parent.create", "guardian.create", "guardian.welcome_sent"]);
  });

  it("asks before linking an existing person, writes nothing until confirmed, then links the same person", async () => {
    const first = await add("ana@example.com", "F1");
    const ask = await add("ANA@example.com", "F2", { name: "Someone Else" });
    expect(ask).toEqual({ ok: false, reason: "confirm_link", parentId: pid(first), name: "Ana Ramirez", familyQboIds: ["F1"] });
    expect(await db.select().from(guardian)).toHaveLength(1);
    const linked = await add("ana@example.com", "F2", {}, pid(ask));
    expect(linked).toMatchObject({ ok: true, outcome: "linked" });
    expect(await db.select().from(parent)).toHaveLength(1);
    expect((await db.select().from(guardian)).map((g) => g.parentId)).toEqual([pid(first), pid(first)]);
    expect(outbox.at(-1)!.text).toContain("You've been added as a guardian for the F2 family.");
  });

  it("asks again when the confirmation names a different person", async () => {
    await add("ana@example.com", "F1");
    expect(await add("ana@example.com", "F2", {}, "00000000-0000-0000-0000-000000000000")).toMatchObject({ ok: false, reason: "confirm_link" });
  });

  it("refuses a second link to the same family", async () => {
    const first = await add("ana@example.com", "F1");
    const again = await add("ana@example.com", "F1", {}, pid(first));
    expect(again).toMatchObject({ ok: false, reason: "already_in_family" });
    expect(await db.select().from(guardian)).toHaveLength(1);
  });

  it("offers no link to a blocked person", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com", blocked: true });
    expect(await add("ana@example.com", "F2", {}, p.id)).toEqual({ ok: false, reason: "blocked", parentId: p.id, name: "Ana" });
    expect(await db.select().from(guardian)).toHaveLength(0);
  });

  it("refuses an address that isn't one", async () => {
    expect(await add("not-an-email", "F1")).toMatchObject({ ok: false, reason: "invalid", errors: ["Enter a valid email address."] });
  });

  it("re-enables a removed row instead of making a second one, with its old status, and welcomes them again", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardian({ parentId: p.id, familyQboId: "F1", status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" });
    const r = await add("ana@example.com", "F1", {}, p.id);
    expect(r).toMatchObject({ ok: true, outcome: "reenabled", guardianId: g.id, welcomeSent: true });
    expect(await db.select().from(guardian)).toMatchObject([{ id: g.id, status: "active", disabledReason: null, statusBeforeDisable: null }]);
    expect(await actions()).toEqual(["guardian.reenable", "guardian.welcome_sent"]);
  });
});

describe("removing, blocking and students", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); });

  it("removing one family leaves the person and their other family alone, and keeps their session", async () => {
    const p = await seedParent({ name: "Ana" });
    const g1 = await seedGuardian({ parentId: p.id, familyQboId: "F1" });
    await seedGuardian({ parentId: p.id, familyQboId: "F2" });
    await seedParentSession(p.authUserId, { familyQboId: "F2" });
    expect(await removeGuardian(g1.id, o)).toEqual({ ok: true, sessionsEnded: 0 });
    expect((await db.select().from(guardian).where(eq(guardian.id, g1.id)))[0]).toMatchObject({ status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" });
    expect((await enabledGuardianRows(p.id)).map((r) => r.familyQboId)).toEqual(["F2"]);
    expect(await sessionsOf(p.authUserId)).toHaveLength(1);
  });

  it("removing the last enabled row ends every session at once", async () => {
    const p = await seedParent({ name: "Ana" });
    const g = await seedGuardian({ parentId: p.id, familyQboId: "F1" });
    await seedParentSession(p.authUserId); await seedParentSession(p.authUserId);
    expect(await removeGuardian(g.id, o)).toEqual({ ok: true, sessionsEnded: 2 });
    expect(await sessionsOf(p.authUserId)).toHaveLength(0);
    const [a] = (await db.select().from(auditLog)).filter((x) => x.action === "guardian.remove");
    expect(a!.after).toMatchObject({ status: "disabled", disabledReason: "removed", sessionsEnded: 2 });
  });

  it("blocking ends sessions and drops unused codes but keeps the rows, so unblocking restores the same access", async () => {
    const p = await seedParent({ name: "Ana" });
    await seedGuardian({ parentId: p.id, familyQboId: "F1", status: "active" });
    await seedParentSession(p.authUserId);
    await db.insert(signinCode).values({ parentId: p.id, codeHash: "x", expiresAt: new Date(Date.now() + 60_000) });
    expect(await blockPerson(p.id, o)).toEqual({ ok: true, sessionsEnded: 1 });
    expect(await sessionsOf(p.authUserId)).toHaveLength(0);
    expect(await db.select().from(signinCode)).toHaveLength(0);
    expect(await db.select().from(guardian)).toMatchObject([{ status: "active" }]);
    expect(await unblockPerson(p.id, o)).toEqual({ ok: true });
    expect((await db.select().from(parent))[0]!.blocked).toBe(false);
    expect(await actions()).toEqual(["parent.block", "parent.unblock"]);
  });

  it("the family's last active student going disables its rows, and a student coming back restores each one's status", async () => {
    const a = await seedParent({ name: "Ana" });
    const b = await seedParent({ name: "Ben" });
    const c = await seedParent({ name: "Cy" });
    await seedGuardian({ parentId: a.id, familyQboId: "F1", status: "active" });
    await seedGuardian({ parentId: b.id, familyQboId: "F1", status: "invited" });
    await seedGuardian({ parentId: c.id, familyQboId: "F1", status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" });
    await seedGuardian({ parentId: b.id, familyQboId: "F9", status: "active" });
    await seedParentSession(a.authUserId); await seedParentSession(b.authUserId);
    expect(await onFamilyStudentsChanged("F1", false, o)).toEqual({ changed: 2 });
    const f1 = async () => Object.fromEntries((await db.select().from(guardian).where(eq(guardian.familyQboId, "F1"))).map((g) => [g.parentId, [g.status, g.disabledReason]]));
    expect(await f1()).toEqual({ [a.id]: ["disabled", "no_active_students"], [b.id]: ["disabled", "no_active_students"], [c.id]: ["disabled", "removed"] });
    expect(await sessionsOf(a.authUserId)).toHaveLength(0); // F1 was Ana's only family
    expect(await sessionsOf(b.authUserId)).toHaveLength(1); // Ben still has F9
    expect(await onFamilyStudentsChanged("F1", true, o)).toEqual({ changed: 2 });
    expect(await f1()).toEqual({ [a.id]: ["active", null], [b.id]: ["invited", null], [c.id]: ["disabled", "removed"] });
    expect((await actions()).filter((x) => x === "guardian.disable")).toHaveLength(2);
    expect((await actions()).filter((x) => x === "guardian.reenable")).toHaveLength(2);
    expect(outbox).toHaveLength(0); // coming back for a student sends no welcome
  });

  it("resends the welcome for an enabled row only", async () => {
    const p = await seedParent({ name: "Ana" });
    const g = await seedGuardian({ parentId: p.id, familyQboId: "F1", status: "invited" });
    expect(await resendWelcome(g.id, "the F1 family", o)).toEqual({ ok: true });
    expect(outbox).toHaveLength(1);
    await removeGuardian(g.id, o);
    expect(await resendWelcome(g.id, null, o)).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("staff changing a parent's email", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); });

  it("changes the one record and the sign-in user, ends sessions, tells the old address, and every family keeps working", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: p.id, familyQboId: "F1" });
    await seedGuardian({ parentId: p.id, familyQboId: "F2" });
    await seedParentSession(p.authUserId);
    expect(await changeParentEmailByStaff(p.id, " Ana.New@Example.com", o)).toEqual({ ok: true, changed: true });
    expect((await db.select().from(parent))[0]!.email).toBe("ana.new@example.com");
    expect((await db.select().from(parentAuthUser))[0]!.email).toBe("ana.new@example.com");
    expect(await sessionsOf(p.authUserId)).toHaveLength(0);
    expect((await enabledGuardianRows(p.id)).map((g) => g.familyQboId)).toEqual(["F1", "F2"]);
    expect(outbox.map((m) => m.to)).toEqual(["ana@example.com"]);
    expect(outbox[0]!.text).toMatch(/The club changed/);
    const [a] = (await db.select().from(auditLog)).filter((x) => x.action === "parent.email_change");
    expect(a).toMatchObject({ before: { email: "ana@example.com" }, after: { email: "ana.new@example.com", by: "staff", sessionsEnded: 1 } });
  });

  it("refuses an address another person holds, and says who", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    const q = await seedParent({ name: "Ben Lee", email: "ben@example.com" });
    expect(await changeParentEmailByStaff(p.id, "BEN@example.com", o)).toEqual({ ok: false, reason: "in_use", heldBy: { parentId: q.id, name: "Ben Lee" } });
  });

  it("treats a change of letter case only as no change", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedParentSession(p.authUserId);
    expect(await changeParentEmailByStaff(p.id, "ANA@Example.com", o)).toEqual({ ok: true, changed: false });
    expect(await sessionsOf(p.authUserId)).toHaveLength(1);
  });
});
```

`tests/integration/parents-email-change.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { db } from "@/lib/db/client";
import { parent, parentAuthSession, parentEmailChange } from "@/lib/db/schema";
import { requestParentEmailChange, confirmParentEmailChange, setPrimaryGuardianEmailHook } from "@/lib/parents/email-change";
import { resetDb, seedParent, seedGuardian, seedParentSession, seedWorkingMail } from "../helpers/db";

const tokenFrom = (m: Msg) => /token=([A-Za-z0-9_-]+)/.exec(m.text)![1]!;

describe("a parent changing their own email", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); setPrimaryGuardianEmailHook(async () => {}); });

  it("sends a confirm link to the new address and a notice to the old one, and changes nothing yet", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    expect(await requestParentEmailChange(p.id, "Ana.New@Example.com", { ip: null })).toEqual({ ok: true });
    expect(outbox.map((m) => m.to).sort()).toEqual(["ana.new@example.com", "ana@example.com"]);
    const link = outbox.find((m) => m.to === "ana.new@example.com")!;
    expect(link.text).toContain("http://localhost:3000/email-change/confirm?token=");
    const [row] = await db.select().from(parentEmailChange);
    expect(row!.tokenHash).not.toBe(tokenFrom(link)); // stored hashed
    expect((await db.select().from(parent))[0]!.email).toBe("ana@example.com");
  });

  it("on confirm updates the one record, ends sessions, tells QuickBooks about primary families, and works once", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: p.id, familyQboId: "F1", isPrimary: true });
    await seedGuardian({ parentId: p.id, familyQboId: "F2", isPrimary: false });
    await seedParentSession(p.authUserId);
    const calls: unknown[] = [];
    setPrimaryGuardianEmailHook(async (x) => { calls.push(x); });
    await requestParentEmailChange(p.id, "ana.new@example.com", { ip: null });
    const token = tokenFrom(outbox.find((m) => m.to === "ana.new@example.com")!);
    expect(await confirmParentEmailChange(token, { ip: "198.51.100.2" })).toEqual({ ok: true, parentId: p.id });
    expect((await db.select().from(parent))[0]!.email).toBe("ana.new@example.com");
    expect(await db.select().from(parentAuthSession)).toHaveLength(0);
    expect(calls).toEqual([{ parentId: p.id, email: "ana.new@example.com", familyQboIds: ["F1"] }]);
    expect(await confirmParentEmailChange(token, { ip: null })).toEqual({ ok: false, reason: "invalid" });
  });

  it("keeps the new address working when the QuickBooks update fails", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: p.id, familyQboId: "F1", isPrimary: true });
    setPrimaryGuardianEmailHook(async () => { throw new Error("QuickBooks is down"); });
    await requestParentEmailChange(p.id, "ana.new@example.com", { ip: null });
    expect(await confirmParentEmailChange(tokenFrom(outbox.find((m) => m.to === "ana.new@example.com")!), { ip: null })).toMatchObject({ ok: true });
    expect((await db.select().from(parent))[0]!.email).toBe("ana.new@example.com");
  });

  it("refuses an address in use, at request and again at confirm", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedParent({ name: "Ben", email: "ben@example.com" });
    expect(await requestParentEmailChange(p.id, "ben@example.com", { ip: null })).toEqual({ ok: false, reason: "in_use" });
    await requestParentEmailChange(p.id, "cy@example.com", { ip: null });
    const token = tokenFrom(outbox.find((m) => m.to === "cy@example.com")!);
    await seedParent({ name: "Cy", email: "cy@example.com" }); // someone else took it meanwhile
    expect(await confirmParentEmailChange(token, { ip: null })).toEqual({ ok: false, reason: "in_use" });
    expect((await db.select().from(parent)).find((x) => x.id === p.id)!.email).toBe("ana@example.com");
  });

  it("refuses an expired link", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await requestParentEmailChange(p.id, "ana.new@example.com", { ip: null });
    await db.update(parentEmailChange).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await confirmParentEmailChange(tokenFrom(outbox.find((m) => m.to === "ana.new@example.com")!), { ip: null })).toEqual({ ok: false, reason: "invalid" });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/integration/parents-people.test.ts tests/integration/parents-email-change.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/lib/parents/sessions.ts`**

```ts
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, signinCode } from "@/lib/db/schema";
import type { Actor } from "@/lib/audit/log";

export type GuardianRow = typeof guardian.$inferSelect;

export const parentActor = (p: { id: string; email: string }): Actor => ({ door: "parent", id: p.id, label: p.email });

/** Ends every session the person has, at once (spec §1 The session). Sessions are read from the database on each request. */
export async function endParentSessions(parentId: string, tx?: Tx): Promise<number> {
  const rows = await (tx ?? db).execute<{ id: string }>(sql`DELETE FROM parent_auth_session
    WHERE user_id IN (SELECT id FROM parent_auth_user WHERE parent_id = ${parentId}) RETURNING id`);
  return Array.from(rows as ArrayLike<{ id: string }>).length;
}

export async function enabledGuardianRows(parentId: string, tx?: Tx): Promise<GuardianRow[]> {
  return (tx ?? db).select().from(guardian)
    .where(and(eq(guardian.parentId, parentId), ne(guardian.status, "disabled"))).orderBy(guardian.familyQboId);
}

export async function deleteUnusedSigninCodes(parentId: string, tx: Tx): Promise<void> {
  await tx.delete(signinCode).where(and(eq(signinCode.parentId, parentId), isNull(signinCode.usedAt)));
}
```

- [ ] **Step 4: Implement `src/lib/parents/people.ts`**

```ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, parent, parentAuthUser, parentEmailChange } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { env } from "@/env";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { welcomeMessage, emailChangeNoticeMessage } from "@/lib/mail/messages";
import { endParentSessions, enabledGuardianRows, deleteUnusedSigninCodes } from "./sessions";

export type StaffOp = { actor: Actor; ip: string | null; permission?: string };
export type GuardianInput = { familyQboId: string; familyLabel: string; name: string; email: string; phone?: string | null; isPrimary?: boolean };
export type AddGuardianResult =
  | { ok: true; outcome: "created" | "linked" | "reenabled"; parentId: string; guardianId: string; welcomeSent: boolean }
  | { ok: false; reason: "confirm_link"; parentId: string; name: string; familyQboIds: string[] }
  | { ok: false; reason: "blocked"; parentId: string; name: string }
  | { ok: false; reason: "already_in_family"; parentId: string; guardianId: string }
  | { ok: false; reason: "invalid"; errors: string[] };

const appUrl = () => env.APP_URL.replace(/\/+$/, "");
/** Serializes changes that claim an email address, so two staff adding the same address can't make two people. */
const lockEmail = (tx: Tx, email: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.parent_email:${email}`}))`);

const inputSchema = z.object({
  familyQboId: z.string().trim().min(1, "Choose the family."),
  familyLabel: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1, "Enter the guardian's name.").max(120, "That name is too long."),
  email: z.string().transform((v, ctx) => {
    const e = normalizeEmail(v);
    if (!e) { ctx.addIssue({ code: "custom", message: "Enter a valid email address." }); return z.NEVER; }
    return e;
  }),
  phone: z.string().trim().max(40, "That phone number is too long.").nullish().transform((v) => (v ? v : null)),
  isPrimary: z.boolean().optional(),
});

async function welcome(parentId: string, guardianId: string, familyLabel: string | null, o: StaffOp): Promise<boolean> {
  const [p] = await db.select().from(parent).where(eq(parent.id, parentId));
  if (!p) return false;
  const r = await sendMail(welcomeMessage(await currentBrand(), p.email, { appUrl: appUrl(), familyLabel }), { purpose: "welcome", actor: o.actor, ip: o.ip });
  if (r.ok) await writeAudit({ actor: o.actor, action: "guardian.welcome_sent", permission: o.permission, targetType: "guardian", targetId: guardianId,
    after: { parentId, to: p.email }, ip: o.ip });
  return r.ok;
}

/**
 * Spec §2 Adding a guardian. A new email makes the person and an invited row. An existing person's email returns
 * `confirm_link` and writes nothing; the caller shows "This person is already a guardian in … Link them to this family
 * too?" and calls again with `confirmLinkParentId` set to that person's id. A removed row for the same family is
 * re-enabled instead of duplicated. The welcome email goes out after the change is committed.
 */
export async function createOrLinkGuardian(raw: GuardianInput, o: StaffOp & { confirmLinkParentId?: string }): Promise<AddGuardianResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid", errors: parsed.error.issues.map((i) => i.message) };
  const g = parsed.data;
  const base = { actor: o.actor, permission: o.permission, ip: o.ip };
  const r = await db.transaction(async (tx) => {
    await lockEmail(tx, g.email);
    const [existing] = await tx.select().from(parent).where(eq(parent.email, g.email));
    if (!existing) {
      const [p] = await tx.insert(parent).values({ name: g.name, email: g.email, phone: g.phone }).returning();
      await tx.insert(parentAuthUser).values({ id: randomUUID(), name: g.name, email: g.email, emailVerified: true, parentId: p!.id });
      const [row] = await tx.insert(guardian).values({ familyQboId: g.familyQboId, parentId: p!.id, isPrimary: g.isPrimary ?? false, status: "invited" }).returning();
      await writeAudit({ ...base, action: "parent.create", targetType: "parent", targetId: p!.id, after: { name: g.name, email: g.email, phone: g.phone } }, tx);
      await writeAudit({ ...base, action: "guardian.create", targetType: "guardian", targetId: row!.id,
        after: { parentId: p!.id, familyQboId: g.familyQboId, isPrimary: row!.isPrimary, status: "invited" } }, tx);
      return { ok: true as const, outcome: "created" as const, parentId: p!.id, guardianId: row!.id };
    }
    if (existing.blocked) return { ok: false as const, reason: "blocked" as const, parentId: existing.id, name: existing.name };
    const rows = await tx.select().from(guardian).where(eq(guardian.parentId, existing.id)).orderBy(guardian.familyQboId);
    const here = rows.find((x) => x.familyQboId === g.familyQboId);
    if (here && !(here.status === "disabled" && here.disabledReason === "removed")) {
      return { ok: false as const, reason: "already_in_family" as const, parentId: existing.id, guardianId: here.id };
    }
    if (o.confirmLinkParentId !== existing.id) {
      return { ok: false as const, reason: "confirm_link" as const, parentId: existing.id, name: existing.name,
        familyQboIds: rows.filter((x) => x.status !== "disabled").map((x) => x.familyQboId) };
    }
    if (here) {
      const status = here.statusBeforeDisable ?? "invited";
      await tx.update(guardian).set({ status, disabledReason: null, statusBeforeDisable: null, isPrimary: g.isPrimary ?? here.isPrimary, updatedAt: new Date() })
        .where(eq(guardian.id, here.id));
      await writeAudit({ ...base, action: "guardian.reenable", targetType: "guardian", targetId: here.id,
        before: { status: "disabled", disabledReason: "removed" }, after: { status } }, tx);
      return { ok: true as const, outcome: "reenabled" as const, parentId: existing.id, guardianId: here.id };
    }
    const [row] = await tx.insert(guardian).values({ familyQboId: g.familyQboId, parentId: existing.id, isPrimary: g.isPrimary ?? false, status: "invited" }).returning();
    await writeAudit({ ...base, action: "guardian.create", targetType: "guardian", targetId: row!.id,
      after: { parentId: existing.id, familyQboId: g.familyQboId, isPrimary: row!.isPrimary, status: "invited", linked: true } }, tx);
    return { ok: true as const, outcome: "linked" as const, parentId: existing.id, guardianId: row!.id };
  });
  if (!r.ok) return r;
  // A new person's welcome doesn't name the family; an existing person's names the one they were added to (spec §2).
  const welcomeSent = await welcome(r.parentId, r.guardianId, r.outcome === "created" ? null : g.familyLabel, o);
  return { ...r, welcomeSent };
}

/** Staff remove a guardian from one family. The person and their other families aren't touched. */
export async function removeGuardian(guardianId: string, o: StaffOp): Promise<{ ok: true; sessionsEnded: number } | { ok: false; reason: "not_found" }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(guardian).where(eq(guardian.id, guardianId)).for("update");
    if (!row) return { ok: false as const, reason: "not_found" as const };
    if (row.status === "disabled" && row.disabledReason === "removed") return { ok: true as const, sessionsEnded: 0 };
    const statusBeforeDisable = row.status === "disabled" ? row.statusBeforeDisable : row.status;
    await tx.update(guardian).set({ status: "disabled", disabledReason: "removed", statusBeforeDisable, updatedAt: new Date() }).where(eq(guardian.id, row.id));
    const sessionsEnded = (await enabledGuardianRows(row.parentId, tx)).length === 0 ? await endParentSessions(row.parentId, tx) : 0;
    await writeAudit({ actor: o.actor, action: "guardian.remove", permission: o.permission, targetType: "guardian", targetId: row.id,
      before: { status: row.status, disabledReason: row.disabledReason }, after: { status: "disabled", disabledReason: "removed", sessionsEnded }, ip: o.ip }, tx);
    return { ok: true as const, sessionsEnded };
  });
}

/** No codes, every session ends. Guardian rows keep their status, so unblocking restores the same access. */
export async function blockPerson(parentId: string, o: StaffOp): Promise<{ ok: true; sessionsEnded: number } | { ok: false; reason: "not_found" }> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    await tx.update(parent).set({ blocked: true, updatedAt: new Date() }).where(eq(parent.id, p.id));
    await deleteUnusedSigninCodes(p.id, tx);
    const sessionsEnded = await endParentSessions(p.id, tx);
    await writeAudit({ actor: o.actor, action: "parent.block", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { blocked: p.blocked }, after: { blocked: true, sessionsEnded }, ip: o.ip }, tx);
    return { ok: true as const, sessionsEnded };
  });
}

export async function unblockPerson(parentId: string, o: StaffOp): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    await tx.update(parent).set({ blocked: false, updatedAt: new Date() }).where(eq(parent.id, p.id));
    await writeAudit({ actor: o.actor, action: "parent.unblock", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { blocked: p.blocked }, after: { blocked: false }, ip: o.ip }, tx);
    return { ok: true as const };
  });
}

/**
 * Spec §2 Status changes. The roster plan calls this whenever a family's students change. No active students: the
 * family's enabled rows become disabled (`no_active_students`). Students again: those rows go back to the status they
 * had. Rows disabled as `removed` stay disabled either way.
 */
export async function onFamilyStudentsChanged(familyQboId: string, hasActiveStudents: boolean, o: StaffOp): Promise<{ changed: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(guardian).where(eq(guardian.familyQboId, familyQboId)).for("update");
    let changed = 0;
    for (const row of rows) {
      if (!hasActiveStudents && row.status !== "disabled") {
        await tx.update(guardian).set({ status: "disabled", disabledReason: "no_active_students", statusBeforeDisable: row.status, updatedAt: new Date() }).where(eq(guardian.id, row.id));
        const sessionsEnded = (await enabledGuardianRows(row.parentId, tx)).length === 0 ? await endParentSessions(row.parentId, tx) : 0;
        await writeAudit({ actor: o.actor, action: "guardian.disable", permission: o.permission, targetType: "guardian", targetId: row.id,
          before: { status: row.status }, after: { status: "disabled", disabledReason: "no_active_students", sessionsEnded }, ip: o.ip }, tx);
        changed++;
      } else if (hasActiveStudents && row.status === "disabled" && row.disabledReason === "no_active_students") {
        const status = row.statusBeforeDisable ?? "invited";
        await tx.update(guardian).set({ status, disabledReason: null, statusBeforeDisable: null, updatedAt: new Date() }).where(eq(guardian.id, row.id));
        await writeAudit({ actor: o.actor, action: "guardian.reenable", permission: o.permission, targetType: "guardian", targetId: row.id,
          before: { status: "disabled", disabledReason: "no_active_students" }, after: { status }, ip: o.ip }, tx);
        changed++;
      }
    }
    return { changed };
  });
}

/** **Resend welcome** on a guardian. */
export async function resendWelcome(guardianId: string, familyLabel: string | null, o: StaffOp):
  Promise<{ ok: true } | { ok: false; reason: "not_found" | "disabled" | "blocked" | "mail_failed"; error?: string }> {
  const [row] = await db.select({ g: guardian, p: parent }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId)).where(eq(guardian.id, guardianId));
  if (!row) return { ok: false, reason: "not_found" };
  if (row.g.status === "disabled") return { ok: false, reason: "disabled" };
  if (row.p.blocked) return { ok: false, reason: "blocked" };
  return (await welcome(row.p.id, row.g.id, familyLabel, o)) ? { ok: true } : { ok: false, reason: "mail_failed" };
}

/** Staff change a parent's email directly (spec §2). Audited; the old address gets a notice; every session ends. */
export async function changeParentEmailByStaff(parentId: string, rawEmail: string, o: StaffOp):
  Promise<{ ok: true; changed: boolean } | { ok: false; reason: "invalid" | "not_found" } | { ok: false; reason: "in_use"; heldBy: { parentId: string; name: string } }> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, reason: "invalid" };
  const r = await db.transaction(async (tx) => {
    await lockEmail(tx, email);
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    if (p.email === email) return { ok: true as const, changed: false, oldEmail: p.email };
    const [other] = await tx.select().from(parent).where(and(eq(parent.email, email), ne(parent.id, p.id)));
    if (other) return { ok: false as const, reason: "in_use" as const, heldBy: { parentId: other.id, name: other.name } };
    await tx.update(parent).set({ email, updatedAt: new Date() }).where(eq(parent.id, p.id));
    await tx.update(parentAuthUser).set({ email, updatedAt: new Date() }).where(eq(parentAuthUser.parentId, p.id));
    await deleteUnusedSigninCodes(p.id, tx);
    await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, p.id), isNull(parentEmailChange.usedAt)));
    const sessionsEnded = await endParentSessions(p.id, tx);
    await writeAudit({ actor: o.actor, action: "parent.email_change", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { email: p.email }, after: { email, by: "staff", sessionsEnded }, ip: o.ip }, tx);
    return { ok: true as const, changed: true, oldEmail: p.email };
  });
  if (!r.ok) return r;
  if (r.changed) await sendMail(emailChangeNoticeMessage(await currentBrand(), r.oldEmail, { byStaff: true }), { purpose: "email_change_notice", actor: o.actor, ip: o.ip });
  return { ok: true, changed: r.changed };
}
```

- [ ] **Step 5: Implement `src/lib/parents/email-change.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, parent, parentAuthUser, parentEmailChange } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { env } from "@/env";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { emailChangeConfirmMessage, emailChangeNoticeMessage } from "@/lib/mail/messages";
import { endParentSessions, deleteUnusedSigninCodes, parentActor } from "./sessions";

export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;
export const PARENT_EMAIL_IN_USE = "That address is already in use. Ask the club to help.";

export type PrimaryEmailHook = (o: { parentId: string; email: string; familyQboIds: string[] }) => Promise<void>;
let primaryEmailHook: PrimaryEmailHook = async () => {};
/**
 * The QuickBooks seam (v1 §6.2 step 3). The roster/QuickBooks plan sets this to update the primary email on each of these
 * families' QuickBooks customers, putting a failed write on the write queue. Until then it does nothing.
 */
export function setPrimaryGuardianEmailHook(h: PrimaryEmailHook): void { primaryEmailHook = h; }

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const emailChangeLink = (token: string) => `${env.APP_URL.replace(/\/+$/, "")}/email-change/confirm?token=${token}`;
const lockEmail = (email: string) => sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.parent_email:${email}`}))`;

/** Step 1 and 2 of a parent's own change: a single-use, hashed, expiring link to the new address, and a notice to the old one. */
export async function requestParentEmailChange(parentId: string, rawEmail: string, o: { ip: string | null }):
  Promise<{ ok: true } | { ok: false; reason: "invalid" | "same" | "not_found" | "in_use" }> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, reason: "invalid" };
  const token = randomBytes(32).toString("base64url");
  const r = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    if (p.email === email) return { ok: false as const, reason: "same" as const };
    const actor = parentActor(p);
    const [other] = await tx.select({ id: parent.id }).from(parent).where(and(eq(parent.email, email), ne(parent.id, p.id)));
    if (other) {
      await writeAudit({ actor, action: "parent.email_change_refused", targetType: "parent", targetId: p.id, after: { email, reason: "in_use" }, ip: o.ip }, tx);
      return { ok: false as const, reason: "in_use" as const };
    }
    await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, p.id), isNull(parentEmailChange.usedAt)));
    await tx.insert(parentEmailChange).values({ parentId: p.id, newEmail: email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS) });
    await writeAudit({ actor, action: "parent.email_change_request", targetType: "parent", targetId: p.id, after: { email }, ip: o.ip }, tx);
    return { ok: true as const, actor, oldEmail: p.email };
  });
  if (!r.ok) return r;
  const brand = await currentBrand();
  await sendMail(emailChangeConfirmMessage(brand, email, { link: emailChangeLink(token) }), { purpose: "email_change_confirm", actor: r.actor, ip: o.ip });
  await sendMail(emailChangeNoticeMessage(brand, r.oldEmail, { byStaff: false }), { purpose: "email_change_notice", actor: r.actor, ip: o.ip });
  return { ok: true };
}

/** Step 3: the new address works for sign-in as soon as this commits; QuickBooks follows through the hook. */
export async function confirmParentEmailChange(token: string, o: { ip: string | null }): Promise<{ ok: true; parentId: string } | { ok: false; reason: "invalid" | "in_use" }> {
  const r = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(parentEmailChange)
      .where(and(eq(parentEmailChange.tokenHash, hashToken(token)), isNull(parentEmailChange.usedAt))).for("update");
    if (!row || row.expiresAt.getTime() <= Date.now()) return { ok: false as const, reason: "invalid" as const };
    await tx.execute(lockEmail(row.newEmail));
    const [p] = await tx.select().from(parent).where(eq(parent.id, row.parentId)).for("update");
    if (!p) return { ok: false as const, reason: "invalid" as const };
    const actor = parentActor(p);
    await tx.update(parentEmailChange).set({ usedAt: new Date() }).where(eq(parentEmailChange.id, row.id));
    const [other] = await tx.select({ id: parent.id }).from(parent).where(and(eq(parent.email, row.newEmail), ne(parent.id, p.id)));
    if (other) {
      await writeAudit({ actor, action: "parent.email_change_refused", targetType: "parent", targetId: p.id, after: { email: row.newEmail, reason: "in_use" }, ip: o.ip }, tx);
      return { ok: false as const, reason: "in_use" as const };
    }
    await tx.update(parent).set({ email: row.newEmail, updatedAt: new Date() }).where(eq(parent.id, p.id));
    await tx.update(parentAuthUser).set({ email: row.newEmail, updatedAt: new Date() }).where(eq(parentAuthUser.parentId, p.id));
    await deleteUnusedSigninCodes(p.id, tx);
    const sessionsEnded = await endParentSessions(p.id, tx);
    await writeAudit({ actor, action: "parent.email_change", targetType: "parent", targetId: p.id,
      before: { email: p.email }, after: { email: row.newEmail, by: "parent", sessionsEnded }, ip: o.ip }, tx);
    const primaries = await tx.select({ f: guardian.familyQboId }).from(guardian)
      .where(and(eq(guardian.parentId, p.id), eq(guardian.isPrimary, true), ne(guardian.status, "disabled"))).orderBy(guardian.familyQboId);
    return { ok: true as const, parentId: p.id, email: row.newEmail, familyQboIds: primaries.map((x) => x.f), actor };
  });
  if (!r.ok) return r;
  if (r.familyQboIds.length) {
    try {
      await primaryEmailHook({ parentId: r.parentId, email: r.email, familyQboIds: r.familyQboIds });
    } catch {
      // The hook owns retries (the write queue); a failure here must not undo the change, which already took effect.
      await writeAudit({ actor: r.actor, action: "parent.email_change.quickbooks_failed", targetType: "parent", targetId: r.parentId,
        after: { familyQboIds: r.familyQboIds }, ip: o.ip });
    }
  }
  return { ok: true, parentId: r.parentId };
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/integration/parents-people.test.ts tests/integration/parents-email-change.test.ts`
Expected: PASS.

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/parents tests/integration/parents-people.test.ts tests/integration/parents-email-change.test.ts
git commit -m "feat(parents): add, link, remove and block people; student changes; email changes

Adding an existing person asks for confirmation and links the same record. Blocking, losing the last
family and an email change end every session. The QuickBooks primary-email update is a named hook
the roster plan fills.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sign-in codes and rate limits

Spec §1 The code, Rate limits, Addresses, Audit. Portal code only (no HTTP yet). `requestSigninCode` returns as soon as
it has decided and stored the code; the email goes out in `delivery`, which the endpoint in Task 6 never awaits, so the
answer takes the same time whether or not anything is sent. `verifySigninCode` reports only `rejected` or
`rate_limited` to its caller; the audit log keeps the real reason.

**Files:**
- Create: `src/lib/parents/rate-limit.ts`, `src/lib/parents/signin-codes.ts`, `src/lib/parents/signin-copy.ts`
- Test: `tests/integration/rate-limit.test.ts`, `tests/integration/signin-codes.test.ts`

**Interfaces:**
- Consumes: `signinCode`, `rateLimitEvent`, `parent` (Task 2); `enabledGuardianRows`, `parentActor`,
  `deleteUnusedSigninCodes` (Task 4); `sendMail`, `currentBrand`, `mailWorking`, `signinCodeMessage` (Task 3);
  `normalizeEmail`; `writeAudit`; `env.BETTER_AUTH_SECRET`.
- Produces (`rate-limit.ts`):
  - `type RateLimitKind = "code_send_email" | "code_send_ip" | "code_check_ip"`
  - `RATE_LIMITS: Record<RateLimitKind, { max: number; windowMs: number }>` — 3, 10 and 30 per 15 minutes
  - `takeRateLimit(kind: RateLimitKind, subject: string, now?: Date): Promise<boolean>` — true and counted when under the limit
- Produces (`signin-codes.ts`):
  - `CODE_TTL_MS = 600_000`, `CODE_MAX_TRIES = 5`, `RESEND_AFTER_MS = 60_000`
  - `generateSigninCode(): string`, `hashSigninCode(parentId: string, code: string): string`
  - `requestSigninCode(rawEmail: string, ip: string | null, now?: Date): Promise<{ delivery: Promise<void> }>`
  - `type VerifyResult = { ok: true; parentId: string } | { ok: false; reason: "rejected" | "rate_limited" }`
  - `verifySigninCode(rawEmail: string, rawCode: string, ip: string | null, now?: Date): Promise<VerifyResult>`
- Produces (`signin-copy.ts`, no imports): `CODE_SENT`, `CODE_REJECTED`, `TOO_MANY_TRIES`, `SIGNIN_UNAVAILABLE`,
  `SIGNIN_NETWORK_FAILED` strings.

- [ ] **Step 1: Write the failing tests**

`tests/integration/rate-limit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { rateLimitEvent } from "@/lib/db/schema";
import { takeRateLimit } from "@/lib/parents/rate-limit";
import { resetDb } from "../helpers/db";

describe("database rate limits", () => {
  beforeEach(resetDb);

  it("allows the limit within 15 minutes, refuses the next, and counts each subject on its own", async () => {
    const t = new Date("2026-11-10T12:00:00Z");
    for (let i = 0; i < 3; i++) expect(await takeRateLimit("code_send_email", "ana@example.com", t)).toBe(true);
    expect(await takeRateLimit("code_send_email", "ana@example.com", t)).toBe(false);
    expect(await takeRateLimit("code_send_email", "ben@example.com", t)).toBe(true);
    expect(await takeRateLimit("code_send_ip", "ana@example.com", t)).toBe(true);
  });

  it("is a sliding window, and drops events older than it", async () => {
    const t = new Date("2026-11-10T12:00:00Z");
    for (let i = 0; i < 3; i++) await takeRateLimit("code_send_email", "ana@example.com", t);
    expect(await takeRateLimit("code_send_email", "ana@example.com", new Date(t.getTime() + 14 * 60_000))).toBe(false);
    expect(await takeRateLimit("code_send_email", "ana@example.com", new Date(t.getTime() + 15 * 60_000 + 1))).toBe(true);
    expect(await db.select().from(rateLimitEvent)).toHaveLength(1);
  });

  it("holds under a burst of parallel requests", async () => {
    const t = new Date("2026-11-10T12:00:00Z");
    const got = await Promise.all(Array.from({ length: 25 }, () => takeRateLimit("code_send_ip", "203.0.113.9", t)));
    expect(got.filter(Boolean)).toHaveLength(10);
  });
});
```

`tests/integration/signin-codes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[], gate: null as Promise<void> | null, fail: false }));
vi.mock("@/lib/mail/senders", async () => {
  const { MailSendError } = await import("@/lib/mail/types");
  return {
    SMTP_PASSWORD_AAD: "mail:smtp-password",
    buildSender: async () => async (m: Msg) => {
      if (mail.gate) await mail.gate;
      if (mail.fail) throw new MailSendError("The mail server didn't accept the message (EENVELOPE 550).");
      mail.outbox.push(m);
    },
  };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, signinCode } from "@/lib/db/schema";
import { requestSigninCode, verifySigninCode, hashSigninCode, CODE_TTL_MS } from "@/lib/parents/signin-codes";
import { resetDb, seedParent, seedGuardian, seedWorkingMail } from "../helpers/db";

const T0 = new Date("2026-11-10T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const IP = "203.0.113.20";
const codeOf = (m: Msg) => /sign-in code: (\d{6})/.exec(m.subject)![1]!;
const audits = async (action: string) => (await db.select().from(auditLog)).filter((a) => a.action === action);
async function send(email: string, now = T0, ip: string | null = IP) { const r = await requestSigninCode(email, ip, now); await r.delivery; }

async function ana(o: { blocked?: boolean; status?: "invited" | "active" | "disabled" } = {}) {
  const p = await seedParent({ name: "Ana", email: "ana@example.com", blocked: o.blocked });
  await seedGuardian({ parentId: p.id, familyQboId: "F1", status: o.status ?? "active", disabledReason: o.status === "disabled" ? "removed" : null });
  return p;
}

describe("requesting a code", () => {
  beforeEach(async () => { await resetDb(); mail.outbox.length = 0; mail.gate = null; mail.fail = false; await seedWorkingMail(); });
  afterEach(() => vi.restoreAllMocks());

  it("sends a 6-digit code to a person with an enabled row, stored only as a hash, valid 10 minutes", async () => {
    const p = await ana();
    await send("ana@example.com");
    expect(mail.outbox).toHaveLength(1);
    const code = codeOf(mail.outbox[0]!);
    expect(code).toMatch(/^\d{6}$/);
    const [row] = await db.select().from(signinCode);
    expect(row!.codeHash).toBe(hashSigninCode(p.id, code));
    expect(row!.codeHash).not.toContain(code);
    expect(row!.expiresAt.getTime()).toBe(T0.getTime() + CODE_TTL_MS);
    expect((await audits("signin.code_sent"))[0]).toMatchObject({ door: "parent", actorId: p.id, targetType: "parent", targetId: p.id, ip: IP });
  });

  it.each([
    ["an unknown email", async () => undefined, "unknown_email"],
    ["a blocked person", () => ana({ blocked: true }), "blocked"],
    ["a person whose rows are all disabled", () => ana({ status: "disabled" }), "no_enabled_guardian"],
  ] as const)("sends nothing to %s and audits why", async (_, setup, reason) => {
    await setup();
    await send("ana@example.com");
    expect(mail.outbox).toHaveLength(0);
    expect(await db.select().from(signinCode)).toHaveLength(0);
    expect((await audits("signin.code_refused"))[0]).toMatchObject({ actorLabel: "ana@example.com", after: { reason } });
  });

  it("matches case and spaces the same on both steps", async () => {
    const p = await ana();
    await send("  Ana@Example.COM ");
    expect(mail.outbox[0]!.to).toBe("ana@example.com");
    expect(await verifySigninCode(" ANA@example.com", codeOf(mail.outbox[0]!), IP, at(1000))).toEqual({ ok: true, parentId: p.id });
  });

  it("answers before the email is sent", async () => {
    await ana();
    let release!: () => void;
    mail.gate = new Promise<void>((r) => { release = r; });
    const r = await requestSigninCode("ana@example.com", IP, T0);
    expect(mail.outbox).toHaveLength(0); // the caller already has its answer; the send is still waiting
    release();
    await r.delivery;
    expect(mail.outbox).toHaveLength(1);
  });

  it("a new code replaces the earlier one, and only the newest works", async () => {
    await ana();
    await send("ana@example.com");
    await send("ana@example.com", at(61_000));
    const [first, second] = mail.outbox.map(codeOf);
    expect(await db.select().from(signinCode)).toHaveLength(1);
    if (first !== second) expect(await verifySigninCode("ana@example.com", first!, IP, at(62_000))).toEqual({ ok: false, reason: "rejected" });
    expect(await verifySigninCode("ana@example.com", second!, IP, at(63_000))).toMatchObject({ ok: true });
  });

  it("two requests at once leave exactly one live code", async () => {
    await ana();
    const rs = await Promise.all([requestSigninCode("ana@example.com", IP, T0), requestSigninCode("ana@example.com", IP, T0)]);
    await Promise.all(rs.map((r) => r.delivery));
    expect(await db.select().from(signinCode)).toHaveLength(1);
    expect(mail.outbox).toHaveLength(1);
    expect((await audits("signin.code_refused"))[0]).toMatchObject({ after: { reason: "rate_limited", limit: "resend" } });
  });

  it("holds 3 codes per email and 10 requests per IP in 15 minutes, and audits hitting them", async () => {
    await ana();
    for (let i = 0; i < 4; i++) await send("ana@example.com", at(i * 61_000));
    expect(mail.outbox).toHaveLength(3);
    expect((await audits("signin.code_refused")).at(-1)).toMatchObject({ after: { reason: "rate_limited", limit: "email" } });
    for (let i = 0; i < 7; i++) await send(`nobody${i}@example.com`, at(300_000), "198.51.100.7");
    await send("ana@example.com", at(300_000), "198.51.100.7"); // 8th from this IP: still allowed by the IP limit, refused by the email one
    for (let i = 0; i < 2; i++) await send(`more${i}@example.com`, at(300_000), "198.51.100.7");
    await send("x@example.com", at(300_000), "198.51.100.7");
    expect((await audits("signin.code_refused")).at(-1)).toMatchObject({ after: { reason: "rate_limited", limit: "ip" } });
  });

  it("audits a failed send as mail_failed and leaves no usable code", async () => {
    await ana();
    mail.fail = true;
    await send("ana@example.com");
    expect((await audits("signin.code_refused"))[0]).toMatchObject({ after: { reason: "mail_failed" } });
    expect(await db.select().from(signinCode)).toHaveLength(0);
  });

  it("sends nothing while mail isn't working", async () => {
    await resetDb();
    await ana();
    await send("ana@example.com");
    expect(mail.outbox).toHaveLength(0);
    expect((await audits("signin.code_refused"))[0]).toMatchObject({ after: { reason: "mail_failed", detail: "mail_not_working" } });
  });

  it("never puts the code in a log line or the audit log", async () => {
    await ana();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    await send("ana@example.com");
    const code = codeOf(mail.outbox[0]!);
    await verifySigninCode("ana@example.com", "000000" === code ? "111111" : "000000", IP, at(1000));
    await verifySigninCode("ana@example.com", code, IP, at(2000));
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(code);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(code);
  });
});

describe("checking a code", () => {
  beforeEach(async () => { await resetDb(); mail.outbox.length = 0; mail.gate = null; mail.fail = false; await seedWorkingMail(); });

  const wrong = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, "0");

  it("works once", async () => {
    await ana();
    await send("ana@example.com");
    const code = codeOf(mail.outbox[0]!);
    expect(await verifySigninCode("ana@example.com", code, IP, at(1000))).toMatchObject({ ok: true });
    expect(await verifySigninCode("ana@example.com", code, IP, at(2000))).toEqual({ ok: false, reason: "rejected" });
    expect((await audits("signin.code_expired"))[0]).toMatchObject({ after: { reason: "no_code" } });
  });

  it("works once even when two checks race", async () => {
    await ana();
    await send("ana@example.com");
    const code = codeOf(mail.outbox[0]!);
    const rs = await Promise.all([verifySigninCode("ana@example.com", code, IP, at(1000)), verifySigninCode("ana@example.com", code, IP, at(1000))]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("expires after 10 minutes", async () => {
    await ana();
    await send("ana@example.com");
    expect(await verifySigninCode("ana@example.com", codeOf(mail.outbox[0]!), IP, at(CODE_TTL_MS))).toEqual({ ok: false, reason: "rejected" });
    expect((await audits("signin.code_expired"))[0]).toMatchObject({ after: { reason: "expired" } });
  });

  it("dies after 5 wrong tries, recording each try number", async () => {
    await ana();
    await send("ana@example.com");
    const code = codeOf(mail.outbox[0]!);
    for (let i = 1; i <= 5; i++) expect(await verifySigninCode("ana@example.com", wrong(code), IP, at(i * 1000))).toEqual({ ok: false, reason: "rejected" });
    expect(await verifySigninCode("ana@example.com", code, IP, at(6000))).toEqual({ ok: false, reason: "rejected" });
    expect((await audits("signin.code_wrong")).map((a) => (a.after as { try: number }).try)).toEqual([1, 2, 3, 4, 5]);
    expect((await audits("signin.code_expired"))[0]).toMatchObject({ after: { reason: "too_many_tries" } });
  });

  it("refuses a right code for a person blocked after it was sent", async () => {
    const p = await ana();
    await send("ana@example.com");
    const { blockPerson } = await import("@/lib/parents/people");
    await blockPerson(p.id, { actor: { door: "staff", id: null, label: "board" }, ip: null });
    expect(await verifySigninCode("ana@example.com", codeOf(mail.outbox[0]!), IP, at(1000))).toEqual({ ok: false, reason: "rejected" });
  });

  it("allows 30 checks per IP in 15 minutes", async () => {
    for (let i = 0; i < 30; i++) expect(await verifySigninCode(`n${i}@example.com`, "123456", IP, at(i))).toEqual({ ok: false, reason: "rejected" });
    expect(await verifySigninCode("n@example.com", "123456", IP, at(31))).toEqual({ ok: false, reason: "rate_limited" });
    expect((await audits("signin.code_refused")).at(-1)).toMatchObject({ after: { reason: "rate_limited", limit: "check_ip" } });
  });

  it("counts a code with letters or the wrong length as a wrong try", async () => {
    await ana();
    await send("ana@example.com");
    expect(await verifySigninCode("ana@example.com", "12a456", IP, at(1000))).toEqual({ ok: false, reason: "rejected" });
    const [row] = await db.select().from(signinCode);
    expect(row!.tries).toBe(1);
    expect(await verifySigninCode("ana@example.com", ` ${codeOf(mail.outbox[0]!).slice(0, 3)} ${codeOf(mail.outbox[0]!).slice(3)} `, IP, at(2000))).toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/integration/rate-limit.test.ts tests/integration/signin-codes.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/lib/parents/rate-limit.ts`**

```ts
import { and, eq, gt, lte, sql, count } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { rateLimitEvent } from "@/lib/db/schema";

export type RateLimitKind = "code_send_email" | "code_send_ip" | "code_check_ip";
const WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMITS: Record<RateLimitKind, { max: number; windowMs: number }> = {
  code_send_email: { max: 3, windowMs: WINDOW_MS },
  code_send_ip: { max: 10, windowMs: WINDOW_MS },
  code_check_ip: { max: 30, windowMs: WINDOW_MS },
};

/**
 * Counts one event for (kind, subject) and returns true, or returns false without counting when the sliding window is
 * full. Held in the database, so it survives restarts and holds across servers; a per-subject advisory lock (the setup
 * code's try counter uses the same reserve-then-compare idea) makes a parallel burst count exactly.
 */
export async function takeRateLimit(kind: RateLimitKind, subject: string, now = new Date()): Promise<boolean> {
  const { max, windowMs } = RATE_LIMITS[kind];
  const since = new Date(now.getTime() - windowMs);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.rate:${kind}:${subject}`}))`);
    const scope = and(eq(rateLimitEvent.kind, kind), eq(rateLimitEvent.subject, subject));
    await tx.delete(rateLimitEvent).where(and(scope, lte(rateLimitEvent.at, since)));
    const [{ n }] = (await tx.select({ n: count() }).from(rateLimitEvent).where(and(scope, gt(rateLimitEvent.at, since)))) as [{ n: number }];
    if (n >= max) return false;
    await tx.insert(rateLimitEvent).values({ kind, subject, at: now });
    return true;
  });
}
```

- [ ] **Step 4: Implement `src/lib/parents/signin-copy.ts` and `src/lib/parents/signin-codes.ts`**

`src/lib/parents/signin-copy.ts`:

```ts
// The sign-in page's fixed sentences (spec §1). No imports: the client component uses this file.
export const CODE_SENT = "If this email belongs to a family in the club, we've sent a 6-digit code. It can take a minute. Check your spam folder too.";
/** One answer for a wrong, expired, used-up or never-sent code, so the code screen can't tell anyone whether an address is on file. */
export const CODE_REJECTED = "That code didn't work. Check the newest email from us, or request a new code.";
export const TOO_MANY_TRIES = "Too many tries. Wait a few minutes and request a new code.";
export const SIGNIN_UNAVAILABLE = "Parent sign-in isn't available yet.";
export const SIGNIN_NETWORK_FAILED = "We couldn't reach the portal just then. Please try again in a moment.";
```

`src/lib/parents/signin-codes.ts`:

```ts
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parent, signinCode } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { env } from "@/env";
import { mailWorking } from "@/lib/mail/settings";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { signinCodeMessage } from "@/lib/mail/messages";
import { takeRateLimit } from "./rate-limit";
import { enabledGuardianRows, parentActor } from "./sessions";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_TRIES = 5;
export const RESEND_AFTER_MS = 60 * 1000;

export const generateSigninCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
/** Keyed with the server secret, so a copy of the database alone can't be searched for the 1,000,000 possible codes. */
export const hashSigninCode = (parentId: string, code: string) =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`signin-code:${parentId}:${code}`).digest("hex");

type Refusal = "unknown_email" | "blocked" | "no_enabled_guardian" | "rate_limited" | "mail_failed";
const anon = (label: string): Actor => ({ door: "parent", id: null, label });
const subjectIp = (ip: string | null) => ip ?? "unknown";
const DONE: { delivery: Promise<void> } = { delivery: Promise.resolve() };

async function refuse(reason: Refusal, label: string, who: { id: string; email: string } | null, ip: string | null, extra: Record<string, unknown> = {}) {
  await writeAudit({ actor: who ? parentActor(who) : anon(label), action: "signin.code_refused", targetType: who ? "parent" : undefined,
    targetId: who?.id, after: { reason, ...extra }, ip });
}

/**
 * Spec §1. Decides, stores the code and returns; the email goes out in `delivery`. The caller answers the parent with
 * the same sentence whatever happened here and must not await `delivery`.
 */
export async function requestSigninCode(rawEmail: string, ip: string | null, now = new Date()): Promise<{ delivery: Promise<void> }> {
  const email = normalizeEmail(rawEmail);
  const label = email ?? rawEmail.trim().toLowerCase().slice(0, 254);
  if (!(await mailWorking())) { await refuse("mail_failed", label, null, ip, { detail: "mail_not_working" }); return DONE; }
  if (!(await takeRateLimit("code_send_ip", subjectIp(ip), now))) { await refuse("rate_limited", label, null, ip, { limit: "ip" }); return DONE; }
  if (!email) { await refuse("unknown_email", label, null, ip); return DONE; }
  if (!(await takeRateLimit("code_send_email", email, now))) { await refuse("rate_limited", email, null, ip, { limit: "email" }); return DONE; }
  const [p] = await db.select().from(parent).where(eq(parent.email, email));
  if (!p) { await refuse("unknown_email", email, null, ip); return DONE; }
  if (p.blocked) { await refuse("blocked", email, p, ip); return DONE; }
  if ((await enabledGuardianRows(p.id)).length === 0) { await refuse("no_enabled_guardian", email, p, ip); return DONE; }

  const code = generateSigninCode();
  const stored = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.signin_code:${p.id}`}))`);
    const [last] = await tx.select({ createdAt: signinCode.createdAt }).from(signinCode).where(eq(signinCode.parentId, p.id))
      .orderBy(desc(signinCode.createdAt)).limit(1);
    if (last && now.getTime() - last.createdAt.getTime() < RESEND_AFTER_MS) return null;
    await tx.delete(signinCode).where(and(eq(signinCode.parentId, p.id), isNull(signinCode.usedAt)));
    const [row] = await tx.insert(signinCode).values({ parentId: p.id, codeHash: hashSigninCode(p.id, code), expiresAt: new Date(now.getTime() + CODE_TTL_MS), createdAt: now })
      .returning({ id: signinCode.id });
    return row!.id;
  });
  if (!stored) { await refuse("rate_limited", email, p, ip, { limit: "resend" }); return DONE; }

  const delivery = (async () => {
    const r = await sendMail(signinCodeMessage(await currentBrand(), p.email, code), { purpose: "signin_code", actor: parentActor(p), ip });
    if (r.ok) {
      await writeAudit({ actor: parentActor(p), action: "signin.code_sent", targetType: "parent", targetId: p.id,
        after: { expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString() }, ip });
    } else {
      await db.delete(signinCode).where(eq(signinCode.id, stored)); // nobody got it, so nobody may use it
      await refuse("mail_failed", email, p, ip);
    }
  })().catch(() => undefined); // every failure above is already audited; nothing here may surface to the caller
  return { delivery };
}

export type VerifyResult = { ok: true; parentId: string } | { ok: false; reason: "rejected" | "rate_limited" };
const REJECTED: VerifyResult = { ok: false, reason: "rejected" };

/** Spec §1. Single use, 10 minutes, 5 wrong tries, 30 checks per IP per 15 minutes. */
export async function verifySigninCode(rawEmail: string, rawCode: string, ip: string | null, now = new Date()): Promise<VerifyResult> {
  const email = normalizeEmail(rawEmail);
  const label = email ?? rawEmail.trim().toLowerCase().slice(0, 254);
  if (!(await takeRateLimit("code_check_ip", subjectIp(ip), now))) {
    await refuse("rate_limited", label, null, ip, { limit: "check_ip" });
    return { ok: false, reason: "rate_limited" };
  }
  const expired = (who: { id: string; email: string } | null, reason: "no_code" | "expired" | "too_many_tries") =>
    writeAudit({ actor: who ? parentActor(who) : anon(label), action: "signin.code_expired", targetType: who ? "parent" : undefined, targetId: who?.id, after: { reason }, ip });
  const [p] = email ? await db.select().from(parent).where(eq(parent.email, email)) : [];
  if (!p) { await expired(null, "no_code"); return REJECTED; }
  const code = rawCode.replace(/[\s-]/g, "");

  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(signinCode).where(and(eq(signinCode.parentId, p.id), isNull(signinCode.usedAt))).for("update");
    if (!row) return "no_code" as const;
    if (row.expiresAt.getTime() <= now.getTime()) return "expired" as const;
    if (row.tries >= CODE_MAX_TRIES) return "too_many_tries" as const;
    const want = Buffer.from(row.codeHash, "hex");
    const got = Buffer.from(hashSigninCode(p.id, /^\d{6}$/.test(code) ? code : "invalid"), "hex");
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      await tx.update(signinCode).set({ tries: row.tries + 1 }).where(eq(signinCode.id, row.id));
      return { wrong: row.tries + 1 } as const;
    }
    await tx.update(signinCode).set({ usedAt: now }).where(eq(signinCode.id, row.id));
    return "ok" as const;
  });
  if (outcome === "no_code" || outcome === "expired" || outcome === "too_many_tries") { await expired(p, outcome); return REJECTED; }
  if (typeof outcome === "object") {
    await writeAudit({ actor: parentActor(p), action: "signin.code_wrong", targetType: "parent", targetId: p.id, after: { try: outcome.wrong }, ip });
    return REJECTED;
  }
  // The code was right; the person must still be allowed in now (they may have been blocked or removed since it was sent).
  const [fresh] = await db.select().from(parent).where(eq(parent.id, p.id));
  const reason = !fresh || fresh.blocked ? "blocked" : (await enabledGuardianRows(p.id)).length === 0 ? "no_enabled_guardian" : null;
  if (reason) {
    await writeAudit({ actor: parentActor(p), action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason }, ip });
    return REJECTED;
  }
  return { ok: true, parentId: p.id };
}
```

Notes for the implementer:
- `blockPerson` already deletes unused codes, so the "blocked after it was sent" test is refused at `no_code`; the final
  check exists for the race where the block lands between the code check and the sign-in.
- The IP limit is taken before the email is validated, so a burst of nonsense addresses still counts against the IP.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/integration/rate-limit.test.ts tests/integration/signin-codes.test.ts`
Expected: PASS.

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/parents/rate-limit.ts src/lib/parents/signin-codes.ts src/lib/parents/signin-copy.ts tests/integration/rate-limit.test.ts tests/integration/signin-codes.test.ts
git commit -m "feat(parents): sign-in codes with database rate limits

6 digits, 10 minutes, single use, 5 tries, hashed with the server secret. Sent only to a person who
isn't blocked and has an enabled guardian row; every refusal is audited with its reason, and the
answer never waits for the email.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The parent door — endpoints, session, family choice, pages

Spec §1 The pages, The session; §2 Signing in with more than one family. Opens the door Task 1 closed. Two Better Auth
endpoints call Task 5; a correct code activates the person's invited rows, creates a Better Auth session holding the
family (when there is exactly one), and sets the cookie. Every parent request re-checks the person and the chosen
family.

**Files:**
- Create: `src/lib/auth/parent-code-plugin.ts`, `src/lib/parents/family-choice.ts`, `src/app/sign-in/code-sign-in.tsx`,
  `src/app/choose-family/page.tsx`, `src/app/choose-family/actions.ts`, `src/app/components/family-label.ts`
- Modify: `src/lib/auth/parent-auth.ts`, `src/lib/auth/resolve.ts`, `src/lib/auth/identity.ts`,
  `src/lib/auth/signin-audit.ts`, `src/lib/guards.ts`, `src/app/sign-in/page.tsx`, `src/app/(parent)/layout.tsx`,
  `src/app/(parent)/page.tsx`
- Test: `tests/integration/parent-door.test.ts`, `tests/integration/signin-audit.test.ts`, `tests/unit/guards.test.ts`

**Interfaces:**
- Consumes: `requestSigninCode`, `verifySigninCode` (Task 5); `enabledGuardianRows`, `endParentSessions`,
  `parentActor` (Task 4); `mailWorking` (Task 3); `CODE_SENT`, `CODE_REJECTED`, `TOO_MANY_TRIES`,
  `SIGNIN_UNAVAILABLE`, `SIGNIN_NETWORK_FAILED` (Task 5).
- Produces:
  - Endpoints `POST /api/auth/parent/portal-code/send` body `{ email }` → always `200 { ok: true }`;
    `POST /api/auth/parent/portal-code/verify` body `{ email, code }` → `{ ok: true, next: "/" | "/choose-family" }` or
    `{ ok: false, error: "rejected" | "rate_limited" }`.
  - `type ParentFamily = { guardianId: string; familyQboId: string }`
  - `type ParentIdentity = { door: "parent"; parentId: string; sessionId: string; guardianId: string; familyQboId: string; name: string; email: string; families: ParentFamily[] }`
  - `type ParentSessionState = { status: "ok"; identity: ParentIdentity } | { status: "choose"; parentId: string; sessionId: string; name: string; families: ParentFamily[] } | { status: "none" }`
  - `resolveParentSession(s: { id: string; userId: string; familyQboId: string | null }, ip?: string | null): Promise<ParentSessionState>` (`resolve.ts`)
  - `getParentState(): Promise<ParentSessionState>`, `getParentIdentity(): Promise<ParentIdentity | null>` (`identity.ts`)
  - `completeParentSignin(parentId: string, ip: string | null): Promise<{ familyQboId: string | null }>`,
    `chooseFamily(o: { sessionId: string; parentId: string; familyQboId: string; ip: string | null }): Promise<boolean>` (`family-choice.ts`)
  - `parentSessionAction(fn: (ctx: { parentId: string; sessionId: string; ip: string | null }, ...args) => Promise<R>)` in
    `guards.ts`, registered with door `"parent"`; `requireParentPage()` now redirects to `/choose-family` when no
    family is chosen.
  - `familyLabel(familyQboId: string): string` (`family-label.ts`) — until the roster plan brings family names.

- [ ] **Step 1: Write the failing tests**

`tests/integration/parent-door.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parentAuthSession } from "@/lib/db/schema";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { resolveParentSession } from "@/lib/auth/resolve";
import { chooseFamily } from "@/lib/parents/family-choice";
import { removeGuardian, blockPerson } from "@/lib/parents/people";
import { env } from "@/env";
import { resetDb, seedParent, seedGuardian, seedWorkingMail } from "../helpers/db";

const IP = "203.0.113.30";
const staff = { actor: { door: "staff" as const, id: null, label: "board" }, ip: null };
async function post(path: string, body: unknown, cookie?: string) {
  const auth = await getParentAuth();
  return auth.handler(new Request(`${env.APP_URL}/api/auth/parent${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: env.APP_URL, "cf-connecting-ip": IP, ...(cookie ? { cookie } : {}) },
  }));
}
const cookieFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => c.startsWith("br_parent")).join("; ");
async function getSession(cookie: string) {
  const auth = await getParentAuth();
  const res = await auth.handler(new Request(`${env.APP_URL}/api/auth/parent/get-session`, { headers: { cookie, origin: env.APP_URL } }));
  return (await res.json()) as { session: { id: string; userId: string; familyQboId?: string | null; expiresAt: string } } | null;
}
async function signIn(email: string) {
  await post("/portal-code/send", { email });
  await vi.waitFor(() => expect(outbox.length).toBeGreaterThan(0));
  const code = /sign-in code: (\d{6})/.exec(outbox.at(-1)!.subject)![1]!;
  const res = await post("/portal-code/verify", { email, code });
  return { res, body: (await res.json()) as { ok: boolean; next?: string; error?: string }, cookie: cookieFrom(res) };
}
const stateOf = async (cookie: string) => {
  const s = (await getSession(cookie))!;
  return resolveParentSession({ id: s.session.id, userId: s.session.userId, familyQboId: s.session.familyQboId ?? null });
};

describe("the parent door", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); });

  it("answers the same for known, unknown, blocked and all-disabled, and only the known one gets mail", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const b = await seedParent({ name: "Ben", email: "ben@example.com", blocked: true }); await seedGuardian({ parentId: b.id, familyQboId: "F1" });
    const c = await seedParent({ name: "Cy", email: "cy@example.com" }); await seedGuardian({ parentId: c.id, familyQboId: "F1", status: "disabled", disabledReason: "removed" });
    const answers = [];
    for (const email of ["ana@example.com", "nobody@example.com", "ben@example.com", "cy@example.com"]) {
      const res = await post("/portal-code/send", { email });
      answers.push([res.status, await res.text()]);
    }
    expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(answers[0]).toEqual([200, JSON.stringify({ ok: true })]);
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    expect(outbox[0]!.to).toBe("ana@example.com");
  });

  it("a code check answers the same for an unknown email and a wrong code", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    await post("/portal-code/send", { email: "ana@example.com" });
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    const code = /sign-in code: (\d{6})/.exec(outbox[0]!.subject)![1]!;
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const r1 = await post("/portal-code/verify", { email: "ana@example.com", code: wrong });
    const r2 = await post("/portal-code/verify", { email: "nobody@example.com", code: wrong });
    expect([r1.status, await r1.text()]).toEqual([r2.status, await r2.text()]);
    expect(r1.headers.getSetCookie().some((c) => c.startsWith("br_parent.session_token"))).toBe(false);
  });

  it("with one family, goes straight in, activates invited rows and audits the sign-in with the family", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardian({ parentId: a.id, familyQboId: "F1", status: "invited" });
    const { body, cookie } = await signIn("ana@example.com");
    expect(body).toEqual({ ok: true, next: "/" });
    const state = await stateOf(cookie);
    expect(state).toMatchObject({ status: "ok", identity: { parentId: a.id, familyQboId: "F1", guardianId: g.id, families: [{ familyQboId: "F1" }] } });
    expect((await db.select().from(guardian))[0]!.status).toBe("active");
    const rows = await db.select().from(auditLog);
    expect(rows.filter((x) => x.action === "guardian.activate")).toHaveLength(1);
    expect(rows.find((x) => x.action === "signin")).toMatchObject({ door: "parent", actorId: a.id, targetType: "parent", targetId: a.id, after: { familyQboId: "F1" }, ip: IP });
  });

  it("with two families, asks first; choosing audits the sign-in, choosing again audits a switch", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: a.id, familyQboId: "F1" }); await seedGuardian({ parentId: a.id, familyQboId: "F2" });
    const { body, cookie } = await signIn("ana@example.com");
    expect(body).toEqual({ ok: true, next: "/choose-family" });
    const first = await stateOf(cookie);
    expect(first).toMatchObject({ status: "choose", families: [{ familyQboId: "F1" }, { familyQboId: "F2" }] });
    const sessionId = first.status === "choose" ? first.sessionId : "";
    expect(await chooseFamily({ sessionId, parentId: a.id, familyQboId: "F2", ip: IP })).toBe(true);
    expect(await stateOf(cookie)).toMatchObject({ status: "ok", identity: { familyQboId: "F2" } });
    expect(await chooseFamily({ sessionId, parentId: a.id, familyQboId: "F1", ip: IP })).toBe(true);
    const rows = await db.select().from(auditLog);
    expect(rows.filter((x) => x.action === "signin").map((x) => x.after)).toEqual([{ familyQboId: "F2" }]);
    expect(rows.find((x) => x.action === "signin.family_switch")!.after).toEqual({ from: "F2", to: "F1" });
    expect(await chooseFamily({ sessionId, parentId: a.id, familyQboId: "F9", ip: IP })).toBe(false);
  });

  it("sends a parent back to choose when the chosen family goes away and another is left", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g1 = await seedGuardian({ parentId: a.id, familyQboId: "F1" }); await seedGuardian({ parentId: a.id, familyQboId: "F2" });
    const { cookie } = await signIn("ana@example.com");
    const s = await stateOf(cookie);
    await chooseFamily({ sessionId: s.status === "choose" ? s.sessionId : "", parentId: a.id, familyQboId: "F1", ip: IP });
    await removeGuardian(g1.id, staff);
    expect(await stateOf(cookie)).toMatchObject({ status: "choose", families: [{ familyQboId: "F2" }] });
    expect((await db.select().from(parentAuthSession))[0]!.familyQboId).toBeNull();
    expect((await db.select().from(auditLog)).find((x) => x.action === "signin.refused")!.after).toEqual({ reason: "family_not_enabled", familyQboId: "F1" });
  });

  it("signs a parent out at once when their last family goes, or they're blocked", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const one = await signIn("ana@example.com");
    await removeGuardian(g.id, staff);
    expect(await getSession(one.cookie)).toBeNull();
    const b = await seedParent({ name: "Ben", email: "ben@example.com" }); await seedGuardian({ parentId: b.id, familyQboId: "F2" });
    outbox.length = 0;
    const two = await signIn("ben@example.com");
    await blockPerson(b.id, staff);
    expect(await getSession(two.cookie)).toBeNull();
  });

  it("lasts 7 days from sign-in and isn't extended by use", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    const [row] = await db.select().from(parentAuthSession);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeGreaterThan(7 * 86_400_000 - 5_000);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeLessThan(7 * 86_400_000 + 5_000);
    // Pretend the session was made 3 days ago and used since: get-session must not push the expiry out.
    const back = (d: Date) => new Date(d.getTime() - 3 * 86_400_000);
    await db.update(parentAuthSession).set({ createdAt: back(row!.createdAt), updatedAt: back(row!.updatedAt), expiresAt: back(row!.expiresAt) });
    expect(await getSession(cookie)).not.toBeNull();
    const [after] = await db.select().from(parentAuthSession);
    expect(after!.expiresAt.getTime()).toBe(back(row!.expiresAt).getTime());
    await db.update(parentAuthSession).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await getSession(cookie)).toBeNull();
  });

  it("is configured so a session is read from the database on every request and never refreshed", async () => {
    const o = (await getParentAuth()).options;
    expect(o.session?.disableSessionRefresh).toBe(true);
    expect(o.session?.expiresIn).toBe(7 * 24 * 60 * 60);
    expect(o.session?.cookieCache?.enabled ?? false).toBe(false);
    expect(o.advanced?.ipAddress?.ipAddressHeaders).toEqual(["cf-connecting-ip"]);
    expect(o.emailAndPassword?.enabled).toBe(false);
  });

  it("over the check limit, says so", async () => {
    for (let i = 0; i < 30; i++) await post("/portal-code/verify", { email: `n${i}@example.com`, code: "123456" });
    const res = await post("/portal-code/verify", { email: "n@example.com", code: "123456" });
    expect(await res.json()).toEqual({ ok: false, error: "rate_limited" });
  });

  it("records a sign-out through /sign-out against the person", async () => {
    const a = await seedParent({ name: "Ana", email: "ana@example.com" }); await seedGuardian({ parentId: a.id, familyQboId: "F1" });
    const { cookie } = await signIn("ana@example.com");
    const res = await post("/sign-out", {}, cookie);
    expect(res.status).toBe(200);
    expect((await db.select().from(auditLog)).find((x) => x.action === "signout")).toMatchObject({ door: "parent", actorId: a.id, actorLabel: "ana@example.com", targetType: "parent", targetId: a.id, ip: IP });
    expect(await db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, a.authUserId))).toHaveLength(0);
  });
});
```

In `tests/integration/signin-audit.test.ts`:
- delete `"records a parent sign-in, falling back to the session's IP when there are no headers"` (the parent door writes
  its own `signin` row now);
- `"is wired to session creation on both doors…"` becomes staff-only: `for (const a of [staffAuth])` and its name
  `"is wired to staff session creation, trusting only cf-connecting-ip for the IP"`;
- `"records a sign-out through the real parent /sign-out endpoint"` expects
  `{ door: "parent", actorId: p.id, actorLabel: "ana@example.com", targetType: "parent", targetId: p.id, ip: "198.51.100.8" }`.

`tests/unit/guards.test.ts`: add `getParentState: async () => (ident.parent ? { status: "ok", identity: ident.parent } : { status: "none" })`
to the identity mock, and make `PARENT`:

```ts
const PARENT = { door: "parent", parentId: "p1", sessionId: "s1", guardianId: "g1", familyQboId: "123", name: "Ana", email: "ana@example.com", families: [{ guardianId: "g1", familyQboId: "123" }] };
```

and add:

```ts
describe("parentSessionAction", () => {
  const act = parentSessionAction(async (ctx) => ctx.parentId);
  it("runs for a signed-in parent and is registered for the parent door", async () => {
    ident.parent = PARENT;
    await expect(act()).resolves.toBe("p1");
    expect(guardOf(act)).toEqual({ door: "parent" });
  });
  it("refuses without a parent session", async () => {
    await expect(act()).rejects.toBeInstanceOf(AccessDenied);
  });
});
```

(import `parentSessionAction` from `@/lib/guards`).

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/integration/parent-door.test.ts tests/unit/guards.test.ts tests/integration/signin-audit.test.ts`
Expected: FAIL: `/portal-code/send` is 404, `resolveParentSession` and `parentSessionAction` don't exist.

- [ ] **Step 3: Implement family choice**

`src/lib/parents/family-choice.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, parent, parentAuthSession } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { enabledGuardianRows, parentActor } from "./sessions";

/**
 * After a correct code: the person's invited rows become active (spec §2 Status changes), and with exactly one enabled
 * family that family is entered now and the sign-in is audited with it. With two or more, the sign-in is audited when
 * the parent chooses (chooseFamily).
 */
export async function completeParentSignin(parentId: string, ip: string | null): Promise<{ familyQboId: string | null }> {
  const [p] = await db.select().from(parent).where(eq(parent.id, parentId));
  if (!p) return { familyQboId: null };
  const actor = parentActor(p);
  const activated = await db.update(guardian).set({ status: "active", updatedAt: new Date() })
    .where(and(eq(guardian.parentId, parentId), eq(guardian.status, "invited"))).returning({ id: guardian.id, familyQboId: guardian.familyQboId });
  for (const g of activated) {
    await writeAudit({ actor, action: "guardian.activate", targetType: "guardian", targetId: g.id, before: { status: "invited" }, after: { status: "active" }, ip });
  }
  const rows = await enabledGuardianRows(parentId);
  if (rows.length !== 1) return { familyQboId: null };
  await writeAudit({ actor, action: "signin", targetType: "parent", targetId: parentId, after: { familyQboId: rows[0]!.familyQboId }, ip });
  return { familyQboId: rows[0]!.familyQboId };
}

/** The chooser and **Switch family**. Refuses (and audits) a family that isn't one of the person's enabled rows. */
export async function chooseFamily(o: { sessionId: string; parentId: string; familyQboId: string; ip: string | null }): Promise<boolean> {
  const [p] = await db.select().from(parent).where(eq(parent.id, o.parentId));
  if (!p) return false;
  const actor = parentActor(p);
  const row = (await enabledGuardianRows(o.parentId)).find((r) => r.familyQboId === o.familyQboId);
  if (!row || p.blocked) {
    await writeAudit({ actor, action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason: "family_not_enabled", familyQboId: o.familyQboId }, ip: o.ip });
    return false;
  }
  const [s] = await db.select({ familyQboId: parentAuthSession.familyQboId }).from(parentAuthSession).where(eq(parentAuthSession.id, o.sessionId));
  if (!s) return false;
  if (s.familyQboId === o.familyQboId) return true;
  await db.update(parentAuthSession).set({ familyQboId: o.familyQboId, updatedAt: new Date() }).where(eq(parentAuthSession.id, o.sessionId));
  await writeAudit(s.familyQboId === null
    ? { actor, action: "signin", targetType: "parent", targetId: p.id, after: { familyQboId: o.familyQboId }, ip: o.ip }
    : { actor, action: "signin.family_switch", targetType: "parent", targetId: p.id, after: { from: s.familyQboId, to: o.familyQboId }, ip: o.ip });
  return true;
}
```

- [ ] **Step 4: Implement the Better Auth plugin and wire it in**

Before writing, read the endpoint and cookie helpers this version exports: `createAuthEndpoint` in
`node_modules/better-auth/dist/api/index.d.mts` and `setSessionCookie` in
`node_modules/better-auth/dist/cookies/index.d.mts` (signature
`setSessionCookie(ctx, { session, user }, dontRememberMe?, overrides?)`), and
`internalAdapter.createSession(userId, dontRememberMe?, override?)` in `@better-auth/core`'s `types/context.d.mts`.

`src/lib/auth/parent-code-plugin.ts`:

```ts
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthUser } from "@/lib/db/schema";
import { clientIpFrom } from "@/lib/request";
import { requestSigninCode, verifySigninCode } from "@/lib/parents/signin-codes";
import { completeParentSignin } from "@/lib/parents/family-choice";

type Ctx = { headers?: Headers; request?: Request };
const ipOf = (ctx: Ctx) => { const h = ctx.headers ?? ctx.request?.headers; return h ? clientIpFrom(h) : null; };

/**
 * The portal's email-code door (spec §1). Codes, tries and limits are portal code (src/lib/parents/signin-codes.ts);
 * Better Auth only makes the session and its cookie. Better Auth's own sign-up is never reachable: the only way in is
 * a code for an existing person, whose auth user the portal made with them.
 */
export const parentCodePlugin = () => ({
  id: "booster-parent-code",
  endpoints: {
    portalCodeSend: createAuthEndpoint("/portal-code/send", { method: "POST", body: z.object({ email: z.string().max(320) }) }, async (ctx) => {
      // The answer doesn't wait for the email and doesn't depend on what happened (spec §12 invariant 9).
      const { delivery } = await requestSigninCode(ctx.body.email, ipOf(ctx));
      void delivery;
      return ctx.json({ ok: true });
    }),
    portalCodeVerify: createAuthEndpoint("/portal-code/verify", {
      method: "POST", body: z.object({ email: z.string().max(320), code: z.string().max(20) }),
    }, async (ctx) => {
      const ip = ipOf(ctx);
      const r = await verifySigninCode(ctx.body.email, ctx.body.code, ip);
      if (!r.ok) return ctx.json({ ok: false, error: r.reason });
      const [u] = await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, r.parentId));
      const user = u ? await ctx.context.internalAdapter.findUserById(u.id) : null;
      if (!user) return ctx.json({ ok: false, error: "rejected" });
      const { familyQboId } = await completeParentSignin(r.parentId, ip);
      const session = await ctx.context.internalAdapter.createSession(user.id, false, { familyQboId });
      await setSessionCookie(ctx, { session, user });
      return ctx.json({ ok: true, next: familyQboId ? "/" : "/choose-family" });
    }),
  },
}) satisfies BetterAuthPlugin;
```

If `satisfies BetterAuthPlugin` fails only because of endpoint typing details, drop the `satisfies` and keep the shape;
the integration test is the check.

`src/lib/auth/parent-auth.ts`: in `buildParentAuth`, replace `databaseHooks` and `session` and add `user` and `plugins`:

```ts
    databaseHooks: {
      // The portal writes the parent `signin` row itself, with the family entered (family-choice.ts).
      session: { delete: { after: (session, ctx) => recordSignout("parent", session, ctx) } },
    },
    // Spec §1: 7 days from sign-in, never extended; no cookie cache, so ended sessions stop at the next request.
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      disableSessionRefresh: true,
      additionalFields: { familyQboId: { type: "string", required: false, input: false } },
    },
    // input: false: a parent can't change the person link through /update-user.
    user: { additionalFields: { parentId: { type: "string", required: true, input: false } } },
    plugins: [parentCodePlugin()],
```

and import `parentCodePlugin` from `./parent-code-plugin`; drop the `recordSignin` import.

`src/lib/auth/signin-audit.ts`: `recordSignout` for the parent door records against the person:

```ts
export async function recordSignout(door: "staff" | "parent", session: EndedSession, ctx?: SignoutContext): Promise<void> {
  if (ctx?.path !== "/sign-out") return;
  const h = ctx.headers ?? ctx.request?.headers;
  const ip = (h ? clientIpFrom(h) : null) ?? session.ipAddress ?? null;
  if (door === "parent") {
    const [u] = await db.select({ email: parentAuthUser.email, parentId: parentAuthUser.parentId }).from(parentAuthUser).where(eq(parentAuthUser.id, session.userId));
    await writeAudit({ actor: { door, id: u?.parentId ?? null, label: u?.email ?? null }, action: "signout",
      targetType: "parent", targetId: u?.parentId ?? undefined, ip });
    return;
  }
  const [u] = await db.select({ email: staffAuthUser.email }).from(staffAuthUser).where(eq(staffAuthUser.id, session.userId));
  await writeAudit({ actor: { door, id: null, label: u?.email ?? null }, action: "signout", targetType: "staff_auth_user", targetId: session.userId, ip });
}
```

`recordSignin` is now only called for staff; change its doc comment to say so (its `door` parameter stays).

- [ ] **Step 5: Resolve the parent session on every request**

`src/lib/auth/resolve.ts`: replace the `ParentIdentity` type and add `resolveParentSession`:

```ts
import { parent, parentAuthSession } from "@/lib/db/schema";
import { enabledGuardianRows, endParentSessions, parentActor } from "@/lib/parents/sessions";

export type ParentFamily = { guardianId: string; familyQboId: string };
export type ParentIdentity = {
  door: "parent"; parentId: string; sessionId: string; guardianId: string; familyQboId: string; name: string; email: string; families: ParentFamily[];
};
export type ParentSessionState =
  | { status: "ok"; identity: ParentIdentity }
  | { status: "choose"; parentId: string; sessionId: string; name: string; families: ParentFamily[] }
  | { status: "none" };

/**
 * Spec §2 and invariant 1: every parent request re-checks the person and the chosen family. A blocked person, or one with
 * no enabled row, is signed out everywhere; a chosen family that isn't enabled any more sends the parent back to choose.
 */
export async function resolveParentSession(s: { id: string; userId: string; familyQboId: string | null }, ip: string | null = null): Promise<ParentSessionState> {
  const [row] = await db.select({ p: parent }).from(parentAuthUser).innerJoin(parent, eq(parent.id, parentAuthUser.parentId)).where(eq(parentAuthUser.id, s.userId));
  if (!row) return { status: "none" };
  const p = row.p;
  const actor = parentActor(p);
  const rows = p.blocked ? [] : await enabledGuardianRows(p.id);
  if (rows.length === 0) {
    await endParentSessions(p.id);
    await writeAudit({ actor, action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason: p.blocked ? "blocked" : "no_enabled_guardian" }, ip });
    return { status: "none" };
  }
  const families = rows.map((r) => ({ guardianId: r.id, familyQboId: r.familyQboId }));
  const chosen = s.familyQboId ? rows.find((r) => r.familyQboId === s.familyQboId) : undefined;
  if (!chosen) {
    if (s.familyQboId) {
      await db.update(parentAuthSession).set({ familyQboId: null, updatedAt: new Date() }).where(eq(parentAuthSession.id, s.id));
      await writeAudit({ actor, action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason: "family_not_enabled", familyQboId: s.familyQboId }, ip });
    }
    return { status: "choose", parentId: p.id, sessionId: s.id, name: p.name, families };
  }
  return { status: "ok", identity: { door: "parent", parentId: p.id, sessionId: s.id, guardianId: chosen.id, familyQboId: chosen.familyQboId, name: p.name, email: p.email, families } };
}
```

(`parentAuthUser`, `writeAudit`, `db` and `eq` are already imported in this file.)

`src/lib/auth/identity.ts`: replace `getParentIdentity` and add `getParentState`:

```ts
import { requestIp } from "@/lib/request";
import { resolveStaff, resolveParentSession, type StaffIdentity, type ParentIdentity, type ParentSessionState } from "./resolve";

export async function getParentState(): Promise<ParentSessionState> {
  const session = await (await getParentAuth()).api.getSession({ headers: await headers() });
  if (!session) return { status: "none" };
  const familyQboId = (session.session as { familyQboId?: string | null }).familyQboId ?? null;
  return resolveParentSession({ id: session.session.id, userId: session.user.id, familyQboId }, await requestIp());
}

export async function getParentIdentity(): Promise<ParentIdentity | null> {
  const s = await getParentState();
  return s.status === "ok" ? s.identity : null;
}
```

`src/lib/guards.ts`: import `getParentState` from `@/lib/auth/identity`, then replace `requireParentPage` and add
`parentSessionAction`:

```ts
export type ParentSessionCtx = { parentId: string; sessionId: string; ip: string | null };

/** For the family chooser: a signed-in parent, whether or not a family is chosen yet. */
export function parentSessionAction<A extends unknown[], R>(fn: (ctx: ParentSessionCtx, ...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => {
    const s = await getParentState();
    if (s.status === "none") throw new AccessDenied();
    const parentId = s.status === "ok" ? s.identity.parentId : s.parentId;
    const sessionId = s.status === "ok" ? s.identity.sessionId : s.sessionId;
    return fn({ parentId, sessionId, ip: await requestIp() }, ...args);
  };
  registry.set(wrapped, { door: "parent" });
  return wrapped;
}

export async function requireParentPage(): Promise<ParentCtx> {
  const s = await getParentState();
  if (s.status === "ok") return { ...s.identity, ip: await requestIp() };
  if (s.status === "choose") redirect("/choose-family");
  redirect((await hasParentSession()) ? "/refused" : "/sign-in");
}
```

- [ ] **Step 6: Build the pages**

Read `node_modules/next/dist/docs/` on server actions and `redirect` before this step.

`src/app/components/family-label.ts`:

```ts
/** How a family is named on parent pages until the roster plan brings family names from QuickBooks. */
export const familyLabel = (familyQboId: string) => `Family account ${familyQboId}`;
```

`src/app/sign-in/page.tsx`:

```tsx
import { getClubSettings } from "@/lib/settings/club";
import { mailWorking } from "@/lib/mail/settings";
import { SIGNIN_UNAVAILABLE } from "@/lib/parents/signin-copy";
import { CodeSignIn } from "./code-sign-in";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function ParentSignIn() {
  const [club, ready] = await Promise.all([getClubSettings(), mailWorking()]);
  return (
    <main className="wrap signin">
      <h1 className="page-title">{club.name}</h1>
      {ready ? <CodeSignIn /> : <p role="status">{SIGNIN_UNAVAILABLE}</p>}
      <p className="lede"><a href="/staff/sign-in">Board and staff sign in here</a></p>
    </main>
  );
}
```

`src/app/sign-in/code-sign-in.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { CODE_SENT, CODE_REJECTED, TOO_MANY_TRIES, SIGNIN_NETWORK_FAILED } from "@/lib/parents/signin-copy";

const BASE = "/api/auth/parent";
const RESEND_SECONDS = 60;

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Spec §1 The pages: email, then the 6-digit code. The page never says whether the address is on file. */
export function CodeSignIn() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentAt, setSentAt] = useState(0);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step !== "code") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [step]);

  const send = async () => {
    setBusy(true); setError(null);
    try {
      await post<{ ok: true }>("/portal-code/send", { email });
      const t = Date.now();
      setSentAt(t); setNow(t); setCode(""); setStep("code");
    } catch { setError(SIGNIN_NETWORK_FAILED); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError(null);
    try {
      const r = await post<{ ok: boolean; next?: string; error?: string }>("/portal-code/verify", { email, code });
      if (r.ok && r.next) { window.location.assign(r.next); return; }
      setError(r.error === "rate_limited" ? TOO_MANY_TRIES : CODE_REJECTED);
    } catch { setError(SIGNIN_NETWORK_FAILED); } finally { setBusy(false); }
  };
  const wait = Math.max(0, RESEND_SECONDS - Math.floor((now - sentAt) / 1000));

  if (step === "email") {
    return (
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <p className="lede">Sign in to see your students, what&apos;s owed, and this season&apos;s forms. We&apos;ll email you a 6-digit code.</p>
        <label className="field"><span>Email</span>
          <input name="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {error && <p role="alert" className="errors">{error}</p>}
        <button className="btn" disabled={busy}>{busy ? "Sending…" : "Send code"}</button>
      </form>
    );
  }
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
      <p role="status">{CODE_SENT}</p>
      <label className="field"><span>6-digit code</span>
        <input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={9} required value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      {error && <p role="alert" className="errors">{error}</p>}
      <button className="btn" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
      <div className="stack">
        <button type="button" className="btn btn-line" disabled={busy || wait > 0} onClick={() => void send()}>
          {wait > 0 ? `Resend code (${wait} s)` : "Resend code"}
        </button>
        <button type="button" className="btn btn-line" onClick={() => { setStep("email"); setError(null); }}>Use a different email</button>
      </div>
    </form>
  );
}
```

`src/app/choose-family/actions.ts`:

```ts
"use server";
import { redirect } from "next/navigation";
import { parentSessionAction } from "@/lib/guards";
import { chooseFamily } from "@/lib/parents/family-choice";

export const chooseFamilyAction = parentSessionAction(async (ctx, familyQboId: string) => {
  const ok = await chooseFamily({ sessionId: ctx.sessionId, parentId: ctx.parentId, familyQboId, ip: ctx.ip });
  redirect(ok ? "/" : "/choose-family");
});
```

`src/app/choose-family/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { getParentState } from "@/lib/auth/identity";
import { getClubSettings } from "@/lib/settings/club";
import { familyLabel } from "@/app/components/family-label";
import { SignOutButton } from "@/app/components/sign-out-button";
import { chooseFamilyAction } from "./actions";

export const metadata = { title: "Choose a family" };
export const dynamic = "force-dynamic";

export default async function ChooseFamily() {
  const [state, club] = await Promise.all([getParentState(), getClubSettings()]);
  if (state.status === "none") redirect("/sign-in");
  const families = state.status === "ok" ? state.identity.families : state.families;
  const current = state.status === "ok" ? state.identity.familyQboId : null;
  return (
    <main className="wrap signin">
      <h1 className="page-title">{club.name}</h1>
      <p className="lede">You&apos;re a guardian in more than one family. Choose the one to look at; you can switch later.</p>
      <ul className="stack">
        {families.map((f) => (
          <li key={f.guardianId}>
            <form action={chooseFamilyAction.bind(null, f.familyQboId)}>
              <button className="btn" aria-current={f.familyQboId === current ? "true" : undefined}>{familyLabel(f.familyQboId)}</button>
            </form>
          </li>
        ))}
      </ul>
      <SignOutButton door="parent" />
    </main>
  );
}
```

`src/app/(parent)/layout.tsx`: after `<ClubBar … />` add the switch control, and import `familyLabel`:

```tsx
      {ctx.families.length > 1 && (
        <p className="wrap switch-family">Viewing {familyLabel(ctx.familyQboId)}. <a href="/choose-family">Switch family</a></p>
      )}
```

`src/app/(parent)/page.tsx` keeps using `ctx.name`; no change needed beyond the type.

Add to `docs/ui-backlog.md` under its open list: "Parent family chooser and Switch family show `Family account <QBO id>`
until the roster plan brings family names; the switch line is unstyled."

- [ ] **Step 7: Run everything**

Run: `pnpm vitest run tests/integration/parent-door.test.ts tests/unit/guards.test.ts tests/integration/signin-audit.test.ts tests/integration/invariants.test.ts`
Expected: PASS. The invariants test finds `src/app/choose-family/actions.ts` among "other" modules and accepts its
parent-door guard.

Run: `pnpm test && pnpm typecheck && pnpm lint`, then the build command.
Expected: PASS; the build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src tests docs/ui-backlog.md
git commit -m "feat(parents): sign in with an emailed code, choose a family, switch, sign out

The portal's own /portal-code endpoints check codes and Better Auth makes a 7-day session that is never
extended. Every request re-checks the person and the chosen family.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Outgoing mail in setup and Settings, the Admin-only permission, and the staff warning

Spec §3 Common to both, Setup. Setup becomes Staff sign-in → **Outgoing mail** (required; **Next** stays off until a
test email has gone out with the saved settings) → First Admin. Settings → Mail has the same card and needs
`Settings.Mail.ReadWrite`, which only Admins hold. Staff who can see settings get a warning on the staff home page and on
the Settings pages while mail isn't set up, isn't tested, or last failed.

**Files:**
- Modify: `src/lib/permissions/registry.ts`, `src/lib/setup/state.ts`, `src/lib/mail/settings.ts`,
  `src/app/setup/{actions.ts,steps.tsx,page.tsx,instructions.tsx}`, `src/app/staff/(app)/layout.tsx`,
  `src/app/staff/(app)/page.tsx`, `src/app/staff/(app)/settings/club/page.tsx`,
  `src/app/staff/(app)/settings/sign-in/page.tsx`
- Create: `src/app/components/mail-settings/mail-card.tsx`, `src/app/components/mail-settings/mail-steps.tsx`,
  `src/app/staff/(app)/settings/mail/page.tsx`, `src/app/staff/(app)/settings/mail/actions.ts`,
  `src/app/staff/(app)/mail-warning.tsx`, `src/app/staff/(app)/mail-warning-rule.ts`
- Test: `tests/unit/permissions/registry.test.ts`, `tests/unit/mail-warning-rule.test.ts`,
  `tests/integration/setup-mail.test.ts`, `tests/integration/settings-mail-actions.test.ts`,
  `tests/integration/setup-state.test.ts`

**Interfaces:**
- Consumes: `parseMailForm`, `saveMailSettings`, `mailSummary`, `mailWorking`, `mailAttention`, `MailSummary` (Task 3);
  `sendTestMail` (Task 3); `staffAction`, `setupAction`, `requireStaffPage`, `can`, `Effective`.
- Produces:
  - Permission `"Settings.Mail.ReadWrite"` in `PERMISSIONS` and `ADMIN_ONLY`.
  - `SETUP_STEPS = ["staff", "mail", "admin"] as const`.
  - `mailFormFields(form: FormData): Record<string, string>` (`settings.ts`).
  - Server actions: `saveSetupMailAction(form: FormData)`, `sendSetupTestMailAction(form: FormData)` (setup);
    `saveMailSettingsAction(form: FormData)`, `sendTestMailAction(form: FormData)` (staff, `Settings.Mail.ReadWrite`).
    Save returns `{ ok: true } | { ok: false; errors: string[] }`; test returns `SendOutcome`.
  - `MailSettingsCard({ summary, save, test })` client component; `GraphMailSteps()`, `SmtpNotes()`.
  - `seesMailWarning(e: Effective): boolean` and `MailWarning({ canFix }: { canFix: boolean })`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/permissions/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ADMIN_ONLY, GRANTABLE, PERMISSIONS } from "@/lib/permissions/registry";
import { expandRules, validateRules } from "@/lib/permissions/rules";

describe("Settings.Mail.ReadWrite", () => {
  it("exists, and only the built-in Admin can hold it", () => {
    expect(PERMISSIONS).toContain("Settings.Mail.ReadWrite");
    expect(ADMIN_ONLY).toContain("Settings.Mail.ReadWrite");
    expect(GRANTABLE).not.toContain("Settings.Mail.ReadWrite");
  });
  it("can't be put in a custom role, even by a wildcard", () => {
    expect(expandRules({ include: ["*"], exclude: [] }).has("Settings.Mail.ReadWrite")).toBe(false);
    expect(expandRules({ include: ["Settings.*"], exclude: [] }).has("Settings.Mail.ReadWrite")).toBe(false);
    expect(validateRules({ include: ["Settings.Mail.ReadWrite"], exclude: [] }))
      .toContain("“Settings.Mail.ReadWrite” only matches Admin permissions, which can't be given to a role.");
  });
});
```

`tests/unit/mail-warning-rule.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { seesMailWarning } from "@/app/staff/(app)/mail-warning-rule";

const e = (perms: string[], isAdmin = false) => ({ isAdmin, permissions: new Set(perms) }) as Parameters<typeof seesMailWarning>[0];

describe("who sees the mail warning", () => {
  it("shows to Admins and to staff with any settings access, not to others", () => {
    expect(seesMailWarning(e([], true))).toBe(true);
    expect(seesMailWarning(e(["Settings.Club.Read"]))).toBe(true);
    expect(seesMailWarning(e(["Audit.Log.Read", "Staff.Users.Read"]))).toBe(false);
  });
});
```

`tests/integration/setup-mail.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ setup: true, sent: 0 }));
vi.mock("@/lib/setup/session", () => ({ hasSetupSession: async () => state.setup, startSetupSession: async () => {}, SETUP_COOKIE: "br_setup" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.40" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); } }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async () => { state.sent++; } }));

import { saveSetupMailAction, sendSetupTestMailAction, goToStepAction } from "@/app/setup/actions";
import { getSetupState } from "@/lib/setup/state";
import { mailWorking } from "@/lib/mail/settings";
import { SETUP_SESSION_ENDED } from "@/lib/setup/guard";
import { resetDb, seedProvider } from "../helpers/db";

const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const smtp = { method: "smtp", host: "smtp.example.org", port: "587", security: "starttls", username: "u", from: "club@example.org", password: "p" };
const redirectOf = async (p: Promise<unknown>) => ((await p.catch((e: { url?: string }) => e)) as { url?: string }).url;

describe("the Outgoing mail setup step", () => {
  beforeEach(async () => {
    await resetDb(); state.setup = true; state.sent = 0;
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" });
  });

  it("saves the settings, and a test send makes them work", async () => {
    expect(await saveSetupMailAction(form(smtp))).toEqual({ ok: true });
    expect(await mailWorking()).toBe(false);
    expect(await sendSetupTestMailAction(form({ to: "admin@example.org" }))).toEqual({ ok: true });
    expect(state.sent).toBe(1);
    expect(await mailWorking()).toBe(true);
  });

  it("won't go on to the first Admin until mail works", async () => {
    expect(await redirectOf(goToStepAction("mail"))).toBe("/setup?step=mail");
    expect(await redirectOf(goToStepAction("admin"))).toBe("/setup?step=mail&error=mail_first");
    await saveSetupMailAction(form(smtp));
    await sendSetupTestMailAction(form({ to: "admin@example.org" }));
    expect(await redirectOf(goToStepAction("admin"))).toBe("/setup?step=admin");
    expect((await getSetupState()).step).toBe("admin");
  });

  it("asks for a new setup code when the session has ended", async () => {
    state.setup = false;
    expect(await saveSetupMailAction(form(smtp))).toEqual({ ok: false, errors: [SETUP_SESSION_ENDED] });
    expect(await sendSetupTestMailAction(form({ to: "a@example.org" }))).toEqual({ ok: false, error: SETUP_SESSION_ENDED });
  });
});
```

`tests/integration/settings-mail-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const who = vi.hoisted(() => ({ staff: null as null | { door: "staff"; staffUserId: string; name: string; email: string } }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => who.staff, hasStaffSession: async () => Boolean(who.staff),
  getParentIdentity: async () => null, getParentState: async () => ({ status: "none" }), hasParentSession: async () => false,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async () => {} }));

import { db } from "@/lib/db/client";
import { auditLog, role, roleRule, roleAssignment } from "@/lib/db/schema";
import { saveMailSettingsAction } from "@/app/staff/(app)/settings/mail/actions";
import { AccessDenied } from "@/lib/guards";
import { resetDb, seedStaff } from "../helpers/db";

const form = () => { const f = new FormData(); for (const [k, v] of Object.entries({ method: "smtp", host: "smtp.example.org", port: "587", security: "starttls", username: "u", from: "c@example.org", password: "p" })) f.set(k, v); return f; };

describe("Settings, Mail actions", () => {
  beforeEach(resetDb);

  it("refuses staff whose custom role includes everything, and audits the refusal", async () => {
    const s = await seedStaff({ email: "treasurer@club.org" });
    const [r] = await db.insert(role).values({ key: "everything", name: "Everything" }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "*" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
    who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email };
    await expect(saveMailSettingsAction(form())).rejects.toBeInstanceOf(AccessDenied);
    expect((await db.select().from(auditLog)).map((a) => [a.action, a.permission])).toEqual([["access.refused", "Settings.Mail.ReadWrite"]]);
  });

  it("lets an Admin save", async () => {
    const s = await seedStaff({ email: "admin@club.org", admin: true });
    who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email };
    expect(await saveMailSettingsAction(form())).toEqual({ ok: true });
    expect((await db.select().from(auditLog)).find((a) => a.action === "settings.mail.save")).toMatchObject({ actorId: s.id, permission: "Settings.Mail.ReadWrite" });
  });
});
```

In `tests/integration/setup-state.test.ts` add:

```ts
  it("has the mail step between staff sign-in and the first Admin", async () => {
    const { SETUP_STEPS } = await import("@/lib/setup/state");
    expect(SETUP_STEPS).toEqual(["staff", "mail", "admin"]);
    await updateSetupState({ step: "mail" });
    expect((await getSetupState()).step).toBe("mail");
  });
```

(import `updateSetupState` if the file doesn't already).

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/unit/permissions/registry.test.ts tests/unit/mail-warning-rule.test.ts tests/integration/setup-mail.test.ts tests/integration/settings-mail-actions.test.ts tests/integration/setup-state.test.ts`
Expected: FAIL: the permission, the step, the actions and the rule don't exist.

- [ ] **Step 3: The permission and the step**

`src/lib/permissions/registry.ts`: add to `PERMISSIONS` after `"Settings.SignIn.ReadWrite"`:

```ts
  "Settings.Mail.ReadWrite",    // admin-only: change outgoing mail; whoever controls it can read parents' sign-in codes
```

and `ADMIN_ONLY` becomes
`["Admin.Roles.ReadWrite", "Staff.Users.ReadWrite", "Settings.SignIn.ReadWrite", "Settings.Mail.ReadWrite"]`.

`src/lib/setup/state.ts`: `export const SETUP_STEPS = ["staff", "mail", "admin"] as const;`.

`src/lib/mail/settings.ts`: add

```ts
const MAIL_FIELDS = ["method", "mailbox", "host", "port", "security", "username", "from", "password"] as const;
/** The mail form's fields as strings, for parseMailForm. */
export const mailFormFields = (form: FormData): Record<string, string> =>
  Object.fromEntries(MAIL_FIELDS.map((n) => [n, String(form.get(n) ?? "")]));
```

- [ ] **Step 4: Setup actions and the step**

`src/app/setup/actions.ts`: add imports and two actions, and the mail check in `goToStepAction`:

```ts
import { parseMailForm, saveMailSettings, mailWorking, mailFormFields } from "@/lib/mail/settings";
import { sendTestMail, type SendOutcome } from "@/lib/mail/send";

type MailSaveResult = { ok: true } | { ok: false; errors: string[] };

export const saveSetupMailAction = setupAction(async (form: FormData): Promise<MailSaveResult> => {
  const parsed = parseMailForm(mailFormFields(form));
  if (!parsed.ok) return parsed;
  const r = await saveMailSettings(parsed.draft, { actor: SETUP_ACTOR, ip: await requestIp() });
  revalidatePath("/setup");
  return r;
}, { onExpired: sessionEnded });

export const sendSetupTestMailAction = setupAction(async (form: FormData): Promise<SendOutcome> => {
  const r = await sendTestMail(String(form.get("to") ?? ""), { actor: SETUP_ACTOR, ip: await requestIp() });
  revalidatePath("/setup");
  return r;
}, { onExpired: () => ({ ok: false as const, error: SETUP_SESSION_ENDED }) });
```

In `goToStepAction`, after the staff check:

```ts
  if (step === "admin" && !(await mailWorking())) redirect("/setup?step=mail&error=mail_first");
```

`src/app/setup/page.tsx`: `STEPS` is
`[{ step: "staff", label: "1. Staff sign-in" }, { step: "mail", label: "2. Outgoing mail" }, { step: "admin", label: "3. First Admin" }]`;
render `{step === "mail" && <MailStep summary={await mailSummary()} error={one("error")} />}` (import `mailSummary` and
`MailStep`).

`src/app/setup/steps.tsx`:
- `StaffStep` ends with `<form action={goToStepAction.bind(null, "mail")}><button className="btn" disabled={!ready}>Next: outgoing mail</button></form>`.
- `AdminStep`: heading `Step 3: First Admin`; last form
  `<form action={goToStepAction.bind(null, "mail")}><button className="btn btn-line">Back to outgoing mail</button></form>`.
- Add:

```tsx
import type { MailSummary } from "@/lib/mail/settings";
import { MailSettingsCard } from "@/app/components/mail-settings/mail-card";
import { GraphMailSteps, SmtpNotes } from "@/app/components/mail-settings/mail-steps";
import { saveSetupMailAction, sendSetupTestMailAction } from "./actions";

export function MailStep({ summary, error }: { summary: MailSummary; error?: string }) {
  return (
    <>
      <h2 className="page-title">Step 2: Outgoing mail</h2>
      <p className="lede">Parents sign in with a code the portal emails them, so the portal has to be able to send mail first. Use Microsoft 365 if the club has it; otherwise use your mail provider&apos;s SMTP settings.</p>
      {error === "mail_first" && <p role="alert" className="errors">Save the mail settings and send a test email before going on.</p>}
      <section className="box" aria-labelledby="mail-h"><h2 id="mail-h">Outgoing mail</h2>
        <MailSettingsCard summary={summary} save={saveSetupMailAction} test={sendSetupTestMailAction} />
        <details><summary>Microsoft 365: let the app send as one mailbox</summary>
          <ScriptOption script="New-BoosterRocketStaffApp.ps1" example="./New-BoosterRocketStaffApp.ps1 -TenantId <your tenant ID> -SetUpMail -Mailbox webmaster@yourclub.org" />
          <GraphMailSteps />
        </details>
        <details><summary>SMTP: before you start</summary><SmtpNotes /></details>
      </section>
      <div className="stack">
        <form action={goToStepAction.bind(null, "admin")}><button className="btn" disabled={!summary.working}>Next: first Admin</button></form>
        <form action={goToStepAction.bind(null, "staff")}><button className="btn btn-line">Back to staff sign-in</button></form>
      </div>
    </>
  );
}
```

`src/app/setup/instructions.tsx`, `ScriptOption`: the module sentence becomes *"It needs PowerShell 7 and the Microsoft Graph
module (`Install-Module Microsoft.Graph.Authentication`). With `-SetUpMail` it also needs the Exchange Online module
(`Install-Module ExchangeOnlineManagement`)."*

- [ ] **Step 5: The shared mail card and instructions**

`src/app/components/mail-settings/mail-card.tsx`:

```tsx
"use client";
import { useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { LocalTime } from "@/app/components/local-time";
import type { MailSummary } from "@/lib/mail/settings";

type SaveResult = { ok: true } | { ok: false; errors: string[] };
type TestResult = { ok: true } | { ok: false; error: string };

/** Settings for outgoing mail, with Send test email. Used on the setup page and under Settings, Mail. */
export function MailSettingsCard({ summary, save, test }: {
  summary: MailSummary; save: (f: FormData) => Promise<SaveResult>; test: (f: FormData) => Promise<TestResult>;
}) {
  const c = summary.config;
  const [method, setMethod] = useState<"graph" | "smtp">(c?.method ?? (summary.graphAvailable ? "graph" : "smtp"));
  const [saved, runSave, saving] = useActionState(async (_: SaveResult | null, f: FormData) => safely(() => save(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  const [tested, runTest, testing] = useActionState(async (_: TestResult | null, f: FormData) => safely(() => test(f), { ok: false as const, error: ACTION_FAILED }), null);
  const smtp = c?.method === "smtp" ? c : null;
  return (
    <div className="stack">
      <p className="hint">
        {summary.working && summary.status.verifiedAt ? <>Working. Last tested <LocalTime iso={summary.status.verifiedAt} />.</>
          : c ? "Saved, but not tested with these settings yet. Send a test email." : "Not set up yet."}
      </p>
      <form action={runSave} className="stack">
        <fieldset className="field"><legend>Send with</legend>
          {summary.graphAvailable && <label><input type="radio" name="method" value="graph" checked={method === "graph"} onChange={() => setMethod("graph")} /> Microsoft 365</label>}
          <label><input type="radio" name="method" value="smtp" checked={method === "smtp"} onChange={() => setMethod("smtp")} /> SMTP</label>
        </fieldset>
        {!summary.graphAvailable && <p className="hint">Sending through Microsoft 365 uses staff sign-in with Microsoft. Set that up first to use it.</p>}
        {method === "graph" ? (
          <label className="field"><span>Send as this mailbox</span>
            <input name="mailbox" type="email" required autoComplete="off" defaultValue={c?.method === "graph" ? c.mailbox : ""} placeholder="webmaster@yourclub.org" />
          </label>
        ) : (
          <>
            <label className="field"><span>Host</span><input name="host" required autoComplete="off" spellCheck={false} defaultValue={smtp?.host ?? ""} placeholder="smtp.example.org" /></label>
            <label className="field"><span>Port</span><input name="port" inputMode="numeric" required defaultValue={smtp?.port ?? 587} /></label>
            <label className="field"><span>Security</span>
              <select name="security" defaultValue={smtp?.security ?? "starttls"}>
                <option value="starttls">STARTTLS (usually port 587)</option>
                <option value="tls">TLS (usually port 465)</option>
              </select>
            </label>
            <label className="field"><span>Username</span><input name="username" required autoComplete="off" spellCheck={false} defaultValue={smtp?.username ?? ""} /></label>
            <label className="field"><span>Password{summary.passwordSaved && summary.passwordReadable ? " (leave blank to keep the saved one)" : ""}</span>
              <input name="password" type="password" autoComplete="new-password" required={!(summary.passwordSaved && summary.passwordReadable)} />
            </label>
            {summary.passwordSaved && !summary.passwordReadable && <p className="hint">The saved password can&apos;t be read with this server&apos;s encryption key. Enter it again.</p>}
            <label className="field"><span>From address</span><input name="from" type="email" required autoComplete="off" defaultValue={smtp?.from ?? ""} placeholder="boosters@yourclub.org" /></label>
          </>
        )}
        {saved && !saved.ok && <ul role="alert" className="errors">{saved.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        {saved?.ok && <p role="status">Saved. Send a test email to check it.</p>}
        <button className="btn" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      </form>
      {c && (
        <form action={runTest} className="stack">
          <label className="field"><span>Send a test email to</span><input name="to" type="email" required autoComplete="email" /></label>
          {tested && !tested.ok && <p role="alert" className="errors">{tested.error}</p>}
          {tested?.ok && <p role="status">Test email sent. Check that it arrived, and look in the spam folder too.</p>}
          <button className="btn btn-line" disabled={testing}>{testing ? "Sending…" : "Send test email"}</button>
        </form>
      )}
    </div>
  );
}
```

`src/app/components/mail-settings/mail-steps.tsx`:

```tsx
import { CopyField } from "@/app/components/sign-in-settings/copy-field";

const ext = { target: "_blank", rel: "noreferrer" } as const;
const RBAC = "https://learn.microsoft.com/exchange/permissions-exo/application-rbac";

/** The same steps the staff script's -SetUpMail part does, by hand (spec §3). */
export function GraphMailSteps() {
  return (
    <ol className="steps-list">
      <li>Pick the mailbox the portal sends as, for example <code>webmaster@yourclub.org</code>. It must be a real mailbox in the club&apos;s Microsoft 365.</li>
      <li>In the Entra admin center, open <b>Enterprise applications</b> &gt; <b>Booster Rocket (staff)</b> and copy its <b>Application ID</b> and <b>Object ID</b> (not the ones on App registrations).</li>
      <li>On <b>App registrations</b> &gt; <b>Booster Rocket (staff)</b> &gt; <b>API permissions</b>, check there is no Microsoft Graph <b>Mail.Send</b> permission of type <b>Application</b>. If there is, remove it and revoke its admin consent: it would let the app send as anyone.</li>
      <li>In PowerShell, as an Exchange administrator, connect to Exchange Online:<CopyField label="Connect" value="Connect-ExchangeOnline" /></li>
      <li>Point Exchange at the app:<CopyField label="Service principal" value={'New-ServicePrincipal -AppId <Application ID> -ObjectId <Object ID> -DisplayName "Booster Rocket (staff)"'} /></li>
      <li>Make a scope that holds only the mailbox:<CopyField label="Scope" value={`New-ManagementScope -Name "Booster Rocket mail sender" -RecipientRestrictionFilter "PrimarySmtpAddress -eq '<mailbox>'"`} /></li>
      <li>Let the app send as that mailbox only:<CopyField label="Role assignment" value={'New-ManagementRoleAssignment -App <Object ID> -Role "Application Mail.Send" -CustomResourceScope "Booster Rocket mail sender"'} /></li>
      <li>Check it: <code>InScope</code> should say <code>True</code>.<CopyField label="Check" value="Test-ServicePrincipalAuthorization -Identity <Object ID> -Resource <mailbox>" /></li>
      <li>Microsoft can take from 30 minutes to 2 hours to apply the change. Then send a test email above. (<a href={RBAC} {...ext}>Microsoft&apos;s guide to RBAC for Applications</a>.)</li>
    </ol>
  );
}

export function SmtpNotes() {
  return (
    <div className="stack">
      <p>Use the SMTP settings your mail provider gives for sending from an app: host, port, STARTTLS or TLS, a username and password (often an app password), and the From address.</p>
      <p>Mail only reaches inboxes reliably when the From address&apos;s domain has your provider&apos;s SPF and DKIM records. Follow your provider&apos;s instructions, for example Google Workspace&apos;s <a href="https://support.google.com/a/answer/33786" {...ext}>SPF</a> and <a href="https://support.google.com/a/answer/174124" {...ext}>DKIM</a> pages.</p>
    </div>
  );
}
```

- [ ] **Step 6: Settings → Mail, the nav and the warning**

`src/app/staff/(app)/settings/mail/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { parseMailForm, saveMailSettings, mailFormFields } from "@/lib/mail/settings";
import { sendTestMail, type SendOutcome } from "@/lib/mail/send";

const P = "Settings.Mail.ReadWrite" as const;

export const saveMailSettingsAction = staffAction(P, async (ctx, form: FormData): Promise<{ ok: true } | { ok: false; errors: string[] }> => {
  const parsed = parseMailForm(mailFormFields(form));
  if (!parsed.ok) return parsed;
  const r = await saveMailSettings(parsed.draft, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  return r;
});

export const sendTestMailAction = staffAction(P, async (ctx, form: FormData): Promise<SendOutcome> => {
  const r = await sendTestMail(String(form.get("to") ?? ""), { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  return r;
});
```

`src/app/staff/(app)/mail-warning-rule.ts`:

```ts
import { can, type Effective } from "@/lib/permissions/effective";

/** Staff with mail or settings access see the mail warning (spec §3 When a send fails). */
export const seesMailWarning = (e: Effective) =>
  can(e, "Settings.Mail.ReadWrite") || can(e, "Settings.Club.Read") || can(e, "Settings.SignIn.ReadWrite");
```

`src/app/staff/(app)/mail-warning.tsx`:

```tsx
import { mailAttention } from "@/lib/mail/settings";
import { LocalTime } from "@/app/components/local-time";

/** Shown on the staff home and the Settings pages while parents can't get sign-in codes. */
export async function MailWarning({ canFix }: { canFix: boolean }) {
  const a = await mailAttention();
  if (!a) return null;
  return (
    <section className="box" role="status" aria-labelledby="mail-warn-h"><h2 id="mail-warn-h">Outgoing mail needs attention</h2>
      <p>{a.kind === "failing"
        ? <>The last email failed{a.since && <> (<LocalTime iso={a.since} />)</>}: {a.lastError} Parents can&apos;t get sign-in codes until a send works again.</>
        : a.kind === "not_tested"
          ? "The mail settings changed and haven't been tested since, so parents can't sign in. Send a test email."
          : "Outgoing mail isn't set up, so parents can't sign in."}</p>
      <p className="box-foot">{canFix ? <a className="btn btn-line" href="/staff/settings/mail">Open mail settings</a> : "An Admin can fix this under Settings, Mail."}</p>
    </section>
  );
}
```

`src/app/staff/(app)/settings/mail/page.tsx`:

```tsx
import { requireStaffPage } from "@/lib/guards";
import { mailSummary } from "@/lib/mail/settings";
import { MailSettingsCard } from "@/app/components/mail-settings/mail-card";
import { GraphMailSteps, SmtpNotes } from "@/app/components/mail-settings/mail-steps";
import { ScriptOption } from "@/app/setup/instructions";
import { MailWarning } from "../../mail-warning";
import { saveMailSettingsAction, sendTestMailAction } from "./actions";

export const metadata = { title: "Mail settings" };

export default async function MailSettingsPage() {
  await requireStaffPage("Settings.Mail.ReadWrite");
  const summary = await mailSummary();
  return (
    <main className="wrap single">
      <h1 className="page-title">Mail</h1>
      <p className="lede">How the portal sends sign-in codes and welcome emails. Only Admins can change this, because whoever controls outgoing mail can read parents&apos; sign-in codes.</p>
      <MailWarning canFix />
      <section className="box" aria-labelledby="mail-h"><h2 id="mail-h">Outgoing mail</h2>
        <MailSettingsCard summary={summary} save={saveMailSettingsAction} test={sendTestMailAction} />
        <details><summary>Microsoft 365: let the app send as one mailbox</summary>
          <ScriptOption script="New-BoosterRocketStaffApp.ps1" example="./New-BoosterRocketStaffApp.ps1 -TenantId <tenant> -SetUpMail -Mailbox webmaster@yourclub.org" />
          <GraphMailSteps />
        </details>
        <details><summary>SMTP: before you start</summary><SmtpNotes /></details>
      </section>
    </main>
  );
}
```

`src/app/staff/(app)/layout.tsx`: after the Sign-in nav entry add
`...(can(e, "Settings.Mail.ReadWrite") ? [{ href: "/staff/settings/mail", label: "Mail" }] : []),`.

Show the warning on the staff home and the other two Settings pages. In each, keep the guard's return value and render
it right under the `<h1>`:

```tsx
import { can } from "@/lib/permissions/effective";
import { MailWarning } from "…/mail-warning";          // "./mail-warning" from page.tsx, "../../mail-warning" from settings pages
import { seesMailWarning } from "…/mail-warning-rule";
// …
const ctx = await requireStaffPage(/* the page's existing permission */);
// …
{seesMailWarning(ctx.effective) && <MailWarning canFix={can(ctx.effective, "Settings.Mail.ReadWrite")} />}
```

Pages: `src/app/staff/(app)/page.tsx` (already has `ctx`), `src/app/staff/(app)/settings/club/page.tsx` (change
`await requireStaffPage("Settings.Club.Read")` to `const ctx = await …`), `src/app/staff/(app)/settings/sign-in/page.tsx`
(same, with `"Settings.SignIn.ReadWrite"`).

- [ ] **Step 7: Run everything**

Run: `pnpm vitest run tests/unit/permissions tests/unit/mail-warning-rule.test.ts tests/integration/setup-mail.test.ts tests/integration/settings-mail-actions.test.ts tests/integration/setup-state.test.ts tests/integration/invariants.test.ts`
Expected: PASS. The invariants test now also covers `src/app/staff/(app)/settings/mail/actions.ts`.

Run: `pnpm test && pnpm typecheck && pnpm lint`, then the build command.
Expected: PASS; the build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "feat(setup): outgoing mail step and Settings, Mail (Admin only), with a staff warning

Setup won't reach the first Admin until a test email has gone out. Settings.Mail.ReadWrite joins the
Admin-only permissions. Staff with settings access see a warning while mail is untested or failing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The staff script's optional mail part

Spec §3 Permissions. `New-BoosterRocketStaffApp.ps1 -SetUpMail -Mailbox <address>` additionally lets the staff app send
as that one mailbox through Exchange Online RBAC for Applications. Cmdlets and their parameters are as Microsoft documents
them in "Role Based Access Control for Applications in Exchange Online"
(https://learn.microsoft.com/exchange/permissions-exo/application-rbac): `New-ServicePrincipal -AppId -ObjectId
-DisplayName`, `New-ManagementScope -Name -RecipientRestrictionFilter`, `New-ManagementRoleAssignment -App -Role
"Application Mail.Send" -CustomResourceScope`, `Test-ServicePrincipalAuthorization -Identity -Resource`. The ids it
needs are the **Enterprise application** (service principal) ids, which the script already has as `$app.appId` and
`$sp.id`. Microsoft Graph's application permission `Mail.Send` has the id `b633e1c5-b582-4048-a93e-9f11b44c7e96`
(Graph permissions reference); an unscoped grant of it would let the app send as anyone, so the script refuses while one
exists.

**Files:**
- Modify: `scripts/setup/New-BoosterRocketStaffApp.ps1`
- Test: `tests/unit/setup-scripts.test.ts`

**Interfaces:**
- Produces: script parameters `[switch]$SetUpMail` and `[string]$Mailbox`; without `-SetUpMail` the script behaves
  exactly as before.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/setup-scripts.test.ts`:

```ts
describe("staff script: the optional mail part", () => {
  const mailPart = staff.slice(staff.indexOf("if ($SetUpMail)"));

  it("is opt-in and needs the mailbox", () => {
    expect(staff).toContain("[switch]$SetUpMail");
    expect(staff).toContain("[string]$Mailbox");
    expect(staff).toMatch(/if \(\$SetUpMail -and -not \$Mailbox\) \{ throw/);
    expect(staff.indexOf("if ($SetUpMail)")).toBeGreaterThan(0);
  });
  it("refuses while the app holds unscoped Graph Mail.Send, and says how to remove it", () => {
    expect(mailPart).toContain("b633e1c5-b582-4048-a93e-9f11b44c7e96");
    expect(mailPart).toContain("appRoleAssignments");
    expect(mailPart).toContain("would let it send as anyone");
    expect(mailPart.indexOf("b633e1c5")).toBeLessThan(mailPart.indexOf("Connect-ExchangeOnline"));
  });
  it("connects to Exchange Online interactively, never with a device code, and disconnects", () => {
    expect(mailPart).toContain("Connect-ExchangeOnline -ShowBanner:$false");
    expect(mailPart).not.toMatch(/-Device\b|UseDeviceAuthentication/i);
    expect(mailPart).toMatch(/finally\s*\{[\s\S]*Disconnect-ExchangeOnline -Confirm:\$false/);
  });
  it("scopes Application Mail.Send to the one mailbox", () => {
    expect(mailPart).toContain("New-ServicePrincipal -AppId $app.appId -ObjectId $sp.id");
    expect(mailPart).toContain("-RecipientRestrictionFilter \"PrimarySmtpAddress -eq '$Mailbox'\"");
    expect(mailPart).toContain("New-ManagementRoleAssignment -App $sp.id -Role 'Application Mail.Send' -CustomResourceScope $ScopeName");
    expect(mailPart).toContain("Test-ServicePrincipalAuthorization -Identity $sp.id -Resource $Mailbox");
    expect(mailPart).not.toMatch(/Add-MailboxPermission|New-ApplicationAccessPolicy|Mail\.Send'\s*=\s*'Role'/);
  });
  it("checks the mailbox exists before changing anything in Exchange", () => {
    expect(mailPart.indexOf("Get-EXOMailbox -Identity $Mailbox")).toBeLessThan(mailPart.indexOf("New-ServicePrincipal"));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/unit/setup-scripts.test.ts`
Expected: FAIL: no `SetUpMail`.

- [ ] **Step 3: Add the mail part**

In `scripts/setup/New-BoosterRocketStaffApp.ps1`:

Extend `.DESCRIPTION` with:

```
  With -SetUpMail -Mailbox <address>, it also lets the app send mail as that one mailbox (Exchange Online RBAC for
  Applications: a management scope holding only the mailbox, and the "Application Mail.Send" role on that scope). It
  refuses while the app holds Microsoft Graph's unscoped Mail.Send application permission. This part needs an Exchange
  administrator and the ExchangeOnlineManagement module.
```

and a second `.EXAMPLE`:

```
.EXAMPLE
  ./New-BoosterRocketStaffApp.ps1 -TenantId 0f8fad5b-d9cb-469f-a165-70867728950e -SetUpMail -Mailbox webmaster@fznband.org
```

`param(…)` becomes:

```powershell
param(
  [Parameter(Mandatory)][string]$TenantId,
  [string]$AppUrl = '__BOOSTER_ROCKET_APP_URL__',
  [switch]$SetUpMail,
  [string]$Mailbox
)
```

After the existing module check, add:

```powershell
if ($SetUpMail -and -not $Mailbox) { throw 'Pass -Mailbox with the address the portal sends as, for example -Mailbox webmaster@yourclub.org' }
if ($SetUpMail) {
  $Mailbox = $Mailbox.Trim().ToLowerInvariant()
  if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
    Write-Host 'Setting up mail needs the Exchange Online PowerShell module. Install it with:'
    Write-Host '  Install-Module ExchangeOnlineManagement -Scope CurrentUser'
    exit 2
  }
}
$MailSendAppRoleId = 'b633e1c5-b582-4048-a93e-9f11b44c7e96' # Microsoft Graph application permission Mail.Send
$ScopeName = 'Booster Rocket mail sender'
```

Inside the existing `try { … }`, after the certificate block and **before** the final "Enter these on the Boosters Rocket
setup page" output, add:

```powershell
  if ($SetUpMail) {
    # An unscoped Graph Mail.Send grant would let the app send as anyone; RBAC for Applications only adds to it.
    $grants = @((Invoke-MgGraphRequest GET "v1.0/servicePrincipals/$($sp.id)/appRoleAssignments").value)
    if ($grants | Where-Object { $_.resourceId -eq $graphSp.id -and $_.appRoleId -eq $MailSendAppRoleId }) {
      throw "The app '$DisplayName' holds Microsoft Graph's Mail.Send application permission, which would let it send as anyone. Remove it first: Entra admin center > Enterprise applications > $DisplayName > Permissions, select Mail.Send and Revoke permission (and remove Mail.Send from App registrations > $DisplayName > API permissions). Then run this script again."
    }
    Connect-ExchangeOnline -ShowBanner:$false
    try {
      if (-not (Get-EXOMailbox -Identity $Mailbox -ErrorAction SilentlyContinue)) {
        throw "Exchange Online has no mailbox $Mailbox. Use the address of an existing mailbox in this tenant."
      }
      if (-not (Get-ServicePrincipal -Identity $sp.id -ErrorAction SilentlyContinue)) {
        New-ServicePrincipal -AppId $app.appId -ObjectId $sp.id -DisplayName $DisplayName | Out-Null
        Write-Host "Pointed Exchange Online at the app '$DisplayName'."
      }
      $filter = "PrimarySmtpAddress -eq '$Mailbox'"
      if (Get-ManagementScope -Identity $ScopeName -ErrorAction SilentlyContinue) {
        Set-ManagementScope -Identity $ScopeName -RecipientRestrictionFilter $filter
      } else {
        New-ManagementScope -Name $ScopeName -RecipientRestrictionFilter "PrimarySmtpAddress -eq '$Mailbox'" | Out-Null
      }
      $assignment = Get-ManagementRoleAssignment -Role 'Application Mail.Send' -ErrorAction SilentlyContinue |
        Where-Object { $_.RoleAssigneeName -eq $sp.id -or $_.RoleAssignee -eq $sp.id } | Select-Object -First 1
      if ($assignment) {
        Set-ManagementRoleAssignment -Identity $assignment.Identity -CustomResourceScope $ScopeName
      } else {
        New-ManagementRoleAssignment -App $sp.id -Role 'Application Mail.Send' -CustomResourceScope $ScopeName | Out-Null
      }
      $check = Test-ServicePrincipalAuthorization -Identity $sp.id -Resource $Mailbox | Where-Object { $_.RoleName -eq 'Application Mail.Send' }
      if ($check -and $check.InScope) { Write-Host "The app can now send as $Mailbox, and only as $Mailbox." }
      else { Write-Host "The role assignment is in place, but Exchange doesn't report $Mailbox in scope yet. Check the mailbox address." }
      Write-Host 'Microsoft can take from 30 minutes to 2 hours to apply this. Then use Send test email on the setup page.'
    } finally {
      Disconnect-ExchangeOnline -Confirm:$false | Out-Null
    }
  }
```

In the closing output, after the certificate line, add:

```powershell
  if ($SetUpMail) { Write-Host "  Mail:                 Microsoft 365, sending as $Mailbox" }
```

Keep `Disconnect-MgGraph` in the outer `finally`. Nothing in this part writes to disk.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/unit/setup-scripts.test.ts tests/integration/setup-scripts-route.test.ts`
Expected: PASS. The route test still sees the app URL and certificate tokens replaced.

Check the script parses. In PowerShell 7 (not bash, which would expand the `$` signs), from the repo root:

Run: `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'scripts/setup/New-BoosterRocketStaffApp.ps1'), [ref]$null, [ref]$e); if ($e) { $e } else { 'parsed' }`
Expected: `parsed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup/New-BoosterRocketStaffApp.ps1 tests/unit/setup-scripts.test.ts
git commit -m "feat(setup): staff script can let the app send mail as one mailbox

-SetUpMail -Mailbox uses Exchange Online RBAC for Applications (a one-mailbox scope and the
Application Mail.Send role) and refuses while an unscoped Graph Mail.Send grant exists.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end parent sign-in with a mail catcher

Spec §7 End-to-end. A parent signs in with a code read from a local SMTP server, switches family and signs out. The app
under test sends real SMTP over TLS: `seed-e2e.ts` saves SMTP settings pointing at `127.0.0.1:2465`, and the e2e server
process trusts the sink's self-signed certificate through Node's own `NODE_EXTRA_CA_CERTS`, set only in
`playwright.config.ts`. There is no capture transport and no switch in the app, so nothing can enable a fake mail path in
production; a unit test keeps it that way.

**Files:**
- Create: `tests/e2e/mail-sink-cert.ts`, `tests/e2e/parent-sign-in.spec.ts`, `tests/unit/no-test-mail-path.test.ts`
- Modify: `playwright.config.ts`, `scripts/seed-e2e.ts`

**Interfaces:**
- Consumes: `localhostCertificate` (`tests/helpers/tls.ts`), `startMailSink` (`tests/helpers/mail-sink.ts`),
  `mailConfigHash` (`src/lib/mail/config-hash.ts`), `createSecretBox`, `SMTP_PASSWORD_AAD` value `"mail:smtp-password"`.
- Produces: `.e2e/sink-key.pem` and `.e2e/sink-cert.pem` (ignored by git, rewritten each e2e run).

- [ ] **Step 1: Guard against a test-only mail path**

`tests/unit/no-test-mail-path.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const files = readdirSync(path.join(root, "src"), { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/.test(f));

describe("the app has one way to send mail", () => {
  it("never imports the test SMTP server, never trusts extra CAs, and never turns off certificate checks", () => {
    for (const f of files) {
      const s = readFileSync(path.join(root, "src", f), "utf8");
      expect(s, f).not.toMatch(/smtp-server|NODE_EXTRA_CA_CERTS|rejectUnauthorized|jsonTransport|streamTransport/);
    }
  });
  it("chooses a sender only from the saved settings", () => {
    const s = readFileSync(path.join(root, "src/lib/mail/senders.ts"), "utf8");
    expect(s).not.toMatch(/process\.env/);
  });
});
```

Run: `pnpm vitest run tests/unit/no-test-mail-path.test.ts`
Expected: PASS (it guards what Tasks 3 and 6 built).

- [ ] **Step 2: The sink certificate and the server's trust**

`tests/e2e/mail-sink-cert.ts`:

```ts
// Run before `pnpm start` in the e2e web server command: writes the mail sink's key and certificate, which the server
// trusts through NODE_EXTRA_CA_CERTS (playwright.config.ts). Test-only; nothing in src/ reads these files.
import { mkdirSync, writeFileSync } from "node:fs";
import { localhostCertificate } from "../helpers/tls";

async function main() {
  const { key, cert } = await localhostCertificate();
  mkdirSync(".e2e", { recursive: true });
  writeFileSync(".e2e/sink-key.pem", key);
  writeFileSync(".e2e/sink-cert.pem", cert);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

`playwright.config.ts`, whole file:

```ts
import { defineConfig } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  workers: 1,
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "pnpm tsx tests/e2e/mail-sink-cert.ts && pnpm start -p 3100",
    url: "http://localhost:3100/sign-in", reuseExistingServer: false, timeout: 60_000,
    // NODE_EXTRA_CA_CERTS makes this e2e server trust the local mail sink's certificate. Only this file sets it.
    env: { ...(process.env as Record<string, string>), SETUP_STATUS_CACHE_MS: "0", NODE_EXTRA_CA_CERTS: path.resolve(".e2e/sink-cert.pem") },
  },
  projects: [{ name: "phone", use: { viewport: { width: 390, height: 844 } } }, { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } }],
});
```

- [ ] **Step 3: Seed a second family and working mail**

`scripts/seed-e2e.ts`: add imports and, after the guardian insert from Task 2, the second family and the mail settings:

```ts
import { createSecretBox } from "../src/lib/crypto/secret-box";
import { mailConfigHash } from "../src/lib/mail/config-hash";
// …
  await sql`INSERT INTO guardian (family_qbo_id, parent_id, is_primary, status) VALUES ('E2E-FAMILY-2', ${p!.id}, false, 'active')
          ON CONFLICT (family_qbo_id, parent_id) DO NOTHING`;
  // SMTP to the e2e mail sink (tests/e2e/parent-sign-in.spec.ts), counted as tested.
  const sealed = createSecretBox({ current: process.env.SETTINGS_ENCRYPTION_KEY! }).seal("sink-password", "mail:smtp-password");
  const mail = { method: "smtp", host: "127.0.0.1", port: 2465, security: "tls", username: "sender", from: "boosters@e2e.example.org",
    passwordCiphertext: sealed.ciphertext, passwordKeyId: sealed.keyId } as const;
  const status = { verifiedHash: mailConfigHash(mail), verifiedAt: new Date().toISOString(), lastSuccessAt: null, lastFailureAt: null, lastError: null };
  await sql`INSERT INTO setting (key, value) VALUES ('mail', ${sql.json(mail)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`INSERT INTO setting (key, value) VALUES ('mail.status', ${sql.json(status)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`DELETE FROM signin_code`;
  await sql`DELETE FROM rate_limit_event`;
```

(The literal `"mail:smtp-password"` is `SMTP_PASSWORD_AAD`; the seed doesn't import `senders.ts`, which pulls in the
database client.)

- [ ] **Step 4: Write the e2e test**

`tests/e2e/parent-sign-in.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { startMailSink, type MailSink } from "../helpers/mail-sink";

const sql = postgres(process.env.DATABASE_URL!);
let sink: MailSink;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  sink = await startMailSink({ secure: true, port: 2465, key: readFileSync(".e2e/sink-key.pem", "utf8"), cert: readFileSync(".e2e/sink-cert.pem", "utf8") });
});
test.afterAll(async () => { await sink.close(); await sql.end(); });
test.beforeEach(async () => {
  sink.messages.length = 0;
  await sql`DELETE FROM signin_code`;
  await sql`DELETE FROM rate_limit_event`;
});

async function codeFor(email: string): Promise<string> {
  await expect.poll(() => sink.messages.filter((m) => m.to.includes(email)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const raw = sink.messages.filter((m) => m.to.includes(email)).at(-1)!.raw;
  return /^Subject: .*sign-in code: (\d{6})/m.exec(raw)![1]!;
}

test("a parent signs in with an emailed code, switches family, and signs out", async ({ page }) => {
  const since = new Date();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(" Zelda@Example.com ");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("status")).toContainText("If this email belongs to a family in the club, we've sent a 6-digit code.");
  await expect(page.getByRole("button", { name: /Resend code/ })).toBeDisabled();
  const code = await codeFor("zelda@example.com");
  expect(sink.messages.at(-1)!.raw).not.toMatch(/https?:\/\//);
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/choose-family$/);
  await page.getByRole("button", { name: "Family account E2E-FAMILY", exact: true }).click();
  await expect(page).toHaveURL(/localhost:3100\/$/);
  await expect(page.getByText("Viewing Family account E2E-FAMILY.")).toBeVisible();

  await page.getByRole("link", { name: "Switch family" }).click();
  await page.getByRole("button", { name: "Family account E2E-FAMILY-2", exact: true }).click();
  await expect(page.getByText("Viewing Family account E2E-FAMILY-2.")).toBeVisible();

  await page.goto("/display");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);

  const actions = (await sql`SELECT action FROM audit_log WHERE door = 'parent' AND at >= ${since} ORDER BY id`).map((r) => r.action as string);
  expect(actions).toEqual(expect.arrayContaining(["signin.code_sent", "signin", "signin.family_switch", "signout"]));
  expect(JSON.stringify(await sql`SELECT * FROM audit_log WHERE at >= ${since}`)).not.toContain(code);
});

test("an unknown address gets the same answer and no email", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("status")).toContainText("If this email belongs to a family in the club, we've sent a 6-digit code.");
  await page.getByLabel("6-digit code").fill("123456");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("That code didn't work. Check the newest email from us, or request a new code.");
  await page.waitForTimeout(2000);
  expect(sink.messages).toHaveLength(0);
});
```

- [ ] **Step 5: Run the e2e suite**

With the environment from Global Constraints set:

Run: `pnpm build && pnpm db:migrate && pnpm tsx scripts/seed-e2e.ts && pnpm e2e`
Expected: PASS for both projects (phone and desktop), including the existing `public-pages` and `setup` specs.
`public-pages.spec.ts` still finds no `Zelda` or `E2E-FAMILY` on `/sign-in` for an anonymous visitor.

If port 2465 is taken on the machine, change it in both `seed-e2e.ts` and the spec; nothing else uses it.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts scripts/seed-e2e.ts tests/e2e tests/unit/no-test-mail-path.test.ts
git commit -m "test(e2e): a parent signs in with a code from a local mail sink, switches family, signs out

The app sends real SMTP over TLS to the sink; only the e2e server trusts its certificate. A unit test
keeps any test transport out of src/.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Runbook and supersession notes

Spec §4 (runbook), §6, §7 PoC on linuxdev. Docs only.

**Files:**
- Modify: `docs/runbooks/poc-linuxdev.md`, `docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md`,
  `docs/superpowers/specs/2026-11-08-first-run-setup-design.md`,
  `docs/superpowers/specs/2026-11-09-certificate-credentials-design.md`

- [ ] **Step 1: Supersession notes**

Under the `**Status:**` line of each spec, add one line:

- v1 design: `**Revised in part:** parent sign-in, people and outgoing mail. See docs/superpowers/specs/2026-11-10-parent-email-code-sign-in-design.md (it lists the sections it changes).`
- First-run setup: `**Superseded in part:** Step 2 is now Outgoing mail, not Parent sign-in. See docs/superpowers/specs/2026-11-10-parent-email-code-sign-in-design.md.`
- Certificate credentials: `**Superseded in part:** only staff sign-in uses a certificate now; the parent certificate and its script are removed. See docs/superpowers/specs/2026-11-10-parent-email-code-sign-in-design.md.`

- [ ] **Step 2: The runbook**

`docs/runbooks/poc-linuxdev.md`:

1. Intro paragraph: replace the sentences about section 4 part A and parts B to E with *"Sign-in and outgoing mail are set
   up on the setup page after the first deploy (sections 3 and 4)."*
2. Section 1: "parent sign-in (Entra External ID)" becomes "parent sign-in (a 6-digit code the portal emails from
   `webmaster@fznband.org`)", and "set up staff sign-in, parent sign-in and the first Admin" becomes "set up staff
   sign-in, outgoing mail and the first Admin".
3. Replace all of section 4 with:

   ```markdown
   ## 4. Outgoing mail (Microsoft 365, sending as webmaster@fznband.org)

   Parents sign in with a code the portal emails them, so mail must work before any parent can sign in. The portal
   sends as one mailbox, `webmaster@fznband.org`, through Microsoft Graph with the staff app's certificate. Exchange
   Online only lets the app send as that mailbox.

   1. Do section 3 first: this uses the staff app.
   2. On a Windows PC with PowerShell 7, install the Exchange Online module once:
      `Install-Module ExchangeOnlineManagement -Scope CurrentUser`
   3. On the setup page, Step 2 (Outgoing mail), open **Microsoft 365: let the app send as one mailbox**, download
      `New-BoosterRocketStaffApp.ps1` again (it carries the current certificate), run `Unblock-File` on it, then run
      `./New-BoosterRocketStaffApp.ps1 -TenantId <band tenant ID> -SetUpMail -Mailbox webmaster@fznband.org`, signed in
      as an Exchange administrator. It reuses the staff app and adds the mail permission. (The same steps by hand are
      under that heading on the setup page.)
   4. If the script stops because the app holds Microsoft Graph's **Mail.Send** application permission, do what it
      says, then run it again.
   5. Wait 30 minutes to 2 hours: Microsoft caches app permissions for that long.
   6. On the setup page choose **Microsoft 365**, enter `webmaster@fznband.org`, **Save**, then **Send test email** to
      an address you can read. When it arrives, **Next: first Admin** turns on.

   The old parents tenant (`fznbandparents`) and its app aren't used any more. Delete them whenever you like; the
   portal never deletes anything in a tenant.

   Sources: Role Based Access Control for Applications in Exchange Online
   (https://learn.microsoft.com/exchange/permissions-exo/application-rbac); user: sendMail
   (https://learn.microsoft.com/graph/api/user-sendmail).
   ```

4. Replace section 5 with:

   ```markdown
   ## 5. Test parents

   1. **Wait until the first deploy in section 7 has succeeded.** Then, on linuxdev, seed parent one:
      ```bash
      cd ~/booster-rocket
      docker compose -f docker-compose.poc.yml --env-file .env.poc run --rm migrate node tools/scripts/seed-poc-guardian.mjs --name "<name>" --email "<email you can read>" --family POC-FAMILY-1
      ```
      Success prints `seeded guardian <id>`. It refuses unless `APP_URL` contains `portaltest`. Running it again with
      the same email and family prints "That person is already a guardian in that family." The same email with
      `--family POC-FAMILY-2` adds a second family to the same person.
   2. Parent two is any other address you can read. It gets no guardian row on purpose (checklist step 7).
   ```

5. Section 8, the checklist: step 4 becomes *"Parent: at `/sign-in`, enter the seeded parent's email, get the code from
   `webmaster@fznband.org`, enter it -> parent home (with two families, the family chooser first)."*; step 5's list
   replaces `parent signin, parent.object_id_set, guardian.activate` with `signin.code_sent`, parent `signin`,
   `guardian.activate`, and adds `settings.mail.save` and `settings.mail.test` from setup; step 7 becomes *"Parent two's
   address -> the same 'If this email belongs to a family…' message, no email arrives, and the audit shows
   `signin.code_refused` with reason `unknown_email`."* Add step 9: *"From PowerShell, confirm the app can't send as
   any other mailbox: `Test-ServicePrincipalAuthorization -Identity <staff app Object ID> -Resource <another mailbox>`
   shows `InScope` `False` for Application Mail.Send."*
6. The "Reading the audit log" paragraph's example becomes `{"reason":"unknown_email"}`.
7. Section 9, troubleshooting: delete every row that mentions `missing_object_id`, `no_guardian`,
   `parent.object_id_*`, the parent redirect URI or External ID sign-up. In the AADSTS50011 row, keep only the staff
   redirect URI. The `disabled` row's SQL becomes
   `update guardian set status='invited', disabled_reason=null where parent_id=(select id from parent where email='<email>');`.
   Add these rows:

   ```markdown
   | A parent never gets a code; audit `signin.code_refused`, reason `unknown_email` | No person has that email | Seed them (section 5); addresses are matched trimmed and lowercased |
   | `signin.code_refused`, reason `no_enabled_guardian` | All of the person's guardian rows are disabled | Test data: re-enable the row (see the `disabled` row) |
   | `signin.code_refused`, reason `rate_limited` | 3 codes to one address, or 10 requests from one IP, in 15 minutes, or a resend within 60 seconds | Wait 15 minutes |
   | `signin.code_refused`, reason `mail_failed`, and a `mail.failed` row | Microsoft 365 or SMTP refused the message; the `mail.failed` row has the provider's error | For `ErrorAccessDenied`, rerun section 4 step 3 and wait up to 2 hours; staff see the same error on the staff home page |
   | `/sign-in` says "Parent sign-in isn't available yet." | Mail settings aren't saved, or haven't had a successful test since they changed | **Settings** > **Mail** (Admins only): **Send test email** |
   | "Too many tries. Wait a few minutes and request a new code." | 30 code checks from one IP in 15 minutes | Wait 15 minutes |
   ```

8. Section 10, results: replace the step 4 and step 7 "Not run" notes with "Not run: waiting on outgoing mail
   (section 4)", and add under the findings: *"2026-11-10: an account an admin creates in External ID always has a
   password, so External ID can't give parents email-code-only sign-in with sign-up off. Parents now get codes from
   the portal itself (spec 2026-11-10)."*

- [ ] **Step 3: Check the wording**

Run: `grep -n "External ID\|parent-oidc\|ParentApp\|object-id\|Object ID" docs/runbooks/poc-linuxdev.md`
Expected: only the 2026-11-10 finding and the `fznbandparents` deletion note mention External ID; nothing else matches.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/poc-linuxdev.md docs/superpowers/specs
git commit -m "docs(runbooks): parents sign in with portal email codes; set up outgoing mail

Removes the External ID steps, adds the Microsoft 365 mail setup and the new test-parent seed, and
notes that the fznbandparents tenant can be deleted. Earlier specs get supersession notes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Rulings made while planning

- **Better Auth's `email-otp` plugin is not used** (spec §5 names it). It stores codes in `parent_auth_verification`
  keyed by email, counts tries in that row, rate-limits in memory, and signs in by email lookup; the spec wants a
  `signin_code` table keyed by the person, database limits, an audited reason for each refusal and try, and codes that die
  on email change. The plugin's own fallback rule (enforce in hooks) would have meant replacing its storage, check and
  sign-in. The portal's plugin uses Better Auth only for `createSession` and `setSessionCookie`.
- **One answer for every failed code check** ("That code didn't work…"), because "no code was sent" for an unknown email
  would otherwise differ from "wrong code" (Review Focus 2). The audit log still records `code_wrong` or `code_expired`.
- **Every Send code counts against the per-email limit**, sent or not, so the limit itself can't reveal whether an address
  is on file; a resend within 60 seconds is refused server-side too (audited `rate_limited`, `limit: "resend"`).
- **Mail not working** is audited as `signin.code_refused` reason `mail_failed` with `detail: "mail_not_working"` (the spec's
  reason list has nothing closer).
- **`signin` is written when the family is entered:** at the code check for one family, at the first choice for two or
  more. A later choice is `signin.family_switch`.
- **Graph sends JSON with an HTML body and `saveToSentItems: false`,** so `webmaster@` doesn't collect codes; Exchange adds
  the text part. SMTP sends both parts.
- **Families are labeled `Family account <QBO id>`** until the roster plan brings names; `GuardianInput.familyLabel`
  carries the name into welcome emails.
- **The parent's own email change UI and the `/email-change/confirm` page are not in this plan.** The library and its
  tests are; the request form belongs with the parent profile page, and the confirm page should be a POST button (mail
  scanners follow links). Nothing in this plan sends that link.
- **Old `setup.state` step `parent`** reads as `staff` (Task 1) and is moved to `mail` by the migration.
- **Old disabled guardian rows** become `disabled` / `removed` with `statusBeforeDisable: "invited"`.
