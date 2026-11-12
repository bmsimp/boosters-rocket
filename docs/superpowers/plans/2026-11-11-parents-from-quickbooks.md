# Parents from QuickBooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A parent who is in the QuickBooks roster can sign in to the portal without staff inviting them, once an Admin has switched parent sign-ins on from a clean-up preview.

**Architecture:** A pure rules function turns the roster cache, the membership shape, the staff decisions and the settings into "who has access to which family". A reconcile step, run inside every roster refresh transaction and after every staff decision, applies only the differences to the existing `parent` and `guardian` tables that sign-in already runs on. Welcome emails and staff review notices are marked in the database and sent by the worker's minute wake.

**Tech Stack:** Next.js 16.4.5 (App Router, server actions), React 19.3, TypeScript strict, Drizzle 0.45 + Postgres 16, Zod 4, Vitest (integration tests against real Postgres on localhost:5433), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-11-parents-from-quickbooks-design.md`. Read it before any task. It builds on `2026-11-10-parent-email-code-sign-in-design.md` and `2026-11-10-quickbooks-connection-and-roster-design.md`.

## Global Constraints

- The portal writes nothing to QuickBooks. This plan adds no request to QuickBooks or Intuit at all.
- Access is decided only by `decideAccess` (Task 2). No page, action or job works out access another way.
- The reconcile runs under the roster advisory lock (`ROSTER_LOCK`, `src/lib/roster/shape.ts`), in the caller's transaction. It never sends mail.
- While parent sign-ins have never been switched on, the reconcile changes nothing and hand-seeded sign-ins keep working.
- An address under more than one family is held for every family staff have not approved for it. A match (Task 8) never grants access.
- A blocked, held or unknown person who asks for a code gets the same sentence as today (`CODE_SENT`); nothing tells them why.
- Every create, update and delete is audited, and staff opening a person's page is audited (`parent.read`). Audit rows never hold an email body or a sign-in code.
- Rows written by the reconcile use the system actor `{ door: "system", id: null, label: "reconcile" }` and carry `cause` in `after`.
- Audit actions added: `settings.parents.save`, `parent.access.granted`, `parent.access.ended`, `parent.email.changed`, `parent.name.changed`, `parent.hold.decided`, `parent.block`, `parent.unblock`, `parent.welcome.sent`, `parent.welcome.failed`, `parent.review.notified`, `parent.read`, `parent.access.cleared`, `parent.match.decided`.
- Permissions added: `Settings.Parents.ReadWrite` (Admin only) and `Parents.ReadWrite` (grantable).
- Staff with only `Roster.Read` never see which other family a held address is under.
- A welcome email holds no family details. A staff review notice names no family, person or address.
- Welcome emails: sent by the worker, at most 5 per wake; a failed send is retried at most once every 15 minutes; a person is welcomed once.
- Review notices: each held item announced once; at most one email in any 24 hours; no reminders.
- The previous company's snapshot is deleted 90 days after the switch.
- Every server action module under `src/app/staff/` exports only `staffAction`-wrapped functions.
- Forms that keep typed values use `type="button"` plus state-built `FormData` inside `startTransition` (see the comment at the top of `src/app/staff/(app)/settings/quickbooks/forms.tsx`). A plain one-button form may use a form `action`.
- QuickBooks names are free text: rendered as text only, never as HTML.
- US English. Times stored UTC, shown with the `LocalTime` component, no time zone in display code.
- No new dependencies. No environment variable switches behavior. No test-only path in app code.
- Never run anything against real Intuit or QuickBooks. Never run `docker compose` with `docker-compose.poc.yml`. Do not push.
- Every commit message ends with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- The code blocks in this plan were not compiled. Follow them; where the compiler, the linter, a library or a test disagrees, make the smallest change that keeps the behavior and report it.

## Review Focus

1. **A QuickBooks email field that is not one clean address** (`"a@x.org; b@x.org"`, `"Ana <ana@x.org>"`, trailing comma, 300 characters of text). Expected: usable addresses are found, the rest is flagged, nothing throws, and nobody gets access through a half-parsed address. Pinned in Task 2.
2. **The same person reaching two families through different spellings of one address** (`Ana@X.org` and `ana@x.org `). Expected: one address, held across families like any other repeat. Pinned in Task 2.
3. **A parent who is signed in when their link closes.** Expected: their session for that family ends in the same transaction; a session for another family they still have carries on. Pinned in Task 3.
4. **A reconcile that fails halfway.** Expected: the roster cache and every link are exactly as before, and the refresh is recorded as failed. Pinned in Task 3.
5. **Small QuickBooks IDs meaning different families in two companies** (family `12` in the sandbox, family `12` in the real books). Expected: no approval, welcome history or link from the old company applies to the new one unless an Admin accepts a match. Pinned in Task 8.

## File Structure

New library files (each has one job):

| File | Responsibility |
|---|---|
| `src/lib/parents/settings.ts` | Read and write the `parents.settings` setting; `parentDoorClosed` |
| `src/lib/parents/emails.ts` | `parseEmailField`: split a QuickBooks email field into usable and unusable addresses |
| `src/lib/parents/access-rules.ts` | `decideAccess`: the pure rules (spec §1) |
| `src/lib/parents/reconcile.ts` | `loadDecision`, `reconcileAccess`, `runReconcile`: apply the differences (spec §2) |
| `src/lib/parents/switches.ts` | `accessPreview` and the Admin switches (spec §3) |
| `src/lib/parents/welcome.ts` | Owed welcomes, the worker's sender, resend |
| `src/lib/parents/holds.ts` | Decide and reverse a held address |
| `src/lib/parents/directory.ts` | People list, one person, statuses for a family's page |
| `src/lib/parents/review-notice.ts` | What is waiting; the once-a-day staff email |
| `src/lib/parents/company-change.ts` | Close everything and snapshot the old company |
| `src/lib/parents/matches.ts` | Suggest and decide matches |

Modified: `src/lib/db/schema.ts`, `src/lib/permissions/registry.ts`, `src/lib/parents/people.ts`, `src/lib/parents/sessions.ts`, `src/lib/parents/signin-codes.ts`, `src/lib/roster/refresh.ts`, `src/lib/roster/source.ts`, `src/lib/roster/attention.ts`, `src/lib/roster/queries.ts`, `src/lib/jobs/runner.ts`, `src/lib/mail/messages.ts`, `src/lib/mail/types.ts`, and the pages named in Tasks 9 and 10.

---

### Task 1: Schema, permissions and the parents setting

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `drizzle/0009_parents_from_quickbooks.sql` (generated)
- Modify: `src/lib/permissions/registry.ts`
- Create: `src/lib/parents/settings.ts`
- Modify: `tests/helpers/db.ts`
- Test: `tests/integration/parents-schema.test.ts`, `tests/unit/parents-settings.test.ts`
- Modify (expectations only): any test that lists permissions, found with `grep -rn "Roster.Read" tests`

**Interfaces:**
- Produces:
  - `parent` columns `blockedAt: Date | null`, `blockedBy: string | null`, `blockedReason: string | null`, `welcomedAt: Date | null`, `welcomeOwed: boolean`, `welcomeTriedAt: Date | null`
  - `guardian.sourceQboId: string | null`; `DisabledReason` = `"no_active_students" | "removed" | "inactive" | "family_inactive" | "no_email" | "held" | "address_changed" | "not_in_quickbooks" | "company_changed"`
  - table `heldAddress` (`held_address`): `email` (pk), `approvedFamilyQboIds: string[]`, `rejectedFamilyQboIds: string[]`, `announcedFamilyQboIds: string[]`, `note`, `decidedBy`, `decidedAt`, `createdAt`, `updatedAt`
  - table `familyMatch` (`family_match`): `id`, `oldRealmId`, `oldFamilyQboId`, `newRealmId`, `newFamilyQboId`, `decidedBy`, `decidedAt`; unique on (`oldRealmId`, `oldFamilyQboId`)
  - `PARENTS_KEY = "parents.settings"`; `type ParentSettings = { signin: boolean; everEnabled: boolean; welcome: boolean; requireActiveStudents: boolean; reviewEmails: boolean }`; `DEFAULT_PARENT_SETTINGS`; `getParentSettings(tx?: Tx): Promise<ParentSettings>`; `putParentSettings(tx: Tx, next: ParentSettings): Promise<void>`; `parentDoorClosed(s: ParentSettings): boolean`
  - permissions `"Settings.Parents.ReadWrite"` (in `ADMIN_ONLY`) and `"Parents.ReadWrite"`

- [ ] **Step 1: Write the failing tests**

`tests/unit/parents-settings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parentDoorClosed, DEFAULT_PARENT_SETTINGS, parseParentSettings } from "@/lib/parents/settings";

describe("the parents setting", () => {
  it("defaults to everything off except staff review emails", () => {
    expect(DEFAULT_PARENT_SETTINGS).toEqual({ signin: false, everEnabled: false, welcome: false, requireActiveStudents: false, reviewEmails: true });
  });
  it("reads a stored value, and falls back to the defaults for anything else", () => {
    expect(parseParentSettings({ signin: true, everEnabled: true, welcome: false, requireActiveStudents: true, reviewEmails: false }))
      .toEqual({ signin: true, everEnabled: true, welcome: false, requireActiveStudents: true, reviewEmails: false });
    for (const bad of [null, undefined, "on", 3, { signin: "yes" }, []]) expect(parseParentSettings(bad)).toEqual(DEFAULT_PARENT_SETTINGS);
  });
  it("closes the parent door only after sign-ins were on and are now off", () => {
    expect(parentDoorClosed({ ...DEFAULT_PARENT_SETTINGS })).toBe(false);                               // never switched on: seeded sign-ins work
    expect(parentDoorClosed({ ...DEFAULT_PARENT_SETTINGS, signin: true, everEnabled: true })).toBe(false);
    expect(parentDoorClosed({ ...DEFAULT_PARENT_SETTINGS, signin: false, everEnabled: true })).toBe(true);
  });
});
```

`tests/integration/parents-schema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { parent, guardian, heldAddress, familyMatch, setting } from "@/lib/db/schema";
import { getParentSettings, putParentSettings, DEFAULT_PARENT_SETTINGS, PARENTS_KEY } from "@/lib/parents/settings";
import { ADMIN_ONLY, GRANTABLE, isPermission } from "@/lib/permissions/registry";
import { resetDb, seedParent, seedGuardian } from "../helpers/db";

