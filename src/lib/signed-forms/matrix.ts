// Staff only: who has signed each form of the current season, across every family (v1 spec §9.3). The current season's
// students down the side, grouped by family, and its form requirements across; a per-family form sits on the family's
// own row. It reads every family, so it is a list (not audited, as the roster list is not) and never imported by
// parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { requirement, requirementProgress, season, seasonStep, signatureRequest, signedFormEvidence, type FormReminders, type FormSetting } from "@/lib/db/schema";
import { getRosterSource } from "@/lib/roster/source";
import { loadCovers, toRequirement } from "@/lib/seasons/recorded";
import { isCovered } from "@/lib/seasons/progress";
import { loadSubjects, type FamilySubject } from "@/lib/seasons/subjects";
import { CELL_WORDS, FILTER_STATES, cellState, type CellState } from "./rules";

export type MatrixForm = {
  id: string; title: string; stepName: string; appliesTo: "family" | "student"; required: boolean; dueOn: string | null;
  setting: FormSetting | null; reminders: FormReminders | null;
  counts: { signed: number; needed: number; waived: number };
};
export type MatrixCell = { state: CellState; words: string; requestId: string | null; evidenceId: string | null };
export type MatrixRow = { kind: "family" | "student"; qboId: string; name: string; familyQboId: string; familyName: string; cells: MatrixCell[] };
export type MatrixFamily = { qboId: string; name: string; rows: MatrixRow[] };
export type Matrix = {
  season: { id: string; name: string };
  /** Every form requirement of the season, whatever the filter: the filter's choices and the counts. */
  allForms: MatrixForm[];
  /** The columns shown: one form when the filter names one, otherwise all. */
  forms: MatrixForm[];
  /** Null when the roster can't be shown (no membership shape, or a cache read from another company). */
  families: MatrixFamily[] | null;
  /** The kept evidence the whole matrix leads to, whatever the filter: the page lists the rest of the company's apart. */
  shownEvidenceIds: string[];
};

export type MatrixFilter = { formId: string | null; state: CellState | null; search: string };

/** The filter from the address: anything it doesn't know is dropped, never guessed at. */
export function parseMatrixFilter(sp: Record<string, string | string[] | undefined>): MatrixFilter {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const state = one("state");
  return {
    formId: /^[0-9a-f-]{36}$/i.test(one("form")) ? one("form").toLowerCase() : null,
    state: (FILTER_STATES as readonly string[]).includes(state) ? (state as CellState) : null,
    search: one("q").trim().slice(0, 100),
  };
}

/** The current season, or null when none is. */
export async function currentSeason(): Promise<{ id: string; name: string } | null> {
  const [s] = await db.select({ id: season.id, name: season.name }).from(season).where(eq(season.isCurrent, true));
  return s ?? null;
}

/** The form requirements of a season, in the order of its steps and their requirements. */
export async function seasonForms(seasonId: string) {
  return db.select({ row: requirement, stepName: seasonStep.name }).from(requirement).innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId))
    .where(and(eq(seasonStep.seasonId, seasonId), eq(requirement.kind, "form"))).orderBy(asc(seasonStep.position), asc(requirement.position), asc(requirement.createdAt));
}

/**
 * The matrix for the current season, filtered; null when there is no current season. A request counts for a student
 * only while it is the family's the student is under now: a student who moved brings no other family's signature.
 */
