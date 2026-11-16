import { db } from "@/lib/db/client";
import { requirement, requirementCover, requirementProgress, season, seasonStep } from "@/lib/db/schema";
import type { ParentFamilySpec } from "./parent";

/**
 * Seasons for tests, written straight into the tables as staff's pages would have left them. Checklist items only:
 * the one kind that can be met today (src/lib/seasons/kinds.ts).
 */
export type SeedRequirement = {
  title: string; appliesTo: "family" | "student"; required?: boolean; dueOn?: string;
  /** A chosen list of QuickBooks ids; left out, the requirement is asked of everyone. */
  chosen?: string[];
  /** The families or students it is ticked off for. */
  ticked?: string[];
  waived?: { qboId: string; reason: string }[];
};
export type SeedStep = { name: string; startsOn?: string; endsOn?: string; requirements?: SeedRequirement[] };
export type SeededSeason = { seasonId: string; stepIds: Record<string, string>; requirementIds: Record<string, string> };

/** One season with its steps, requirements, chosen lists, ticks and waivers. Ids come back by step name and requirement title. */
export async function seedSeason(o: { name: string; current?: boolean; steps: SeedStep[] }): Promise<SeededSeason> {
  const [s] = await db.insert(season).values({ name: o.name, isCurrent: o.current ?? true }).returning();
  const seeded: SeededSeason = { seasonId: s!.id, stepIds: {}, requirementIds: {} };
  for (const [position, step] of o.steps.entries()) {
    const [made] = await db.insert(seasonStep).values({ seasonId: s!.id, name: step.name, position, startsOn: step.startsOn ?? null, endsOn: step.endsOn ?? null }).returning();
    seeded.stepIds[step.name] = made!.id;
    for (const [at, r] of (step.requirements ?? []).entries()) {
      const [row] = await db.insert(requirement).values({ stepId: made!.id, kind: "checklist", title: r.title, required: r.required ?? true, appliesTo: r.appliesTo,
        dueOn: r.dueOn ?? null, covers: r.chosen ? "chosen" : "everyone", position: at }).returning();
      seeded.requirementIds[r.title] = row!.id;
      if (r.chosen?.length) await db.insert(requirementCover).values(r.chosen.map((subjectQboId) => ({ requirementId: row!.id, subjectQboId })));
      const subjects = new Set([...(r.ticked ?? []), ...(r.waived ?? []).map((w) => w.qboId)]);
      for (const subjectQboId of subjects) {
        const waiver = r.waived?.find((w) => w.qboId === subjectQboId);
        await db.insert(requirementProgress).values({ requirementId: row!.id, subjectQboId, metAt: r.ticked?.includes(subjectQboId) ? new Date() : null,
          waivedAt: waiver ? new Date() : null, waivedReason: waiver?.reason ?? null });
      }
    }
  }
  return seeded;
}

/** The season seedTwoFamilies() gives both families: its name and steps are the club's, shown to everyone. */
export const TWO_FAMILY_SEASON = "Autumn Field Season";

export type FamilySeason = {
  /** Strings that belong to this family's season alone: titles of requirements asked only of it, their ids, and its waiver reasons. */
  markers: string[];
  /** What this family's parent must find on Home: the step it is on, and what that step asks of it. */
  home: string[];
  /** What this family's parent must find on the Season page. */
  page: string[];
  /** A waiver's reason is for staff and the audit log: no parent page shows it, the family's own included. */
  staffOnly: string[];
};

/**
 * The current season for family A and family B (tests/helpers/parent.ts): three steps with no dates. Some requirements
 * are asked of everyone, with different ticks for each family; one per family is asked of that family alone, and one
 * of a single student of each. Each family has a waiver. A is still on the first step; B has moved on to the second.
 * A requirement asked only of one family must not reach the other's pages at all, not even its title.
 */
export async function seedTwoFamilySeason(a: ParentFamilySpec, b: ParentFamilySpec): Promise<{ season: SeededSeason; a: FamilySeason; b: FamilySeason }> {
  const A = { carpool: "Carpool pledge QA71", piccolo: "Piccolo loan agreement QA72", reason: "Plays her own piccolo QA73" };
  const B = { trailer: "Trailer key returned QB82", sousaphone: "Sousaphone harness check QB83", reason: "Lent the key to the director QB84" };
  const seeded = await seedSeason({ name: TWO_FAMILY_SEASON, steps: [
    { name: "Sign-up", requirements: [
      { title: "Handbook read", appliesTo: "family", ticked: [a.family.qboId, b.family.qboId] },
      { title: A.carpool, appliesTo: "family", chosen: [a.family.qboId] },
      { title: B.trailer, appliesTo: "family", chosen: [b.family.qboId], waived: [{ qboId: b.family.qboId, reason: B.reason }] },
    ] },
    { name: "Uniforms", requirements: [
      { title: "Uniform fitting attended", appliesTo: "student", ticked: [a.students[0]!.qboId, b.students[1]!.qboId] },
      { title: A.piccolo, appliesTo: "student", chosen: [a.students[1]!.qboId], waived: [{ qboId: a.students[1]!.qboId, reason: A.reason }] },
      { title: B.sousaphone, appliesTo: "student", chosen: [b.students[0]!.qboId], ticked: [b.students[0]!.qboId] },
    ] },
    { name: "Wrap-up" },
  ] });
  const id = (title: string) => seeded.requirementIds[title]!;
  return {
    season: seeded,
    a: { markers: [A.carpool, A.piccolo, A.reason, id(A.carpool), id(A.piccolo)], staffOnly: [A.reason],
      home: [TWO_FAMILY_SEASON, "Set 1 of 3", "Sign-up", A.carpool, "1 thing left to do in Sign-up"],
      page: [TWO_FAMILY_SEASON, "Sign-up", "Uniforms", "Wrap-up", "Handbook read", A.carpool, A.piccolo, "Uniform fitting attended", "Waived"] },
    b: { markers: [B.trailer, B.sousaphone, B.reason, id(B.trailer), id(B.sousaphone)], staffOnly: [B.reason],
      home: [TWO_FAMILY_SEASON, "Set 2 of 3", "Uniforms", B.sousaphone, "Uniform fitting attended", "1 thing left to do in Uniforms"],
      page: [TWO_FAMILY_SEASON, "Sign-up", "Uniforms", "Wrap-up", "Handbook read", B.trailer, B.sousaphone, "Uniform fitting attended", "Waived"] },
  };
}