describe("the parents-from-QuickBooks schema", () => {
  beforeEach(resetDb);

  it("gives a person welcome and block fields with safe defaults", async () => {
    const p = await seedParent({ name: "Ana Rivera" });
    const [row] = await db.select().from(parent);
    expect(row).toMatchObject({ id: p.id, blocked: false, blockedAt: null, blockedBy: null, blockedReason: null, welcomedAt: null, welcomeOwed: false, welcomeTriedAt: null });
  });

  it("lets a family link remember its QuickBooks customer and why it closed", async () => {
    const p = await seedParent({ name: "Ana Rivera" });
    const g = await seedGuardian({ parentId: p.id, familyQboId: "10" });
    expect(g.sourceQboId).toBeNull();
    await db.update(guardian).set({ sourceQboId: "11", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
    expect((await db.select().from(guardian))[0]).toMatchObject({ sourceQboId: "11", disabledReason: "company_changed" });
  });

  it("keeps one row per held address, with three sets of family IDs", async () => {
    await db.insert(heldAddress).values({ email: "ana@example.com" });
    const [h] = await db.select().from(heldAddress);
    expect(h).toMatchObject({ email: "ana@example.com", approvedFamilyQboIds: [], rejectedFamilyQboIds: [], announcedFamilyQboIds: [], note: null, decidedBy: null, decidedAt: null });
    await expect(db.insert(heldAddress).values({ email: "ana@example.com" })).rejects.toThrow();
  });

  it("allows one match per old family", async () => {
    const m = { oldRealmId: "1", oldFamilyQboId: "12", newRealmId: "2", newFamilyQboId: "87" };
    await db.insert(familyMatch).values(m);
    await expect(db.insert(familyMatch).values({ ...m, newFamilyQboId: "88" })).rejects.toThrow();
  });

  it("stores and reads the parents setting, defaulting when it is missing", async () => {
    expect(await getParentSettings()).toEqual(DEFAULT_PARENT_SETTINGS);
    await db.transaction((tx) => putParentSettings(tx, { ...DEFAULT_PARENT_SETTINGS, signin: true, everEnabled: true }));
    expect(await getParentSettings()).toMatchObject({ signin: true, everEnabled: true });
    expect(await db.select().from(setting)).toEqual([expect.objectContaining({ key: PARENTS_KEY })]);
  });

  it("adds an Admin-only settings permission and a grantable parents permission", () => {
    expect(isPermission("Settings.Parents.ReadWrite")).toBe(true);
    expect(isPermission("Parents.ReadWrite")).toBe(true);
    expect(ADMIN_ONLY).toContain("Settings.Parents.ReadWrite");
    expect(GRANTABLE).toContain("Parents.ReadWrite");
    expect(GRANTABLE).not.toContain("Settings.Parents.ReadWrite");
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tests/unit/parents-settings.test.ts tests/integration/parents-schema.test.ts`
Expected: FAIL (cannot find `@/lib/parents/settings`; `heldAddress` is not exported).

- [ ] **Step 3: Change the schema**

In `src/lib/db/schema.ts`:

```ts
export type DisabledReason = "no_active_students" | "removed" | "inactive" | "family_inactive" | "no_email" | "held" | "address_changed" | "not_in_quickbooks" | "company_changed";
const DISABLED_REASONS = ["no_active_students", "removed", "inactive", "family_inactive", "no_email", "held", "address_changed", "not_in_quickbooks", "company_changed"] as const;
```

Add to `parent`, after `blocked`:

```ts
  blockedAt: timestamp("blocked_at", { withTimezone: true }),
  blockedBy: uuid("blocked_by"),                       // staff_user.id
  blockedReason: text("blocked_reason"),               // staff see it; the parent never does
  welcomedAt: timestamp("welcomed_at", { withTimezone: true }),
  welcomeOwed: boolean("welcome_owed").notNull().default(false),
  welcomeTriedAt: timestamp("welcome_tried_at", { withTimezone: true }),
```

In `guardian`, replace the `disabledReason` line and add `sourceQboId`:

```ts
  sourceQboId: text("source_qbo_id"),                  // the QuickBooks customer this link came from; null for one made by hand
  disabledReason: text("disabled_reason", { enum: DISABLED_REASONS }),
```

After `parentEmailChange`, add:

```ts
/**
 * One row per email address that is, or was, under more than one family (spec §1 Held addresses). The three sets hold
 * family QuickBooks IDs: approved by staff as the same person, rejected as not the same person, and already announced
 * to staff by email. The IDs belong to the connected company; a company change deletes every row.
 */
export const heldAddress = pgTable("held_address", {
  email: text("email").primaryKey(),                   // trimmed + lower-cased
  approvedFamilyQboIds: jsonb("approved_family_qbo_ids").$type<string[]>().notNull().default([]),
  rejectedFamilyQboIds: jsonb("rejected_family_qbo_ids").$type<string[]>().notNull().default([]),
  announcedFamilyQboIds: jsonb("announced_family_qbo_ids").$type<string[]>().notNull().default([]),
  note: text("note"),
  decidedBy: uuid("decided_by"),                       // staff_user.id
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: created(),
  updatedAt: updated(),
});

/** "This family in the previous QuickBooks company is this family in the connected one" (spec §6). Kept for good. */
export const familyMatch = pgTable("family_match", {
  id: uuid("id").primaryKey().defaultRandom(),
  oldRealmId: text("old_realm_id").notNull(),
  oldFamilyQboId: text("old_family_qbo_id").notNull(),
  newRealmId: text("new_realm_id").notNull(),
  newFamilyQboId: text("new_family_qbo_id").notNull(),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("family_match_old_uq").on(t.oldRealmId, t.oldFamilyQboId)]);
```

Generate the migration: `pnpm db:generate --name parents_from_quickbooks`. Confirm the file is `drizzle/0009_parents_from_quickbooks.sql` and holds only: six `ALTER TABLE "parent" ADD COLUMN`, one `ALTER TABLE "guardian" ADD COLUMN "source_qbo_id"`, two `CREATE TABLE`, one `CREATE UNIQUE INDEX`. If it holds anything else, stop and report.

- [ ] **Step 4: Permissions, the setting, and the test helper**

`src/lib/permissions/registry.ts`: add to `PERMISSIONS`, after `"Roster.Read"`:

```ts
  "Settings.Parents.ReadWrite",    // admin-only: switch parent sign-ins and welcome emails on, and review company matches
  "Parents.ReadWrite",             // decide held addresses, block and unblock a parent, resend a welcome email
```

and add `"Settings.Parents.ReadWrite"` to `ADMIN_ONLY`.

`src/lib/parents/settings.ts`:

```ts
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";

export const PARENTS_KEY = "parents.settings";

/**
 * The Admin's switches for parent sign-ins (spec §3). `everEnabled` stays true once sign-ins have been on: before that
 * the reconcile does nothing and hand-seeded sign-ins work; after it, `signin: false` closes the parent door.
 */
export type ParentSettings = { signin: boolean; everEnabled: boolean; welcome: boolean; requireActiveStudents: boolean; reviewEmails: boolean };
export const DEFAULT_PARENT_SETTINGS: ParentSettings = { signin: false, everEnabled: false, welcome: false, requireActiveStudents: false, reviewEmails: true };

const stored = z.object({ signin: z.boolean(), everEnabled: z.boolean(), welcome: z.boolean(), requireActiveStudents: z.boolean(), reviewEmails: z.boolean() });

export function parseParentSettings(value: unknown): ParentSettings {
  const parsed = stored.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_PARENT_SETTINGS };
}

export async function getParentSettings(tx?: Tx): Promise<ParentSettings> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, PARENTS_KEY));
  return parseParentSettings(row?.value);
}

/** Writes the setting. The caller audits (`settings.parents.save`) in the same transaction. */
export async function putParentSettings(tx: Tx, next: ParentSettings): Promise<void> {
  const value = stored.parse(next);
  await tx.insert(setting).values({ key: PARENTS_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
}

/** The door is closed only when sign-ins were on and an Admin switched them off (or a company change did). */
export const parentDoorClosed = (s: ParentSettings): boolean => s.everEnabled && !s.signin;
```

`tests/helpers/db.ts`: add `"held_address", "family_match"` to `TABLES`, and let `seedGuardian` take `sourceQboId?: string | null` and `seedParent` take `welcomedAt?: Date | null; welcomeOwed?: boolean` (pass them through to the inserts, defaulting to `null`, `null`, `false`).

- [ ] **Step 5: Run the tests and the checks**

Run: `pnpm db:migrate` (with the test `DATABASE_URL` from `vitest.config.mts`), then
`pnpm vitest run tests/unit/parents-settings.test.ts tests/integration/parents-schema.test.ts tests/integration/schema.test.ts tests/unit/permissions`
Expected: PASS. Fix any test that lists the permissions or the tables by adding the new names; change nothing else in them.
Run: `pnpm typecheck && pnpm lint`. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(parents): schema, permissions and the setting for sign-ins from QuickBooks"
```

---

### Task 2: The rules

**Files:**
- Create: `src/lib/parents/emails.ts`, `src/lib/parents/access-rules.ts`
- Test: `tests/unit/parents-emails.test.ts`, `tests/unit/parents-access-rules.test.ts`

**Interfaces:**
- Consumes: `Roster`, `Family`, `Cust` from `src/lib/roster/model.ts`; `MembershipShape` from `src/lib/roster/shape.ts`; `normalizeEmail(raw: string): string | null` from `src/lib/setup/state.ts`.
- Produces:

```ts
export function parseEmailField(raw: string | null): { usable: string[]; unusable: string[] };

export type HoldSets = { approved: string[]; rejected: string[] };
export type DenyReason = "inactive" | "family_inactive" | "no_email" | "held" | "no_active_students";
export type Grant = { email: string; familyQboId: string; sourceQboId: string; name: string };
export type Denial = { sourceQboId: string; familyQboId: string; name: string; email: string | null; reason: DenyReason };
export type HeldAddress = { email: string; families: { qboId: string; name: string; held: boolean }[]; names: string[]; pending: boolean };
export type AccessFlagRule = "no_email" | "bad_email" | "many_addresses" | "held_address" | "name_differs" | "family_no_signin";
export type AccessFlag = { rule: AccessFlagRule; qboId: string | null; name: string; detail: string };
export type AccessDecision = { grants: Grant[]; denials: Denial[]; held: HeldAddress[]; flags: AccessFlag[]; personNames: Map<string, string> };
export function decideAccess(i: { roster: Roster; shape: MembershipShape; holds: Map<string, HoldSets>; requireActiveStudents: boolean }): AccessDecision;
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/parents-emails.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseEmailField } from "@/lib/parents/emails";

describe("parseEmailField", () => {
  it.each([
    [null, [], []],
    ["", [], []],
    ["   ", [], []],
    ["ana@example.com", ["ana@example.com"], []],
    ["  Ana@Example.COM ", ["ana@example.com"], []],
    ["ana@example.com, leo@example.com", ["ana@example.com", "leo@example.com"], []],
    ["ana@example.com;leo@example.com", ["ana@example.com", "leo@example.com"], []],
    ["ana@example.com ; leo@example.com,", ["ana@example.com", "leo@example.com"], []],
    ["ana@example.com leo@example.com", ["ana@example.com", "leo@example.com"], []],
    ["ana@example.com, ANA@example.com", ["ana@example.com"], []],
    ["not an address", [], ["not", "an", "address"]],
    ["ana@example.com, nope", ["ana@example.com"], ["nope"]],
    ["Ana <ana@example.com>", [], ["ana", "<ana@example.com>"]],
  ])("%j", (raw, usable, unusable) => {
    expect(parseEmailField(raw)).toEqual({ usable, unusable });
  });

  it("does not throw on a very long field, and keeps no unusable piece longer than 80 characters", () => {
    const r = parseEmailField(`${"x".repeat(5000)}, ana@example.com`);
    expect(r.usable).toEqual(["ana@example.com"]);
    expect(r.unusable).toEqual(["x".repeat(80)]);
  });
});
```

`tests/unit/parents-access-rules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildRoster, type Cust } from "@/lib/roster/model";
import type { MembershipShape } from "@/lib/roster/shape";
import { decideAccess, type HoldSets } from "@/lib/parents/access-rules";

const LAYERED: MembershipShape = { kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" };
const NO_PARENT: MembershipShape = { kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null };
const NO_STUDENT: MembershipShape = { kind: "layered", familyTypeId: "F", studentTypeId: null, parentTypeId: "P" };
const FLAT: MembershipShape = { kind: "flat", memberTypeIds: ["M"] };

const c = (qboId: string, displayName: string, typeQboId: string, o: Partial<Cust> = {}): Cust =>
  ({ qboId, displayName, active: true, parentQboId: null, typeQboId, email: null, phone: null, ...o });
const fam = (id: string, name: string, o: Partial<Cust> = {}) => c(id, name, "F", o);
const par = (id: string, name: string, family: string, email: string | null, o: Partial<Cust> = {}) => c(id, name, "P", { parentQboId: family, email, ...o });
const stu = (id: string, name: string, family: string, o: Partial<Cust> = {}) => c(id, name, "S", { parentQboId: family, ...o });

const decide = (shape: MembershipShape, customers: Cust[], o: { holds?: Record<string, HoldSets>; requireActiveStudents?: boolean } = {}) =>
  decideAccess({ roster: buildRoster(shape, customers), shape, holds: new Map(Object.entries(o.holds ?? {})), requireActiveStudents: o.requireActiveStudents ?? false });
const grants = (d: ReturnType<typeof decide>) => d.grants.map((g) => `${g.email}>${g.familyQboId}`).sort();
const denied = (d: ReturnType<typeof decide>) => d.denials.map((x) => `${x.sourceQboId}:${x.reason}`).sort();
const rules = (d: ReturnType<typeof decide>) => d.flags.map((f) => `${f.rule}:${f.qboId}`).sort();

describe("decideAccess, layered with a parent type", () => {
  it("gives each active parent with an address access to the family it sits under", () => {
    const d = decide(LAYERED, [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), par("12", "Leo Rivera", "10", "leo@example.com"), stu("13", "Kid", "10")]);
    expect(d.grants).toEqual([
      { email: "ana@example.com", familyQboId: "10", sourceQboId: "11", name: "Ana Rivera" },
      { email: "leo@example.com", familyQboId: "10", sourceQboId: "12", name: "Leo Rivera" },
    ]);
    expect(d.denials).toEqual([]); expect(d.held).toEqual([]); expect(d.flags).toEqual([]);
  });

  it("never grants through the family customer's own address", () => {
    const d = decide(LAYERED, [fam("10", "Rivera Family", { email: "family@example.com" })]);
    expect(d.grants).toEqual([]);
    expect(rules(d)).toEqual(["family_no_signin:10"]);
  });

  it.each([
    ["an inactive parent", [fam("10", "R"), par("11", "Ana", "10", "ana@example.com", { active: false })], ["11:inactive"]],
    ["an inactive family", [fam("10", "R", { active: false }), par("11", "Ana", "10", "ana@example.com")], ["11:family_inactive"]],
    ["no address", [fam("10", "R"), par("11", "Ana", "10", null)], ["11:no_email"]],
    ["an unusable address", [fam("10", "R"), par("11", "Ana", "10", "call the office")], ["11:no_email"]],
  ])("refuses %s", (_label, customers, want) => {
    const d = decide(LAYERED, customers as Cust[]);
    expect(grants(d)).toEqual([]);
    expect(denied(d)).toEqual(want);
  });

  it("flags an unusable address, and a family nobody can sign in to, but not an inactive family", () => {
    expect(rules(decide(LAYERED, [fam("10", "R"), par("11", "Ana", "10", "call the office")]))).toEqual(["bad_email:11", "family_no_signin:10"]);
    expect(rules(decide(LAYERED, [fam("10", "R", { active: false }), par("11", "Ana", "10", "ana@example.com")]))).toEqual([]);
  });

  it("uses the first address on a parent record and flags the rest", () => {
    const d = decide(LAYERED, [fam("10", "R"), par("11", "Ana", "10", "ana@example.com, leo@example.com")]);
    expect(grants(d)).toEqual(["ana@example.com>10"]);
    expect(rules(d)).toEqual(["many_addresses:11"]);
  });

  it("gives one sign-in when two parents in one family share an address, from the lower QuickBooks ID", () => {
    const d = decide(LAYERED, [fam("10", "R"), par("100", "Leo Rivera", "10", "shared@example.com"), par("9", "Ana Rivera", "10", "shared@example.com")]);
    expect(d.grants).toEqual([{ email: "shared@example.com", familyQboId: "10", sourceQboId: "9", name: "Ana Rivera" }]);
    expect(d.held).toEqual([]);
    expect(rules(d)).toEqual(["name_differs:9"]);
  });

  it("holds an address that is under two families, for both, until staff approve it", () => {
    const customers = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), fam("20", "Chen Family"), par("21", "Ana R.", "20", " ANA@example.com ")];
    const d = decide(LAYERED, customers);
    expect(grants(d)).toEqual([]);
    expect(denied(d)).toEqual(["11:held", "21:held"]);
    expect(d.held).toEqual([{ email: "ana@example.com", pending: true, names: ["Ana Rivera", "Ana R."],
      families: [{ qboId: "10", name: "Rivera Family", held: true }, { qboId: "20", name: "Chen Family", held: true }] }]);
    expect(rules(d)).toEqual(["family_no_signin:10", "family_no_signin:20", "held_address:null", "name_differs:11"]);

    const approved = decide(LAYERED, customers, { holds: { "ana@example.com": { approved: ["10", "20"], rejected: [] } } });
    expect(grants(approved)).toEqual(["ana@example.com>10", "ana@example.com>20"]);
    expect(approved.held).toEqual([]);
    expect(approved.personNames.get("ana@example.com")).toBe("Ana Rivera");
  });

  it("holds only the new family when an approved address turns up under a third", () => {
    const customers = [fam("10", "A"), par("11", "Ana", "10", "ana@example.com"), fam("20", "B"), par("21", "Ana", "20", "ana@example.com"), fam("30", "C"), par("31", "Ana", "30", "ana@example.com")];
    const d = decide(LAYERED, customers, { holds: { "ana@example.com": { approved: ["10", "20"], rejected: [] } } });
    expect(grants(d)).toEqual(["ana@example.com>10", "ana@example.com>20"]);
    expect(denied(d)).toEqual(["31:held"]);
    expect(d.held[0]).toMatchObject({ pending: true, families: [{ qboId: "10", held: false }, { qboId: "20", held: false }, { qboId: "30", held: true }] });
  });

  it("keeps a rejected address held, and no longer waiting, until another family appears", () => {
    const customers = [fam("10", "A"), par("11", "Ana", "10", "ana@example.com"), fam("20", "B"), par("21", "Ana", "20", "ana@example.com")];
    const rejected = { "ana@example.com": { approved: [], rejected: ["10", "20"] } };
    expect(decide(LAYERED, customers, { holds: rejected }).held[0]).toMatchObject({ pending: false });
    expect(grants(decide(LAYERED, customers, { holds: rejected }))).toEqual([]);
    const more = [...customers, fam("30", "C"), par("31", "Ana", "30", "ana@example.com")];
    expect(decide(LAYERED, more, { holds: rejected }).held[0]).toMatchObject({ pending: true });
  });

  it("stops holding when the address is back under one family", () => {
    const d = decide(LAYERED, [fam("10", "A"), par("11", "Ana", "10", "ana@example.com"), fam("20", "B"), par("21", "Ana", "20", "ana@example.com", { active: false })]);
    expect(grants(d)).toEqual(["ana@example.com>10"]);
    expect(d.held).toEqual([]);
  });

  it("applies the active-students setting only when it is on", () => {
    const customers = [fam("10", "A"), par("11", "Ana", "10", "ana@example.com"), stu("12", "Kid", "10", { active: false }), fam("20", "B"), par("21", "Bo", "20", "bo@example.com"), stu("22", "Kid", "20")];
    expect(grants(decide(LAYERED, customers))).toEqual(["ana@example.com>10", "bo@example.com>20"]);
    const on = decide(LAYERED, customers, { requireActiveStudents: true });
    expect(grants(on)).toEqual(["bo@example.com>20"]);
    expect(denied(on)).toEqual(["11:no_active_students"]);
  });

  it("ignores the active-students setting when the shape names no student type", () => {
    const d = decide(NO_STUDENT, [fam("10", "A"), par("11", "Ana", "10", "ana@example.com")], { requireActiveStudents: true });
    expect(grants(d)).toEqual(["ana@example.com>10"]);
  });
});

describe("decideAccess, other shapes", () => {
  it("layered with no parent type: every address on the family customer signs in to that family", () => {
    const d = decide(NO_PARENT, [fam("10", "Rivera Family", { email: "ana@example.com; leo@example.com" }), fam("20", "Chen Family")]);
    expect(d.grants).toEqual([
      { email: "ana@example.com", familyQboId: "10", sourceQboId: "10", name: "Rivera Family" },
      { email: "leo@example.com", familyQboId: "10", sourceQboId: "10", name: "Rivera Family" },
    ]);
    expect(denied(d)).toEqual(["20:no_email"]);
    expect(rules(d)).toEqual(["family_no_signin:20", "no_email:20"]);
  });

  it("flat: each member signs in to their own record, by their first address", () => {
    const d = decide(FLAT, [c("5", "Ana Rivera", "M", { email: "ana@example.com" }), c("6", "Old Member", "M", { email: "old@example.com", active: false }), c("7", "Vendor", "V", { email: "v@example.com" })]);
    expect(d.grants).toEqual([{ email: "ana@example.com", familyQboId: "5", sourceQboId: "5", name: "Ana Rivera" }]);
    expect(denied(d)).toEqual(["6:inactive"]);
  });

  it("flat: one address on two members is held like any repeat across families", () => {
    const d = decide(FLAT, [c("5", "Ana", "M", { email: "ana@example.com" }), c("6", "Ana Two", "M", { email: "ana@example.com" })]);
    expect(grants(d)).toEqual([]);
    expect(d.held).toHaveLength(1);
  });
});

describe("decideAccess is pure and steady", () => {
  it("returns the same answer for the same input, in a fixed order, without changing its input", () => {
    const customers = [fam("20", "B"), par("21", "Bo", "20", "bo@example.com"), fam("10", "A"), par("11", "Ana", "10", "ana@example.com")];
    const frozen = JSON.stringify(customers);
    const a = decide(LAYERED, customers), b = decide(LAYERED, [...customers].reverse());
    expect(a.grants).toEqual(b.grants);
    expect(a.grants.map((g) => g.familyQboId)).toEqual(["10", "20"]);
    expect(JSON.stringify(customers)).toBe(frozen);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tests/unit/parents-emails.test.ts tests/unit/parents-access-rules.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write `src/lib/parents/emails.ts`**

```ts
import { normalizeEmail } from "@/lib/setup/state";

/**
 * Splits a QuickBooks email field into addresses (spec §1 Candidates). People type several addresses into one field,
 * separated by commas, semicolons or spaces. Each piece is trimmed and lower-cased; one that isn't a valid address is
 * unusable. Never throws; an unusable piece is cut to 80 characters so a pasted paragraph can't fill a page.
 */
export function parseEmailField(raw: string | null): { usable: string[]; unusable: string[] } {
  const usable: string[] = [], unusable: string[] = [];
  for (const piece of (raw ?? "").split(/[\s,;]+/)) {
    if (!piece) continue;
    const email = normalizeEmail(piece);
    if (email) { if (!usable.includes(email)) usable.push(email); }
    else { const kept = piece.toLowerCase().slice(0, 80); if (!unusable.includes(kept)) unusable.push(kept); }
  }
  return { usable, unusable };
}
```

- [ ] **Step 4: Write `src/lib/parents/access-rules.ts`**

```ts
import type { MembershipShape } from "@/lib/roster/shape";
import type { Roster } from "@/lib/roster/model";
import { parseEmailField } from "./emails";

export type HoldSets = { approved: string[]; rejected: string[] };
export type DenyReason = "inactive" | "family_inactive" | "no_email" | "held" | "no_active_students";
export type Grant = { email: string; familyQboId: string; sourceQboId: string; name: string };
export type Denial = { sourceQboId: string; familyQboId: string; name: string; email: string | null; reason: DenyReason };
export type HeldAddress = { email: string; families: { qboId: string; name: string; held: boolean }[]; names: string[]; pending: boolean };
export type AccessFlagRule = "no_email" | "bad_email" | "many_addresses" | "held_address" | "name_differs" | "family_no_signin";
export type AccessFlag = { rule: AccessFlagRule; qboId: string | null; name: string; detail: string };
export type AccessDecision = { grants: Grant[]; denials: Denial[]; held: HeldAddress[]; flags: AccessFlag[]; personNames: Map<string, string> };

/** A QuickBooks customer whose email field can become sign-ins (spec §1 Candidates). */
type Candidate = {
  sourceQboId: string; familyQboId: string; familyName: string; name: string; field: string | null;
  active: boolean; familyActive: boolean; hasActiveStudent: boolean | null; everyAddress: boolean; flagNoEmail: boolean;
};
type Claim = { email: string; familyQboId: string; familyName: string; sourceQboId: string; name: string };

const byId = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

function candidates(roster: Roster, shape: MembershipShape): { list: Candidate[]; families: { qboId: string; name: string; active: boolean }[] } {
  if (roster.kind === "flat") {
    return {
      list: roster.members.map((m) => ({ sourceQboId: m.qboId, familyQboId: m.qboId, familyName: m.displayName, name: m.displayName, field: m.email,
        // A flat member is its own "family": only its own Active flag counts, and it is reported as `inactive`.
        active: m.active, familyActive: true, hasActiveStudent: null, everyAddress: false, flagNoEmail: false })),
      families: roster.members.map((m) => ({ qboId: m.qboId, name: m.displayName, active: m.active })),
    };
  }
  const withParents = shape.kind === "layered" && shape.parentTypeId !== null;
  const withStudents = shape.kind === "layered" && shape.studentTypeId !== null;
  const list: Candidate[] = [];
  for (const f of roster.families) {
    const base = { familyQboId: f.customer.qboId, familyName: f.customer.displayName, familyActive: f.customer.active,
      hasActiveStudent: withStudents ? f.students.some((s) => s.active) : null };
    if (withParents) for (const p of f.parents) list.push({ ...base, sourceQboId: p.qboId, name: p.displayName, field: p.email, active: p.active, everyAddress: false, flagNoEmail: false });
    // No parent type: the family customer's own addresses are all there is, so each one counts (spec §1).
    else list.push({ ...base, sourceQboId: f.customer.qboId, name: f.customer.displayName, field: f.customer.email, active: f.customer.active, everyAddress: true, flagNoEmail: true });
  }
  return { list, families: roster.families.map((f) => ({ qboId: f.customer.qboId, name: f.customer.displayName, active: f.customer.active })) };
}

/**
 * Who has access to which family (spec §1). Pure: it reads nothing and changes nothing, so the clean-up preview and the
 * reconcile always agree. Whether sign-ins are switched on, and whether a person is blocked, are checked elsewhere.
 * Missing addresses on parents and members are already flagged by the roster's own rules (`needsAttention`), so
 * `no_email` is flagged here only for a family customer that is itself the candidate.
 */
export function decideAccess(i: { roster: Roster; shape: MembershipShape; holds: Map<string, HoldSets>; requireActiveStudents: boolean }): AccessDecision {
  const { list, families } = candidates(i.roster, i.shape);
  const denials: Denial[] = [], flags: AccessFlag[] = [], claims: Claim[] = [];

  for (const c of [...list].sort((a, b) => byId(a.sourceQboId, b.sourceQboId))) {
    const deny = (reason: DenyReason, email: string | null = null) => denials.push({ sourceQboId: c.sourceQboId, familyQboId: c.familyQboId, name: c.name, email, reason });
    if (!c.familyActive) { deny("family_inactive"); continue; }
    if (!c.active) { deny("inactive"); continue; }
    const { usable, unusable } = parseEmailField(c.field);
    if (unusable.length) flags.push({ rule: "bad_email", qboId: c.sourceQboId, name: c.name, detail: "The email field in QuickBooks holds something that isn't an email address. Correct it in QuickBooks." });
    if (!c.everyAddress && usable.length > 1) {
      flags.push({ rule: "many_addresses", qboId: c.sourceQboId, name: c.name, detail: "This record has more than one email address in QuickBooks. The portal uses the first. Keep one address on a person's own record." });
    }
    if (!usable.length) {
      if (c.flagNoEmail && !unusable.length) flags.push({ rule: "no_email", qboId: c.sourceQboId, name: c.name, detail: "This family has no email address in QuickBooks, so nobody can sign in for it." });
      deny("no_email"); continue;
    }
    if (i.requireActiveStudents && c.hasActiveStudent === false) { deny("no_active_students", usable[0]!); continue; }
    for (const email of c.everyAddress ? usable : usable.slice(0, 1)) claims.push({ email, familyQboId: c.familyQboId, familyName: c.familyName, sourceQboId: c.sourceQboId, name: c.name });
  }

  // One sign-in per address per family: the claim from the lowest QuickBooks ID stands (claims are already in ID order).
  const kept: Claim[] = [];
  const allNames = new Map<string, string[]>();
  for (const cl of claims) {
    const names = allNames.get(cl.email) ?? [];
    if (!names.includes(cl.name)) names.push(cl.name);
    allNames.set(cl.email, names);
    if (!kept.some((k) => k.email === cl.email && k.familyQboId === cl.familyQboId)) kept.push(cl);
  }

  const grants: Grant[] = [], held: HeldAddress[] = [], personNames = new Map<string, string>();
  const byEmail = new Map<string, Claim[]>();
  for (const k of kept) byEmail.set(k.email, [...(byEmail.get(k.email) ?? []), k]);
  for (const [email, mine] of byEmail) {
    const names = allNames.get(email)!;
    personNames.set(email, names[0]!);
    if (new Set(names.map((n) => n.trim().toLowerCase())).size > 1) {
      flags.push({ rule: "name_differs", qboId: mine[0]!.sourceQboId, name: names[0]!, detail: `The address ${email} is on records with different names in QuickBooks. The portal shows the first.` });
    }
    const sets = i.holds.get(email) ?? { approved: [], rejected: [] };
    const heldHere = mine.length > 1 ? mine.filter((m) => !sets.approved.includes(m.familyQboId)) : [];
    for (const m of mine) {
      if (heldHere.includes(m)) denials.push({ sourceQboId: m.sourceQboId, familyQboId: m.familyQboId, name: m.name, email, reason: "held" });
      else grants.push({ email, familyQboId: m.familyQboId, sourceQboId: m.sourceQboId, name: m.name });
    }
    if (heldHere.length) {
      held.push({ email, names, pending: !heldHere.every((m) => sets.rejected.includes(m.familyQboId)),
        families: mine.map((m) => ({ qboId: m.familyQboId, name: m.familyName, held: heldHere.includes(m) })) });
      flags.push({ rule: "held_address", qboId: null, name: names[0]!, detail: "This person's email address is under more than one family in QuickBooks, so it is held until someone with access to Parents reviews it." });
    }
  }

  const reached = new Set(grants.map((g) => g.familyQboId));
  for (const f of families) {
    if (f.active && !reached.has(f.qboId)) flags.push({ rule: "family_no_signin", qboId: f.qboId, name: f.name, detail: "Nobody can sign in to the portal for this one yet." });
  }

  const order = (a: { familyQboId: string; sourceQboId: string; email?: string | null }, b: typeof a) =>
    byId(a.familyQboId, b.familyQboId) || byId(a.sourceQboId, b.sourceQboId) || (a.email ?? "").localeCompare(b.email ?? "");
  grants.sort(order); denials.sort(order);
  held.sort((a, b) => a.email.localeCompare(b.email));
  flags.sort((a, b) => a.rule.localeCompare(b.rule) || byId(a.qboId ?? "", b.qboId ?? "") || a.name.localeCompare(b.name));
  return { grants, denials, held, flags, personNames };
}
```

The `held_address` flag deliberately names no family and no address: it is shown on the roster to staff who may hold only `Roster.Read`.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/unit/parents-emails.test.ts tests/unit/parents-access-rules.test.ts`
Expected: PASS. If an expectation about ordering fails, fix the sort in the code so the test's order holds; do not reorder the expectations.
Run: `pnpm typecheck && pnpm lint`. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(parents): the rules for who can sign in to which family"
```

---
### Task 3: The reconcile step

**Files:**
- Create: `src/lib/parents/reconcile.ts`
- Modify: `src/lib/parents/sessions.ts` (add `endFamilySessions`)
- Modify: `src/lib/roster/refresh.ts` (run the reconcile inside the cache swap)
- Create: `tests/helpers/roster-cache.ts`
- Test: `tests/integration/parents-reconcile.test.ts`, `tests/integration/parents-reconcile-refresh.test.ts`

**Interfaces:**
- Consumes: `decideAccess`, `AccessDecision`, `HoldSets` (Task 2); `getParentSettings`, `ParentSettings` (Task 1); `getShape`, `missingTypes`, `ROSTER_LOCK` (`src/lib/roster/shape.ts`); `buildRoster`, `Cust`, `Roster` (`src/lib/roster/model.ts`); `endParentSessions`, `deleteUnusedSigninCodes` (`src/lib/parents/sessions.ts`).
- Produces:

```ts
export const RECONCILE_ACTOR: Actor;                       // { door: "system", id: null, label: "reconcile" }
export class ReconcileFailed extends Error {}
export type ReconcileResult = { ran: boolean; granted: number; ended: number; emailChanged: number; welcomeOwed: number };
export type Loaded = { decision: AccessDecision; settings: ParentSettings; shape: MembershipShape; roster: Roster };
export async function loadDecision(tx?: Tx, o?: { requireActiveStudents?: boolean }): Promise<Loaded | null>;   // null: no shape, or a broken one
export async function reconcileAccess(tx: Tx, o: { cause: string }): Promise<ReconcileResult>;                  // caller holds ROSTER_LOCK
export async function runReconcile(o: { cause: string }): Promise<ReconcileResult>;                             // own transaction + lock
// sessions.ts
export async function endFamilySessions(parentId: string, familyQboId: string, tx?: Tx): Promise<number>;
// tests/helpers/roster-cache.ts
export async function seedCache(customers: CacheCustomer[], types?: { qboId: string; name: string }[]): Promise<void>;   // replaces the cache
export async function seedShape(shape: MembershipShape): Promise<void>;
export async function seedParentSettings(patch: Partial<ParentSettings>): Promise<void>;
export const P_SHAPE: MembershipShape;      // layered: family "F", student "S", parent "P"
export const fam, par, stu;                 // row builders, as in tests/unit/parents-access-rules.test.ts
```

- [ ] **Step 1: Write the test helper**

`tests/helpers/roster-cache.ts`:

```ts
import { db } from "@/lib/db/client";
import { qboCustomer, qboCustomerType, setting } from "@/lib/db/schema";
import { SHAPE_KEY, type MembershipShape } from "@/lib/roster/shape";
import { DEFAULT_PARENT_SETTINGS, PARENTS_KEY, getParentSettings, type ParentSettings } from "@/lib/parents/settings";

export type CacheCustomer = { qboId: string; displayName: string; typeQboId: string; active?: boolean; parentQboId?: string | null; email?: string | null; phone?: string | null };
export const P_SHAPE: MembershipShape = { kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" };
export const P_TYPES = [{ qboId: "F", name: "Family" }, { qboId: "S", name: "Student" }, { qboId: "P", name: "Parent" }, { qboId: "M", name: "Member" }];

export const fam = (qboId: string, displayName: string, o: Partial<CacheCustomer> = {}): CacheCustomer => ({ qboId, displayName, typeQboId: "F", ...o });
export const par = (qboId: string, displayName: string, family: string, email: string | null, o: Partial<CacheCustomer> = {}): CacheCustomer =>
  ({ qboId, displayName, typeQboId: "P", parentQboId: family, email, ...o });
export const stu = (qboId: string, displayName: string, family: string, o: Partial<CacheCustomer> = {}): CacheCustomer => ({ qboId, displayName, typeQboId: "S", parentQboId: family, ...o });

/** Replaces the roster cache with these rows, as a refresh would have left it. */
export async function seedCache(customers: CacheCustomer[], types = P_TYPES): Promise<void> {
  await db.delete(qboCustomer); await db.delete(qboCustomerType);
  await db.insert(qboCustomerType).values(types.map((t) => ({ ...t, active: true })));
  if (customers.length) await db.insert(qboCustomer).values(customers.map((c) => ({
    qboId: c.qboId, displayName: c.displayName, active: c.active ?? true, parentQboId: c.parentQboId ?? null, typeQboId: c.typeQboId,
    email: c.email ?? null, phone: c.phone ?? null, syncToken: "0" })));
}

export async function seedShape(shape: MembershipShape = P_SHAPE): Promise<void> {
  await db.insert(setting).values({ key: SHAPE_KEY, value: shape }).onConflictDoUpdate({ target: setting.key, set: { value: shape } });
}

export async function seedParentSettings(patch: Partial<ParentSettings>): Promise<void> {
  const value = { ...DEFAULT_PARENT_SETTINGS, ...(await getParentSettings()), ...patch };
  await db.insert(setting).values({ key: PARENTS_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
}
export const SIGNINS_ON = { signin: true, everEnabled: true } as const;
```

- [ ] **Step 2: Write the failing tests**

`tests/integration/parents-reconcile.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, heldAddress, parent, parentAuthSession, parentAuthUser, signinCode } from "@/lib/db/schema";
import { runReconcile } from "@/lib/parents/reconcile";
import { resetDb, seedParent, seedGuardian, seedParentSession } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par, stu, P_SHAPE } from "../helpers/roster-cache";

const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const links = async () => (await db.select({ g: guardian, p: parent }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId)))
  .map((r) => ({ email: r.p.email, family: r.g.familyQboId, source: r.g.sourceQboId, status: r.g.status, reason: r.g.disabledReason }))
  .sort((a, b) => `${a.family}${a.email}`.localeCompare(`${b.family}${b.email}`));
const run = () => runReconcile({ cause: "test" });
const RIVERA = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10")];

describe("the reconcile", () => {
  beforeEach(async () => { await resetDb(); await seedShape(); });

  it("changes nothing while parent sign-ins have never been switched on", async () => {
    await seedCache(RIVERA);
    const seeded = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: seeded.id, familyQboId: "POC-FAMILY-1" });
    expect(await run()).toEqual({ ran: false, granted: 0, ended: 0, emailChanged: 0, welcomeOwed: 0 });
    expect(await links()).toEqual([{ email: "seeded@example.com", family: "POC-FAMILY-1", source: null, status: "active", reason: null }]);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("changes nothing when there is no shape, or the shape names a type QuickBooks no longer has", async () => {
    await seedParentSettings(SIGNINS_ON);
    await seedCache(RIVERA, [{ qboId: "F", name: "Family" }]);           // "P" and "S" are gone
    expect((await run()).ran).toBe(false);
    expect(await links()).toEqual([]);
  });

  it("makes a person, their sign-in account and an invited link, audited with the cause", async () => {
    await seedParentSettings(SIGNINS_ON); await seedCache(RIVERA);
    expect(await run()).toEqual({ ran: true, granted: 1, ended: 0, emailChanged: 0, welcomeOwed: 0 });
    expect(await links()).toEqual([{ email: "ana@example.com", family: "10", source: "11", status: "invited", reason: null }]);
    const [p] = await db.select().from(parent);
    expect(p).toMatchObject({ name: "Ana Rivera", email: "ana@example.com", welcomeOwed: false });
    expect(await db.select().from(parentAuthUser)).toEqual([expect.objectContaining({ parentId: p!.id, email: "ana@example.com", emailVerified: true })]);
    const [row] = await audits("parent.access.granted");
    expect(row).toMatchObject({ door: "system", actorLabel: "reconcile", targetType: "guardian" });
    expect(row!.after).toMatchObject({ familyQboId: "10", sourceQboId: "11", cause: "test" });
  });

  it("changes nothing the second time", async () => {
    await seedParentSettings(SIGNINS_ON); await seedCache(RIVERA);
    await run();
    const before = (await db.select().from(auditLog)).length;
    expect(await run()).toEqual({ ran: true, granted: 0, ended: 0, emailChanged: 0, welcomeOwed: 0 });
    expect((await db.select().from(auditLog)).length).toBe(before);
  });

  it("marks a welcome as owed only when welcomes are on and the person has never been welcomed", async () => {
    await seedParentSettings({ ...SIGNINS_ON, welcome: true });
    await seedParent({ name: "Old Hand", email: "old@example.com", welcomedAt: new Date("2026-01-01T00:00:00Z") });
    await seedCache([...RIVERA, par("13", "Old Hand", "10", "old@example.com")]);
    expect((await run()).welcomeOwed).toBe(1);
    const owed = Object.fromEntries((await db.select().from(parent)).map((p) => [p.email, p.welcomeOwed]));
    expect(owed).toEqual({ "ana@example.com": true, "old@example.com": false });
  });

  it("closes a hand-seeded link QuickBooks doesn't back, and takes over one it does", async () => {
    await seedParentSettings(SIGNINS_ON); await seedCache(RIVERA);
    const stray = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: stray.id, familyQboId: "POC-FAMILY-1" });
    const ana = await seedParent({ name: "Ana R", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10" });
    expect(await run()).toMatchObject({ granted: 0, ended: 1 });
    expect(await links()).toEqual([
      { email: "ana@example.com", family: "10", source: "11", status: "active", reason: null },
      { email: "seeded@example.com", family: "POC-FAMILY-1", source: null, status: "disabled", reason: "not_in_quickbooks" },
    ]);
    expect((await db.select().from(parent).where(eq(parent.id, ana.id)))[0]!.name).toBe("Ana Rivera");
    expect(await audits("parent.name.changed")).toHaveLength(1);
  });

  it("ends the session for a closed family at once and leaves the person's other family alone, then reopens it as it was", async () => {
    await seedParentSettings(SIGNINS_ON);
    const both = [...RIVERA, fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")];
    await seedCache(both);
    await db.insert(heldAddress).values({ email: "ana@example.com", approvedFamilyQboIds: ["10", "20"] });
    await run();
    await db.update(guardian).set({ status: "active" });
    const [u] = await db.select().from(parentAuthUser);
    const inTen = await seedParentSession(u!.id, { familyQboId: "10" }), inTwenty = await seedParentSession(u!.id, { familyQboId: "20" });

    await seedCache(both.map((c) => (c.qboId === "11" ? { ...c, active: false } : c)));
    expect(await run()).toMatchObject({ ended: 1 });
    expect((await db.select().from(parentAuthSession)).map((s) => s.id)).toEqual([inTwenty.id]);
    expect(inTen.id).not.toBe(inTwenty.id);
    expect((await links()).find((l) => l.family === "10")).toMatchObject({ status: "disabled", reason: "inactive" });
    expect((await audits("parent.access.ended"))[0]!.after).toMatchObject({ familyQboId: "10", reason: "inactive", sessionsEnded: 1 });

    await seedCache(both);
    expect(await run()).toMatchObject({ granted: 1 });
    expect((await links()).find((l) => l.family === "10")).toMatchObject({ status: "active", reason: null });
  });

  it("ends every session when a person's last link closes", async () => {
    await seedParentSettings(SIGNINS_ON); await seedCache(RIVERA); await run();
    const [u] = await db.select().from(parentAuthUser);
    await seedParentSession(u!.id, { familyQboId: null });
    await seedCache([fam("10", "Rivera Family", { active: false }), par("11", "Ana Rivera", "10", "ana@example.com")]);
    await run();
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect((await links())[0]).toMatchObject({ status: "disabled", reason: "family_inactive" });
  });

  it("changes a person's address in place when the QuickBooks record's address changes", async () => {
    await seedParentSettings({ ...SIGNINS_ON, welcome: true }); await seedCache(RIVERA); await run();
    const [before] = await db.select().from(parent);
    await db.update(parent).set({ welcomedAt: new Date(), welcomeOwed: false });
    await db.insert(signinCode).values({ parentId: before!.id, codeHash: "x", expiresAt: new Date(Date.now() + 60_000) });
    await seedCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana.new@example.com")]);
    expect(await run()).toEqual({ ran: true, granted: 0, ended: 0, emailChanged: 1, welcomeOwed: 0 });
    const people = await db.select().from(parent);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ id: before!.id, email: "ana.new@example.com", welcomeOwed: false });
    expect((await db.select().from(parentAuthUser))[0]!.email).toBe("ana.new@example.com");
    expect(await db.select().from(signinCode)).toEqual([]);
    const [row] = await audits("parent.email.changed");
    expect(row).toMatchObject({ targetType: "parent", targetId: before!.id, before: { email: "ana@example.com" } });
    expect(row!.after).toMatchObject({ email: "ana.new@example.com", cause: "test" });
  });

  it("moves the link when the new address already belongs to someone else", async () => {
    await seedParentSettings(SIGNINS_ON);
    await seedCache([...RIVERA, fam("20", "Chen Family"), par("21", "Mei Chen", "20", "mei@example.com")]); await run();
    await seedCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "mei@example.com"), fam("20", "Chen Family"), par("21", "Mei Chen", "20", "mei@example.com")]);
    await db.insert(heldAddress).values({ email: "mei@example.com", approvedFamilyQboIds: ["10", "20"] });
    await run();
    expect(await links()).toEqual([
      { email: "ana@example.com", family: "10", source: null, status: "disabled", reason: "address_changed" },
      { email: "mei@example.com", family: "10", source: "11", status: "invited", reason: null },
      { email: "mei@example.com", family: "20", source: "21", status: "invited", reason: null },
    ]);
    expect(await audits("parent.email.changed")).toEqual([]);
  });

  it("holds an address under two families, keeps a row for it, and opens both once staff approve", async () => {
    await seedParentSettings(SIGNINS_ON);
    await seedCache([...RIVERA, fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")]);
    expect(await run()).toMatchObject({ granted: 0 });
    expect(await links()).toEqual([]);
    expect(await db.select().from(heldAddress)).toEqual([expect.objectContaining({ email: "ana@example.com", approvedFamilyQboIds: [] })]);
    await db.update(heldAddress).set({ approvedFamilyQboIds: ["10", "20"] });
    expect(await run()).toMatchObject({ granted: 2 });
    expect(await db.select().from(parent)).toHaveLength(1);
    expect((await links()).map((l) => l.family)).toEqual(["10", "20"]);
  });

  it("with no parent type, gives each address on the family record its own person, and changes only the one that changed", async () => {
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await seedParentSettings(SIGNINS_ON);
    await seedCache([fam("10", "Rivera Family", { email: "ana@example.com; leo@example.com" })]); await run();
    expect(await links()).toEqual([
      { email: "ana@example.com", family: "10", source: "10", status: "invited", reason: null },
      { email: "leo@example.com", family: "10", source: "10", status: "invited", reason: null },
    ]);
    const leo = (await db.select().from(parent).where(eq(parent.email, "leo@example.com")))[0]!;
    await seedCache([fam("10", "Rivera Family", { email: "ana@example.com; leo.new@example.com" })]);
    expect(await run()).toMatchObject({ emailChanged: 1, ended: 0, granted: 0 });
    expect((await db.select().from(parent).where(eq(parent.id, leo.id)))[0]!.email).toBe("leo.new@example.com");
    expect((await links()).map((l) => l.email)).toEqual(["ana@example.com", "leo.new@example.com"]);
    await seedShape(P_SHAPE);
  });

  it("closes a family's links when the active-students setting is on and it has no active student", async () => {
    await seedParentSettings(SIGNINS_ON); await seedCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo", "10", { active: false })]);
    await run();
    await seedParentSettings({ requireActiveStudents: true });
    expect(await run()).toMatchObject({ ended: 1 });
    expect((await links())[0]).toMatchObject({ status: "disabled", reason: "no_active_students" });
  });
});
```

`tests/integration/parents-reconcile-refresh.test.ts` (start it with the same two `vi.mock` blocks and stub lifecycle as `tests/integration/roster-refresh.test.ts`: the `qboEndpoints` mock and `next/headers`):

```ts
import * as reconcile from "@/lib/parents/reconcile";
// ... the stub block copied from roster-refresh.test.ts, then:
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };

describe("the reconcile inside a roster refresh", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); await seedConnected(stub); await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null }); });
  afterEach(() => vi.restoreAllMocks());

  it("gives the roster's parents access in the same refresh, naming the run", async () => {
    await seedParentSettings(SIGNINS_ON);
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    const [g] = await db.select().from(guardian);
    expect(g).toMatchObject({ familyQboId: "10", sourceQboId: "11", status: "invited" });   // Ana Rivera, the only parent with an address
    const [run] = await db.select().from(jobRun);
    const granted = (await db.select().from(auditLog)).find((r) => r.action === "parent.access.granted");
    expect(granted!.after).toMatchObject({ cause: `roster.refresh#${run!.id}` });
  });

  it("leaves the old roster and every link as they were when the reconcile fails, and records the refresh as failed", async () => {
    await seedParentSettings(SIGNINS_ON);
    await refreshRoster(worker);
    const before = { customers: await db.select().from(qboCustomer), links: await db.select().from(guardian) };
    stub.customers = stub.customers.filter((c: { Id: string }) => c.Id !== "11");            // would close Ana's link
    vi.spyOn(reconcile, "reconcileAccess").mockRejectedValueOnce(new Error("boom: ana@example.com"));
    const r = await refreshRoster(worker);
    expect(r).toEqual({ ok: false, reason: "failed", error: "The parent sign-ins couldn't be brought up to date, so the roster was left as it was. (reconcile_failed)" });
    expect(await db.select().from(qboCustomer)).toEqual(before.customers);
    expect(await db.select().from(guardian)).toEqual(before.links);
    const last = (await db.select().from(jobRun)).sort((a, b) => b.id - a.id)[0]!;
    expect(last).toMatchObject({ outcome: "failed" });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("boom");
    const failed = (await db.select().from(auditLog)).filter((x) => x.action === "roster.refresh.failed").at(-1)!;
    expect(failed.after).toEqual({ code: "reconcile_failed" });
  });
});
```

If `vi.spyOn` on the module namespace does not reach the import inside `refresh.ts` (run the test to find out), have `refresh.ts` import the namespace (`import * as parentReconcile from "@/lib/parents/reconcile"`) and call `parentReconcile.reconcileAccess(...)`, and report it.

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm vitest run tests/integration/parents-reconcile.test.ts tests/integration/parents-reconcile-refresh.test.ts`
Expected: FAIL (`@/lib/parents/reconcile` not found).

