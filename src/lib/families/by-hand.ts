import { and, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, student } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { studentsRuleInForce } from "@/lib/parents/sessions";
import { accountingOn } from "@/plugins";
import type { AddFamilyAsk, AddResult } from "@/plugins/types";
import { asAppFamilyId, asAppStudentId, type AppFamilyId } from "./ids";
import { checkRecordName, freeName, nameKey } from "./names";
import { followMovedStudent } from "./moved";
import { RECORDS_LOCK } from "./records-lock";
import { recordNameWords } from "./words";

// The club's families and students kept by hand, with no books (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md,
// section 2, "With no accounting at all"): staff add a family and a student, rename them, move a student and make
// either inactive. Each saves at once, under the records lock, with its audit row in the same transaction, and sends
// nothing: no accounting plugin is on. Each checks that again under the lock, so a page drawn before the books were
// turned on changes nothing. The actions take only the app's ids, each looked up again here. Staff-only: a write by any
// family's or student's id (tests/integration/page-guards.test.ts, STAFF_ONLY_IMPORTS).

/** Who is changing the records: a staff member, with the permission their action needs. */
export type ByHandOp = { actor: Actor; ip: string | null; permission: string };
export type ByHandResult = AddResult;

export const BY_HAND_COPY = {
  booksOn: "The club's books were turned on since this page was opened, so nothing was changed. Reload the page.",
  gone: "That isn't in the portal any more, so nothing was changed. Reload the page.",
  inactive: "That is inactive in the portal, so nothing was changed.",
  familyOnly: "Only a family can be added here, so nothing was saved.",
  alreadyNamed: "That is its name already, so there was nothing to change.",
  alreadyThere: "The student is in that family already, so there was nothing to change.",
  notToFamily: "That family isn't one of the portal's active families, so nobody can be moved to it. Choose a family from the list on this page.",
} as const;

const refuse = (error: string): ByHandResult => ({ ok: false, errors: [error] });
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** The records lock, exclusive, then whether the club still keeps no books: the first thing every change here does. */
async function lockByHand(tx: Tx): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(${RECORDS_LOCK})`);
  return (await accountingOn(tx)) === null;
}

/** A refusal for a name another active family has (compared as nameKey() does), with the first free one offered. */
async function nameTaken(tx: Tx, name: string, except: AppFamilyId | null): Promise<ByHandResult | null> {
  const rows = await tx.select({ id: family.id, name: family.name }).from(family).where(eq(family.active, true));
  const others = rows.flatMap((r) => (r.name === null || (except !== null && String(r.id) === String(except)) ? [] : [r.name]));
  if (!others.some((n) => nameKey(n) === nameKey(name))) return null;
  const offer = freeName(name, others);
  return { ok: false, ...(offer ? { offer } : {}),
    errors: [`Another family is called “${name}”, and every family's name must be different.${offer ? ` You could use “${offer}” instead.` : ""}`] };
}

const hasActiveStudent = async (tx: Tx, familyId: AppFamilyId) =>
  (await tx.select({ id: student.id }).from(student).where(and(eq(student.familyId, familyId), eq(student.active, true))).limit(1)).length > 0;

/** What a change did to who may sign in, while "Families with no active student" is in force: a sentence, or none. */
const opens = (familyWords: string) => `${familyWords} has an active student now, so its guardians can sign in to it.`;
const closes = (familyWords: string) => `${familyWords} has no active student now, so its guardians can't sign in to it until it has one again.`;
const said = (message: string, notes: (string | null)[]) => [message, ...notes.filter((n): n is string => n !== null)].join(" ");

/** The active family `rawId` names, locked for the change, or a refusal. */
async function activeFamily(tx: Tx, rawId: unknown): Promise<{ ok: true; f: typeof family.$inferSelect } | { ok: false; result: ByHandResult }> {
  if (!isUuid(rawId)) return { ok: false, result: refuse(BY_HAND_COPY.gone) };
  const [f] = await tx.select().from(family).where(eq(family.id, asAppFamilyId(rawId.toLowerCase()))).for("update");
  if (!f) return { ok: false, result: refuse(BY_HAND_COPY.gone) };
  if (!f.active) return { ok: false, result: refuse(BY_HAND_COPY.inactive) };
  return { ok: true, f };
}

/** The active student `rawId` names, in an active family, locked for the change, or a refusal. */
async function activeStudent(tx: Tx, rawId: unknown): Promise<{ ok: true; s: typeof student.$inferSelect & { familyId: AppFamilyId }; familyName: string | null } | { ok: false; result: ByHandResult }> {
  if (!isUuid(rawId)) return { ok: false, result: refuse(BY_HAND_COPY.gone) };
  const [s] = await tx.select().from(student).where(eq(student.id, asAppStudentId(rawId.toLowerCase()))).for("update");
  if (!s || s.familyId === null) return { ok: false, result: refuse(BY_HAND_COPY.gone) };
  const [f] = await tx.select({ active: family.active, name: family.name }).from(family).where(eq(family.id, s.familyId));
  if (!s.active || !f?.active) return { ok: false, result: refuse(BY_HAND_COPY.inactive) };
  return { ok: true, s: { ...s, familyId: s.familyId }, familyName: f.name };
}

