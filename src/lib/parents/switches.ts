import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, jobRun, parent, parentAuthSession, signinCode } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { connectionView } from "@/lib/quickbooks/connection";
import { mailWorking } from "@/lib/mail/settings";
import { getShape, ROSTER_LOCK } from "@/lib/roster/shape";
import { ROSTER_JOB } from "@/lib/roster/source";
import type { HeldAddress } from "./access-rules";
import type { StaffOp } from "./people";
import { loadDecision, reconcileAccess, type EndedReport } from "./reconcile";
import { getParentSettings, putParentSettings, PARENTS_KEY, type ParentSettings } from "./settings";

const FRESH_MS = 48 * 3_600_000;
export type Ready = { connected: boolean; shape: boolean; rosterFresh: boolean; mail: boolean };
export type AccessPreview = {
  ready: Ready; settings: ParentSettings; people: number; families: number; held: HeldAddress[];
  noEmail: { qboId: string; name: string }[]; manyAddresses: { qboId: string; name: string }[]; noSignin: { qboId: string; name: string }[];
  ending: { name: string; email: string; familyQboId: string }[]; welcomeNow: number;
  students: { offered: boolean; families: number; people: number };
  /** True when the list of ending sign-ins could not be worked out now because a roster refresh is running. */
  endingUnknown: boolean;
};
export type SwitchResult = { ok: true } | { ok: false; errors: string[] };

async function readiness(hasDecision: boolean): Promise<Ready> {
  const [conn, mail, [lastOk]] = await Promise.all([connectionView(), mailWorking(),
    db.select().from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1)]);
  return { connected: conn.connected, shape: hasDecision, mail,
    rosterFresh: Boolean(lastOk?.finishedAt && Date.now() - lastOk.finishedAt.getTime() <= FRESH_MS) };
}

class RolledBack extends Error {}

/**
 * The sign-ins the reconcile would close, from the reconcile itself run as if sign-ins were on and then rolled back, so
 * there is one implementation of link matching. Never waits for the roster lock: null when a refresh holds it.
 */
async function dryRunEnding(): Promise<EndedReport["ended"] | null> {
  const report: EndedReport = { ended: [] };
  let busy = false;
  try {
    await db.transaction(async (tx) => {
      const got = Array.from(await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(${ROSTER_LOCK}) as locked`))[0];
      if (!got?.locked) { busy = true; return; }
      await reconcileAccess(tx, { cause: "preview", report, assumeSignin: true });
      throw new RolledBack();
    });
  } catch (e) {
    if (!(e instanceof RolledBack)) throw e;
  }
  if (busy) return null;
  return report.ended.sort((a, b) => a.name.localeCompare(b.name) || a.familyQboId.localeCompare(b.familyQboId, "en", { numeric: true }));
}

/** What switching on would do, and what needs cleaning up first (spec §3 step 1). It changes nothing. */
export async function accessPreview(): Promise<AccessPreview> {
  const loaded = await loadDecision();
  const settings = loaded?.settings ?? (await getParentSettings());
  const ready = await readiness(loaded !== null);
  const empty = { ready, settings, people: 0, families: 0, held: [], noEmail: [], manyAddresses: [], noSignin: [], ending: [], welcomeNow: 0,
    students: { offered: false, families: 0, people: 0 }, endingUnknown: false };
  if (!loaded) return empty;
  const { decision, shape } = loaded;
  const flagged = (rule: string) => decision.flags.filter((f) => f.rule === rule && f.qboId !== null).map((f) => ({ qboId: f.qboId!, name: f.name }));
  const emails = new Set(decision.grants.map((g) => g.email));
  const ending = await dryRunEnding();
  const welcomed = new Set((await db.select({ email: parent.email }).from(parent).where(sql`${parent.welcomedAt} is not null`)).map((p) => p.email));
  const offered = shape.kind === "layered" && shape.studentTypeId !== null;
  const strict = offered ? ((await loadDecision(undefined, { requireActiveStudents: true }))?.decision.grants ?? decision.grants) : decision.grants;
  const lost = decision.grants.filter((g) => !strict.some((s) => s.email === g.email && s.familyQboId === g.familyQboId));
  return {
    ...empty, people: emails.size, families: new Set(decision.grants.map((g) => g.familyQboId)).size, held: decision.held,
    noEmail: decision.denials.filter((d) => d.reason === "no_email").map((d) => ({ qboId: d.sourceQboId, name: d.name })),
    manyAddresses: flagged("many_addresses"), noSignin: flagged("family_no_signin"),
    ending: ending ?? [], endingUnknown: ending === null,
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

/** The sentences for what is missing before sign-ins can be switched on; empty when ready. The settings page uses them too. */
export async function missingForSignins(): Promise<string[]> {
  const decided = (await loadDecision()) !== null;
  const ready = await readiness(decided);
  const shapeMessage = (await getShape()) === null
    ? "Choose the membership shape first."
    : "The roster can't be used yet: refresh it, and check the membership shape under QuickBooks.";
  return [
    ...(ready.connected ? [] : ["Connect QuickBooks first."]),
    ...(ready.shape ? [] : [shapeMessage]),
    ...(ready.rosterFresh ? [] : ["Refresh the roster first: it hasn't been read in the last 2 days."]),
    ...(ready.mail ? [] : ["Set up outgoing mail and send a test email first."]),
  ];
}

export async function setSignins(on: boolean, o: StaffOp): Promise<SwitchResult> {
  if (!on) {
    // Never on: there is nothing to close, and nothing to record.
    if (!(await getParentSettings()).everEnabled) return { ok: true };
    await change({ signin: false }, o, async (tx) => {
      const ended = await tx.delete(parentAuthSession).returning({ id: parentAuthSession.id });
      const codes = await tx.delete(signinCode).where(isNull(signinCode.usedAt)).returning({ id: signinCode.id });
      return { sessionsEnded: ended.length, codesDeleted: codes.length };
    });
    return { ok: true };
  }
  const errors = await missingForSignins();
  if (errors.length) return { ok: false, errors };
  try {
    await change({ signin: true, everEnabled: true }, o, async (tx) => {
      const r = await reconcileAccess(tx, { cause: "settings.signin" });
      // The roster stopped being usable after the check above: save nothing.
      if (!r.ran) throw new RolledBack();
      return { granted: r.granted, ended: r.ended };
    });
  } catch (e) {
    if (!(e instanceof RolledBack)) throw e;
    return { ok: false, errors: ["The roster changed while this was being switched on. Check the preview and try again."] };
  }
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

/** How many people have an open link and are not blocked, whether or not the parent door is open. */
export async function peopleWithAccess(): Promise<number> {
  const rows = await db.selectDistinct({ id: guardian.parentId }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId))
    .where(and(ne(guardian.status, "disabled"), eq(parent.blocked, false)));
  return rows.length;
}