- [ ] **Step 4: Add `endFamilySessions` to `src/lib/parents/sessions.ts`**

```ts
/** Ends the person's sessions that are in one family (spec §2 Closing a link). Sessions in their other families carry on. */
export async function endFamilySessions(parentId: string, familyQboId: string, tx?: Tx): Promise<number> {
  const rows = await (tx ?? db).execute<{ id: string }>(sql`DELETE FROM parent_auth_session
    WHERE family_qbo_id = ${familyQboId} AND user_id IN (SELECT id FROM parent_auth_user WHERE parent_id = ${parentId}) RETURNING id`);
  return Array.from(rows as ArrayLike<{ id: string }>).length;
}
```

- [ ] **Step 5: Write `src/lib/parents/reconcile.ts`**

```ts
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, heldAddress, parent, parentAuthUser, qboCustomer, qboCustomerType, type DisabledReason } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getShape, missingTypes, ROSTER_LOCK, type MembershipShape } from "@/lib/roster/shape";
import { buildRoster, type Cust, type Roster } from "@/lib/roster/model";
import { decideAccess, type AccessDecision, type HoldSets } from "./access-rules";
import { getParentSettings, type ParentSettings } from "./settings";
import { deleteUnusedSigninCodes, endFamilySessions, endParentSessions } from "./sessions";

export const RECONCILE_ACTOR: Actor = { door: "system", id: null, label: "reconcile" };
/** Thrown by the roster refresh when the reconcile inside it fails, so the refresh can say which part failed. */
export class ReconcileFailed extends Error {}
export type ReconcileResult = { ran: boolean; granted: number; ended: number; emailChanged: number; welcomeOwed: number };
export type Loaded = { decision: AccessDecision; settings: ParentSettings; shape: MembershipShape; roster: Roster };

/**
 * The rules' answer for the roster as it is cached now. Null when there is nothing safe to decide from: no shape, or a
 * shape naming a type QuickBooks no longer has (which includes an empty cache). `requireActiveStudents` overrides the
 * saved setting, for the preview that shows what switching it on would do.
 */
export async function loadDecision(tx?: Tx, o: { requireActiveStudents?: boolean } = {}): Promise<Loaded | null> {
  const q = tx ?? db;
  const shape = await getShape(tx);
  if (!shape) return null;
  const types = (await q.select().from(qboCustomerType)).map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }));
  if (missingTypes(shape, types).length) return null;
  const settings = await getParentSettings(tx);
  const customers: Cust[] = (await q.select().from(qboCustomer)).map((c) =>
    ({ qboId: c.qboId, displayName: c.displayName, active: c.active, parentQboId: c.parentQboId, typeQboId: c.typeQboId, email: c.email, phone: c.phone }));
  const holds = new Map<string, HoldSets>((await q.select().from(heldAddress)).map((h) => [h.email, { approved: h.approvedFamilyQboIds, rejected: h.rejectedFamilyQboIds }]));
  const roster = buildRoster(shape, customers);
  const requireActiveStudents = (o.requireActiveStudents ?? settings.requireActiveStudents) && shape.kind === "layered" && shape.studentTypeId !== null;
  return { decision: decideAccess({ roster, shape, holds, requireActiveStudents }), settings, shape, roster };
}

/**
 * Brings the stored people and family links in line with the rules (spec §2), applying only the differences. The
 * caller holds ROSTER_LOCK and owns the transaction; nothing here sends mail. While parent sign-ins are off it changes
 * nothing. A link follows its QuickBooks customer (`sourceQboId`): when that customer's address changes, the person's
 * address is changed in place if nobody else has the new one and they have no other link; otherwise the link moves.
 */
export async function reconcileAccess(tx: Tx, o: { cause: string }): Promise<ReconcileResult> {
  const r: ReconcileResult = { ran: false, granted: 0, ended: 0, emailChanged: 0, welcomeOwed: 0 };
  const loaded = await loadDecision(tx);
  if (!loaded || !loaded.settings.signin) return r;
  r.ran = true;
  const { decision, settings } = loaded;
  const audit = (action: string, targetType: string, targetId: string, before: unknown, after: Record<string, unknown>) =>
    writeAudit({ actor: RECONCILE_ACTOR, action, targetType, targetId, before, after: { ...after, cause: o.cause } }, tx);

  for (const h of decision.held) await tx.insert(heldAddress).values({ email: h.email }).onConflictDoNothing();

  // Lock everything this step may change, in a fixed order.
  const links = await tx.select().from(guardian).orderBy(guardian.id).for("update");
  const people = new Map((await tx.select().from(parent).orderBy(parent.id).for("update")).map((p) => [p.id, p]));
  const byEmail = new Map([...people.values()].map((p) => [p.email, p]));
  type Link = (typeof links)[number];
  type Person = NonNullable<ReturnType<typeof people.get>>;
  const ownerOf = (l: Link) => people.get(l.parentId)!;
  const kept = new Set<string>();

  const close = async (l: Link, reason: DisabledReason, dropSource = false) => {
    const was = l.status === "disabled" ? l.statusBeforeDisable : l.status;
    const set = { status: "disabled" as const, disabledReason: reason, statusBeforeDisable: was, ...(dropSource ? { sourceQboId: null } : {}) };
    await tx.update(guardian).set({ ...set, updatedAt: new Date() }).where(eq(guardian.id, l.id));
    Object.assign(l, set);
    let sessionsEnded = await endFamilySessions(l.parentId, l.familyQboId, tx);
    if (!links.some((x) => x.parentId === l.parentId && x.status !== "disabled")) sessionsEnded += await endParentSessions(l.parentId, tx);
    await audit("parent.access.ended", "guardian", l.id, { status: was }, { parentId: l.parentId, familyQboId: l.familyQboId, reason, sessionsEnded });
    r.ended++;
  };
  const owe = async (p: Person) => {
    if (!settings.welcome || p.welcomedAt || p.welcomeOwed) return;
    await tx.update(parent).set({ welcomeOwed: true, updatedAt: new Date() }).where(eq(parent.id, p.id));
    p.welcomeOwed = true; r.welcomeOwed++;
  };
  const createPerson = async (email: string, name: string): Promise<Person> => {
    const [p] = await tx.insert(parent).values({ name, email }).returning();
    await tx.insert(parentAuthUser).values({ id: randomUUID(), name, email, emailVerified: true, parentId: p!.id });
    people.set(p!.id, p!); byEmail.set(email, p!);
    return p!;
  };

  for (const g of decision.grants) {
    const name = decision.personNames.get(g.email) ?? g.name;
    const fromSource = links.filter((l) => l.familyQboId === g.familyQboId && l.sourceQboId === g.sourceQboId);
    // The link for this grant: from this customer and owned by this address; or one made by hand for this family and address.
    let link: Link | undefined = fromSource.find((l) => ownerOf(l).email === g.email)
      ?? links.find((l) => l.familyQboId === g.familyQboId && l.sourceQboId === null && ownerOf(l).email === g.email);
    let person = byEmail.get(g.email);

    if (!link) {
      // The customer's address changed: a link from it whose owner's address no grant from it claims any more.
      const stale = fromSource.find((l) => !kept.has(l.id)
        && !decision.grants.some((x) => x.familyQboId === g.familyQboId && x.sourceQboId === g.sourceQboId && x.email === ownerOf(l).email));
      if (stale) {
        const owner = ownerOf(stale);
        if (!person && !links.some((l) => l.id !== stale.id && l.parentId === owner.id)) {
          const old = owner.email;
          await tx.update(parent).set({ email: g.email, updatedAt: new Date() }).where(eq(parent.id, owner.id));
          await tx.update(parentAuthUser).set({ email: g.email, updatedAt: new Date() }).where(eq(parentAuthUser.parentId, owner.id));
          await deleteUnusedSigninCodes(owner.id, tx);        // a code sent to the old address must not work
          byEmail.delete(old); owner.email = g.email; byEmail.set(g.email, owner);
          await audit("parent.email.changed", "parent", owner.id, { email: old }, { email: g.email, sourceQboId: g.sourceQboId });
          r.emailChanged++; link = stale; person = owner;
        } else {
          await close(stale, "address_changed", true);        // the source is dropped so the new link can carry it
        }
      }
    }
    if (!link) {
      person ??= await createPerson(g.email, name);
      link = links.find((l) => l.familyQboId === g.familyQboId && l.parentId === person!.id);
      if (!link) {
        const [row] = await tx.insert(guardian).values({ familyQboId: g.familyQboId, parentId: person.id, sourceQboId: g.sourceQboId, status: "invited" }).returning();
        links.push(row!); link = row!;
        await audit("parent.access.granted", "guardian", link.id, null, { parentId: person.id, familyQboId: g.familyQboId, sourceQboId: g.sourceQboId, status: "invited" });
        r.granted++; await owe(person);
      }
    }
    person = ownerOf(link);
    if (link.sourceQboId !== g.sourceQboId) {
      await tx.update(guardian).set({ sourceQboId: g.sourceQboId, updatedAt: new Date() }).where(eq(guardian.id, link.id));
      link.sourceQboId = g.sourceQboId;
    }
    if (link.status === "disabled") {
      const status = link.statusBeforeDisable ?? "invited", was = link.disabledReason;
      await tx.update(guardian).set({ status, disabledReason: null, statusBeforeDisable: null, updatedAt: new Date() }).where(eq(guardian.id, link.id));
      Object.assign(link, { status, disabledReason: null, statusBeforeDisable: null });
      await audit("parent.access.granted", "guardian", link.id, { status: "disabled", disabledReason: was }, { parentId: person.id, familyQboId: g.familyQboId, sourceQboId: g.sourceQboId, status });
      r.granted++; await owe(person);
    }
    if (person.name !== name) {
      await tx.update(parent).set({ name, updatedAt: new Date() }).where(eq(parent.id, person.id));
      await tx.update(parentAuthUser).set({ name, updatedAt: new Date() }).where(eq(parentAuthUser.parentId, person.id));
      await audit("parent.name.changed", "parent", person.id, { name: person.name }, { name });
      person.name = name;
    }
    kept.add(link.id);
  }

  const whyNot = new Map(decision.denials.map((d) => [`${d.familyQboId}|${d.sourceQboId}`, d.reason]));
  for (const l of links) {
    if (l.status !== "disabled" && !kept.has(l.id)) await close(l, whyNot.get(`${l.familyQboId}|${l.sourceQboId}`) ?? "not_in_quickbooks");
  }
  return r;
}

/** The reconcile on its own, for a staff decision or a switch: takes the roster lock, so it waits for a running refresh. */
export async function runReconcile(o: { cause: string }): Promise<ReconcileResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    return reconcileAccess(tx, o);
  });
}
```

- [ ] **Step 6: Run the reconcile inside the roster refresh**

In `src/lib/roster/refresh.ts`, import `reconcileAccess, ReconcileFailed` from `@/lib/parents/reconcile`, and change the cache-swap block to:

```ts
    try {
      // A savepoint: a failure here undoes the cache changes and the parent-access changes together, so the roster and
      // who can sign in never disagree (parents spec §2), and the failed run can still be recorded.
      await tx.transaction(async (sp) => {
        await sp.delete(qboCustomerType);
        await sp.delete(qboCustomer);
        for (let i = 0; i < typeRows.length; i += CHUNK) await sp.insert(qboCustomerType).values(typeRows.slice(i, i + CHUNK)).onConflictDoNothing();
        for (let i = 0; i < customerRows.length; i += CHUNK) await sp.insert(qboCustomer).values(customerRows.slice(i, i + CHUNK)).onConflictDoNothing();
        await setRosterSource(sp, realmId);
        try { await reconcileAccess(sp, { cause: `roster.refresh#${run!.id}` }); } catch { throw new ReconcileFailed(); }
      });
    } catch (e) {
      return e instanceof ReconcileFailed
        ? fail("The parent sign-ins couldn't be brought up to date, so the roster was left as it was. (reconcile_failed)", "reconcile_failed")
        : fail("The roster couldn't be saved. (save_failed)", "save_failed");
    }
```

`reconcile.ts` must not import `refresh.ts` (it would be a cycle).

- [ ] **Step 7: Run the tests and the checks**

Run: `pnpm vitest run tests/integration/parents-reconcile.test.ts tests/integration/parents-reconcile-refresh.test.ts tests/integration/roster-refresh.test.ts tests/integration/roster-company.test.ts tests/integration/jobs-runner.test.ts`
Expected: PASS, including the three existing files unchanged.
Run: `pnpm typecheck && pnpm lint`. Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(parents): reconcile people and family links with the roster, inside every refresh"
```

---

### Task 4: The switches, the preview and the parent door

**Files:**
- Create: `src/lib/parents/switches.ts`
- Modify: `src/lib/parents/signin-codes.ts`, `src/app/sign-in/page.tsx`
- Test: `tests/integration/parents-switches.test.ts`; add cases to `tests/integration/signin-codes.test.ts`

**Interfaces:**
- Consumes: `loadDecision`, `reconcileAccess`, `ReconcileResult` (Task 3); `getParentSettings`, `putParentSettings`, `parentDoorClosed`, `PARENTS_KEY` (Task 1); `connectionView` (`src/lib/quickbooks/connection.ts`); `mailWorking` (`src/lib/mail/settings.ts`); `ROSTER_JOB` (`src/lib/roster/source.ts`); `StaffOp` (`src/lib/parents/people.ts`).
- Produces:

```ts
export type Ready = { connected: boolean; shape: boolean; rosterFresh: boolean; mail: boolean };
export type AccessPreview = {
  ready: Ready; settings: ParentSettings;
  people: number; families: number;                       // who would have access, to how many families
  held: HeldAddress[];                                    // every held address, waiting or not
  noEmail: { qboId: string; name: string }[];
  manyAddresses: { qboId: string; name: string }[];
  noSignin: { qboId: string; name: string }[];
  ending: { name: string; email: string; familyQboId: string }[];          // enabled links the reconcile would close
  welcomeNow: number;                                     // people a welcome would go to if welcomes were switched on now
  students: { offered: boolean; families: number; people: number };       // what the active-students setting would close
};
export async function accessPreview(): Promise<AccessPreview>;
export type SwitchResult = { ok: true } | { ok: false; errors: string[] };
export async function setSignins(on: boolean, o: StaffOp): Promise<SwitchResult>;
export async function setRequireStudents(on: boolean, o: StaffOp): Promise<SwitchResult>;
export async function setReviewEmails(on: boolean, o: StaffOp): Promise<SwitchResult>;
export async function peopleWithAccess(): Promise<number>;                // for the Disconnect warning (Task 10)
```

(`setWelcome` is added in Task 5, in this same file.)

- [ ] **Step 1: Write the failing tests**

`tests/integration/parents-switches.test.ts` (start with the same `qboEndpoints` mock and stub lifecycle as `tests/integration/roster-pages.test.ts`, because `connectionView` and a connected row are needed; use `seedConnected(stub)` only, never a refresh):

```ts
const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: "203.0.113.9", permission: "Settings.Parents.ReadWrite" };
const freshRun = () => db.insert(jobRun).values({ job: ROSTER_JOB, startedBy: "worker", finishedAt: new Date(), outcome: "ok" });
const RIVERA = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10")];
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);

describe("the parent switches", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); });
  const ready = async (customers = RIVERA) => { await seedConnected(stub); await seedShape(); await seedCache(customers); await freshRun(); await seedWorkingMail(); };

  it("says what is missing, and refuses to switch on, until QuickBooks, the shape, a fresh roster and mail are all there", async () => {
    expect((await accessPreview()).ready).toEqual({ connected: false, shape: false, rosterFresh: false, mail: false });
    expect(await setSignins(true, admin)).toEqual({ ok: false, errors: [
      "Connect QuickBooks first.", "Choose the membership shape first.", "Refresh the roster first: it hasn't been read in the last 2 days.", "Set up outgoing mail and send a test email first." ] });
    await ready();
    await db.update(jobRun).set({ finishedAt: new Date(Date.now() - 49 * 3_600_000) });
    expect((await accessPreview()).ready).toEqual({ connected: true, shape: true, rosterFresh: false, mail: true });
    expect((await getParentSettings()).signin).toBe(false);
  });

  it("previews who would get access, what needs fixing and which sign-ins would end, before anything is on", async () => {
    await ready([...RIVERA, par("13", "No Mail", "10", null), par("14", "Two Mail", "10", "a@example.com, b@example.com"),
      fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com"), fam("30", "Empty Family")]);
    const seeded = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: seeded.id, familyQboId: "POC-FAMILY-1" });
    const p = await accessPreview();
    expect(p).toMatchObject({ people: 1, families: 1, welcomeNow: 1,
      noEmail: [{ qboId: "13", name: "No Mail" }], manyAddresses: [{ qboId: "14", name: "Two Mail" }],
      noSignin: [{ qboId: "20", name: "Chen Family" }, { qboId: "30", name: "Empty Family" }],
      ending: [{ name: "Hand Seeded", email: "seeded@example.com", familyQboId: "POC-FAMILY-1" }] });
    expect(p.held.map((h) => h.email)).toEqual(["ana@example.com"]);
    expect(await db.select().from(guardian)).toHaveLength(1);              // the preview changed nothing
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("switching on runs the reconcile and is audited with the counts", async () => {
    await ready();
    expect(await setSignins(true, admin)).toEqual({ ok: true });
    expect(await getParentSettings()).toMatchObject({ signin: true, everEnabled: true });
    expect(await db.select().from(guardian)).toHaveLength(1);
    const [row] = await audits("settings.parents.save");
    expect(row).toMatchObject({ door: "staff", actorLabel: "admin@club.org", permission: "Settings.Parents.ReadWrite", targetType: "setting", targetId: PARENTS_KEY, ip: "203.0.113.9" });
    expect(row!.before).toMatchObject({ signin: false });
    expect(row!.after).toMatchObject({ signin: true, granted: 1, ended: 0 });
  });

  it("switching off signs every parent out and stops the reconcile; links stay", async () => {
    await ready(); await setSignins(true, admin);
    const [u] = await db.select().from(parentAuthUser);
    await seedParentSession(u!.id, { familyQboId: "10" });
    expect(await setSignins(false, admin)).toEqual({ ok: true });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect(await getParentSettings()).toMatchObject({ signin: false, everEnabled: true });
    expect((await db.select().from(guardian))[0]!.status).toBe("invited");
    expect((await audits("settings.parents.save")).at(-1)!.after).toMatchObject({ signin: false, sessionsEnded: 1 });
    await seedCache([]);                                                   // would close the link if the reconcile still ran
    expect((await runReconcile({ cause: "test" })).ran).toBe(false);
  });

  it("offers the active-students setting only when the shape names a student type, and shows what it would close", async () => {
    await ready([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo", "10", { active: false })]);
    await setSignins(true, admin);
    expect((await accessPreview()).students).toEqual({ offered: true, families: 1, people: 1 });
    expect(await setRequireStudents(true, admin)).toEqual({ ok: true });
    expect((await db.select().from(guardian))[0]).toMatchObject({ status: "disabled", disabledReason: "no_active_students" });
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: null, parentTypeId: "P" });
    expect((await accessPreview()).students.offered).toBe(false);
    expect(await setRequireStudents(true, admin)).toEqual({ ok: false, errors: ["The membership shape doesn't say which customers are students, so this can't be used."] });
  });

  it("saves the review-email switch and audits it", async () => {
    expect(await setReviewEmails(false, admin)).toEqual({ ok: true });
    expect((await getParentSettings()).reviewEmails).toBe(false);
    expect((await audits("settings.parents.save"))[0]!.after).toMatchObject({ reviewEmails: false });
  });

  it("counts the people who can sign in now", async () => {
    await ready(); await setSignins(true, admin);
    expect(await peopleWithAccess()).toBe(1);
  });
});
```

Add to `tests/integration/signin-codes.test.ts`, following that file's existing setup for a parent who can get a code:

```ts
  it("refuses a code, with the same answer to the parent, once an Admin has switched parent sign-ins off", async () => {
    // (arrange a parent who would otherwise get a code, exactly as the "sends a code" test in this file does)
    await seedParentSettings({ signin: false, everEnabled: true });
    const { delivery } = await requestSigninCode("ana@example.com", "203.0.113.5");
    await delivery;
    expect(await db.select().from(signinCode)).toEqual([]);
    expect((await audits("signin.code_refused")).at(-1)!.after).toMatchObject({ reason: "signins_off" });
  });

  it("still sends codes before parent sign-ins have ever been switched on", async () => {
    await seedParentSettings({ signin: false, everEnabled: false });
    const { delivery } = await requestSigninCode("ana@example.com", "203.0.113.5");
    await delivery;
    expect(await db.select().from(signinCode)).toHaveLength(1);
  });

  it("refuses a correct code entered after sign-ins were switched off", async () => {
    // (get a real code as the "accepts the right code" test does, then:)
    await seedParentSettings({ signin: false, everEnabled: true });
    expect(await verifySigninCode("ana@example.com", code, "203.0.113.5")).toEqual({ ok: false, reason: "rejected" });
    expect((await audits("signin.refused")).at(-1)!.after).toEqual({ reason: "signins_off" });
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tests/integration/parents-switches.test.ts tests/integration/signin-codes.test.ts`
Expected: FAIL (`@/lib/parents/switches` not found; `signins_off` never recorded).

- [ ] **Step 3: Write `src/lib/parents/switches.ts`**

```ts
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, jobRun, parent } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { connectionView } from "@/lib/quickbooks/connection";
import { mailWorking } from "@/lib/mail/settings";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { ROSTER_JOB } from "@/lib/roster/source";
import type { HeldAddress } from "./access-rules";
import type { StaffOp } from "./people";
import { loadDecision, reconcileAccess } from "./reconcile";
import { getParentSettings, putParentSettings, PARENTS_KEY, type ParentSettings } from "./settings";

const FRESH_MS = 48 * 3_600_000;
export type Ready = { connected: boolean; shape: boolean; rosterFresh: boolean; mail: boolean };
export type AccessPreview = {
  ready: Ready; settings: ParentSettings; people: number; families: number; held: HeldAddress[];
  noEmail: { qboId: string; name: string }[]; manyAddresses: { qboId: string; name: string }[]; noSignin: { qboId: string; name: string }[];
  ending: { name: string; email: string; familyQboId: string }[]; welcomeNow: number;
  students: { offered: boolean; families: number; people: number };
};
export type SwitchResult = { ok: true } | { ok: false; errors: string[] };

async function readiness(hasDecision: boolean): Promise<Ready> {
  const [conn, mail, [lastOk]] = await Promise.all([connectionView(), mailWorking(),
    db.select().from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1)]);
  return { connected: conn.connected, shape: hasDecision, mail,
    rosterFresh: Boolean(lastOk?.finishedAt && Date.now() - lastOk.finishedAt.getTime() <= FRESH_MS) };
}

/** What switching on would do, and what needs cleaning up first (spec §3 step 1). It changes nothing. */
export async function accessPreview(): Promise<AccessPreview> {
  const loaded = await loadDecision();
  const settings = loaded?.settings ?? (await getParentSettings());
  const ready = await readiness(loaded !== null);
  const empty = { ready, settings, people: 0, families: 0, held: [], noEmail: [], manyAddresses: [], noSignin: [], ending: [], welcomeNow: 0,
    students: { offered: false, families: 0, people: 0 } };
  if (!loaded) return empty;
  const { decision, shape } = loaded;
  const flagged = (rule: string) => decision.flags.filter((f) => f.rule === rule && f.qboId !== null).map((f) => ({ qboId: f.qboId!, name: f.name }));
  const emails = new Set(decision.grants.map((g) => g.email));
  const enabled = await db.select({ familyQboId: guardian.familyQboId, name: parent.name, email: parent.email, welcomedAt: parent.welcomedAt })
    .from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId)).where(ne(guardian.status, "disabled")).orderBy(parent.name, guardian.familyQboId);
  const welcomed = new Set((await db.select({ email: parent.email }).from(parent).where(sql`${parent.welcomedAt} is not null`)).map((p) => p.email));
  const offered = shape.kind === "layered" && shape.studentTypeId !== null;
  const strict = offered ? (await loadDecision(undefined, { requireActiveStudents: true }))!.decision.grants : decision.grants;
  const lost = decision.grants.filter((g) => !strict.some((s) => s.email === g.email && s.familyQboId === g.familyQboId));
  return {
    ...empty, people: emails.size, families: new Set(decision.grants.map((g) => g.familyQboId)).size, held: decision.held,
    noEmail: decision.denials.filter((d) => d.reason === "no_email").map((d) => ({ qboId: d.sourceQboId, name: d.name })),
    manyAddresses: flagged("many_addresses"), noSignin: flagged("family_no_signin"),
    ending: enabled.filter((l) => !decision.grants.some((g) => g.familyQboId === l.familyQboId && g.email === l.email))
      .map((l) => ({ name: l.name, email: l.email, familyQboId: l.familyQboId })),
    welcomeNow: [...emails].filter((e) => !welcomed.has(e)).length,
    students: { offered, families: new Set(lost.map((g) => g.familyQboId)).size, people: new Set(lost.map((g) => g.email)).size },
  };
}

/** One settings change: lock, write, do the work the change needs, and audit it with what happened (spec §7). */
async function change(patch: Partial<ParentSettings>, o: StaffOp, work: (tx: Tx, next: ParentSettings) => Promise<Record<string, unknown>>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    const before = await getParentSettings(tx);
    const next = { ...before, ...patch };
    await putParentSettings(tx, next);
    const did = await work(tx, next);
    await writeAudit({ actor: o.actor, action: "settings.parents.save", permission: o.permission, targetType: "setting", targetId: PARENTS_KEY, ip: o.ip,
      before, after: { ...next, ...did } }, tx);
  });
}

export async function setSignins(on: boolean, o: StaffOp): Promise<SwitchResult> {
  if (!on) {
    await change({ signin: false }, o, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`DELETE FROM parent_auth_session RETURNING id`);
      return { sessionsEnded: Array.from(rows as ArrayLike<{ id: string }>).length };
    });
    return { ok: true };
  }
  const ready = await readiness((await loadDecision()) !== null);
  const errors = [
    ...(ready.connected ? [] : ["Connect QuickBooks first."]),
    ...(ready.shape ? [] : ["Choose the membership shape first."]),
    ...(ready.rosterFresh ? [] : ["Refresh the roster first: it hasn't been read in the last 2 days."]),
    ...(ready.mail ? [] : ["Set up outgoing mail and send a test email first."]),
  ];
  if (errors.length) return { ok: false, errors };
  await change({ signin: true, everEnabled: true }, o, async (tx) => {
    const r = await reconcileAccess(tx, { cause: "settings.signin" });
    return { granted: r.granted, ended: r.ended };
  });
  return { ok: true };
}

export async function setRequireStudents(on: boolean, o: StaffOp): Promise<SwitchResult> {
  const loaded = await loadDecision();
  if (on && !(loaded?.shape.kind === "layered" && loaded.shape.studentTypeId !== null)) {
    return { ok: false, errors: ["The membership shape doesn't say which customers are students, so this can't be used."] };
  }
  await change({ requireActiveStudents: on }, o, async (tx) => {
    const r = await reconcileAccess(tx, { cause: "settings.students" });
    return { granted: r.granted, ended: r.ended };
  });
  return { ok: true };
}

export async function setReviewEmails(on: boolean, o: StaffOp): Promise<SwitchResult> {
  await change({ reviewEmails: on }, o, async () => ({}));
  return { ok: true };
}

/** How many people can sign in right now (not blocked, with at least one open link). */
export async function peopleWithAccess(): Promise<number> {
  const rows = await db.selectDistinct({ id: guardian.parentId }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId))
    .where(and(ne(guardian.status, "disabled"), eq(parent.blocked, false)));
  return rows.length;
}
```

- [ ] **Step 4: Close the parent door when sign-ins are off**

In `src/lib/parents/signin-codes.ts`: import `getParentSettings, parentDoorClosed` from `./settings`; add `"signins_off"` to the `Refusal` type; in `requestSigninCode`, directly after the `mailWorking()` line:

```ts
  if (parentDoorClosed(await getParentSettings())) { await refuse("signins_off", label, null, ip); return DONE; }
```

and in `verifySigninCode`, replace the `const reason = ...` line with:

```ts
  const reason = parentDoorClosed(await getParentSettings()) ? "signins_off"
    : !fresh || fresh.blocked ? "blocked" : (await enabledGuardianRows(p.id)).length === 0 ? "no_enabled_guardian" : null;
```

In `src/app/sign-in/page.tsx`, the form is shown only when mail works and the door is open:

```tsx
import { getParentSettings, parentDoorClosed } from "@/lib/parents/settings";
// ...
  const [club, mail, settings] = await Promise.all([getClubSettings(), mailWorking(), getParentSettings()]);
  const ready = mail && !parentDoorClosed(settings);
```

- [ ] **Step 5: Run the tests and the checks**