/** A new family, saved active, audited `roster.family.added` with nothing sent. A flat club's member is the books' idea: refused. */
export async function addFamilyByHand(ask: AddFamilyAsk, o: ByHandOp): Promise<ByHandResult> {
  return db.transaction(async (tx): Promise<ByHandResult> => {
    if (!(await lockByHand(tx))) return refuse(BY_HAND_COPY.booksOn);
    if (ask.role !== "family") return refuse(BY_HAND_COPY.familyOnly);
    const name = checkRecordName(ask.name);
    if (!name.ok) return refuse(name.error);
    const taken = await nameTaken(tx, name.name, null);
    if (taken) return taken;
    const [made] = await tx.insert(family).values({ name: name.name, active: true }).returning({ id: family.id });
    await writeAudit({ actor: o.actor, action: "roster.family.added", permission: o.permission, ip: o.ip, targetType: "family", targetId: String(made!.id),
      after: { familyId: String(made!.id), name: name.name, role: "family", books: "none" } }, tx);
    return { ok: true, message: `Added ${name.name}. Add its students and guardians on its page.` };
  });
}

/** A new student in an active family, saved active, audited `roster.student.added` with nothing sent. */
export async function addStudentByHand(familyId: unknown, rawName: unknown, o: ByHandOp): Promise<ByHandResult> {
  return db.transaction(async (tx): Promise<ByHandResult> => {
    if (!(await lockByHand(tx))) return refuse(BY_HAND_COPY.booksOn);
    const at = await activeFamily(tx, familyId);
    if (!at.ok) return at.result;
    const name = checkRecordName(rawName);
    if (!name.ok) return refuse(name.error);
    const first = (await studentsRuleInForce(tx)) && !(await hasActiveStudent(tx, at.f.id));
    const [made] = await tx.insert(student).values({ familyId: at.f.id, name: name.name, active: true }).returning({ id: student.id });
    await writeAudit({ actor: o.actor, action: "roster.student.added", permission: o.permission, ip: o.ip, targetType: "student", targetId: String(made!.id),
      after: { studentId: String(made!.id), familyId: String(at.f.id), name: name.name, books: "none" } }, tx);
    const familyWords = recordNameWords(at.f.name, "family");
    return { ok: true, message: said(`Added ${name.name} to ${familyWords}.`, [first ? opens(familyWords) : null]) };
  });
}

/** A change staff make by hand to a family or a student, as the page sent it: the app's ids, each looked up again. */
export type ByHandChange =
  | { op: "rename_family"; familyId: unknown; name: unknown }
  | { op: "deactivate_family"; familyId: unknown }
  | { op: "rename_student"; studentId: unknown; name: unknown }
  | { op: "deactivate_student"; studentId: unknown };

/**
 * A rename, or a make-inactive, of a family or a student: refused for a record that isn't there or is inactive, a name
 * the rules refuse or another active family holds, or the name it has. A family is made inactive with its active
 * students. Each is audited in the same transaction: `roster.record.renamed`, `roster.record.made_inactive`.
 */