export async function loadMatrix(filter: MatrixFilter): Promise<Matrix | null> {
  const s = await currentSeason();
  if (!s) return null;
  const formRows = await seasonForms(s.id);
  const ids = formRows.map((f) => f.row.id);
  const [subjects, covers, waivers, requests, realmId] = await Promise.all([
    loadSubjects(), loadCovers(ids, null),
    ids.length ? db.select({ requirementId: requirementProgress.requirementId, subjectQboId: requirementProgress.subjectQboId }).from(requirementProgress)
      .where(and(inArray(requirementProgress.requirementId, ids), isNotNull(requirementProgress.waivedAt))) : Promise.resolve([]),
    ids.length ? db.select({ id: signatureRequest.id, requirementId: signatureRequest.requirementId, familyQboId: signatureRequest.familyQboId, subjectQboId: signatureRequest.subjectQboId,
      state: signatureRequest.state, signers: signatureRequest.signers }).from(signatureRequest).where(inArray(signatureRequest.requirementId, ids)) : Promise.resolve([]),
    getRosterSource(),
  ]);
  const complete = requests.filter((r) => r.state === "complete").map((r) => r.id);
  // Evidence is matched by request and by the company the cache holds now: never an earlier company's.
  const evidence = complete.length && realmId !== null ? await db.select({ id: signedFormEvidence.id, requestId: signedFormEvidence.requestId }).from(signedFormEvidence)
    .where(and(inArray(signedFormEvidence.requestId, complete), eq(signedFormEvidence.realmId, realmId), isNull(signedFormEvidence.earlierCompanyAt))) : [];
  const waived = new Set(waivers.map((w) => `${w.requirementId}|${w.subjectQboId}`));
  const requirements = formRows.map((f) => toRequirement(f.row, covers.get(f.row.id) ?? []));

  const cellFor = (formIndex: number, subjectQboId: string, familyQboId: string, kind: "family" | "student"): MatrixCell => {
    const r = requirements[formIndex]!;
    const covered = r.appliesTo === kind && isCovered(r, subjectQboId);
    const request = covered ? requests.find((q) => q.requirementId === r.id && q.subjectQboId === subjectQboId && q.familyQboId === familyQboId) ?? null : null;
    const state = cellState({ covered, waived: waived.has(`${r.id}|${subjectQboId}`), request });
    return { state, words: CELL_WORDS[state], requestId: request?.id ?? null, evidenceId: request ? evidence.find((e) => e.requestId === request.id)?.id ?? null : null };
  };
  const rowsOf = (f: FamilySubject): MatrixRow[] => [
    { kind: "family", qboId: f.qboId, name: f.name, familyQboId: f.qboId, familyName: f.name, cells: formRows.map((_, i) => cellFor(i, f.qboId, f.qboId, "family")) },
    ...f.students.map((st): MatrixRow => ({ kind: "student", qboId: st.qboId, name: st.name, familyQboId: f.qboId, familyName: f.name, cells: formRows.map((_, i) => cellFor(i, st.qboId, f.qboId, "student")) })),
  ];
  const all = subjects?.map((f) => ({ qboId: f.qboId, name: f.name, rows: rowsOf(f) })) ?? null;

  const allForms: MatrixForm[] = formRows.map((f, i) => {
    const cells = (all ?? []).flatMap((fam) => fam.rows.map((r) => r.cells[i]!)).filter((c) => c.state !== "not_asked");
    return { id: f.row.id, title: f.row.title, stepName: f.stepName, appliesTo: f.row.appliesTo, required: f.row.required, dueOn: f.row.dueOn,
      setting: f.row.form ?? null, reminders: f.row.formReminders ?? null,
      counts: { signed: cells.filter((c) => c.state === "signed").length, needed: cells.filter((c) => c.state !== "waived").length, waived: cells.filter((c) => c.state === "waived").length } };
  });

  // The filter: one form's column, rows with a cell in one state, and families or students by name.
  const shownIndexes = allForms.map((f, i) => (filter.formId === null || f.id === filter.formId ? i : -1)).filter((i) => i >= 0);
  const needle = filter.search.toLowerCase();
  const families = all === null ? null : all.map((fam) => {
    const familyMatches = needle === "" || fam.name.toLowerCase().includes(needle);
    const rows = fam.rows
      .map((r) => ({ ...r, cells: shownIndexes.map((i) => r.cells[i]!) }))
      .filter((r) => familyMatches || r.kind === "family" || r.name.toLowerCase().includes(needle))
      .filter((r) => r.cells.some((c) => c.state !== "not_asked"))
      .filter((r) => filter.state === null || r.cells.some((c) => c.state === filter.state));
    const anyStudent = rows.some((r) => r.kind === "student");
    // A family with nothing of its own to show is still named above the students who are shown.
    const kept = familyMatches || anyStudent ? rows : [];
    return { qboId: fam.qboId, name: fam.name, rows: kept };
  }).filter((fam) => fam.rows.length > 0);
  const shownEvidenceIds = (all ?? []).flatMap((fam) => fam.rows.flatMap((r) => r.cells.flatMap((c) => (c.evidenceId ? [c.evidenceId] : []))));
  return { season: s, allForms, forms: shownIndexes.map((i) => allForms[i]!), families, shownEvidenceIds };
}