Run: `pnpm vitest run tests/integration/parents-switches.test.ts tests/integration/signin-codes.test.ts tests/integration/parent-door.test.ts`
Expected: PASS.
Run: `pnpm typecheck && pnpm lint`. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(parents): the clean-up preview, the sign-in switch, and a closed door when it is off"
```

---

### Task 5: Welcome emails

**Files:**
- Create: `src/lib/parents/welcome.ts`
- Modify: `src/lib/mail/messages.ts` (the welcome message), `src/lib/parents/switches.ts` (`setWelcome`), `src/lib/jobs/runner.ts`, `src/lib/parents/people.ts` (remove what this piece replaces)
- Modify tests: `tests/unit/mail-messages.test.ts`, `tests/integration/parents-people.test.ts`
- Test: `tests/integration/parents-welcome.test.ts`

**Interfaces:**
- Consumes: `sendMail`, `currentBrand` (`src/lib/mail/send.ts`); `getStoredMailConfig`, `mailWorking` (`src/lib/mail/settings.ts`); `getParentSettings`; `StaffOp`.
- Produces:

```ts
// messages.ts
export function welcomeMessage(b: Brand, to: string, o: { appUrl: string; contact: string | null }): MailMessage;
// welcome.ts
export const WELCOME_BATCH = 5;
export const WELCOME_RETRY_MS = 15 * 60_000;
export async function sendOwedWelcomes(now?: Date): Promise<{ sent: number; failed: number }>;
export async function resendWelcome(parentId: string, o: StaffOp): Promise<{ ok: true } | { ok: false; reason: "not_found" | "no_access" | "blocked" | "mail_failed" }>;
// switches.ts
export async function setWelcome(on: boolean, o: StaffOp): Promise<SwitchResult>;
```

- [ ] **Step 1: Remove what this piece replaces from `src/lib/parents/people.ts`**

Delete `createOrLinkGuardian`, `removeGuardian`, `onFamilyStudentsChanged`, `resendWelcome`, the private `welcome` helper, `GuardianInput`, `AddGuardianResult`, `inputSchema` and `appUrl`, and the imports only they used. Keep `StaffOp`, `blockPerson`, `unblockPerson` and `changeParentEmailByStaff`. In `tests/integration/parents-people.test.ts` delete the tests of the removed functions and keep the rest. Nothing in `src/app` calls the removed functions (check with `grep -rn "createOrLinkGuardian\|removeGuardian\|onFamilyStudentsChanged\|resendWelcome" src`; expect no matches after the edit). Access now comes only from the reconcile (spec §7 Existing code).

- [ ] **Step 2: Write the failing tests**

In `tests/unit/mail-messages.test.ts`, replace the welcome-message tests with:

```ts
  it("the welcome names the club and the address, says how to sign in, and gives the contact when there is one", () => {
    const m = welcomeMessage({ clubName: "FZN Band Boosters", color: "#005102" }, "ana@example.com", { appUrl: "https://portal.example.org", contact: "webmaster@fznband.org" });
    expect(m.to).toBe("ana@example.com");
    expect(m.subject).toBe("You can now sign in to FZN Band Boosters");
    expect(m.text).toContain("https://portal.example.org");
    expect(m.text).toContain("with this email address");
    expect(m.text).toContain("Questions? Write to webmaster@fznband.org.");
    expect(welcomeMessage({ clubName: "C", color: "#005102" }, "a@example.com", { appUrl: "https://p.example", contact: null }).text).not.toContain("Questions?");
  });
  it("the welcome holds no family details", () => {
    const m = welcomeMessage({ clubName: "C", color: "#005102" }, "a@example.com", { appUrl: "https://p.example", contact: null });
    expect(`${m.text}${m.html}`).not.toMatch(/family|guardian/i);
  });
```

`tests/integration/parents-welcome.test.ts` (uses the local mail sink exactly as `tests/integration/signin-codes.test.ts` does: copy its sink setup, its `seedWorkingMail` call for SMTP to the sink, and its way of reading received messages; call the list of received messages `sink.messages` below):

```ts
const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: null, permission: "Settings.Parents.ReadWrite" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const person = async (name: string, o: { family?: string; welcomedAt?: Date | null; welcomeOwed?: boolean; blocked?: boolean; status?: "invited" | "active" | "disabled" } = {}) => {
  const p = await seedParent({ name, welcomedAt: o.welcomedAt ?? null, welcomeOwed: o.welcomeOwed ?? false, blocked: o.blocked ?? false });
  await seedGuardian({ parentId: p.id, familyQboId: o.family ?? "10", status: o.status ?? "invited" });
  return p;
};

describe("welcome emails", () => {
  beforeEach(async () => { /* resetDb, reset the sink, working mail pointed at the sink */ await seedParentSettings({ signin: true, everEnabled: true }); });

  it("switching welcomes on marks everyone with access who was never welcomed, and nobody else", async () => {
    await person("New One"); await person("Welcomed Before", { welcomedAt: new Date("2026-01-01T00:00:00Z") });
    await person("Blocked One", { blocked: true }); await person("No Access", { status: "disabled" });
    expect(await setWelcome(true, admin)).toEqual({ ok: true });
    const owed = (await db.select().from(parent)).filter((p) => p.welcomeOwed).map((p) => p.name);
    expect(owed).toEqual(["New One"]);
    expect((await audits("settings.parents.save"))[0]!.after).toMatchObject({ welcome: true, owed: 1 });
    expect(sink.messages).toEqual([]);                                     // the switch itself sends nothing
  });

  it("the worker sends owed welcomes, five a wake, and records each one", async () => {
    await seedParentSettings({ welcome: true });
    for (let i = 1; i <= 7; i++) await person(`Parent ${i}`, { welcomeOwed: true });
    expect(await sendOwedWelcomes()).toEqual({ sent: 5, failed: 0 });
    expect(sink.messages).toHaveLength(5);
    expect(await sendOwedWelcomes()).toEqual({ sent: 2, failed: 0 });
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    expect(sink.messages).toHaveLength(7);
    const rows = await db.select().from(parent);
    expect(rows.every((p) => p.welcomedAt !== null && !p.welcomeOwed)).toBe(true);
    const sent = await audits("parent.welcome.sent");
    expect(sent).toHaveLength(7);
    expect(sent[0]).toMatchObject({ door: "system", targetType: "parent" });
    expect(JSON.stringify(sent)).not.toContain("We'll email you a code");   // no email body in the audit log
  });

  it("sends nothing while welcomes, or sign-ins, are off, or mail isn't working", async () => {
    await person("Parent 1", { welcomeOwed: true });
    await seedParentSettings({ welcome: false });
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    await seedParentSettings({ welcome: true, signin: false });
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    await seedParentSettings({ signin: true });
    await db.delete(setting).where(eq(setting.key, "mail.status"));        // mail no longer counts as working
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    expect(sink.messages).toEqual([]);
  });

  it("skips a blocked person and one with no open link, and leaves them owed", async () => {
    await seedParentSettings({ welcome: true });
    await person("Blocked One", { welcomeOwed: true, blocked: true }); await person("No Access", { welcomeOwed: true, status: "disabled" });
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    expect((await db.select().from(parent)).every((p) => p.welcomeOwed)).toBe(true);
  });

  it("a failed send is recorded, tried again only after 15 minutes, and holds nobody else up", async () => {
    await seedParentSettings({ welcome: true });
    const bad = await person("Bounce", { welcomeOwed: true }); await person("Fine", { welcomeOwed: true });
    sink.rejectRecipient = bad.email;                                      // the sink refuses this one address (see Step 4)
    expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 1 });
    expect((await audits("parent.welcome.failed"))[0]).toMatchObject({ targetId: bad.id });
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });      // too soon to retry
    sink.rejectRecipient = null;
    expect(await sendOwedWelcomes(new Date(Date.now() + WELCOME_RETRY_MS + 1000))).toEqual({ sent: 1, failed: 0 });
  });

  it("staff can resend to one person, which never needs the welcome switch", async () => {
    const p = await person("Ana Rivera", { welcomedAt: new Date("2026-01-01T00:00:00Z") });
    const staff = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000002", label: "reg@club.org" }, ip: "203.0.113.9", permission: "Parents.ReadWrite" };
    expect(await resendWelcome(p.id, staff)).toEqual({ ok: true });
    expect(sink.messages).toHaveLength(1);
    expect((await audits("parent.welcome.sent"))[0]).toMatchObject({ door: "staff", permission: "Parents.ReadWrite", targetId: p.id });
    expect((await audits("parent.welcome.sent"))[0]!.after).toMatchObject({ resend: true });
    const blocked = await person("Blocked One", { blocked: true }), gone = await person("No Access", { status: "disabled" });
    expect(await resendWelcome(blocked.id, staff)).toEqual({ ok: false, reason: "blocked" });
    expect(await resendWelcome(gone.id, staff)).toEqual({ ok: false, reason: "no_access" });
    expect(await resendWelcome("00000000-0000-4000-8000-00000000dead", staff)).toEqual({ ok: false, reason: "not_found" });
  });

  it("the worker's wake sends owed welcomes even when QuickBooks isn't connected", async () => {
    await seedParentSettings({ welcome: true }); await person("Parent 1", { welcomeOwed: true });
    expect((await runDueJobs()).ran).toEqual([{ job: "parents.welcome", ok: true }]);
  });
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm vitest run tests/unit/mail-messages.test.ts tests/integration/parents-welcome.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write the code**

If the mail sink (`tests/helpers/mail-sink.ts`) cannot refuse one recipient, add an optional `rejectRecipient: string | null` to it: when set, `RCPT TO` for that address is answered `550`. This is test tooling only.

`src/lib/mail/messages.ts`, replacing `welcomeMessage`:

```ts
/** The welcome (parents spec §3). It holds no family details: the address alone decides what the person sees after signing in. */
export function welcomeMessage(b: Brand, to: string, o: { appUrl: string; contact: string | null }): MailMessage {
  const lines = [
    `You can now sign in to ${b.clubName} at ${o.appUrl} with this email address. We'll email you a code each time, so there is no password.`,
    ...(o.contact ? [`Questions? Write to ${o.contact}.`] : []),
  ];
  return { to, subject: `You can now sign in to ${b.clubName}`, text: text(lines), html: html(b, lines) };
}
```

`src/lib/parents/welcome.ts`:

```ts
import { and, asc, eq, exists, isNull, lt, ne, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, parent } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { env } from "@/env";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { getStoredMailConfig, mailWorking } from "@/lib/mail/settings";
import { welcomeMessage } from "@/lib/mail/messages";
import type { StaffOp } from "./people";
import { getParentSettings } from "./settings";

export const WELCOME_BATCH = 5;
export const WELCOME_RETRY_MS = 15 * 60_000;
const WELCOME_ACTOR: Actor = { door: "system", id: null, label: "welcome" };

async function message(to: string) {
  const stored = await getStoredMailConfig();
  // The club's own sending address is the one a reply reaches (spec §3).
  const contact = stored ? (stored.method === "graph" ? stored.mailbox : stored.from) : null;
  return welcomeMessage(await currentBrand(), to, { appUrl: env.APP_URL.replace(/\/+$/, ""), contact });
}
const hasOpenLink = exists(db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, parent.id), ne(guardian.status, "disabled"))));

/**
 * Sends welcomes the reconcile or the switch marked as owed (spec §2 Welcome emails). Called on every wake of the
 * worker: at most five a wake, so a whole roster goes out over some minutes, not in one burst from the club's mailbox.
 */
export async function sendOwedWelcomes(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  const settings = await getParentSettings();
  if (!settings.welcome || !settings.signin || !(await mailWorking())) return { sent: 0, failed: 0 };
  const due = await db.select().from(parent)
    .where(and(eq(parent.welcomeOwed, true), eq(parent.blocked, false), hasOpenLink,
      or(isNull(parent.welcomeTriedAt), lt(parent.welcomeTriedAt, new Date(now.getTime() - WELCOME_RETRY_MS)))))
    .orderBy(asc(parent.createdAt), asc(parent.id)).limit(WELCOME_BATCH);
  let sent = 0, failed = 0;
  for (const p of due) {
    const r = await sendMail(await message(p.email), { purpose: "welcome", actor: WELCOME_ACTOR });
    if (r.ok) {
      await db.update(parent).set({ welcomedAt: new Date(), welcomeOwed: false, welcomeTriedAt: null, updatedAt: new Date() }).where(eq(parent.id, p.id));
      await writeAudit({ actor: WELCOME_ACTOR, action: "parent.welcome.sent", targetType: "parent", targetId: p.id, after: { to: p.email } });
      sent++;
    } else {
      await db.update(parent).set({ welcomeTriedAt: now, updatedAt: new Date() }).where(eq(parent.id, p.id));
      await writeAudit({ actor: WELCOME_ACTOR, action: "parent.welcome.failed", targetType: "parent", targetId: p.id, after: { to: p.email, error: r.error } });
      failed++;
    }
  }
  return { sent, failed };
}

/** **Resend welcome email** on a person's page. It goes at once and does not depend on the welcome switch. */
export async function resendWelcome(parentId: string, o: StaffOp): Promise<{ ok: true } | { ok: false; reason: "not_found" | "no_access" | "blocked" | "mail_failed" }> {
  const [p] = await db.select().from(parent).where(eq(parent.id, parentId));
  if (!p) return { ok: false, reason: "not_found" };
  if (p.blocked) return { ok: false, reason: "blocked" };
  const [open] = await db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, p.id), ne(guardian.status, "disabled"))).limit(1);
  if (!open) return { ok: false, reason: "no_access" };
  const r = await sendMail(await message(p.email), { purpose: "welcome", actor: o.actor, ip: o.ip });
  if (!r.ok) {
    await writeAudit({ actor: o.actor, action: "parent.welcome.failed", permission: o.permission, targetType: "parent", targetId: p.id, after: { to: p.email, error: r.error, resend: true }, ip: o.ip });
    return { ok: false, reason: "mail_failed" };
  }
  await db.update(parent).set({ welcomedAt: new Date(), welcomeOwed: false, welcomeTriedAt: null, updatedAt: new Date() }).where(eq(parent.id, p.id));
  await writeAudit({ actor: o.actor, action: "parent.welcome.sent", permission: o.permission, targetType: "parent", targetId: p.id, after: { to: p.email, resend: true }, ip: o.ip });
  return { ok: true };
}
```

Add to `src/lib/parents/switches.ts`:

```ts
/** Welcome emails, behind their own switch (spec §3 step 3). On: everyone with access who was never welcomed is owed one. */
export async function setWelcome(on: boolean, o: StaffOp): Promise<SwitchResult> {
  await change({ welcome: on }, o, async (tx) => {
    if (!on) {
      await tx.update(parent).set({ welcomeOwed: false }).where(eq(parent.welcomeOwed, true));
      return {};
    }
    const rows = await tx.execute<{ id: string }>(sql`UPDATE parent SET welcome_owed = true, updated_at = now()
      WHERE welcomed_at IS NULL AND blocked = false AND welcome_owed = false
        AND EXISTS (SELECT 1 FROM guardian g WHERE g.parent_id = parent.id AND g.status <> 'disabled') RETURNING id`);
    return { owed: Array.from(rows as ArrayLike<{ id: string }>).length };
  });
  return { ok: true };
}
```

`src/lib/jobs/runner.ts`: import `sendOwedWelcomes` from `@/lib/parents/welcome`, and directly after the wake is recorded (before the `connectionView()` check, because welcomes do not need QuickBooks):

```ts
  const welcomes = await sendOwedWelcomes(now);
  if (welcomes.sent + welcomes.failed > 0) ran.push({ job: "parents.welcome", ok: welcomes.failed === 0 });
```

(`const ran` must be declared before this line.)

- [ ] **Step 5: Run the tests and the checks**

Run: `pnpm vitest run tests/unit/mail-messages.test.ts tests/integration/parents-welcome.test.ts tests/integration/parents-people.test.ts tests/integration/jobs-runner.test.ts tests/integration/parents-switches.test.ts`
Expected: PASS.
Run: `pnpm typecheck && pnpm lint`. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(parents): welcome emails behind their own switch, sent by the worker, with resend"
```

---
### Task 6: Held-address decisions, blocking with a reason, and the people directory

**Files:**
- Create: `src/lib/parents/holds.ts`, `src/lib/parents/directory.ts`
- Modify: `src/lib/parents/people.ts` (`blockPerson`, `unblockPerson`)
- Test: `tests/integration/parents-holds.test.ts`, `tests/integration/parents-directory.test.ts`, `tests/unit/parents-access-words.test.ts`; update the block tests in `tests/integration/parents-people.test.ts`

**Interfaces:**
- Consumes: `loadDecision`, `reconcileAccess` (Task 3); `HeldAddress` (Task 2); `StaffOp`; `ROSTER_LOCK`.
- Produces:

```ts
// holds.ts
export type HoldDecision = "same_person" | "not_same";
export async function decideHold(email: string, decision: HoldDecision, note: string, o: StaffOp): Promise<{ ok: true } | { ok: false; errors: string[] }>;
export async function reverseHold(email: string, note: string, o: StaffOp): Promise<{ ok: true } | { ok: false; errors: string[] }>;
// people.ts (changed signatures)
export async function blockPerson(parentId: string, reason: string, o: StaffOp): Promise<{ ok: true; sessionsEnded: number } | { ok: false; reason: "not_found" | "invalid" }>;
export async function unblockPerson(parentId: string, o: StaffOp): Promise<{ ok: true } | { ok: false; reason: "not_found" }>;
// directory.ts
export type AccessKind = "can" | "cannot" | "held" | "blocked";
export function accessWords(o: { status: GuardianStatus; reason: DisabledReason | null; blocked: boolean; otherFamilies?: string[] | null }): { kind: AccessKind; words: string };
export type FamilySignin = { parentId: string | null; name: string; email: string | null; kind: AccessKind; words: string };
export type PersonFamily = { familyQboId: string; familyName: string; kind: AccessKind; words: string };
export type PersonRow = { parentId: string; name: string; email: string; blocked: boolean; families: PersonFamily[]; lastSigninAt: string | null; welcomedAt: string | null };
export type PersonDetail = PersonRow & { blockedReason: string | null; blockedAt: string | null; welcomeOwed: boolean };
export type DecidedHold = { email: string; approved: string[]; rejected: string[]; note: string | null; decidedAt: string | null; decidedBy: string | null };   // family names, staff name
export async function familyNames(ids: string[]): Promise<Map<string, string>>;      // falls back to "Family account <id>"
export async function listPeople(q?: string): Promise<PersonRow[]>;
export async function getPerson(parentId: string): Promise<PersonDetail | null>;
export async function familySignins(familyQboId: string, o: { detailed: boolean }): Promise<FamilySignin[]>;
export async function heldReview(): Promise<{ waiting: HeldAddress[]; decided: DecidedHold[] }>;
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/parents-access-words.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { accessWords } from "@/lib/parents/directory";

describe("accessWords", () => {
  it.each([
    [{ status: "active", reason: null, blocked: false }, "can", "Can sign in"],
    [{ status: "invited", reason: null, blocked: false }, "can", "Can sign in (hasn't yet)"],
    [{ status: "active", reason: null, blocked: true }, "blocked", "Blocked"],
    [{ status: "disabled", reason: "inactive", blocked: false }, "cannot", "Can't sign in: inactive in QuickBooks"],
    [{ status: "disabled", reason: "family_inactive", blocked: false }, "cannot", "Can't sign in: the family is inactive in QuickBooks"],
    [{ status: "disabled", reason: "no_email", blocked: false }, "cannot", "Can't sign in: no email address in QuickBooks"],
    [{ status: "disabled", reason: "no_active_students", blocked: false }, "cannot", "Can't sign in: the family has no active students"],
    [{ status: "disabled", reason: "not_in_quickbooks", blocked: false }, "cannot", "Can't sign in: not listed under this family in QuickBooks"],
    [{ status: "disabled", reason: "address_changed", blocked: false }, "cannot", "Can't sign in: the email address changed in QuickBooks"],
    [{ status: "disabled", reason: "company_changed", blocked: false }, "cannot", "Can't sign in: a different QuickBooks company was connected"],
    [{ status: "disabled", reason: "removed", blocked: false }, "cannot", "Can't sign in: removed by staff"],
    [{ status: "disabled", reason: null, blocked: false }, "cannot", "Can't sign in"],
    [{ status: "disabled", reason: "held", blocked: false }, "held", "Held: this address is also under another family"],
    [{ status: "disabled", reason: "held", blocked: false, otherFamilies: ["Chen Family", "Old Family"] }, "held", "Held: this address is also under Chen Family and Old Family"],
    [{ status: "disabled", reason: "held", blocked: false, otherFamilies: [] }, "held", "Held: this address is also under another family"],
  ] as const)("%j", (input, kind, words) => {
    expect(accessWords(input)).toEqual({ kind, words });
  });
});
```

`tests/integration/parents-holds.test.ts`:

```ts
const staff = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000002", label: "reg@club.org" }, ip: "203.0.113.9", permission: "Parents.ReadWrite" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const TWO = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")];
const openFamilies = async () => (await db.select().from(guardian)).filter((g) => g.status !== "disabled").map((g) => g.familyQboId).sort();

describe("deciding a held address", () => {
  beforeEach(async () => { await resetDb(); await seedShape(); await seedParentSettings(SIGNINS_ON); await seedCache(TWO); await runReconcile({ cause: "test" }); });

  it("Same person gives the one person every listed family, in the same step, and is audited with the note", async () => {
    expect(await decideHold("ana@example.com", "same_person", "Called Ana; she is in both.", staff)).toEqual({ ok: true });
    expect(await openFamilies()).toEqual(["10", "20"]);
    expect(await db.select().from(parent)).toHaveLength(1);
    const [h] = await db.select().from(heldAddress);
    expect(h).toMatchObject({ approvedFamilyQboIds: ["10", "20"], rejectedFamilyQboIds: [], note: "Called Ana; she is in both.", decidedBy: staff.actor.id });
    const [row] = await audits("parent.hold.decided");
    expect(row).toMatchObject({ door: "staff", permission: "Parents.ReadWrite", targetType: "held_address", targetId: "ana@example.com", ip: "203.0.113.9" });
    expect(row!.after).toEqual({ decision: "same_person", familyQboIds: ["10", "20"], note: "Called Ana; she is in both." });
  });

  it("Not the same person keeps it held and takes it off the waiting list", async () => {
    expect(await decideHold("ana@example.com", "not_same", "Copied by mistake.", staff)).toEqual({ ok: true });
    expect(await openFamilies()).toEqual([]);
    const r = await heldReview();
    expect(r.waiting).toEqual([]);
    expect(r.decided).toEqual([expect.objectContaining({ email: "ana@example.com", approved: [], rejected: ["Rivera Family", "Chen Family"], note: "Copied by mistake." })]);
  });

  it("needs a note, and refuses an address that isn't held", async () => {
    expect(await decideHold("ana@example.com", "same_person", "   ", staff)).toEqual({ ok: false, errors: ["Add a short note saying how you know."] });
    expect(await decideHold("ana@example.com", "same_person", "x".repeat(501), staff)).toEqual({ ok: false, errors: ["Keep the note to 500 characters."] });
    expect(await decideHold("nobody@example.com", "same_person", "note", staff)).toEqual({ ok: false, errors: ["That address isn't held any more. Reload the page."] });
    expect(await audits("parent.hold.decided")).toEqual([]);
  });

  it("holds only the new family when an approved address appears under a third, and lists it as waiting again", async () => {
    await decideHold("ana@example.com", "same_person", "Both hers.", staff);
    await seedCache([...TWO, fam("30", "Third Family"), par("31", "Ana Rivera", "30", "ana@example.com")]);
    await runReconcile({ cause: "test" });
    expect(await openFamilies()).toEqual(["10", "20"]);
    expect((await heldReview()).waiting.map((w) => w.families.filter((f) => f.held).map((f) => f.qboId))).toEqual([["30"]]);
  });

  it("reversing a decision holds the address again and ends the access it gave", async () => {
    await decideHold("ana@example.com", "same_person", "Both hers.", staff);
    const [u] = await db.select().from(parentAuthUser);
    await seedParentSession(u!.id, { familyQboId: "10" });
    expect(await reverseHold("ana@example.com", "She says the Chen record is wrong.", staff)).toEqual({ ok: true });
    expect(await openFamilies()).toEqual([]);
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect((await heldReview()).waiting).toHaveLength(1);
    expect((await audits("parent.hold.decided")).at(-1)!.after).toMatchObject({ decision: "reversed" });
  });
});
```

`tests/integration/parents-directory.test.ts`:

```ts
describe("the people directory", () => {
  beforeEach(async () => { await resetDb(); await seedShape(); await seedParentSettings(SIGNINS_ON); });
  const ALL = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), par("12", "No Mail", "10", null),
    par("13", "Shared Sam", "10", "sam@example.com"), fam("20", "Chen Family"), par("21", "Shared Sam", "20", "sam@example.com")];

  it("lists what each person can reach, with family names, last sign-in and welcome, and finds by name or email", async () => {
    await seedCache(ALL); await runReconcile({ cause: "test" });
    const [ana] = await db.select().from(parent);
    await db.update(parent).set({ welcomedAt: new Date("2026-11-01T12:00:00Z") });
    await db.insert(auditLog).values({ door: "parent", actorId: ana!.id, actorLabel: ana!.email, action: "signin", targetType: "parent", targetId: ana!.id, at: new Date("2026-11-05T12:00:00Z") });
    expect(await listPeople()).toEqual([{ parentId: ana!.id, name: "Ana Rivera", email: "ana@example.com", blocked: false,
      families: [{ familyQboId: "10", familyName: "Rivera Family", kind: "can", words: "Can sign in (hasn't yet)" }],
      lastSigninAt: "2026-11-05T12:00:00.000Z", welcomedAt: "2026-11-01T12:00:00.000Z" }]);
    expect((await listPeople("RIVERA")).length).toBe(1);
    expect((await listPeople("ana@ex")).length).toBe(1);
    expect(await listPeople("zzz")).toEqual([]);
    expect(await getPerson(ana!.id)).toMatchObject({ name: "Ana Rivera", blockedReason: null, blockedAt: null, welcomeOwed: false });
    expect(await getPerson("00000000-0000-4000-8000-00000000dead")).toBeNull();
  });

  it("shows a family's sign-ins with reasons, and names the other family only when asked for detail", async () => {
    await seedCache(ALL); await runReconcile({ cause: "test" });
    const plain = await familySignins("10", { detailed: false });
    expect(plain.map((s) => `${s.name}: ${s.words}`)).toEqual([
      "Ana Rivera: Can sign in (hasn't yet)",
      "No Mail: Can't sign in: no email address in QuickBooks",
      "Shared Sam: Held: this address is also under another family",
    ]);
    expect(JSON.stringify(plain)).not.toContain("Chen");
    expect(plain.find((s) => s.name === "No Mail")).toMatchObject({ parentId: null, email: null, kind: "cannot" });
    const detailed = await familySignins("10", { detailed: true });
    expect(detailed.find((s) => s.name === "Shared Sam")!.words).toBe("Held: this address is also under Chen Family");
  });

  it("shows a blocked person as blocked, and a link made by hand as it stands before sign-ins are switched on", async () => {
    await seedParentSettings({ signin: false, everEnabled: false });
    await seedCache(ALL);
    const p = await seedParent({ name: "Hand Seeded", email: "seeded@example.com", blocked: true });
    await seedGuardian({ parentId: p.id, familyQboId: "10" });
    expect(await familySignins("10", { detailed: true })).toEqual([{ parentId: p.id, name: "Hand Seeded", email: "seeded@example.com", kind: "blocked", words: "Blocked" }]);
  });

  it("gives family names from the roster, and a stand-in for an ID it doesn't know", async () => {
    await seedCache(ALL);
    expect(await familyNames(["10", "NOPE"])).toEqual(new Map([["10", "Rivera Family"], ["NOPE", "Family account NOPE"]]));
  });
});
```

In `tests/integration/parents-people.test.ts`, change the block tests to the new signature and add:

```ts
  it("blocking records who, when and why; unblocking clears them; the reason is audited", async () => {
    const p = await seedParent({ name: "Ana Rivera" });
    expect(await blockPerson(p.id, "  ", staff)).toEqual({ ok: false, reason: "invalid" });
    expect(await blockPerson(p.id, "Custody order on file.", staff)).toMatchObject({ ok: true });
    const [row] = await db.select().from(parent);
    expect(row).toMatchObject({ blocked: true, blockedReason: "Custody order on file.", blockedBy: staff.actor.id });
    expect(row!.blockedAt).toBeInstanceOf(Date);
    expect((await audits("parent.block"))[0]!.after).toMatchObject({ blocked: true, reason: "Custody order on file." });
    await unblockPerson(p.id, staff);
    expect((await db.select().from(parent))[0]).toMatchObject({ blocked: false, blockedReason: null, blockedBy: null, blockedAt: null });
  });

  it("a blocked person owed a welcome is no longer owed one", async () => {
    const p = await seedParent({ name: "Ana Rivera", welcomeOwed: true });
    await blockPerson(p.id, "reason", staff);
    expect((await db.select().from(parent))[0]!.welcomeOwed).toBe(false);
  });
```

(`staff` there needs `actor.id` to be a UUID string; use the same value as in the holds test.)

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tests/unit/parents-access-words.test.ts tests/integration/parents-holds.test.ts tests/integration/parents-directory.test.ts tests/integration/parents-people.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/lib/parents/holds.ts`**

```ts
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { heldAddress } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import type { StaffOp } from "./people";
import { loadDecision, reconcileAccess } from "./reconcile";

export type HoldDecision = "same_person" | "not_same";
type Result = { ok: true } | { ok: false; errors: string[] };

function checkNote(raw: string): { ok: true; note: string } | { ok: false; errors: string[] } {
  const note = raw.trim();
  if (!note) return { ok: false, errors: ["Add a short note saying how you know."] };
  if (note.length > 500) return { ok: false, errors: ["Keep the note to 500 characters."] };
  return { ok: true, note };
}
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort((x, y) => x.localeCompare(y, "en", { numeric: true }));

/**
 * A staff decision on an address that is under more than one family (spec §1 Held addresses). **Same person** approves
 * every family the address is under now; **Not the same person** keeps the held ones held and takes the item off the
 * waiting list. Access changes in the same transaction, through the reconcile.
 */
export async function decideHold(email: string, decision: HoldDecision, rawNote: string, o: StaffOp): Promise<Result> {
  const checked = checkNote(rawNote);
  if (!checked.ok) return checked;
  return db.transaction(async (tx): Promise<Result> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    const item = (await loadDecision(tx))?.decision.held.find((h) => h.email === email);
    if (!item) return { ok: false, errors: ["That address isn't held any more. Reload the page."] };
    await tx.insert(heldAddress).values({ email }).onConflictDoNothing();
    const [row] = await tx.select().from(heldAddress).where(eq(heldAddress.email, email)).for("update");
    const all = item.families.map((f) => f.qboId), heldNow = item.families.filter((f) => f.held).map((f) => f.qboId);
    const next = decision === "same_person"
      ? { approvedFamilyQboIds: union(row!.approvedFamilyQboIds, all), rejectedFamilyQboIds: row!.rejectedFamilyQboIds.filter((f) => !all.includes(f)) }
      : { approvedFamilyQboIds: row!.approvedFamilyQboIds, rejectedFamilyQboIds: union(row!.rejectedFamilyQboIds, heldNow) };
    await tx.update(heldAddress).set({ ...next, note: checked.note, decidedBy: o.actor.id, decidedAt: new Date(), updatedAt: new Date() }).where(eq(heldAddress.email, email));
    await writeAudit({ actor: o.actor, action: "parent.hold.decided", permission: o.permission, targetType: "held_address", targetId: email, ip: o.ip,
      before: { approved: row!.approvedFamilyQboIds, rejected: row!.rejectedFamilyQboIds },
      after: { decision, familyQboIds: decision === "same_person" ? union([], all) : union([], heldNow), note: checked.note } }, tx);
    await reconcileAccess(tx, { cause: "hold" });
    return { ok: true };
  });
}