export async function changeByHand(ask: ByHandChange, o: ByHandOp): Promise<ByHandResult> {
  return db.transaction(async (tx): Promise<ByHandResult> => {
    if (!(await lockByHand(tx))) return refuse(BY_HAND_COPY.booksOn);
    const audit = (action: string, targetType: "family" | "student", targetId: string, before: Record<string, unknown>, after: Record<string, unknown>) =>
      writeAudit({ actor: o.actor, action, permission: o.permission, ip: o.ip, targetType, targetId, before, after: { ...after, books: "none" } }, tx);
    const now = new Date();

    if (ask.op === "rename_family" || ask.op === "deactivate_family") {
      const at = await activeFamily(tx, ask.familyId);
      if (!at.ok) return at.result;
      const f = at.f, familyWords = recordNameWords(f.name, "family");
      if (ask.op === "rename_family") {
        const name = checkRecordName(ask.name);
        if (!name.ok) return refuse(name.error);
        if (f.name === name.name) return refuse(BY_HAND_COPY.alreadyNamed);
        const taken = await nameTaken(tx, name.name, f.id);
        if (taken) return taken;
        await tx.update(family).set({ name: name.name, updatedAt: now }).where(eq(family.id, f.id));
        await audit("roster.record.renamed", "family", String(f.id), { name: f.name }, { kind: "family", familyId: String(f.id), name: name.name });
        return { ok: true, message: `Renamed ${familyWords} to ${name.name}.` };
      }
      const under = await tx.select({ id: student.id }).from(student).where(and(eq(student.familyId, f.id), eq(student.active, true))).for("update");
      if (under.length) await tx.update(student).set({ active: false, updatedAt: now }).where(inArray(student.id, under.map((s) => s.id)));
      await tx.update(family).set({ active: false, updatedAt: now }).where(eq(family.id, f.id));
      await audit("roster.record.made_inactive", "family", String(f.id), { active: true }, { kind: "family", familyId: String(f.id), students: under.map((s) => String(s.id)) });
      return { ok: true, message: under.length ? `Made ${familyWords} inactive, with ${under.length === 1 ? "its student" : `its ${under.length} students`}.` : `Made ${familyWords} inactive.` };
    }

    const at = await activeStudent(tx, ask.studentId);
    if (!at.ok) return at.result;
    const s = at.s, studentWords = recordNameWords(s.name, "student");
    if (ask.op === "rename_student") {
      const name = checkRecordName(ask.name);
      if (!name.ok) return refuse(name.error);
      if (s.name === name.name) return refuse(BY_HAND_COPY.alreadyNamed);
      await tx.update(student).set({ name: name.name, updatedAt: now }).where(eq(student.id, s.id));
      await audit("roster.record.renamed", "student", String(s.id), { name: s.name }, { kind: "student", studentId: String(s.id), familyId: String(s.familyId), name: name.name });
      return { ok: true, message: `Renamed ${studentWords} to ${name.name}.` };
    }
    const rule = await studentsRuleInForce(tx);
    await tx.update(student).set({ active: false, updatedAt: now }).where(eq(student.id, s.id));
    await audit("roster.record.made_inactive", "student", String(s.id), { active: true }, { kind: "student", studentId: String(s.id), familyId: String(s.familyId) });
    const last = rule && !(await hasActiveStudent(tx, s.familyId));
    return { ok: true, message: said(`Made ${studentWords} inactive.`, [last ? closes(recordNameWords(at.familyName, "family")) : null]) };
  });
}

/**
 * A student moved to another of the portal's active families, by hand: saved at once, with the move's follow-ups
 * (followMovedStudent(): forms, volunteer places, and their audit row), audited `roster.record.moved`, in one
 * transaction. The guardians whose places were given up are told after it commits.
 */
export async function moveByHand(rawStudentId: unknown, rawToFamilyId: unknown, o: ByHandOp): Promise<ByHandResult> {
  let tell: () => Promise<unknown> = async () => undefined;
  const r = await db.transaction(async (tx): Promise<ByHandResult> => {
    if (!(await lockByHand(tx))) return refuse(BY_HAND_COPY.booksOn);
    const at = await activeStudent(tx, rawStudentId);
    if (!at.ok) return at.result;
    const s = at.s, fromFamilyId = s.familyId;
    if (!isUuid(rawToFamilyId)) return refuse(BY_HAND_COPY.notToFamily);
    const [to] = await tx.select().from(family).where(eq(family.id, asAppFamilyId(rawToFamilyId.toLowerCase())));
    if (!to?.active) return refuse(BY_HAND_COPY.notToFamily);
    if (String(to.id) === String(fromFamilyId)) return refuse(BY_HAND_COPY.alreadyThere);
    const rule = await studentsRuleInForce(tx);
    const joinedOpens = rule && !(await hasActiveStudent(tx, to.id));
    await tx.update(student).set({ familyId: to.id, updatedAt: new Date() }).where(eq(student.id, s.id));
    const leftCloses = rule && !(await hasActiveStudent(tx, fromFamilyId));
    const followed = await followMovedStudent(tx, { studentId: s.id, fromFamilyId, toFamilyId: to.id, cause: `roster.record.moved#${s.id}` }, o);
    tell = followed.tell;
    await writeAudit({ actor: o.actor, action: "roster.record.moved", permission: o.permission, ip: o.ip, targetType: "student", targetId: String(s.id),
      before: { familyId: String(fromFamilyId) }, after: { kind: "student", studentId: String(s.id), familyId: String(to.id), fromFamilyId: String(fromFamilyId), books: "none" } }, tx);
    const fromWords = recordNameWords(at.familyName, "family"), toWords = recordNameWords(to.name, "family");
    return { ok: true, message: said(`Moved ${recordNameWords(s.name, "student")} to ${toWords}.`, [leftCloses ? closes(fromWords) : null, joinedOpens ? opens(toWords) : null]) };
  });
  // A mail failure is the notices' own to record; it never undoes the move.
  if (r.ok) await tell().catch(() => undefined);
  return r;
}