/** Undoes every decision on the address: it is held again for all its families, and waiting again (spec §1). */
export async function reverseHold(email: string, rawNote: string, o: StaffOp): Promise<Result> {
  const checked = checkNote(rawNote);
  if (!checked.ok) return checked;
  return db.transaction(async (tx): Promise<Result> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    const [row] = await tx.select().from(heldAddress).where(eq(heldAddress.email, email)).for("update");
    if (!row || (!row.approvedFamilyQboIds.length && !row.rejectedFamilyQboIds.length)) return { ok: false, errors: ["There is no decision on that address to reverse."] };
    await tx.update(heldAddress).set({ approvedFamilyQboIds: [], rejectedFamilyQboIds: [], note: checked.note, decidedBy: o.actor.id, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(heldAddress.email, email));
    await writeAudit({ actor: o.actor, action: "parent.hold.decided", permission: o.permission, targetType: "held_address", targetId: email, ip: o.ip,
      before: { approved: row.approvedFamilyQboIds, rejected: row.rejectedFamilyQboIds }, after: { decision: "reversed", note: checked.note } }, tx);
    await reconcileAccess(tx, { cause: "hold" });
    return { ok: true };
  });
}
```

`announcedFamilyQboIds` is deliberately left alone by both: a reversed item is not announced to staff by email a second time (spec §5).

- [ ] **Step 4: Blocking with a reason, in `src/lib/parents/people.ts`**

```ts
/** No codes, every session ends. Family links keep their status, so unblocking restores the same access. The reason is for staff only. */
export async function blockPerson(parentId: string, rawReason: string, o: StaffOp): Promise<{ ok: true; sessionsEnded: number } | { ok: false; reason: "not_found" | "invalid" }> {
  const reason = rawReason.trim();
  if (!reason || reason.length > 500) return { ok: false, reason: "invalid" };
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    await tx.update(parent).set({ blocked: true, blockedAt: new Date(), blockedBy: o.actor.id, blockedReason: reason, welcomeOwed: false, updatedAt: new Date() }).where(eq(parent.id, p.id));
    await deleteUnusedSigninCodes(p.id, tx);
    await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, p.id), isNull(parentEmailChange.usedAt)));
    const sessionsEnded = await endParentSessions(p.id, tx);
    await writeAudit({ actor: o.actor, action: "parent.block", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { blocked: p.blocked }, after: { blocked: true, reason, sessionsEnded }, ip: o.ip }, tx);
    return { ok: true as const, sessionsEnded };
  });
}
```

and in `unblockPerson` set `{ blocked: false, blockedAt: null, blockedBy: null, blockedReason: null, updatedAt: new Date() }`, with `before: { blocked: p.blocked, reason: p.blockedReason }` in its audit row.

- [ ] **Step 5: Write `src/lib/parents/directory.ts`**

```ts
import { and, eq, inArray, max } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, heldAddress, parent, qboCustomer, staffUser, type DisabledReason, type GuardianStatus } from "@/lib/db/schema";
import { familyLabel } from "@/app/components/family-label";
import type { HeldAddress } from "./access-rules";
import { loadDecision } from "./reconcile";

export type AccessKind = "can" | "cannot" | "held" | "blocked";
export type FamilySignin = { parentId: string | null; name: string; email: string | null; kind: AccessKind; words: string };
export type PersonFamily = { familyQboId: string; familyName: string; kind: AccessKind; words: string };
export type PersonRow = { parentId: string; name: string; email: string; blocked: boolean; families: PersonFamily[]; lastSigninAt: string | null; welcomedAt: string | null };
export type PersonDetail = PersonRow & { blockedReason: string | null; blockedAt: string | null; welcomeOwed: boolean };
export type DecidedHold = { email: string; approved: string[]; rejected: string[]; note: string | null; decidedAt: string | null; decidedBy: string | null };

const WHY: Record<DisabledReason, string> = {
  inactive: "inactive in QuickBooks", family_inactive: "the family is inactive in QuickBooks", no_email: "no email address in QuickBooks",
  no_active_students: "the family has no active students", not_in_quickbooks: "not listed under this family in QuickBooks",
  address_changed: "the email address changed in QuickBooks", company_changed: "a different QuickBooks company was connected",
  removed: "removed by staff", held: "",
};
const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!);

/** One person's standing in one family, in plain words (spec §4 The roster). `otherFamilies` is given only to staff who may see it. */
export function accessWords(o: { status: GuardianStatus; reason: DisabledReason | null; blocked: boolean; otherFamilies?: string[] | null }): { kind: AccessKind; words: string } {
  if (o.status === "disabled" && o.reason === "held") {
    return { kind: "held", words: `Held: this address is also under ${o.otherFamilies?.length ? list(o.otherFamilies) : "another family"}` };
  }
  if (o.status === "disabled") return { kind: "cannot", words: o.reason ? `Can't sign in: ${WHY[o.reason]}` : "Can't sign in" };
  if (o.blocked) return { kind: "blocked", words: "Blocked" };
  return { kind: "can", words: o.status === "invited" ? "Can sign in (hasn't yet)" : "Can sign in" };
}

/** Family names from the roster cache, for showing a family to staff and to its own parents. */
export async function familyNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const rows = unique.length ? await db.select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName }).from(qboCustomer).where(inArray(qboCustomer.qboId, unique)) : [];
  const found = new Map(rows.map((r) => [r.qboId, r.name]));
  return new Map(unique.map((id) => [id, found.get(id) ?? familyLabel(id)]));
}

const numeric = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

async function people(where?: ReturnType<typeof eq>): Promise<PersonDetail[]> {
  const persons = await db.select().from(parent).where(where).orderBy(parent.name, parent.email);
  if (!persons.length) return [];
  const ids = persons.map((p) => p.id);
  const [links, signins, held] = await Promise.all([
    db.select().from(guardian).where(inArray(guardian.parentId, ids)),
    db.select({ id: auditLog.targetId, at: max(auditLog.at) }).from(auditLog)
      .where(and(eq(auditLog.action, "signin"), eq(auditLog.door, "parent"), inArray(auditLog.targetId, ids))).groupBy(auditLog.targetId),
    loadDecision().then((l) => l?.decision.held ?? []),
  ]);
  const names = await familyNames(links.map((l) => l.familyQboId));
  const last = new Map(signins.map((s) => [s.id, s.at]));
  return persons.map((p) => ({
    parentId: p.id, name: p.name, email: p.email, blocked: p.blocked,
    families: links.filter((l) => l.parentId === p.id).sort((a, b) => numeric(a.familyQboId, b.familyQboId)).map((l) => ({
      familyQboId: l.familyQboId, familyName: names.get(l.familyQboId)!,
      ...accessWords({ status: l.status, reason: l.disabledReason, blocked: p.blocked,
        otherFamilies: held.find((h) => h.email === p.email)?.families.filter((f) => f.qboId !== l.familyQboId).map((f) => f.name) ?? null }) })),
    lastSigninAt: last.get(p.id)?.toISOString() ?? null, welcomedAt: p.welcomedAt?.toISOString() ?? null,
    blockedReason: p.blockedReason, blockedAt: p.blockedAt?.toISOString() ?? null, welcomeOwed: p.welcomeOwed,
  }));
}

/** Everyone the portal knows, for staff with `Parents.ReadWrite` (spec §4 Parents). `q` matches part of a name or address. */
export async function listPeople(q?: string): Promise<PersonRow[]> {
  const needle = (q ?? "").trim().toLowerCase().slice(0, 100);
  return (await people()).filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.email.includes(needle))
    .map(({ blockedReason: _r, blockedAt: _a, welcomeOwed: _o, ...row }) => row);
}

export async function getPerson(parentId: string): Promise<PersonDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(parentId)) return null;
  return (await people(eq(parent.id, parentId)))[0] ?? null;
}

/**
 * The **Portal sign-ins** box on a family's roster page: the people linked to the family, and (once sign-ins are on)
 * the QuickBooks candidates who have no link because the rules refused them. `detailed` is for staff with
 * `Parents.ReadWrite`: only they are told which other family a held address is under (spec §4).
 */
export async function familySignins(familyQboId: string, o: { detailed: boolean }): Promise<FamilySignin[]> {
  const [links, loaded] = await Promise.all([
    db.select({ g: guardian, p: parent }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId)).where(eq(guardian.familyQboId, familyQboId)),
    loadDecision(),
  ]);
  const others = (email: string | null) => (!o.detailed || !email ? null
    : loaded?.decision.held.find((h) => h.email === email)?.families.filter((f) => f.qboId !== familyQboId).map((f) => f.name) ?? null);
  const out: FamilySignin[] = links.map(({ g, p }) => ({ parentId: p.id, name: p.name, email: p.email,
    ...accessWords({ status: g.status, reason: g.disabledReason, blocked: p.blocked, otherFamilies: others(p.email) }) }));
  if (loaded?.settings.signin) {
    const linked = new Set(links.map(({ g }) => g.sourceQboId));
    for (const d of loaded.decision.denials) {
      if (d.familyQboId !== familyQboId || linked.has(d.sourceQboId)) continue;
      out.push({ parentId: null, name: d.name, email: d.email, ...accessWords({ status: "disabled", reason: d.reason, blocked: false, otherFamilies: others(d.email) }) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (a.email ?? "").localeCompare(b.email ?? ""));
}

/** The Parents page's review lists: held addresses waiting for a decision, and the decisions made (which can be reversed). */
export async function heldReview(): Promise<{ waiting: HeldAddress[]; decided: DecidedHold[] }> {
  const [loaded, rows] = await Promise.all([loadDecision(), db.select().from(heldAddress).orderBy(heldAddress.email)]);
  const decidedRows = rows.filter((r) => r.approvedFamilyQboIds.length || r.rejectedFamilyQboIds.length);
  const names = await familyNames(decidedRows.flatMap((r) => [...r.approvedFamilyQboIds, ...r.rejectedFamilyQboIds]));
  const staffIds = decidedRows.map((r) => r.decidedBy).filter((id): id is string => id !== null);
  const staff = new Map((staffIds.length ? await db.select({ id: staffUser.id, name: staffUser.name }).from(staffUser).where(inArray(staffUser.id, staffIds)) : []).map((s) => [s.id, s.name]));
  return {
    waiting: loaded?.settings.signin ? loaded.decision.held.filter((h) => h.pending) : [],
    decided: decidedRows.map((r) => ({ email: r.email, approved: r.approvedFamilyQboIds.map((f) => names.get(f)!), rejected: r.rejectedFamilyQboIds.map((f) => names.get(f)!),
      note: r.note, decidedAt: r.decidedAt?.toISOString() ?? null, decidedBy: r.decidedBy ? staff.get(r.decidedBy) ?? null : null })),
  };
}
```

`DenyReason` values are all `DisabledReason` values, so a denial's reason can be passed to `accessWords` as is.

- [ ] **Step 6: Run the tests and the checks**

Run: `pnpm vitest run tests/unit/parents-access-words.test.ts tests/integration/parents-holds.test.ts tests/integration/parents-directory.test.ts tests/integration/parents-people.test.ts`
Expected: PASS.
Run: `pnpm typecheck && pnpm lint`. Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(parents): decide held addresses, block with a reason, and a directory of people"
```

---

### Task 7: Telling staff there is something to review

**Files:**
- Create: `src/lib/parents/review-notice.ts`
- Modify: `src/lib/mail/messages.ts`, `src/lib/mail/types.ts` (`MailPurpose` gains `"review_notice"`), `src/lib/jobs/runner.ts`
- Test: `tests/integration/parents-review-notice.test.ts`; one case in `tests/unit/mail-messages.test.ts`

**Interfaces:**
- Consumes: `loadDecision` (Task 3); `effectivePermissions`, `can` (`src/lib/permissions/effective.ts`); `sendMail`, `currentBrand`; `mailWorking`.
- Produces:

```ts
// messages.ts
export function reviewNoticeMessage(b: Brand, to: string, o: { newCount: number; waiting: number; link: string }): MailMessage;
// review-notice.ts
export const REVIEW_NOTICE_KEY = "parents.review_notice";             // setting: { lastSentAt: string }
export const REVIEW_NOTICE_GAP_MS = 24 * 3_600_000;
export async function reviewWaiting(): Promise<number>;               // held addresses awaiting a decision; 0 while sign-ins are off
export async function sendReviewNotice(now?: Date): Promise<{ sent: number; newItems: number }>;
```

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/mail-messages.test.ts`:

```ts
  it("the staff review notice gives two numbers and a link, and names nobody", () => {
    const m = reviewNoticeMessage({ clubName: "FZN Band Boosters", color: "#005102" }, "reg@club.org", { newCount: 2, waiting: 5, link: "https://portal.example.org/staff/parents" });
    expect(m.subject).toBe("FZN Band Boosters: 2 parent sign-ins to review");
    expect(m.text).toContain("2 new");
    expect(m.text).toContain("5 waiting in all");
    expect(m.text).toContain("https://portal.example.org/staff/parents");
    expect(reviewNoticeMessage({ clubName: "C", color: "#005102" }, "r@c.org", { newCount: 1, waiting: 1, link: "x" }).subject).toBe("C: 1 parent sign-in to review");
  });
```

`tests/integration/parents-review-notice.test.ts` (mail sink set up as in Task 5's welcome test):

```ts
const TWO = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")];
const MORE = [...TWO, fam("30", "Third Family"), par("31", "Sam Lee", "30", "sam@example.com"), fam("40", "Fourth Family"), par("41", "Sam Lee", "40", "sam@example.com")];
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const hours = (n: number) => new Date(Date.now() + n * 3_600_000);

describe("the staff review notice", () => {
  let reviewer: Awaited<ReturnType<typeof seedStaff>>;
  beforeEach(async () => {
    /* resetDb, reset the sink, working mail pointed at the sink */
    await seedShape(); await seedParentSettings(SIGNINS_ON);
    reviewer = await seedStaff({ email: "reg@club.org", name: "Reg Istrar" });
    const [r] = await db.insert(role).values({ key: "parents", name: "Parents" }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "Parents.*" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: reviewer.id });
    await seedStaff({ email: "volunteer@club.org" });                                  // no permission: never emailed
    await seedStaff({ email: "gone@club.org", admin: true, status: "disabled" });      // disabled: never emailed
  });

  it("counts what is waiting, and nothing while sign-ins are off", async () => {
    await seedCache(TWO);
    expect(await reviewWaiting()).toBe(1);
    await seedParentSettings({ signin: false });
    expect(await reviewWaiting()).toBe(0);
  });

  it("emails each person who can act, once per item, with numbers and a link only", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    expect(await sendReviewNotice()).toEqual({ sent: 1, newItems: 1 });
    expect(sink.messages).toHaveLength(1);
    const text = String(sink.messages[0]!.text ?? sink.messages[0]);
    expect(sink.messages[0]).toMatchObject({ to: "reg@club.org" });
    expect(text).toContain("/staff/parents");
    for (const secret of ["ana@example.com", "Rivera", "Chen", "Ana"]) expect(text).not.toContain(secret);
    expect((await db.select().from(heldAddress))[0]!.announcedFamilyQboIds).toEqual(["10", "20"]);
    const [row] = await audits("parent.review.notified");
    expect(row).toMatchObject({ door: "system" });
    expect(row!.after).toEqual({ newItems: 1, waiting: 1, recipients: 1, failed: 0 });
    expect(JSON.stringify(row)).not.toContain("ana@example.com");

    expect(await sendReviewNotice(hours(72))).toEqual({ sent: 0, newItems: 0 });         // the same item is never announced again
    expect(sink.messages).toHaveLength(1);
  });

  it("gathers new items into at most one email in 24 hours", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    await sendReviewNotice();
    await seedCache(MORE); await runReconcile({ cause: "test" });
    expect(await sendReviewNotice(hours(1))).toEqual({ sent: 0, newItems: 1 });          // new, but too soon
    expect(await sendReviewNotice(hours(25))).toEqual({ sent: 1, newItems: 1 });
    expect(String(sink.messages[1]!.text ?? sink.messages[1])).toContain("2 waiting in all");
  });

  it("announces an approved address again only for a family it has not been announced for", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" }); await sendReviewNotice();
    await db.update(heldAddress).set({ approvedFamilyQboIds: ["10", "20"] });
    await seedCache([...TWO, fam("30", "Third Family"), par("31", "Ana Rivera", "30", "ana@example.com")]); await runReconcile({ cause: "test" });
    expect(await sendReviewNotice(hours(25))).toEqual({ sent: 1, newItems: 1 });
  });

  it("sends nothing when the switch is off, sign-ins are off, mail isn't working, or nobody holds the permission", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    await seedParentSettings({ reviewEmails: false });
    expect(await sendReviewNotice()).toEqual({ sent: 0, newItems: 0 });
    await seedParentSettings({ reviewEmails: true });
    await db.delete(roleAssignment);
    expect(await sendReviewNotice()).toEqual({ sent: 0, newItems: 1 });
    expect((await db.select().from(heldAddress))[0]!.announcedFamilyQboIds).toEqual([]);  // nobody was told, so it is still new
    expect(sink.messages).toEqual([]);
  });

  it("is sent from the worker's wake", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    expect((await runDueJobs()).ran).toContainEqual({ job: "parents.review_notice", ok: true });
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tests/unit/mail-messages.test.ts tests/integration/parents-review-notice.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the code**

`src/lib/mail/types.ts`: `export type MailPurpose = "signin_code" | "welcome" | "email_change_confirm" | "email_change_notice" | "test" | "review_notice";`

`src/lib/mail/messages.ts`:

```ts
/** To staff who can decide held addresses (parents spec §5). Two numbers and a link: no family, person or address. */
export function reviewNoticeMessage(b: Brand, to: string, o: { newCount: number; waiting: number; link: string }): MailMessage {
  const items = (n: number) => `${n} parent ${n === 1 ? "sign-in" : "sign-ins"}`;
  const lines = [
    `${o.newCount} new, ${o.waiting} waiting in all: some email addresses in QuickBooks are under more than one family, so the people at those addresses can't sign in until someone reviews them.`,
    `Review them here: ${o.link}`,
    "You won't be reminded about these again. They stay on the staff home page until they are decided.",
  ];
  return { to, subject: `${b.clubName}: ${items(o.newCount)} to review`, text: text(lines), html: html(b, lines) };
}
```

`src/lib/parents/review-notice.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { heldAddress, setting, staffUser } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { env } from "@/env";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { mailWorking } from "@/lib/mail/settings";
import { reviewNoticeMessage } from "@/lib/mail/messages";
import { loadDecision } from "./reconcile";

export const REVIEW_NOTICE_KEY = "parents.review_notice";
export const REVIEW_NOTICE_GAP_MS = 24 * 3_600_000;
const NOTICE_ACTOR: Actor = { door: "system", id: null, label: "review-notice" };

async function pending() {
  const loaded = await loadDecision();
  return loaded?.settings.signin ? { settings: loaded.settings, items: loaded.decision.held.filter((h) => h.pending) } : null;
}

/** How many held addresses are waiting for a decision: the number on the staff home (spec §5). */
export async function reviewWaiting(): Promise<number> {
  return (await pending())?.items.length ?? 0;
}

/**
 * The once-a-day email to staff who can decide held addresses (spec §5). An item is announced once: it is new while a
 * family it is held for is not in the row's announced set. Nothing is marked announced unless at least one email went.
 */
export async function sendReviewNotice(now: Date = new Date()): Promise<{ sent: number; newItems: number }> {
  const p = await pending();
  if (!p || !p.settings.reviewEmails) return { sent: 0, newItems: 0 };
  const rows = new Map((await db.select().from(heldAddress)).map((r) => [r.email, r]));
  const heldFamilies = (email: string) => p.items.find((i) => i.email === email)!.families.filter((f) => f.held).map((f) => f.qboId);
  const fresh = p.items.filter((i) => heldFamilies(i.email).some((f) => !(rows.get(i.email)?.announcedFamilyQboIds ?? []).includes(f)));
  if (!fresh.length) return { sent: 0, newItems: 0 };
  const [last] = await db.select().from(setting).where(eq(setting.key, REVIEW_NOTICE_KEY));
  const lastSentAt = Date.parse(String((last?.value as { lastSentAt?: unknown } | undefined)?.lastSentAt ?? ""));
  if (!Number.isNaN(lastSentAt) && now.getTime() - lastSentAt < REVIEW_NOTICE_GAP_MS) return { sent: 0, newItems: fresh.length };
  if (!(await mailWorking())) return { sent: 0, newItems: fresh.length };

  const staff = await db.select().from(staffUser).where(eq(staffUser.status, "active"));
  const recipients: string[] = [];
  for (const s of staff) if (can(await effectivePermissions(s.id), "Parents.ReadWrite")) recipients.push(s.email);
  const brand = await currentBrand(), link = `${env.APP_URL.replace(/\/+$/, "")}/staff/parents`;
  let sent = 0;
  for (const to of recipients) {
    const r = await sendMail(reviewNoticeMessage(brand, to, { newCount: fresh.length, waiting: p.items.length, link }), { purpose: "review_notice", actor: NOTICE_ACTOR });
    if (r.ok) sent++;
  }
  if (!sent) return { sent: 0, newItems: fresh.length };
  await db.transaction(async (tx) => {
    for (const i of fresh) {
      const announced = [...new Set([...(rows.get(i.email)?.announcedFamilyQboIds ?? []), ...heldFamilies(i.email)])].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      await tx.insert(heldAddress).values({ email: i.email, announcedFamilyQboIds: announced })
        .onConflictDoUpdate({ target: heldAddress.email, set: { announcedFamilyQboIds: announced, updatedAt: new Date() } });
    }
    const value = { lastSentAt: now.toISOString() };
    await tx.insert(setting).values({ key: REVIEW_NOTICE_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
    await writeAudit({ actor: NOTICE_ACTOR, action: "parent.review.notified", targetType: "setting", targetId: REVIEW_NOTICE_KEY,
      after: { newItems: fresh.length, waiting: p.items.length, recipients: recipients.length, failed: recipients.length - sent } }, tx);
  });
  return { sent, newItems: fresh.length };
}
```

`src/lib/jobs/runner.ts`, directly after the welcome lines from Task 5:

```ts
  const notice = await sendReviewNotice(now);
  if (notice.sent > 0) ran.push({ job: "parents.review_notice", ok: true });
```

- [ ] **Step 4: Run the tests and the checks**

Run: `pnpm vitest run tests/unit/mail-messages.test.ts tests/integration/parents-review-notice.test.ts tests/integration/jobs-runner.test.ts tests/integration/parents-welcome.test.ts`
Expected: PASS. (`parents-welcome.test.ts`'s wake test expects exactly one entry in `ran`; it has no held address, so it still holds.)
Run: `pnpm typecheck && pnpm lint`. Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(parents): one email a day to staff when there are new sign-ins to review"
```

---

### Task 8: A different QuickBooks company, and the match review

**Files:**
- Create: `src/lib/parents/company-change.ts`, `src/lib/parents/matches.ts`
- Modify: `src/lib/roster/source.ts` (`clearRosterOfOtherCompany`), `src/lib/jobs/runner.ts`
- Test: `tests/integration/parents-company-change.test.ts`, `tests/unit/parents-matches.test.ts`, `tests/integration/parents-matches.test.ts`

**Interfaces:**
- Consumes: `loadDecision`, `reconcileAccess` (Task 3); `getParentSettings`, `putParentSettings`; `getConnection` (`src/lib/quickbooks/connection.ts`); `StaffOp`.
- Produces:

```ts
// company-change.ts
export const PREVIOUS_COMPANY_KEY = "parents.previous_company";
export const PREVIOUS_COMPANY_KEEP_MS = 90 * 86_400_000;
export type PreviousFamily = { qboId: string; name: string; people: { parentId: string; name: string; email: string; welcomedAt: string | null }[]; decision: "matched" | "rejected" | null; matchedTo: string | null };
export type PreviousCompany = { realmId: string; newRealmId: string; at: string; families: PreviousFamily[]; approvals: { email: string; familyQboIds: string[] }[] };
export async function clearParentAccess(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void>;
export async function getPreviousCompany(tx?: Tx): Promise<PreviousCompany | null>;
export async function deletePreviousCompany(o: { actor: Actor; ip: string | null; permission?: string; reason: "admin" | "expired" }): Promise<boolean>;
export async function expirePreviousCompany(now?: Date): Promise<boolean>;
// matches.ts
export type NewFamily = { qboId: string; name: string; emails: string[] };
export type MatchSuggestion = {
  old: { qboId: string; name: string; emails: string[] };
  suggested: { qboId: string; name: string } | null; nameMatches: boolean; addressesMatched: number; strong: boolean;
  decision: "matched" | "rejected" | null; matchedTo: { qboId: string; name: string } | null;
};
export function suggestMatches(prev: PreviousCompany, families: NewFamily[]): MatchSuggestion[];        // pure
export async function matchReview(): Promise<{ suggestions: MatchSuggestion[]; families: { qboId: string; name: string }[] } | null>;   // null: nothing to review
export async function decideMatch(oldFamilyQboId: string, newFamilyQboId: string | null, o: StaffOp): Promise<{ ok: true } | { ok: false; errors: string[] }>;
export async function acceptStrongMatches(o: StaffOp): Promise<{ accepted: number }>;
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/parents-matches.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { suggestMatches, type NewFamily } from "@/lib/parents/matches";
import type { PreviousCompany, PreviousFamily } from "@/lib/parents/company-change";

const old = (qboId: string, name: string, emails: string[], o: Partial<PreviousFamily> = {}): PreviousFamily =>
  ({ qboId, name, people: emails.map((email, i) => ({ parentId: `p${qboId}-${i}`, name: "x", email, welcomedAt: null })), decision: null, matchedTo: null, ...o });
const prev = (families: PreviousFamily[]): PreviousCompany => ({ realmId: "1", newRealmId: "2", at: "2026-11-11T00:00:00.000Z", families, approvals: [] });
const nu = (qboId: string, name: string, emails: string[] = []): NewFamily => ({ qboId, name, emails });

describe("suggestMatches", () => {
  it("is strong when the name matches and every old address is under the new family", () => {
    const [s] = suggestMatches(prev([old("12", "Rivera Family", ["ana@example.com", "leo@example.com"])]), [nu("87", "rivera  family", ["leo@example.com", "ana@example.com", "x@example.com"])]);
    expect(s).toEqual({ old: { qboId: "12", name: "Rivera Family", emails: ["ana@example.com", "leo@example.com"] }, suggested: { qboId: "87", name: "rivera  family" },
      nameMatches: true, addressesMatched: 2, strong: true, decision: null, matchedTo: null });
  });
  it.each([
    ["name only", old("12", "Rivera Family", ["ana@example.com"]), [nu("87", "Rivera Family")], "87", true, 0, false],
    ["addresses only", old("12", "Rivera Family", ["ana@example.com"]), [nu("87", "Rivera-Smith", ["ana@example.com"])], "87", false, 1, false],
    ["some addresses", old("12", "Rivera Family", ["ana@example.com", "leo@example.com"]), [nu("87", "Rivera Family", ["ana@example.com"])], "87", true, 1, false],
    ["nothing in common", old("12", "Rivera Family", ["ana@example.com"]), [nu("87", "Chen Family", ["mei@example.com"])], null, false, 0, false],
    ["a name match with no old addresses is never strong", old("12", "Rivera Family", []), [nu("87", "Rivera Family")], "87", true, 0, false],
  ] as const)("%s", (_label, o, families, id, nameMatches, addressesMatched, strong) => {
    const [s] = suggestMatches(prev([o]), [...families]);
    expect(s!.suggested?.qboId ?? null).toBe(id);
    expect({ nameMatches: s!.nameMatches, addressesMatched: s!.addressesMatched, strong: s!.strong }).toEqual({ nameMatches, addressesMatched, strong });
  });
  it("prefers more matching addresses over a matching name, then the lower QuickBooks ID", () => {
    const o = prev([old("12", "Rivera Family", ["ana@example.com"])]);
    expect(suggestMatches(o, [nu("90", "Rivera Family"), nu("87", "Other", ["ana@example.com"])])[0]!.suggested!.qboId).toBe("87");
    expect(suggestMatches(o, [nu("100", "Rivera Family"), nu("9", "Rivera Family")])[0]!.suggested!.qboId).toBe("9");
  });
  it("never suggests the same new family twice, and never one already matched", () => {
    const o = prev([old("12", "Rivera Family", ["ana@example.com"]), old("13", "Rivera Family", []), old("14", "Done", [], { decision: "matched", matchedTo: "87" })]);
    const s = suggestMatches(o, [nu("87", "Done"), nu("88", "Rivera Family", ["ana@example.com"])]);
    expect(s.map((x) => [x.old.qboId, x.suggested?.qboId ?? null, x.matchedTo?.qboId ?? null])).toEqual([["12", "88", null], ["13", null, null], ["14", null, "87"]]);
  });
  it("does not treat the same small ID in two companies as a match", () => {
    const [s] = suggestMatches(prev([old("12", "Rivera Family", ["ana@example.com"])]), [nu("12", "Chen Family", ["mei@example.com"])]);
    expect(s!.suggested).toBeNull();
  });
});
```

`tests/integration/parents-company-change.test.ts` (start with the `qboEndpoints` mock and stub lifecycle of `tests/integration/roster-company.test.ts`; that file shows how a second company is connected through `completeConnect`. Here the company change is driven directly, which needs no stub call):

```ts
const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: "203.0.113.9" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const OLD = [fam("12", "Rivera Family"), par("13", "Ana Rivera", "12", "ana@example.com"), fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com"), par("22", "Mei Chen", "20", "mei@example.com")];

describe("connecting a different QuickBooks company", () => {
  beforeEach(async () => {
    await resetDb(); await seedShape(); await seedParentSettings({ ...SIGNINS_ON, welcome: true }); await seedCache(OLD);
    await setRosterSourceForTest("1111");                                       // db.transaction((tx) => setRosterSource(tx, "1111"))
    await db.insert(heldAddress).values({ email: "ana@example.com", approvedFamilyQboIds: ["12", "20"], note: "Both hers." });
    await runReconcile({ cause: "test" });
    await db.update(guardian).set({ status: "active" });
    await db.update(parent).set({ welcomedAt: new Date("2026-11-01T12:00:00Z"), welcomeOwed: false });
  });

  it("closes every link, signs parents out, switches sign-ins and welcomes off, and keeps the people", async () => {
    const [u] = await db.select().from(parentAuthUser);
    await seedParentSession(u!.id, { familyQboId: "12" });
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    const links = await db.select().from(guardian);
    expect(links).toHaveLength(3);
    expect(links.every((l) => l.status === "disabled" && l.disabledReason === "company_changed" && l.statusBeforeDisable === "active")).toBe(true);
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect(await getParentSettings()).toMatchObject({ signin: false, welcome: false, everEnabled: true });
    expect((await db.select().from(parent)).map((p) => p.name).sort()).toEqual(["Ana Rivera", "Mei Chen"]);
    const [row] = await audits("parent.access.cleared");
    expect(row).toMatchObject({ door: "staff", actorLabel: "admin@club.org", ip: "203.0.113.9" });
    expect(row!.after).toMatchObject({ reason: "different_company", links: 3, people: 2, sessionsEnded: 1 });
  });

  it("forgets every approval and every welcome, so nothing from the old company applies to the new one by accident", async () => {
    await clearRosterOfOtherCompany("2222", admin);
    expect(await db.select().from(heldAddress)).toEqual([]);
    expect((await db.select().from(parent)).every((p) => p.welcomedAt === null && !p.welcomeOwed)).toBe(true);
    // The new company happens to reuse the old IDs for other families, with the same address under two of them.
    await seedShape();
    await seedCache([fam("12", "Stranger Family"), par("13", "Someone Else", "12", "ana@example.com"), fam("20", "Another Family"), par("21", "Other", "20", "ana@example.com")]);
    await seedParentSettings(SIGNINS_ON);
    await runReconcile({ cause: "test" });
    expect((await db.select().from(guardian)).filter((l) => l.status !== "disabled")).toEqual([]);   // held: the old approval is gone
  });

  it("saves a snapshot of the old company's families, people and approvals", async () => {
    await clearRosterOfOtherCompany("2222", admin);
    const snap = await getPreviousCompany();
    expect(snap).toMatchObject({ realmId: "1111", newRealmId: "2222", approvals: [{ email: "ana@example.com", familyQboIds: ["12", "20"] }] });
    expect(snap!.families.map((f) => [f.qboId, f.name, f.people.map((p) => p.email), f.decision])).toEqual([
      ["12", "Rivera Family", ["ana@example.com"], null], ["20", "Chen Family", ["ana@example.com", "mei@example.com"], null]]);
    expect(snap!.families[0]!.people[0]!.welcomedAt).toBe("2026-11-01T12:00:00.000Z");
  });

  it("does none of it when the same company is connected again", async () => {
    expect(await clearRosterOfOtherCompany("1111", admin)).toBe(false);
    expect((await db.select().from(guardian)).every((l) => l.status === "active")).toBe(true);
    expect(await getPreviousCompany()).toBeNull();
  });

  it("deletes the snapshot after 90 days, or when an Admin says so, and audits it", async () => {
    await clearRosterOfOtherCompany("2222", admin);
    expect(await expirePreviousCompany(new Date(Date.now() + 89 * 86_400_000))).toBe(false);
    expect(await expirePreviousCompany(new Date(Date.now() + 91 * 86_400_000))).toBe(true);
    expect(await getPreviousCompany()).toBeNull();
    expect((await audits("settings.parents.save")).at(-1)!.after).toEqual({ previousCompany: "deleted", reason: "expired" });
  });
});
```

`tests/integration/parents-matches.test.ts` (same setup; after `clearRosterOfOtherCompany("2222", admin)` seed a connected row with `seedConnected(stub, { realmId: "2222" })`, `seedShape()`, and the new cache below):

```ts
const NEW = [fam("87", "Rivera Family"), par("88", "Ana Rivera", "87", "ana@example.com"), fam("90", "Chen Family"), par("91", "Ana Rivera", "90", "ana@example.com"), par("92", "Mei Chen", "90", "mei@example.com"), fam("95", "Brand New Family")];
const settingsAdmin = { ...admin, permission: "Settings.Parents.ReadWrite" };

describe("the match review", () => {
  // beforeEach: the company-change setup above, then clearRosterOfOtherCompany("2222", admin), seedConnected(stub, { realmId: "2222" }), seedShape(), seedCache(NEW)

  it("suggests each old family's counterpart with the reason", async () => {
    const r = await matchReview();
    expect(r!.suggestions.map((s) => [s.old.name, s.suggested?.qboId, s.nameMatches, s.addressesMatched, s.strong])).toEqual([
      ["Rivera Family", "87", true, 1, true], ["Chen Family", "90", true, 2, true]]);
    expect(r!.families.map((f) => f.qboId)).toEqual(["95", "90", "87"]);            // by name: Brand New, Chen, Rivera
  });

  it("accepting a match records it for good, carries the approval and the welcome over, and grants nothing by itself", async () => {
    expect(await decideMatch("12", "87", settingsAdmin)).toEqual({ ok: true });
    expect(await decideMatch("20", "90", settingsAdmin)).toEqual({ ok: true });
    expect((await db.select().from(familyMatch)).map((m) => [m.oldRealmId, m.oldFamilyQboId, m.newRealmId, m.newFamilyQboId]).sort())
      .toEqual([["1111", "12", "2222", "87"], ["1111", "20", "2222", "90"]]);
    expect((await db.select().from(heldAddress))[0]).toMatchObject({ email: "ana@example.com", approvedFamilyQboIds: ["87", "90"] });
    expect((await db.select().from(parent)).every((p) => p.welcomedAt !== null)).toBe(true);
    expect((await db.select().from(guardian)).filter((l) => l.status !== "disabled")).toEqual([]);     // sign-ins are still off
    expect((await audits("parent.match.decided"))[0]!.after).toEqual({ decision: "matched", oldFamilyQboId: "12", newFamilyQboId: "87" });

    await seedParentSettings({ signin: true, welcome: true });
    const r = await runReconcile({ cause: "test" });
    expect(r).toMatchObject({ granted: 3, welcomeOwed: 0 });                                             // Ana in both, Mei in one; nobody is welcomed twice
  });

  it("a person who is not part of an accepted match is new: owed a welcome once welcomes are on", async () => {
    await seedParentSettings({ signin: true, welcome: true });
    expect((await runReconcile({ cause: "test" })).welcomeOwed).toBe(1);                                 // Mei; Ana is held (no approval carried over)
  });

  it("refuses a family that isn't there, one already used, and a second decision on a matched family", async () => {
    expect(await decideMatch("12", "999", settingsAdmin)).toEqual({ ok: false, errors: ["Choose a family from the list."] });
    expect(await decideMatch("nope", "87", settingsAdmin)).toEqual({ ok: false, errors: ["That family isn't in the previous company's list."] });
    await decideMatch("12", "87", settingsAdmin);
    expect(await decideMatch("20", "87", settingsAdmin)).toEqual({ ok: false, errors: ["That family is already matched to another one."] });
    expect(await decideMatch("12", "90", settingsAdmin)).toEqual({ ok: false, errors: ["That family is already matched."] });
  });

  it("rejecting records the decision and nothing else; a rejected family can still be matched later", async () => {
    expect(await decideMatch("12", null, settingsAdmin)).toEqual({ ok: true });
    expect(await db.select().from(familyMatch)).toEqual([]);
    expect((await matchReview())!.suggestions[0]).toMatchObject({ decision: "rejected" });
    expect(await decideMatch("12", "87", settingsAdmin)).toEqual({ ok: true });
  });

  it("accepts every strong suggestion at once", async () => {
    expect(await acceptStrongMatches(settingsAdmin)).toEqual({ accepted: 2 });
    expect(await db.select().from(familyMatch)).toHaveLength(2);
    expect(await acceptStrongMatches(settingsAdmin)).toEqual({ accepted: 0 });
  });

  it("has nothing to review once the snapshot is gone, or when another company is connected", async () => {
    await db.update(qboConnection).set({ realmId: "3333" });
    expect(await matchReview()).toBeNull();
    await db.update(qboConnection).set({ realmId: "2222" });
    await deletePreviousCompany({ ...settingsAdmin, reason: "admin" });
    expect(await matchReview()).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tests/unit/parents-matches.test.ts tests/integration/parents-company-change.test.ts tests/integration/parents-matches.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/lib/parents/company-change.ts`**

```ts
import { z } from "zod";
import { eq, inArray, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, heldAddress, parent, qboCustomer, setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getParentSettings, putParentSettings, PARENTS_KEY } from "./settings";

export const PREVIOUS_COMPANY_KEY = "parents.previous_company";
export const PREVIOUS_COMPANY_KEEP_MS = 90 * 86_400_000;

const family = z.object({
  qboId: z.string(), name: z.string(),
  people: z.array(z.object({ parentId: z.string(), name: z.string(), email: z.string(), welcomedAt: z.string().nullable() })),
  decision: z.enum(["matched", "rejected"]).nullable(), matchedTo: z.string().nullable(),
});
const stored = z.object({ realmId: z.string(), newRealmId: z.string(), at: z.string(), families: z.array(family),
  approvals: z.array(z.object({ email: z.string(), familyQboIds: z.array(z.string()) })) });
export type PreviousFamily = z.infer<typeof family>;
export type PreviousCompany = z.infer<typeof stored>;

const numeric = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

export async function getPreviousCompany(tx?: Tx): Promise<PreviousCompany | null> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, PREVIOUS_COMPANY_KEY));
  const parsed = stored.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

export async function putPreviousCompany(tx: Tx, value: PreviousCompany): Promise<void> {
  await tx.insert(setting).values({ key: PREVIOUS_COMPANY_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
}

/**
 * Called inside `clearRosterOfOtherCompany`, before the cache is deleted (the family names come from it). QuickBooks
 * IDs are small numbers that mean a different customer in every company, so nothing keyed by them may survive: every
 * link closes, every approval and "already welcomed" goes into the snapshot and out of the live tables, and sign-ins
 * and welcomes switch off until an Admin has looked at the new company (spec §6).
 */
export async function clearParentAccess(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  const open = await tx.select({ g: guardian, p: parent }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId)).where(ne(guardian.status, "disabled"));
  const ids = [...new Set(open.map((r) => r.g.familyQboId))].sort(numeric);
  const names = new Map((ids.length ? await tx.select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName }).from(qboCustomer).where(inArray(qboCustomer.qboId, ids)) : [])
    .map((c) => [c.qboId, c.name]));
  const families: PreviousFamily[] = ids.map((qboId) => ({
    qboId, name: names.get(qboId) ?? `Family ${qboId}`, decision: null, matchedTo: null,
    people: open.filter((r) => r.g.familyQboId === qboId).sort((a, b) => a.p.email.localeCompare(b.p.email))
      .map((r) => ({ parentId: r.p.id, name: r.p.name, email: r.p.email, welcomedAt: r.p.welcomedAt?.toISOString() ?? null })),
  }));
  const approvals = (await tx.select().from(heldAddress)).filter((h) => h.approvedFamilyQboIds.length)
    .map((h) => ({ email: h.email, familyQboIds: h.approvedFamilyQboIds }));

  for (const { g } of open) {
    await tx.update(guardian).set({ status: "disabled", disabledReason: "company_changed", statusBeforeDisable: g.status, updatedAt: new Date() }).where(eq(guardian.id, g.id));
  }
  const ended = await tx.execute<{ id: string }>(sql`DELETE FROM parent_auth_session RETURNING id`);
  await tx.delete(heldAddress);
  await tx.update(parent).set({ welcomedAt: null, welcomeOwed: false, welcomeTriedAt: null });
  const before = await getParentSettings(tx);
  await putParentSettings(tx, { ...before, signin: false, welcome: false });
  await putPreviousCompany(tx, { realmId: o.fromRealmId, newRealmId: o.toRealmId, at: new Date().toISOString(), families, approvals });
  await writeAudit({ actor: o.actor, action: "parent.access.cleared", targetType: "setting", targetId: PARENTS_KEY, ip: o.ip,
    before: { signin: before.signin, welcome: before.welcome },
    after: { reason: "different_company", links: open.length, people: new Set(open.map((r) => r.p.id)).size, sessionsEnded: Array.from(ended as ArrayLike<{ id: string }>).length } }, tx);
}

export async function deletePreviousCompany(o: { actor: Actor; ip: string | null; permission?: string; reason: "admin" | "expired" }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.delete(setting).where(eq(setting.key, PREVIOUS_COMPANY_KEY)).returning({ key: setting.key });
    if (!rows.length) return false;
    await writeAudit({ actor: o.actor, action: "settings.parents.save", permission: o.permission, targetType: "setting", targetId: PREVIOUS_COMPANY_KEY, ip: o.ip,
      after: { previousCompany: "deleted", reason: o.reason } }, tx);
    return true;
  });
}

/** The snapshot holds names and addresses from a company the club left; it goes 90 days after the switch (spec §6). */
export async function expirePreviousCompany(now: Date = new Date()): Promise<boolean> {
  const prev = await getPreviousCompany();
  if (!prev || now.getTime() - Date.parse(prev.at) < PREVIOUS_COMPANY_KEEP_MS) return false;
  return deletePreviousCompany({ actor: { door: "system", id: null, label: "worker" }, ip: null, reason: "expired" });
}
```

The realm IDs live only in the setting and the audit row; no page shows them.

In `src/lib/roster/source.ts`, inside `clearRosterOfOtherCompany`, directly after the `if (from === null || from === realmId) return false;` line and before the deletes:

```ts
    await clearParentAccess(tx, { fromRealmId: from, toRealmId: realmId, actor: o.actor, ip: o.ip });
```

(import it from `@/lib/parents/company-change`; that module must not import anything from `src/lib/roster/`.)

In `src/lib/jobs/runner.ts`, after the review-notice lines: `await expirePreviousCompany(now);`

- [ ] **Step 4: Write `src/lib/parents/matches.ts`**

```ts
import { eq, inArray, isNull, and, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { familyMatch, heldAddress, parent } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import type { StaffOp } from "./people";
import { loadDecision, reconcileAccess } from "./reconcile";
import { getPreviousCompany, putPreviousCompany, type PreviousCompany } from "./company-change";

export type NewFamily = { qboId: string; name: string; emails: string[] };
export type MatchSuggestion = {
  old: { qboId: string; name: string; emails: string[] };
  suggested: { qboId: string; name: string } | null; nameMatches: boolean; addressesMatched: number; strong: boolean;
  decision: "matched" | "rejected" | null; matchedTo: { qboId: string; name: string } | null;
};

const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
const numeric = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/**
 * For each family of the previous company, the family of the connected one it most likely is (spec §6). Pure. A
 * suggestion needs a matching name or a matching address: an ID alone means nothing across companies. More matching
 * addresses beat a matching name; ties go to the lower ID. A new family is suggested for at most one old family.
 */
export function suggestMatches(prev: PreviousCompany, families: NewFamily[]): MatchSuggestion[] {
  const taken = new Set(prev.families.map((f) => f.matchedTo).filter((id): id is string => id !== null));
  const byId = new Map(families.map((f) => [f.qboId, f]));
  return prev.families.map((f) => {
    const emails = [...new Set(f.people.map((p) => p.email))].sort();
    const old = { qboId: f.qboId, name: f.name, emails };
    const matched = f.matchedTo ? { qboId: f.matchedTo, name: byId.get(f.matchedTo)?.name ?? `Family ${f.matchedTo}` } : null;
    if (f.decision === "matched") return { old, suggested: null, nameMatches: false, addressesMatched: 0, strong: false, decision: f.decision, matchedTo: matched };
    const scored = families.filter((n) => !taken.has(n.qboId)).map((n) => ({ n, name: sameName(n.name, f.name), hits: emails.filter((e) => n.emails.includes(e)).length }))
      .filter((s) => s.name || s.hits > 0)
      .sort((a, b) => b.hits - a.hits || Number(b.name) - Number(a.name) || numeric(a.n.qboId, b.n.qboId));
    const best = scored[0];
    if (!best) return { old, suggested: null, nameMatches: false, addressesMatched: 0, strong: false, decision: f.decision, matchedTo: null };
    taken.add(best.n.qboId);
    return { old, suggested: { qboId: best.n.qboId, name: best.n.name }, nameMatches: best.name, addressesMatched: best.hits,
      strong: best.name && emails.length > 0 && best.hits === emails.length, decision: f.decision, matchedTo: null };
  });
}

/** The connected company's families with every address the rules saw under them, granted or held. */
async function newFamilies(): Promise<NewFamily[] | null> {
  const loaded = await loadDecision();
  if (!loaded) return null;
  const emails = new Map<string, Set<string>>();
  const add = (familyQboId: string, email: string | null) => { if (email) emails.set(familyQboId, (emails.get(familyQboId) ?? new Set()).add(email)); };
  for (const g of loaded.decision.grants) add(g.familyQboId, g.email);
  for (const d of loaded.decision.denials) if (d.reason === "held") add(d.familyQboId, d.email);
  const all = loaded.roster.kind === "flat" ? loaded.roster.members : loaded.roster.families.map((f) => f.customer);
  return all.filter((c) => c.active).map((c) => ({ qboId: c.qboId, name: c.displayName, emails: [...(emails.get(c.qboId) ?? [])].sort() }));
}

/** What the match review page shows. Null when there is no snapshot, or it was made for a company that isn't the connected one. */
export async function matchReview(): Promise<{ suggestions: MatchSuggestion[]; families: { qboId: string; name: string }[] } | null> {
  const [prev, conn, families] = await Promise.all([getPreviousCompany(), getConnection(), newFamilies()]);
  if (!prev || !families || conn?.realmId !== prev.newRealmId) return null;
  return { suggestions: suggestMatches(prev, families),
    families: families.map((f) => ({ qboId: f.qboId, name: f.name })).sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || numeric(a.qboId, b.qboId)) };
}

/**
 * Accepts (`newFamilyQboId` set) or rejects (null) a match. Accepting records it for good, carries over the approvals
 * that involved the old family and the welcome history of its people, then runs the reconcile. It never grants access
 * by itself: that still comes only from the connected company's roster, and only while sign-ins are on.
 */
export async function decideMatch(oldFamilyQboId: string, newFamilyQboId: string | null, o: StaffOp): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const families = await newFamilies();
  return db.transaction(async (tx): Promise<{ ok: true } | { ok: false; errors: string[] }> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    const prev = await getPreviousCompany(tx);
    const conn = await getConnection(tx);
    const old = prev?.families.find((f) => f.qboId === oldFamilyQboId);
    if (!prev || !old || conn?.realmId !== prev.newRealmId) return { ok: false, errors: ["That family isn't in the previous company's list."] };
    if (old.decision === "matched") return { ok: false, errors: ["That family is already matched."] };
    const audit = (after: Record<string, unknown>) => writeAudit({ actor: o.actor, action: "parent.match.decided", permission: o.permission,
      targetType: "family_match", targetId: oldFamilyQboId, ip: o.ip, after }, tx);
    const save = (decision: "matched" | "rejected", matchedTo: string | null) =>
      putPreviousCompany(tx, { ...prev, families: prev.families.map((f) => (f.qboId === oldFamilyQboId ? { ...f, decision, matchedTo } : f)) });
    if (newFamilyQboId === null) {
      await save("rejected", null);
      await audit({ decision: "rejected", oldFamilyQboId });
      return { ok: true };
    }
    if (!families?.some((f) => f.qboId === newFamilyQboId)) return { ok: false, errors: ["Choose a family from the list."] };
    if (prev.families.some((f) => f.matchedTo === newFamilyQboId)) return { ok: false, errors: ["That family is already matched to another one."] };
    await tx.insert(familyMatch).values({ oldRealmId: prev.realmId, oldFamilyQboId, newRealmId: prev.newRealmId, newFamilyQboId, decidedBy: o.actor.id });
    for (const a of prev.approvals.filter((x) => x.familyQboIds.includes(oldFamilyQboId))) {
      await tx.insert(heldAddress).values({ email: a.email }).onConflictDoNothing();
      const [row] = await tx.select().from(heldAddress).where(eq(heldAddress.email, a.email)).for("update");
      const approved = [...new Set([...row!.approvedFamilyQboIds, newFamilyQboId])].sort(numeric);
      await tx.update(heldAddress).set({ approvedFamilyQboIds: approved, updatedAt: new Date() }).where(eq(heldAddress.email, a.email));
    }
    for (const p of old.people.filter((x) => x.welcomedAt)) {
      await tx.update(parent).set({ welcomedAt: new Date(p.welcomedAt!), welcomeOwed: false, updatedAt: new Date() }).where(and(eq(parent.id, p.parentId), isNull(parent.welcomedAt)));
    }
    await save("matched", newFamilyQboId);
    await audit({ decision: "matched", oldFamilyQboId, newFamilyQboId });
    await reconcileAccess(tx, { cause: "match" });
    return { ok: true };
  });
}

/** **Accept all strong matches**: every suggestion whose name and every address match (spec §6). */
export async function acceptStrongMatches(o: StaffOp): Promise<{ accepted: number }> {
  const review = await matchReview();
  let accepted = 0;
  for (const s of review?.suggestions ?? []) {
    if (s.strong && s.decision === null && s.suggested && (await decideMatch(s.old.qboId, s.suggested.qboId, o)).ok) accepted++;
  }
  return { accepted };
}
```

Remove the unused `inArray` import if the linter reports it. `getConnection` accepts an optional transaction (it is called with one in `refresh.ts`).

- [ ] **Step 5: Run the tests and the checks**

Run: `pnpm vitest run tests/unit/parents-matches.test.ts tests/integration/parents-company-change.test.ts tests/integration/parents-matches.test.ts tests/integration/roster-company.test.ts tests/integration/quickbooks-connection.test.ts tests/integration/jobs-runner.test.ts`
Expected: PASS, the three existing files unchanged.
Run: `pnpm typecheck && pnpm lint`. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(parents): a company change closes all access and keeps a snapshot; matches carry decisions over"
```

---
### Task 9: Staff pages for parents, the roster's sign-in box, and family names for parents

**Files:**
- Create: `src/app/staff/(app)/parents/page.tsx`, `src/app/staff/(app)/parents/[id]/page.tsx`, `src/app/staff/(app)/parents/actions.ts`, `src/app/staff/(app)/parents/forms.tsx`, `src/app/staff/(app)/parents-review.tsx`
- Modify: `src/app/staff/(app)/layout.tsx` (menu), `src/app/staff/(app)/page.tsx` (home notice), `src/app/staff/(app)/roster/[id]/page.tsx` (sign-ins box), `src/lib/roster/attention.ts`, `src/lib/roster/queries.ts`, `src/app/(parent)/layout.tsx`, `src/app/choose-family/page.tsx`
- Test: `tests/integration/parents-pages.test.ts`; update expectations in `tests/integration/roster-pages.test.ts`, `tests/integration/roster-queries.test.ts`, `tests/unit/roster-attention.test.ts` where the new Needs attention kinds add items

**Interfaces:**
- Consumes: `heldReview`, `listPeople`, `getPerson`, `familySignins`, `familyNames` (Task 6); `decideHold`, `reverseHold` (Task 6); `blockPerson`, `unblockPerson` (Task 6); `resendWelcome` (Task 5); `reviewWaiting` (Task 7); `loadDecision` (Task 3); `staffAction`, `requireStaffPage` (`src/lib/guards.ts`).
- Produces (server actions, all `staffAction("Parents.ReadWrite", …)`):

```ts
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
export const decideHoldAction: (email: string, decision: "same_person" | "not_same", note: string) => Promise<Done>;
export const reverseHoldAction: (email: string, note: string) => Promise<Done>;
export const blockAction: (parentId: string, reason: string) => Promise<Done>;
export const unblockAction: (parentId: string) => Promise<Done>;
export const resendWelcomeAction: (parentId: string) => Promise<Done>;
```

- [ ] **Step 1: Write the failing tests**

`tests/integration/parents-pages.test.ts`. Copy the mocks at the top of `tests/integration/roster-pages.test.ts` (identity, `next/headers`, `next/cache`, `next/navigation`; the `qboEndpoints` mock is not needed) and its `who`, `thrown` and `audits` helpers. Then:

```ts
import ParentsPage from "@/app/staff/(app)/parents/page";
import PersonPage from "@/app/staff/(app)/parents/[id]/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import StaffHome from "@/app/staff/(app)/page";
import ChooseFamily from "@/app/choose-family/page";
import { decideHoldAction, reverseHoldAction, blockAction, unblockAction, resendWelcomeAction } from "@/app/staff/(app)/parents/actions";

const ALL = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), par("13", "Shared Sam", "10", "sam@example.com"),
  fam("20", "Chen <b>Family</b>"), par("21", "Shared Sam", "20", "sam@example.com")];
const parentsPage = async (q?: string) => renderToStaticMarkup(await ParentsPage({ searchParams: Promise.resolve(q ? { q } : {}) }));
const personPage = async (id: string) => renderToStaticMarkup(await PersonPage({ params: Promise.resolve({ id }) }));
const familyPage = async (id: string) => renderToStaticMarkup(await RosterEntryPage({ params: Promise.resolve({ id }) }));

describe("the staff pages for parents", () => {
  let registrar: Awaited<ReturnType<typeof seedStaff>>, reader: Awaited<ReturnType<typeof seedStaff>>;
  const as = (s: typeof registrar) => { who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email }; };
  beforeEach(async () => {
    await resetDb(); await seedShape(); await seedParentSettings(SIGNINS_ON); await seedCache(ALL);
    await db.transaction((tx) => setRosterSource(tx, "9130000000000001"));
    await db.insert(jobRun).values({ job: ROSTER_JOB, startedBy: "worker", finishedAt: new Date(), outcome: "ok" });
    await runReconcile({ cause: "test" });
    registrar = await seedStaff({ email: "reg@club.org", name: "Reg Istrar" });
    reader = await seedStaff({ email: "reader@club.org", name: "Rae Der" });
    const [parents] = await db.insert(role).values({ key: "parents", name: "Parents" }).returning();
    await db.insert(roleRule).values([{ roleId: parents!.id, kind: "include", pattern: "Parents.*" }, { roleId: parents!.id, kind: "include", pattern: "Roster.*" }]);
    await db.insert(roleAssignment).values({ roleId: parents!.id, staffUserId: registrar.id });
    const [roster] = await db.insert(role).values({ key: "roster", name: "Roster" }).returning();
    await db.insert(roleRule).values({ roleId: roster!.id, kind: "include", pattern: "Roster.*" });
    await db.insert(roleAssignment).values({ roleId: roster!.id, staffUserId: reader.id });
    as(registrar);
  });

  it("refuses the Parents pages and every action without Parents.ReadWrite", async () => {
    as(reader);
    const [ana] = await db.select().from(parent);
    expect((await thrown(ParentsPage({ searchParams: Promise.resolve({}) }))).url).toBe("/refused");
    expect((await thrown(PersonPage({ params: Promise.resolve({ id: ana!.id }) }))).url).toBe("/refused");
    await expect(decideHoldAction("sam@example.com", "same_person", "note")).rejects.toBeInstanceOf(AccessDenied);
    await expect(reverseHoldAction("sam@example.com", "note")).rejects.toBeInstanceOf(AccessDenied);
    await expect(blockAction(ana!.id, "reason")).rejects.toBeInstanceOf(AccessDenied);
    await expect(unblockAction(ana!.id)).rejects.toBeInstanceOf(AccessDenied);
    await expect(resendWelcomeAction(ana!.id)).rejects.toBeInstanceOf(AccessDenied);
    expect(await audits("parent.read")).toEqual([]);
  });

  it("lists what is waiting with both families and the names on the records, as text", async () => {
    const html = await parentsPage();
    expect(html).toContain("To review (1)");
    expect(html).toContain("sam@example.com");
    expect(html).toContain("Rivera Family");
    expect(html).toContain("Chen &lt;b&gt;Family&lt;/b&gt;");
    expect(html).not.toContain("<b>Family</b>");
    expect(html).toContain("Same person");
    expect(html).toContain("Not the same person");
  });

  it("lists people and finds them, and says where names and addresses are changed", async () => {
    const html = await parentsPage();
    expect(html).toContain("Ana Rivera");
    expect(html).toContain("Can sign in (hasn&#x27;t yet)");
    expect(html).toContain("Names and email addresses are changed in QuickBooks");
    expect(await parentsPage("zzz")).toContain("Nobody matches");
  });

  it("deciding and reversing go through the actions, and the page follows", async () => {
    expect(await decideHoldAction("sam@example.com", "same_person", "Sam confirmed by phone.")).toEqual({ ok: true, message: "Saved. They can sign in to each of those families now." });
    expect(await parentsPage()).toContain("Nothing is waiting");
    expect((await audits("parent.hold.decided"))[0]).toMatchObject({ actorId: registrar.id, permission: "Parents.ReadWrite", ip: "203.0.113.40" });
    expect(await decideHoldAction("sam@example.com", "same_person", "Again.")).toEqual({ ok: false, errors: ["That address isn't held any more. Reload the page."] });
    expect(await decideHoldAction("sam@example.com", "same_person", "  ")).toEqual({ ok: false, errors: ["Add a short note saying how you know."] });
    expect(await reverseHoldAction("sam@example.com", "Wrong after all.")).toEqual({ ok: true, message: "Reversed. The address is held again." });
    expect(await parentsPage()).toContain("To review (1)");
  });

  it("a person's page shows their families and is recorded as a read", async () => {
    const [ana] = await db.select().from(parent);
    const html = await personPage(ana!.id);
    expect(html).toContain("Ana Rivera");
    expect(html).toContain("Rivera Family");
    expect(html).toContain("Resend welcome email");
    expect(html).toContain("Block");
    expect(await audits("parent.read")).toEqual([expect.objectContaining({ actorId: registrar.id, permission: "Parents.ReadWrite", targetType: "parent", targetId: ana!.id })]);
    expect((await thrown(PersonPage({ params: Promise.resolve({ id: "not-an-id" }) }))).notFound).toBe(true);
  });

  it("blocks with a reason and unblocks, through the actions", async () => {
    const [ana] = await db.select().from(parent);
    expect(await blockAction(ana!.id, "  ")).toEqual({ ok: false, errors: ["Say why, in a few words. Only staff see it."] });
    expect(await blockAction(ana!.id, "Custody order on file.")).toEqual({ ok: true, message: "Blocked. They are signed out and can't get a code." });
    const html = await personPage(ana!.id);
    expect(html).toContain("Blocked");
    expect(html).toContain("Custody order on file.");
    expect(html).toContain("Unblock");
    expect(await unblockAction(ana!.id)).toEqual({ ok: true, message: "Unblocked." });
  });

  it("a family's roster page shows each sign-in's standing; only Parents.ReadWrite sees the other family and gets links", async () => {
    const [ana] = await db.select().from(parent);
    const detailed = await familyPage("10");
    expect(detailed).toContain("Held: this address is also under Chen &lt;b&gt;Family&lt;/b&gt;");
    expect(detailed).toContain(`href="/staff/parents/${ana!.id}"`);
    as(reader);
    const plain = await familyPage("10");
    expect(plain).toContain("Can sign in (hasn&#x27;t yet)");
    expect(plain).toContain("Held: this address is also under another family");
    expect(plain).not.toContain("Chen");
    expect(plain).not.toContain("/staff/parents/");
  });

  it("the staff home tells people who can act that something is waiting, and nobody else", async () => {
    expect(renderToStaticMarkup(await StaffHome())).toContain("1 address to review");
    as(reader);
    expect(renderToStaticMarkup(await StaffHome())).not.toContain("to review");
  });

  it("Needs attention on the roster lists the new kinds without naming a held address's families", async () => {
    const page = await loadRosterPage();
    expect(page.attention.map((a) => a.rule)).toEqual(expect.arrayContaining(["held_address", "family_no_signin"]));
    const held = page.attention.find((a) => a.rule === "held_address")!;
    expect(`${held.name}${held.detail}`).not.toMatch(/Rivera|Chen|sam@example\.com/);
  });
});
```

Add one test to `tests/integration/choose-family-action.test.ts` (or a new block in `parents-pages.test.ts` if that file's mocks fit better): with the cache holding `fam("10", "Rivera Family")` and a parent whose session is in the `choose` state with families `10` and `NOPE`, the rendered `ChooseFamily` page contains `Rivera Family` and `Family account NOPE`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tests/integration/parents-pages.test.ts`
Expected: FAIL (the pages don't exist).

- [ ] **Step 3: Needs attention gains the new kinds**

`src/lib/roster/attention.ts`: `import type { AccessFlagRule } from "@/lib/parents/access-rules";` and widen the rule type:

```ts
export type AttentionRule = "family_no_parent" | "family_no_student" | "not_under_family" | "family_is_sub" | "no_email" | "same_email" | "signin_unknown" | "inactive_with_signin" | AccessFlagRule;
```

`src/lib/roster/queries.ts`: `import { loadDecision } from "@/lib/parents/reconcile";` and in `loadRosterPage`, where `attention` is built:

```ts
  // The sign-in rules' own findings (parents spec §1 What is flagged), shown whether or not sign-ins are switched on yet.
  const access = roster && shape ? (await loadDecision())?.decision.flags ?? [] : [];
  // ...
    attention: roster && shape ? [...needsAttention(roster, shape, people), ...access] : [], signIns: people, types: typeRows,
```

`reconcile.ts` imports only `roster/shape` and `roster/model`, so this is not a cycle. Existing tests that count Needs attention items now see extra `family_no_signin`, `bad_email`, `many_addresses`, `held_address` or `name_differs` items: update those expectations, adding the new items and removing none.

- [ ] **Step 4: The actions**

`src/app/staff/(app)/parents/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { decideHold, reverseHold, type HoldDecision } from "@/lib/parents/holds";
import { blockPerson, unblockPerson } from "@/lib/parents/people";
import { resendWelcome } from "@/lib/parents/welcome";

const P = "Parents.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const op = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
const refresh = () => revalidatePath("/staff", "layout");

export const decideHoldAction = staffAction(P, async (ctx, email: string, decision: HoldDecision, note: string): Promise<Done> => {
  if (decision !== "same_person" && decision !== "not_same") return { ok: false, errors: ["Choose one of the two answers."] };
  const r = await decideHold(String(email), decision, String(note), op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: decision === "same_person" ? "Saved. They can sign in to each of those families now." : "Saved. The address stays held until the records are corrected in QuickBooks." };
});

export const reverseHoldAction = staffAction(P, async (ctx, email: string, note: string): Promise<Done> => {
  const r = await reverseHold(String(email), String(note), op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Reversed. The address is held again." };
});

export const blockAction = staffAction(P, async (ctx, parentId: string, reason: string): Promise<Done> => {
  const r = await blockPerson(String(parentId), String(reason), op(ctx));
  if (!r.ok) return { ok: false, errors: [r.reason === "invalid" ? "Say why, in a few words. Only staff see it." : "That person isn't in the portal any more."] };
  refresh();
  return { ok: true, message: "Blocked. They are signed out and can't get a code." };
});

export const unblockAction = staffAction(P, async (ctx, parentId: string): Promise<Done> => {
  const r = await unblockPerson(String(parentId), op(ctx));
  if (!r.ok) return { ok: false, errors: ["That person isn't in the portal any more."] };
  refresh();
  return { ok: true, message: "Unblocked." };
});

const RESEND_FAILED = {
  not_found: "That person isn't in the portal any more.", blocked: "This person is blocked, so no email was sent.",
  no_access: "This person can't sign in to any family right now, so no email was sent.", mail_failed: "The email couldn't be sent. Check outgoing mail under Mail.",
} as const;
export const resendWelcomeAction = staffAction(P, async (ctx, parentId: string): Promise<Done> => {
  const r = await resendWelcome(String(parentId), op(ctx));
  if (!r.ok) return { ok: false, errors: [RESEND_FAILED[r.reason]] };
  refresh();
  return { ok: true, message: "Sent." };
});
```

- [ ] **Step 5: The client forms**

`src/app/staff/(app)/parents/forms.tsx`:

```tsx
"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";

// No form `action` on the forms with a text field: React resets a form after one, and the note would vanish on a
// refusal. State is the source of truth; a type="button" calls the action inside startTransition (see
// settings/quickbooks/forms.tsx).
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();
function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return state.ok ? <p role="status">{state.message}</p> : <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>;
}

/** One held address: a note and the two answers (spec §4 To review). */
export function HoldForm({ email, decide }: { email: string; decide: (email: string, decision: "same_person" | "not_same", note: string) => Promise<Done> }) {
  const [note, setNote] = useState("");
  const [state, run, pending] = useActionState(async (_: Done | null, decision: "same_person" | "not_same") => safely(() => decide(email, decision, note), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>How do you know? (staff only)</span>
        <textarea name="note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <Outcome state={state} />
      <div className="row-actions">
        <button type="button" className="btn" disabled={pending} onClick={() => startTransition(() => run("same_person"))}>Same person</button>
        <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run("not_same"))}>Not the same person</button>
      </div>
    </form>
  );
}

/** A text field and one button: used to reverse a decision and to block a person. */
export function NoteAction({ label, field, pendingLabel, act }: { label: string; field: string; pendingLabel: string; act: (text: string) => Promise<Done> }) {
  const [text, setText] = useState("");
  const [state, run, pending] = useActionState(async () => safely(() => act(text), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>{field}</span><textarea rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? pendingLabel : label}</button>
    </form>
  );
}

/** One button, nothing to type: a plain form action is fine here. */
export function OneButton({ label, pendingLabel, act }: { label: string; pendingLabel: string; act: () => Promise<Done> }) {
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  return (
    <form action={run} className="stack">
      <Outcome state={state} />
      <button className="btn btn-line" disabled={pending}>{pending ? pendingLabel : label}</button>
    </form>
  );
}
```

- [ ] **Step 6: The Parents page and a person's page**

`src/app/staff/(app)/parents/page.tsx`:

```tsx
import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { heldReview, listPeople } from "@/lib/parents/directory";
import { getParentSettings } from "@/lib/parents/settings";
import { LocalTime } from "@/app/components/local-time";
import { HoldForm, NoteAction } from "./forms";
import { decideHoldAction, reverseHoldAction } from "./actions";

export const metadata = { title: "Parents" };
export const dynamic = "force-dynamic";

export default async function ParentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaffPage("Parents.ReadWrite");
  const sp = await searchParams;
  const typed = (typeof sp.q === "string" ? sp.q : "").slice(0, 100);
  const [review, people, settings] = await Promise.all([heldReview(), listPeople(typed), getParentSettings()]);
  return (
    <main className="wrap single">
      <h1 className="page-title">Parents</h1>
      <p className="lede">Who can sign in to the portal, and why someone can&apos;t. People come from QuickBooks. Names and email addresses are changed in QuickBooks, not here; a missing parent is added in QuickBooks, then the roster is refreshed.</p>
      {!settings.signin && <p role="status">{settings.everEnabled ? "Parent sign-ins are switched off, so nobody can sign in right now." : "Parent sign-ins haven't been switched on yet. An Admin does that under Parent sign-ins."}</p>}

      <section className="box" aria-labelledby="review-h"><h2 id="review-h">To review ({review.waiting.length})</h2>
        {review.waiting.length === 0 ? <p>Nothing is waiting.</p> : (
          <>
            <p>Each address below is under more than one family in QuickBooks. Nobody at that address can sign in to the families marked held until you say whether it is one person. If it is a copying mistake, choose Not the same person and have the records corrected in QuickBooks.</p>
            <ul className="lines">{review.waiting.map((h) => (
              <li key={h.email}><div className="stack">
                <span className="what">{h.email}</span>
                <span className="when">On records named: {h.names.join(", ")}</span>
                <ul>{h.families.map((f) => <li key={f.qboId}>{f.name}{f.held ? " (held)" : " (already approved)"}</li>)}</ul>
                <HoldForm email={h.email} decide={decideHoldAction} />
              </div></li>))}</ul>
          </>
        )}
      </section>

      {review.decided.length > 0 && (
        <section className="box" aria-labelledby="decided-h"><h2 id="decided-h">Decided</h2>
          <ul className="lines">{review.decided.map((d) => (
            <li key={d.email}><div className="stack">
              <span className="what">{d.email}</span>
              <span className="when">
                {d.approved.length ? `Same person in ${d.approved.join(", ")}. ` : ""}{d.rejected.length ? `Not the same person in ${d.rejected.join(", ")}. ` : ""}
                {d.decidedBy ? `Decided by ${d.decidedBy}` : "Decided"}{d.decidedAt ? <> <LocalTime iso={d.decidedAt} /></> : null}{d.note ? `: ${d.note}` : "."}
              </span>
              <details><summary>Reverse this decision</summary>
                <p>The address is held again for every family, and anyone it let in is signed out of those families.</p>
                <NoteAction label="Reverse" field="Why? (staff only)" pendingLabel="Reversing…" act={reverseHoldAction.bind(null, d.email)} />
              </details>
            </div></li>))}</ul>
        </section>
      )}

      <section className="box" aria-labelledby="people-h"><h2 id="people-h">People</h2>
        <form method="get" role="search" className="stack">
          <label className="field"><span>Find a person by name or email</span><input name="q" type="search" defaultValue={typed} autoComplete="off" /></label>
          <button className="btn btn-line">Find</button>
        </form>
        {people.length === 0 ? <p>{typed ? "Nobody matches." : "Nobody yet."}</p> : (
          <ul className="lines">{people.map((p) => (
            <li key={p.parentId}><div>
              <Link className="what" href={`/staff/parents/${p.parentId}`}>{p.name}</Link>
              <span className="when">{p.email}{p.blocked ? " · Blocked" : ""}</span>
              <span className="when">{p.families.map((f) => `${f.familyName}: ${f.words}`).join(" · ") || "No families"}</span>
            </div></li>))}</ul>
        )}
      </section>
    </main>
  );
}
```

`src/app/staff/(app)/parents/[id]/page.tsx`:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { writeAudit } from "@/lib/audit/log";
import { getPerson } from "@/lib/parents/directory";
import { LocalTime } from "@/app/components/local-time";
import { NoteAction, OneButton } from "../forms";
import { blockAction, unblockAction, resendWelcomeAction } from "../actions";

export const metadata = { title: "Parent" };
export const dynamic = "force-dynamic";

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Parents.ReadWrite");
  const { id } = await params;
  const p = await getPerson(id);
  if (!p) notFound();
  // A staff read of family data (spec §7): recorded before anything is shown.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "parent.read", permission: "Parents.ReadWrite",
    targetType: "parent", targetId: p.parentId, ip: ctx.ip });
  const canSignIn = !p.blocked && p.families.some((f) => f.kind === "can");
  return (
    <main className="wrap single">
      <h1 className="page-title">{p.name}</h1>
      <p className="lede">{p.email}. <Link href="/staff/parents">Back to Parents</Link></p>

      <section className="box" aria-labelledby="pf-h"><h2 id="pf-h">Families</h2>
        {p.families.length === 0 ? <p>This person isn&apos;t linked to any family.</p> : (
          <ul className="lines">{p.families.map((f) => (
            <li key={f.familyQboId}><div><Link className="what" href={`/staff/roster/${encodeURIComponent(f.familyQboId)}`}>{f.familyName}</Link><span className="when">{f.words}</span></div></li>))}</ul>
        )}
        <dl className="details">
          <dt>Last signed in</dt><dd>{p.lastSigninAt ? <LocalTime iso={p.lastSigninAt} /> : "Never"}</dd>
          <dt>Welcome email</dt><dd>{p.welcomedAt ? <>Sent <LocalTime iso={p.welcomedAt} /></> : p.welcomeOwed ? "Waiting to be sent" : "Not sent"}</dd>
        </dl>
        <p className="hint">The name and email address come from QuickBooks. To change them, change the customer in QuickBooks and refresh the roster.</p>
      </section>

      <section className="box" aria-labelledby="pw-h"><h2 id="pw-h">Welcome email</h2>
        <p>Sends the welcome again, now: where to sign in, and that they sign in with this address and a code.</p>
        {canSignIn ? <OneButton label="Resend welcome email" pendingLabel="Sending…" act={resendWelcomeAction.bind(null, p.parentId)} />
          : <p>{p.blocked ? "This person is blocked, so no email can be sent." : "This person can't sign in to any family right now, so there is nothing to welcome them to."}</p>}
      </section>

      <section className="box" aria-labelledby="pb-h"><h2 id="pb-h">{p.blocked ? "Blocked" : "Block"}</h2>
        {p.blocked ? (
          <>
            <p>Blocked{p.blockedAt ? <> <LocalTime iso={p.blockedAt} /></> : null}. Reason: {p.blockedReason ?? "none recorded"}</p>
            <p>Unblocking gives back exactly the access they had.</p>
            <OneButton label="Unblock" pendingLabel="Unblocking…" act={unblockAction.bind(null, p.parentId)} />
          </>
        ) : (
          <>
            <p>Blocking signs this person out of every family at once and stops sign-in codes. They aren&apos;t told. Use it for a custody matter or misuse; a family that has left is handled by making it inactive in QuickBooks.</p>
            <NoteAction label="Block" field="Why? (staff only)" pendingLabel="Blocking…" act={blockAction.bind(null, p.parentId)} />
          </>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 7: The roster's sign-in box, the home notice, the menu, and family names for parents**

`src/app/staff/(app)/roster/[id]/page.tsx`: replace the `SignIns` component and its use. Load with `const detailed = can(ctx.effective, "Parents.ReadWrite"); const signins = await familySignins(qboId, { detailed });` after the entry is found, and render:

```tsx
function SignIns({ signins, detailed }: { signins: FamilySignin[]; detailed: boolean }) {
  return (
    <section className="box" aria-labelledby="entry-signins-h"><h2 id="entry-signins-h">Portal sign-ins</h2>
      <p>Who can sign in to the portal for this QuickBooks customer, and why someone can&apos;t.</p>
      {signins.length === 0 ? <p>Nobody can sign in for it yet.</p> : <ul className="lines">{signins.map((s) => (
        <li key={`${s.parentId ?? "none"}|${s.name}|${s.email ?? ""}`}><div>
          {detailed && s.parentId ? <Link className="what" href={`/staff/parents/${s.parentId}`}>{s.name}</Link> : <span className="what">{s.name}</span>}
          <span className="when">{s.email ? `${s.email} · ` : ""}{s.words}</span>
        </div></li>))}</ul>}
    </section>
  );
}
```

Remove the now-unused `STATUS` map and `SignIn` import there. `entry.signIns` stays on `RosterEntry` (Needs attention still uses it).

`src/app/staff/(app)/parents-review.tsx`:

```tsx
import { reviewWaiting } from "@/lib/parents/review-notice";

/** On the staff home for people who can decide held addresses, while any are waiting (parents spec §5). */
export async function ParentsReview() {
  const waiting = await reviewWaiting();
  if (!waiting) return null;
  return (
    <section className="box" role="status" aria-labelledby="parents-review-h"><h2 id="parents-review-h">Parent sign-ins</h2>
      <p>{waiting} {waiting === 1 ? "address" : "addresses"} to review. Nobody at {waiting === 1 ? "that address" : "those addresses"} can sign in until someone decides.</p>
      <p className="box-foot"><a className="btn btn-line" href="/staff/parents">Open Parents</a></p>
    </section>
  );
}
```

`src/app/staff/(app)/page.tsx`: after the QuickBooks warning line add `{can(ctx.effective, "Parents.ReadWrite") && <ParentsReview />}`.

`src/app/staff/(app)/layout.tsx`: after the Roster entry add `...(can(e, "Parents.ReadWrite") ? [{ href: "/staff/parents", label: "Parents" }] : []),`.

`src/app/choose-family/page.tsx`: load `const names = await familyNames(families.map((f) => f.familyQboId));` and show `{names.get(f.familyQboId)}` on each button in place of `familyLabel(f.familyQboId)`.
`src/app/(parent)/layout.tsx`: the same for the "Viewing …" line: `const names = ctx.families.length > 1 ? await familyNames([ctx.familyQboId]) : null;` and `Viewing {names!.get(ctx.familyQboId)}.`. `familyLabel` stays (it is `familyNames`' fallback).

- [ ] **Step 8: Run the tests and the checks**

Run: `pnpm vitest run tests/integration/parents-pages.test.ts tests/integration/roster-pages.test.ts tests/integration/roster-queries.test.ts tests/unit/roster-attention.test.ts tests/integration/choose-family-action.test.ts tests/integration/invariants.test.ts tests/unit/parent-nav.test.ts`
Expected: PASS (after the expectation updates named in Step 3).
Run: `pnpm typecheck && pnpm lint`. Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(parents): staff pages for held addresses, people and blocking; sign-in standing on the roster"
```

---

### Task 10: The Parent sign-ins settings pages and the match review

**Files:**
- Create: `src/app/staff/(app)/settings/parents/page.tsx`, `src/app/staff/(app)/settings/parents/setup/page.tsx`, `src/app/staff/(app)/settings/parents/matches/page.tsx`, `src/app/staff/(app)/settings/parents/actions.ts`, `src/app/staff/(app)/settings/parents/forms.tsx`
- Modify: `src/app/staff/(app)/layout.tsx` (menu), `src/app/staff/(app)/settings/quickbooks/page.tsx` and `forms.tsx` (the Disconnect warning)
- Test: `tests/integration/settings-parents.test.ts`

**Interfaces:**
- Consumes: `accessPreview`, `setSignins`, `setWelcome`, `setRequireStudents`, `setReviewEmails`, `peopleWithAccess` (Tasks 4, 5); `matchReview`, `decideMatch`, `acceptStrongMatches` (Task 8); `getPreviousCompany`, `deletePreviousCompany` (Task 8); `welcomeMessage` (Task 5).
- Produces (server actions, all `staffAction("Settings.Parents.ReadWrite", …)`, each returning `{ ok: true; message: string } | { ok: false; errors: string[] }`): `setSigninsAction(on: boolean)`, `setWelcomeAction(on: boolean)`, `setRequireStudentsAction(on: boolean)`, `setReviewEmailsAction(on: boolean)`, `decideMatchAction(oldFamilyQboId: string, newFamilyQboId: string | null)`, `acceptStrongMatchesAction()`, `deletePreviousCompanyAction()`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/settings-parents.test.ts`: copy the mocks and stub lifecycle of `tests/integration/roster-pages.test.ts` (this file needs the `qboEndpoints` mock because the pages read the connection). Then:

```ts
import ParentSettingsPage from "@/app/staff/(app)/settings/parents/page";
import ParentSetupPage from "@/app/staff/(app)/settings/parents/setup/page";
import MatchesPage from "@/app/staff/(app)/settings/parents/matches/page";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import { setSigninsAction, setWelcomeAction, setRequireStudentsAction, setReviewEmailsAction, decideMatchAction, acceptStrongMatchesAction, deletePreviousCompanyAction } from "@/app/staff/(app)/settings/parents/actions";

const ROSTER = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10"), par("13", "No Mail", "10", null),
  fam("20", "Chen Family"), par("21", "Shared Sam", "20", "sam@example.com"), fam("30", "Lee Family"), par("31", "Shared Sam", "30", "sam@example.com")];
const view = async () => renderToStaticMarkup(await ParentSettingsPage());
const setup = async (step?: string) => renderToStaticMarkup(await ParentSetupPage({ searchParams: Promise.resolve(step ? { step } : {}) }));

describe("the Parent sign-ins settings", () => {
  let admin: Awaited<ReturnType<typeof seedStaff>>;
  beforeEach(async () => {
    await resetDb(); stub.reset();
    admin = await seedStaff({ email: "admin@club.org", name: "Ad Min", admin: true });
    who.staff = { door: "staff", staffUserId: admin.id, name: admin.name, email: admin.email };
  });
  const ready = async () => {
    await seedConnected(stub); await seedShape(); await seedCache(ROSTER); await seedWorkingMail();
    await db.transaction((tx) => setRosterSource(tx, "9130000000000001"));
    await db.insert(jobRun).values({ job: ROSTER_JOB, startedBy: "worker", finishedAt: new Date(), outcome: "ok" });
  };

  it("is Admin only: a role with every grantable permission is refused, pages and actions alike", async () => {
    const other = await seedStaff({ email: "reg@club.org" });
    const [r] = await db.insert(role).values({ key: "all", name: "All" }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "*" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: other.id });
    who.staff = { door: "staff", staffUserId: other.id, name: other.name, email: other.email };
    expect((await thrown(ParentSettingsPage())).url).toBe("/refused");
    expect((await thrown(ParentSetupPage({ searchParams: Promise.resolve({}) }))).url).toBe("/refused");
    expect((await thrown(MatchesPage())).url).toBe("/refused");
    for (const call of [() => setSigninsAction(true), () => setWelcomeAction(true), () => setRequireStudentsAction(true), () => setReviewEmailsAction(false),
      () => decideMatchAction("12", "87"), () => acceptStrongMatchesAction(), () => deletePreviousCompanyAction()]) {
      await expect(call()).rejects.toBeInstanceOf(AccessDenied);
    }
  });

  it("the view shows what is set, plainly, with no inputs", async () => {
    await ready();
    const html = await view();
    expect(html).toContain("Not switched on yet");
    expect(html).toContain("Welcome emails");
    expect(html).not.toMatch(/<textarea|<select|<input(?![^>]*type="hidden")/);   // React may add hidden fields to a form; nothing to type into
    expect(html).toContain('href="/staff/settings/parents/setup"');
  });

  it("step 1 previews the numbers and what needs fixing, and says what is missing before anything can be switched on", async () => {
    expect(await setup()).toContain("Connect QuickBooks first.");
    await ready();
    const html = await setup("preview");
    expect(html).toContain("1 person would be able to sign in, to 1 family.");
    expect(html).toContain("sam@example.com");
    expect(html).toContain("No Mail");
    expect(html).toContain("Chen Family");
    expect(await audits("settings.parents.save")).toEqual([]);
  });

  it("switching sign-ins on, then welcomes, through the actions", async () => {
    await ready();
    expect(await setSigninsAction(true)).toEqual({ ok: true, message: "Parent sign-ins are on." });
    expect(await view()).toContain("<dd>On</dd>");
    expect((await audits("settings.parents.save"))[0]).toMatchObject({ actorId: admin.id, permission: "Settings.Parents.ReadWrite", ip: "203.0.113.40" });
    const welcome = await setup("welcome");
    expect(welcome).toContain("1 person would be emailed now.");
    expect(welcome).toContain("You can now sign in to");
    expect(await setWelcomeAction(true)).toEqual({ ok: true, message: "Welcome emails are on. They go out a few each minute." });
    expect(await setSigninsAction(false)).toEqual({ ok: true, message: "Parent sign-ins are off. Every parent has been signed out." });
    expect(await view()).toContain("Switched off");
  });

  it("refuses to switch on with the reasons, and changes nothing", async () => {
    expect(await setSigninsAction(true)).toMatchObject({ ok: false, errors: expect.arrayContaining(["Connect QuickBooks first."]) });
    expect(await audits("settings.parents.save")).toEqual([]);
  });

  it("the active-students and review-email options are saved through their actions", async () => {
    await ready(); await setSigninsAction(true);
    expect(await setRequireStudentsAction(true)).toEqual({ ok: true, message: "Saved. Families with no active student can't sign in." });
    expect(await setReviewEmailsAction(false)).toEqual({ ok: true, message: "Saved. Staff won't be emailed; the notice on the staff home stays." });
    expect(await getParentSettings()).toMatchObject({ requireActiveStudents: true, reviewEmails: false });
  });

  it("the QuickBooks page warns before a disconnect when parents can sign in", async () => {
    await ready(); await setSigninsAction(true);
    const html = renderToStaticMarkup(await QuickBooksSettingsPage());
    expect(html).toContain("1 person can sign in to the portal now. Connecting a different QuickBooks company afterwards ends all of that access");
  });

  it("the match review lists suggestions, and its actions decide them", async () => {
    await ready(); await setSigninsAction(true);
    await db.insert(heldAddress).values({ email: "sam@example.com", approvedFamilyQboIds: ["20", "30"] }).onConflictDoUpdate({ target: heldAddress.email, set: { approvedFamilyQboIds: ["20", "30"] } });
    await runReconcile({ cause: "test" });
    await clearRosterOfOtherCompany("2222", { actor: { door: "staff", id: admin.id, label: admin.email }, ip: null });
    expect((await thrown(MatchesPage())).url).toBe("/staff/settings/parents");          // nothing to review until the new roster is read
    await db.update(qboConnection).set({ realmId: "2222" });
    await seedShape(); await seedCache([fam("87", "Rivera Family"), par("88", "Ana Rivera", "87", "ana@example.com"), fam("90", "Chen Family"), par("91", "Shared Sam", "90", "sam@example.com")]);
    const html = renderToStaticMarkup(await MatchesPage());
    expect(html).toContain("Rivera Family");
    expect(html).toContain("name matches, 1 of 1 addresses match");
    expect(html).toContain("Accept all strong matches");
    expect(html).not.toMatch(/1111|2222|9130000000000001/);                                  // company IDs are on no page
    expect(await view()).toContain('href="/staff/settings/parents/matches"');
    expect(await acceptStrongMatchesAction()).toEqual({ ok: true, message: "Accepted 2 matches." });
    expect(await decideMatchAction("30", null)).toEqual({ ok: true, message: "Saved." });
    expect(await deletePreviousCompanyAction()).toEqual({ ok: true, message: "Deleted." });
    expect(await view()).not.toContain("/staff/settings/parents/matches");
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run tests/integration/settings-parents.test.ts`
Expected: FAIL.

- [ ] **Step 3: The actions**

`src/app/staff/(app)/settings/parents/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { setSignins, setWelcome, setRequireStudents, setReviewEmails } from "@/lib/parents/switches";
import { decideMatch, acceptStrongMatches } from "@/lib/parents/matches";
import { deletePreviousCompany } from "@/lib/parents/company-change";

const P = "Settings.Parents.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const op = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
const done = (r: { ok: true } | { ok: false; errors: string[] }, message: string): Done => {
  if (!r.ok) return r;
  revalidatePath("/staff", "layout");
  return { ok: true, message };
};

export const setSigninsAction = staffAction(P, async (ctx, on: boolean): Promise<Done> =>
  done(await setSignins(on === true, op(ctx)), on === true ? "Parent sign-ins are on." : "Parent sign-ins are off. Every parent has been signed out."));
export const setWelcomeAction = staffAction(P, async (ctx, on: boolean): Promise<Done> =>
  done(await setWelcome(on === true, op(ctx)), on === true ? "Welcome emails are on. They go out a few each minute." : "Welcome emails are off."));
export const setRequireStudentsAction = staffAction(P, async (ctx, on: boolean): Promise<Done> =>
  done(await setRequireStudents(on === true, op(ctx)), on === true ? "Saved. Families with no active student can't sign in." : "Saved. Students no longer affect who can sign in."));
export const setReviewEmailsAction = staffAction(P, async (ctx, on: boolean): Promise<Done> =>
  done(await setReviewEmails(on === true, op(ctx)), on === true ? "Saved. Staff are emailed when there is something new to review." : "Saved. Staff won't be emailed; the notice on the staff home stays."));

export const decideMatchAction = staffAction(P, async (ctx, oldFamilyQboId: string, newFamilyQboId: string | null): Promise<Done> =>
  done(await decideMatch(String(oldFamilyQboId), newFamilyQboId === null ? null : String(newFamilyQboId), op(ctx)), "Saved."));
export const acceptStrongMatchesAction = staffAction(P, async (ctx): Promise<Done> => {
  const { accepted } = await acceptStrongMatches(op(ctx));
  return done({ ok: true }, `Accepted ${accepted} ${accepted === 1 ? "match" : "matches"}.`);
});
export const deletePreviousCompanyAction = staffAction(P, async (ctx): Promise<Done> => {
  await deletePreviousCompany({ ...op(ctx), reason: "admin" });
  return done({ ok: true }, "Deleted.");
});
```

- [ ] **Step 4: The client forms**

`src/app/staff/(app)/settings/parents/forms.tsx`:

```tsx
"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };
function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return state.ok ? <p role="status">{state.message}</p> : <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>;
}

/** One button for one switch. Nothing is typed, so a plain form action is fine. */
export function SwitchButton({ label, pendingLabel, quiet, act }: { label: string; pendingLabel: string; quiet?: boolean; act: () => Promise<Done> }) {
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  return (
    <form action={run} className="stack">
      <Outcome state={state} />
      <button className={quiet ? "btn btn-line" : "btn"} disabled={pending}>{pending ? pendingLabel : label}</button>
    </form>
  );
}

/** One old family: accept the chosen counterpart, or reject. The select is state, so a refusal keeps the choice. */
export function MatchRow({ oldId, suggested, families, decide }: {
  oldId: string; suggested: string | null; families: { qboId: string; name: string }[];
  decide: (oldFamilyQboId: string, newFamilyQboId: string | null) => Promise<Done>;
}) {
  const [choice, setChoice] = useState(suggested ?? "");
  const [state, run, pending] = useActionState(async (_: Done | null, to: string | null) => safely(() => decide(oldId, to), failed), null);
  return (
    <form onSubmit={(e) => e.preventDefault()} className="stack">
      <label className="field"><span>The same family in the connected company</span>
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose a family</option>
          {families.map((f) => <option key={f.qboId} value={f.qboId}>{f.name}</option>)}
        </select></label>
      <Outcome state={state} />
      <div className="row-actions">
        <button type="button" className="btn" disabled={pending || !choice} onClick={() => startTransition(() => run(choice))}>Accept</button>
        <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run(null))}>No match</button>
      </div>
    </form>
  );
}
```

- [ ] **Step 5: The view**

`src/app/staff/(app)/settings/parents/page.tsx`:

```tsx
import { requireStaffPage } from "@/lib/guards";
import { accessPreview } from "@/lib/parents/switches";
import { matchReview } from "@/lib/parents/matches";
import { getPreviousCompany } from "@/lib/parents/company-change";
import { LocalTime } from "@/app/components/local-time";
import { SwitchButton } from "./forms";
import { setRequireStudentsAction, setReviewEmailsAction, deletePreviousCompanyAction } from "./actions";

export const metadata = { title: "Parent sign-ins" };
export const dynamic = "force-dynamic";
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What is set, shown plainly, with no inputs (the pattern the QuickBooks page set). Switching anything opens the steps. */
export default async function ParentSettingsPage() {
  await requireStaffPage("Settings.Parents.ReadWrite");
  const [p, review, previous] = await Promise.all([accessPreview(), matchReview(), getPreviousCompany()]);
  const s = p.settings;
  return (
    <main className="wrap single">
      <h1 className="page-title">Parent sign-ins</h1>
      <p className="lede">Parents in QuickBooks can sign in to the portal with their email address and a code. Nobody is invited one by one: who can sign in follows the roster, once this is switched on. Only Admins can change this.</p>

      <section className="box" aria-labelledby="ps-status-h"><h2 id="ps-status-h">What is set</h2>
        <dl className="details">
          <dt>Parent sign-ins</dt><dd>{s.signin ? "On" : s.everEnabled ? "Switched off. Nobody can sign in." : "Not switched on yet"}</dd>
          <dt>Who can sign in</dt><dd>{s.signin ? `${n(p.people, "person", "people")}, to ${n(p.families, "family", "families")}` : "Nobody yet"}</dd>
          <dt>Welcome emails</dt><dd>{s.welcome ? "On: each new person is emailed once" : "Off: nobody is emailed"}</dd>
          <dt>Waiting for staff</dt><dd>{n(p.held.filter((h) => h.pending).length, "address", "addresses")} to review</dd>
        </dl>
        <p><a className="btn" href="/staff/settings/parents/setup">{s.everEnabled ? "Change" : "Set up"}</a></p>
      </section>

      <section className="box" aria-labelledby="ps-options-h"><h2 id="ps-options-h">Options</h2>
        <h3>Families with no active student</h3>
        {p.students.offered ? (
          <>
            <p>{s.requireActiveStudents ? "On: a family with no active student in QuickBooks can't sign in." : `Off: students don't affect who can sign in. Switching this on would close ${n(p.students.families, "family", "families")} (${n(p.students.people, "person", "people")}) now.`}</p>
            <SwitchButton quiet label={s.requireActiveStudents ? "Let those families sign in" : "Require an active student"} pendingLabel="Saving…" act={setRequireStudentsAction.bind(null, !s.requireActiveStudents)} />
          </>
        ) : <p>Not available: the membership shape doesn&apos;t say which customers are students.</p>}
        <h3>Emails to staff</h3>
        <p>{s.reviewEmails ? "On: people who can review held addresses get one email when there is something new, at most once a day." : "Off: nobody is emailed. The notice on the staff home still shows."}</p>
        <SwitchButton quiet label={s.reviewEmails ? "Stop these emails" : "Send these emails"} pendingLabel="Saving…" act={setReviewEmailsAction.bind(null, !s.reviewEmails)} />
      </section>

      {previous && (
        <section className="box" aria-labelledby="ps-prev-h"><h2 id="ps-prev-h">The previous QuickBooks company</h2>
          <p>A different QuickBooks company was connected <LocalTime iso={previous.at} />. All parent access from the old company ended then. The portal kept a list of the old company&apos;s {n(previous.families.length, "family", "families")} and who could sign in to them, so decisions made there can be carried over.</p>
          {review ? <p><a className="btn" href="/staff/settings/parents/matches">Review matches</a></p>
            : <p>The matches can be reviewed once the new company&apos;s roster has been read and a membership shape chosen.</p>}
          <details><summary>Delete this list</summary>
            <p>It is deleted by itself 90 days after the switch. Matches already accepted are kept.</p>
            <SwitchButton quiet label="Delete the list now" pendingLabel="Deleting…" act={deletePreviousCompanyAction} />
          </details>
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 6: The steps**

`src/app/staff/(app)/settings/parents/setup/page.tsx`:

```tsx
import { requireStaffPage } from "@/lib/guards";
import { env } from "@/env";
import { accessPreview } from "@/lib/parents/switches";
import { currentBrand } from "@/lib/mail/send";
import { getStoredMailConfig } from "@/lib/mail/settings";
import { welcomeMessage } from "@/lib/mail/messages";
import { SwitchButton } from "../forms";
import { setSigninsAction, setWelcomeAction } from "../actions";

export const metadata = { title: "Set up parent sign-ins" };
export const dynamic = "force-dynamic";

type Step = "preview" | "signins" | "welcome";
const STEPS: { step: Step; label: string }[] = [{ step: "preview", label: "1. Clean-up preview" }, { step: "signins", label: "2. Parent sign-ins" }, { step: "welcome", label: "3. Welcome emails" }];
const SETUP = "/staff/settings/parents/setup";
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export default async function ParentSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaffPage("Settings.Parents.ReadWrite");
  const sp = await searchParams;
  const asked = STEPS.find((s) => s.step === (typeof sp.step === "string" ? sp.step : ""))?.step;
  const p = await accessPreview();
  const step: Step = asked ?? (p.settings.signin ? "welcome" : "preview");
  const missing = [
    ...(p.ready.connected ? [] : ["Connect QuickBooks first."]), ...(p.ready.shape ? [] : ["Choose the membership shape first."]),
    ...(p.ready.rosterFresh ? [] : ["Refresh the roster first: it hasn't been read in the last 2 days."]), ...(p.ready.mail ? [] : ["Set up outgoing mail and send a test email first."]),
  ];
  const names = (rows: { name: string }[]) => rows.map((r) => r.name).join(", ");
  const sample = step === "welcome" ? welcomeMessage(await currentBrand(), "parent@example.org", {
    appUrl: env.APP_URL.replace(/\/+$/, ""), contact: await getStoredMailConfig().then((m) => (m ? (m.method === "graph" ? m.mailbox : m.from) : null)) }) : null;
  return (
    <main className="wrap single">
      <h1 className="page-title">Set up parent sign-ins</h1>
      <ol className="setup-progress">{STEPS.map((s) => <li key={s.step} aria-current={s.step === step ? "step" : undefined}><a href={`${SETUP}?step=${s.step}`}>{s.label}</a></li>)}</ol>

      {step === "preview" && (
        <section className="box" aria-labelledby="pp-h"><h2 id="pp-h">Step 1: What would happen</h2>
          {missing.length > 0 && <ul role="status">{missing.map((m) => <li key={m}>{m}</li>)}</ul>}
          {p.ready.shape && (
            <>
              <p><b>{n(p.people, "person", "people")} would be able to sign in, to {n(p.families, "family", "families")}.</b></p>
              <p>Nothing below stops you switching on. The people listed just can&apos;t sign in until it is fixed. Fix records in QuickBooks, choose Refresh now on the Roster, and open this page again.</p>
              <h3>Addresses under more than one family ({p.held.length})</h3>
              {p.held.length === 0 ? <p>None.</p> : <ul>{p.held.map((h) => <li key={h.email}>{h.email}: {h.families.map((f) => f.name).join(", ")}</li>)}</ul>}
              <p className="hint">These are held until someone with access to Parents says whether each is one person.</p>
              <h3>No email address ({p.noEmail.length})</h3><p>{p.noEmail.length ? names(p.noEmail) : "None."}</p>
              <h3>More than one address on a person&apos;s record ({p.manyAddresses.length})</h3><p>{p.manyAddresses.length ? names(p.manyAddresses) : "None."}</p>
              <h3>Nobody could sign in ({p.noSignin.length})</h3><p>{p.noSignin.length ? names(p.noSignin) : "None."}</p>
              <h3>Sign-ins that would end ({p.ending.length})</h3>
              {p.ending.length === 0 ? <p>None.</p> : <ul>{p.ending.map((e) => <li key={`${e.email}|${e.familyQboId}`}>{e.name} ({e.email})</li>)}</ul>}
              <p className="hint">These were made by hand and QuickBooks doesn&apos;t list them, so they stop working when sign-ins are switched on.</p>
            </>
          )}
          <p className="box-foot"><a className="btn" href={`${SETUP}?step=signins`}>Next: parent sign-ins</a> <a href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}

      {step === "signins" && (
        <section className="box" aria-labelledby="psi-h"><h2 id="psi-h">Step 2: Parent sign-ins</h2>
          {p.settings.signin ? (
            <>
              <p>Parent sign-ins are on. {n(p.people, "person", "people")} can sign in, to {n(p.families, "family", "families")}.</p>
              <details><summary>Switch parent sign-ins off</summary>
                <p>Every parent is signed out at once and nobody can sign in until this is switched on again. Nothing is deleted.</p>
                <SwitchButton quiet label="Switch parent sign-ins off" pendingLabel="Switching off…" act={setSigninsAction.bind(null, false)} />
              </details>
            </>
          ) : missing.length > 0 ? (
            <><p>Not yet:</p><ul role="status">{missing.map((m) => <li key={m}>{m}</li>)}</ul></>
          ) : (
            <>
              {p.settings.everEnabled && <p role="status">Parent sign-ins are off. Nobody can sign in.</p>}
              <p>Switching on lets {n(p.people, "person", "people")} sign in, to {n(p.families, "family", "families")}{p.ending.length ? `, and ends ${n(p.ending.length, "sign-in", "sign-ins")} made by hand` : ""}. No email is sent: welcome emails are step 3.</p>
              <SwitchButton label="Switch parent sign-ins on" pendingLabel="Switching on…" act={setSigninsAction.bind(null, true)} />
            </>
          )}
          <p className="box-foot"><a href={`${SETUP}?step=welcome`}>Next: welcome emails</a> · <a href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}

      {step === "welcome" && sample && (
        <section className="box" aria-labelledby="pw-h"><h2 id="pw-h">Step 3: Welcome emails</h2>
          <p>{p.settings.welcome ? "Welcome emails are on. Each new person is emailed once, when they first get access." : "Welcome emails are off. Nobody has been emailed by switching sign-ins on."}</p>
          {!p.settings.welcome && <p><b>{n(p.welcomeNow, "person", "people")} would be emailed now.</b> After that, each new person is emailed once. They go out a few each minute.</p>}
          <h3>The email</h3>
          <p>Subject: {sample.subject}</p>
          <pre>{sample.text}</pre>
          {!p.settings.signin ? <p role="status">Switch parent sign-ins on first (step 2).</p>
            : p.settings.welcome ? <SwitchButton quiet label="Switch welcome emails off" pendingLabel="Switching off…" act={setWelcomeAction.bind(null, false)} />
            : <SwitchButton label="Switch welcome emails on" pendingLabel="Switching on…" act={setWelcomeAction.bind(null, true)} />}
          <p className="box-foot"><a href="/staff/settings/parents">Back to Parent sign-ins</a></p>
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 7: The match review page**

`src/app/staff/(app)/settings/parents/matches/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { matchReview } from "@/lib/parents/matches";
import { MatchRow, SwitchButton } from "../forms";
import { decideMatchAction, acceptStrongMatchesAction } from "../actions";

export const metadata = { title: "Review matches" };
export const dynamic = "force-dynamic";

export default async function MatchesPage() {
  await requireStaffPage("Settings.Parents.ReadWrite");
  const review = await matchReview();
  if (!review) redirect("/staff/settings/parents");
  const open = review.suggestions.filter((s) => s.decision !== "matched");
  const strong = open.filter((s) => s.strong && s.decision === null).length;
  const why = (s: (typeof open)[number]) => !s.suggested ? "No likely match found."
    : `Suggested: ${s.suggested.name} (${s.nameMatches ? "name matches" : "name differs"}, ${s.addressesMatched} of ${s.old.emails.length} addresses match).`;
  return (
    <main className="wrap single">
      <h1 className="page-title">Review matches</h1>
      <p className="lede">Each family from the previous QuickBooks company, beside the family it most likely is in the connected one. Accepting a match carries over decisions made about that family and remembers who was already welcomed. It never lets anyone sign in: that comes only from the connected company&apos;s roster. <a href="/staff/settings/parents">Back to Parent sign-ins</a></p>

      {strong > 0 && (
        <section className="box" aria-labelledby="mm-strong-h"><h2 id="mm-strong-h">Strong matches ({strong})</h2>
          <p>The name matches and every address that could sign in before is under the suggested family.</p>
          <SwitchButton label="Accept all strong matches" pendingLabel="Accepting…" act={acceptStrongMatchesAction} />
        </section>
      )}

      <section className="box" aria-labelledby="mm-open-h"><h2 id="mm-open-h">To decide ({open.length})</h2>
        {open.length === 0 ? <p>Every family has been matched.</p> : (
          <ul className="lines">{open.map((s) => (
            <li key={s.old.qboId}><div className="stack">
              <span className="what">{s.old.name}</span>
              <span className="when">{s.old.emails.length ? `Could sign in: ${s.old.emails.join(", ")}` : "Nobody could sign in"}{s.decision === "rejected" ? " · Marked as no match" : ""}</span>
              <span className="when">{why(s)}</span>
              <MatchRow oldId={s.old.qboId} suggested={s.suggested?.qboId ?? null} families={review.families} decide={decideMatchAction} />
            </div></li>))}</ul>
        )}
      </section>

      <section className="box" aria-labelledby="mm-done-h"><h2 id="mm-done-h">Matched</h2>
        {review.suggestions.filter((s) => s.decision === "matched").length === 0 ? <p>None yet.</p> : (
          <ul>{review.suggestions.filter((s) => s.decision === "matched").map((s) => <li key={s.old.qboId}>{s.old.name} is now {s.matchedTo?.name}</li>)}</ul>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 8: The menu and the Disconnect warning**

`src/app/staff/(app)/layout.tsx`: after the QuickBooks entry add `...(can(e, "Settings.Parents.ReadWrite") ? [{ href: "/staff/settings/parents", label: "Parent sign-ins" }] : []),`.

`src/app/staff/(app)/settings/quickbooks/forms.tsx`: `Disconnect` takes an optional `warning?: string` and shows `<p role="status">{warning}</p>` inside the `<details>`, above the button, when it is given.
`src/app/staff/(app)/settings/quickbooks/page.tsx`: load `const [settings, people] = await Promise.all([getParentSettings(), peopleWithAccess()]);` and pass

```tsx
warning={settings.signin && people > 0 ? `${people} ${people === 1 ? "person" : "people"} can sign in to the portal now. Connecting a different QuickBooks company afterwards ends all of that access, switches parent sign-ins and welcome emails off, and needs them set up again. Reconnecting this same company changes nothing.` : undefined}
```

- [ ] **Step 9: Run the tests and the checks**

Run: `pnpm vitest run tests/integration/settings-parents.test.ts tests/integration/settings-quickbooks.test.ts tests/integration/invariants.test.ts`
Expected: PASS.
Run: `pnpm typecheck && pnpm lint`. Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(parents): Admin settings for parent sign-ins, welcome emails and the match review"
```

---

### Task 11: Browser tests, the seed, and the documents

**Files:**
- Modify: `scripts/seed-e2e.ts`, `tests/e2e/quickbooks.spec.ts` (counts), `tests/e2e/parent-sign-in.spec.ts` (family names)
- Create: `tests/e2e/parents.spec.ts`
- Modify: `docs/runbooks/poc-linuxdev.md`, `docs/superpowers/specs/2026-11-11-parents-from-quickbooks-design.md`, `docs/superpowers/plans/2026-11-07-v1-roadmap.md`, `docs/ui-backlog.md`

**Interfaces:**
- Consumes: every page from Tasks 9 and 10. Produces nothing later tasks use.

The e2e run has one worker and runs every spec twice (phone, then desktop) against one database that is seeded once. Every test here must therefore leave the database as it found it, or be written to pass from either state.

- [ ] **Step 1: Extend the seed**

In `scripts/seed-e2e.ts`, add to the `qbo_customer` insert (keep the existing five rows):

```ts
          ('E2E-FAMILY', 'Quetzalcoatl Family', true, null, '1', null, null, '0'),
          ('E2E-P1', 'Zelda Quetzalcoatl', true, 'E2E-FAMILY', '2', 'zelda@example.com', null, '0'),
          ('E2E-FAMILY-2', 'Second Family', true, null, '1', null, null, '0'),
          ('E2E-P2', 'Zelda Quetzalcoatl', true, 'E2E-FAMILY-2', '2', 'zelda@example.com', null, '0'),
          ('40', 'Okafor Family', true, null, '1', null, null, '0'),
          ('41', 'Sam Okafor', true, '40', '2', 'sam@example.com', null, '0'),
          ('50', 'Lee Family', true, null, '1', null, null, '0'),
          ('51', 'Sam Okafor', true, '50', '2', 'sam@example.com', null, '0')
```

and, after it:

```ts
  // Zelda is in two families on purpose (the family chooser test), so staff have already said she is one person.
  // The parents setting is left as it is: tests/e2e/parents.spec.ts switches sign-ins on, and that state must survive
  // the second (desktop) pass of the run.
  await sql`INSERT INTO held_address (email, approved_family_qbo_ids) VALUES ('zelda@example.com', ${sql.json(["E2E-FAMILY", "E2E-FAMILY-2"])})
          ON CONFLICT (email) DO UPDATE SET approved_family_qbo_ids = EXCLUDED.approved_family_qbo_ids`;
  await sql`DELETE FROM held_address WHERE email = 'sam@example.com'`;
  await sql`DELETE FROM setting WHERE key IN ('parents.settings', 'parents.review_notice', 'parents.previous_company')`;
```

Update the job-run detail to `'13 customers, 4 customer types'`. With sign-ins switched on, the reconcile takes over Zelda's two hand-made links (same family, same address) and keeps them active, so `tests/e2e/parent-sign-in.spec.ts` passes before and after.

- [ ] **Step 2: Update the two existing specs**

- `tests/e2e/quickbooks.spec.ts`: the roster now has 6 families, 1 student, 5 parents and 1 customer outside the portal. Update each count it asserts, on the QuickBooks page and in Needs attention (search the file for `families` and `Needs attention`), and nothing else.
- `tests/e2e/parent-sign-in.spec.ts`: where it expects `Family account E2E-FAMILY` or `Family account E2E-FAMILY-2`, expect `Quetzalcoatl Family` and `Second Family`.

- [ ] **Step 3: Write `tests/e2e/parents.spec.ts`**

```ts
import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });
test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });
test.describe.configure({ mode: "serial" });

// Each test leaves things as it found them, or works from either state: the run does everything twice (phone, desktop).

test("an Admin previews, then switches parent sign-ins on (and finds them on the second time)", async ({ page }) => {
  await page.goto("/staff/settings/parents/setup?step=preview");
  await expect(page.getByRole("heading", { name: "Step 1: What would happen" })).toBeVisible();
  await expect(page.getByText("sam@example.com: Okafor Family, Lee Family")).toBeVisible();
  await page.goto("/staff/settings/parents/setup?step=signins");
  const on = page.getByRole("button", { name: "Switch parent sign-ins on" });
  if (await on.count()) {
    await on.click();
    // The page itself says so once it is on: the button that was pressed is gone by then, and its own message with it.
    await expect(page.getByText("Parent sign-ins are on.")).toBeVisible();
  }
  await page.goto("/staff/settings/parents");
  await expect(page.locator("dl.details")).toContainText("On");
  await expect(page.locator("main input:not([type=hidden]), main textarea, main select")).toHaveCount(0);
  const [{ value }] = await sql`SELECT value FROM setting WHERE key = 'parents.settings'`;
  expect(value).toMatchObject({ signin: true, everEnabled: true });
});

test("the staff home and the Parents page show the held address; deciding and reversing work and keep the note on a refusal", async ({ page }) => {
  await page.goto("/staff");
  await expect(page.getByText("1 address to review")).toBeVisible();
  await page.goto("/staff/parents");
  await expect(page.getByRole("heading", { name: "To review (1)" })).toBeVisible();
  await page.getByRole("button", { name: "Same person" }).click();
  await expect(page.getByRole("alert")).toContainText("Add a short note saying how you know.");
  await page.getByLabel("How do you know? (staff only)").fill("Sam confirmed by phone.");
  await page.getByRole("button", { name: "Same person" }).click();
  await expect(page.getByRole("heading", { name: "To review (0)" })).toBeVisible();
  await expect(page.getByText("Sam confirmed by phone.")).toBeVisible();
  // Put it back, so the second pass of the run starts from the same place.
  await page.getByText("Reverse this decision").click();
  await page.getByLabel("Why? (staff only)").fill("Reversed by the e2e run.");
  await page.getByRole("button", { name: "Reverse" }).click();
  await expect(page.getByRole("heading", { name: "To review (1)" })).toBeVisible();
});

test("a person's page: block with a reason, then unblock; the visit is in the audit log", async ({ page }) => {
  await page.goto("/staff/parents?q=ana%40example.com");
  await page.getByRole("link", { name: "Ana Rivera" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ana Rivera");
  await page.getByLabel("Why? (staff only)").fill("e2e block");
  await page.getByRole("button", { name: "Block" }).click();
  await expect(page.getByRole("heading", { name: "Blocked" })).toBeVisible();
  await expect(page.getByText("Reason: e2e block")).toBeVisible();
  await page.getByRole("button", { name: "Unblock" }).click();
  await expect(page.getByRole("heading", { name: "Block", exact: true })).toBeVisible();
  const rows = await sql`SELECT action FROM audit_log WHERE action IN ('parent.read', 'parent.block', 'parent.unblock') AND at > now() - interval '2 minutes'`;
  expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["parent.read", "parent.block", "parent.unblock"]));
});

test("a family's roster page shows who can sign in and why someone can't", async ({ page }) => {
  await page.goto("/staff/roster/40");
  await expect(page.getByRole("heading", { name: "Portal sign-ins" })).toBeVisible();
  await expect(page.getByText("Held: this address is also under Lee Family")).toBeVisible();
  await page.goto("/staff/roster/10");
  await expect(page.getByText(/ana@example\.com · Can sign in/)).toBeVisible();
});

test("the Parent sign-ins and Parents pages are refused without a staff session", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const path of ["/staff/parents", "/staff/settings/parents", "/staff/settings/parents/setup", "/staff/settings/parents/matches"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/staff\/sign-in/);
  }
  await context.close();
});
```

Welcome emails are not switched on in the browser run (the worker is not running there, and a welcome to a seeded address would land in the sink that `parent-sign-in.spec.ts` reads). They are covered in Task 5.

- [ ] **Step 4: Run the whole browser suite**

With the fake values (`DATABASE_URL=postgres://booster:booster@localhost:5433/booster_test APP_URL=http://localhost:3100 BETTER_AUTH_SECRET=ci-fake-secret-ci-fake-secret-1234567890 SETTINGS_ENCRYPTION_KEY=Y2ktZmFrZS1rZXktY2ktZmFrZS1rZXktY2ktZmFrZSE= SETUP_STATUS_CACHE_MS=0`):
`pnpm build && pnpm db:migrate && pnpm tsx scripts/seed-e2e.ts && pnpm e2e`
Expected: every spec passes on both projects (42 existing tests plus 10 new). If a test fails only on the second pass, it is leaving state behind: fix the test, not the order.

- [ ] **Step 5: The documents**

`docs/runbooks/poc-linuxdev.md`:
- Add a section "Parent sign-ins from QuickBooks" after the QuickBooks section: back up the database first (the deploy runs migration 0009); in the sandbox company give `Test Parent` an address you can read; **Refresh now**; open **Parent sign-ins** > **Set up**; read step 1 (the two hand-seeded test sign-ins on `POC-FAMILY-1` are listed under "Sign-ins that would end"); switch sign-ins on in step 2; sign in as that parent at `/sign-in`; switch welcome emails on in step 3 and wait a minute for the email.
- Add checklist items after 17: (18) the preview lists the hand-seeded sign-ins as ending and the numbers match the sandbox; (19) after switching on, the sandbox parent signs in with a code and the audit log has `settings.parents.save` and `parent.access.granted` with `cause`; (20) put the same address on a Parent customer under a second family, **Refresh now**: the staff home says "1 address to review", neither family can be signed in to, and one staff email arrives; (21) choose **Same person**: the chooser offers both families by name; (22) make the Parent customer inactive, **Refresh now**: the parent is signed out and `parent.access.ended` has reason `inactive`; (23) block and unblock from the person's page; (24) switch welcome emails on: one email arrives within two minutes and `docker logs booster-rocket-worker` shows `ran parents.welcome: ok`; (25) connect the second sandbox company: `parent.access.cleared`, sign-ins and welcomes off, and **Review matches** appears once the roster is read and a shape chosen.
- Troubleshooting rows: "The last roster refresh failed: The parent sign-ins couldn't be brought up to date … (reconcile_failed)" (the roster and access are as they were; read `docker logs booster-rocket-app` and report it); "Parent sign-in isn't available yet." after switching sign-ins off (switch them on again under **Parent sign-ins**).
- Check `scripts/worker.mjs`: if it prints each entry of `ran`, the new job names (`parents.welcome`, `parents.review_notice`) appear in the log with no change; if it names jobs itself, add them.

`docs/superpowers/specs/2026-11-11-parents-from-quickbooks-design.md`:
- Status line: "implemented by plan 2026-11-11-parents-from-quickbooks.md".
- §7 audit table: add `parent.name.changed` (the reconcile changed a person's name to match QuickBooks). Add a sentence that a code refused because sign-ins are off is recorded as `signin.code_refused` with reason `signins_off`.
- §2 What is stored: say that held-address decisions are one row per address with three sets of family IDs (approved, rejected, announced), and that the previous company's snapshot is a setting.
- §1 What is flagged: say that a held address is listed in Needs attention without the address or the families, because that list is shown to staff with only `Roster.Read`.
- §6: say that after a company change approvals and "already welcomed" are moved into the snapshot and restored only by an accepted match.
- Open questions: record what Task 2 settled (the parser splits on commas, semicolons and spaces) and that the sandbox check and the sending rate (5 a minute) are proof-of-concept items.

`docs/superpowers/plans/2026-11-07-v1-roadmap.md`: mark row 3a "**Written:** `2026-11-11-parents-from-quickbooks.md`".

`docs/ui-backlog.md`: under a new heading "Parents and Parent sign-ins (`/staff/parents`, `/staff/settings/parents`)", dated today: the pages reuse the roster's list styles and have no design of their own; the To review items stack a note field and two buttons with no visual grouping; the clean-up preview is headings and comma-separated names and will not scale to a long list; the match review needs a table on wide screens; the staff menu now has eleven entries and needs grouping (ties in with the single Settings page).

- [ ] **Step 6: Final checks**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: exit 0; every test file passes (the count grows by the files this plan adds; 4 skipped as before).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test(e2e): parent sign-ins from the roster; docs: runbook, spec and backlog for parents from QuickBooks"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** §1 → Task 2; §2 → Tasks 3 and 5; §3 → Tasks 4, 5 and 10; §4 → Tasks 6 and 9; §5 → Tasks 7 and 9; §6 → Tasks 8 and 10; §7 → every task's audit rows, Task 1's permissions, Task 11's browser tests and runbook.
- **Not built, on purpose:** the parent's own change-my-email feature has no page today, so there is nothing to switch off; `changeParentEmailByStaff` and `src/lib/parents/email-change.ts` are left as they are for the next spec.
- **Names used across tasks:** `decideAccess`, `loadDecision`, `reconcileAccess`, `runReconcile`, `accessPreview`, `setSignins`, `setWelcome`, `setRequireStudents`, `setReviewEmails`, `peopleWithAccess`, `sendOwedWelcomes`, `resendWelcome`, `decideHold`, `reverseHold`, `blockPerson`, `unblockPerson`, `accessWords`, `familyNames`, `listPeople`, `getPerson`, `familySignins`, `heldReview`, `reviewWaiting`, `sendReviewNotice`, `clearParentAccess`, `getPreviousCompany`, `deletePreviousCompany`, `expirePreviousCompany`, `suggestMatches`, `matchReview`, `decideMatch`, `acceptStrongMatches`.
