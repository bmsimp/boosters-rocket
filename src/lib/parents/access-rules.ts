import type { MembershipShape } from "@/lib/roster/shape";
import type { Roster } from "@/lib/roster/model";
import { parseEmailField } from "./emails";

export type HoldSets = { approved: string[]; rejected: string[] };
export type DenyReason = "inactive" | "family_inactive" | "no_email" | "held" | "no_active_students";
export type Grant = { email: string; familyQboId: string; sourceQboId: string; name: string };
export type Denial = { sourceQboId: string; familyQboId: string; name: string; email: string | null; reason: DenyReason };
export type HeldAddress = { email: string; families: { qboId: string; name: string; held: boolean }[]; names: string[]; pending: boolean };
export type AccessFlagRule = "no_email" | "bad_email" | "many_addresses" | "held_address" | "name_differs" | "family_no_signin" | "same_address_in_family";
export type AccessFlag = { rule: AccessFlagRule; qboId: string | null; name: string; detail: string };
export type AccessDecision = { grants: Grant[]; denials: Denial[]; held: HeldAddress[]; flags: AccessFlag[]; personNames: Map<string, string> };

/** A QuickBooks customer whose email field can become sign-ins (spec §1 Candidates). */
type Candidate = {
  sourceQboId: string; familyQboId: string; familyName: string; name: string; field: string | null;
  active: boolean; familyActive: boolean; hasActiveStudent: boolean | null; everyAddress: boolean; flagNoEmail: boolean;
};
type Claim = { email: string; familyQboId: string; familyName: string; sourceQboId: string; name: string; field: string | null; hasActiveStudent: boolean | null };

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
    // Every active candidate with an address claims it, whether or not its family has an active student: the hold
    // below must see every family an address is under. The active-students setting is applied after the hold.
    for (const email of c.everyAddress ? usable : usable.slice(0, 1)) claims.push({ email, familyQboId: c.familyQboId, familyName: c.familyName, sourceQboId: c.sourceQboId, name: c.name, field: c.field, hasActiveStudent: c.hasActiveStudent });
  }

  // One sign-in per address per family: the claim from the lowest QuickBooks ID stands (claims are already in ID order).
  const kept: Claim[] = [];
  const allNames = new Map<string, string[]>();
  for (const cl of claims) {
    const names = allNames.get(cl.email) ?? [];
    if (!names.includes(cl.name)) names.push(cl.name);
    allNames.set(cl.email, names);
    const earlier = kept.find((k) => k.email === cl.email && k.familyQboId === cl.familyQboId);
    if (!earlier) kept.push(cl);
    // Two records with identical fields are caught by the roster's own `same_email` rule; this catches the rest.
    else if (earlier.field !== cl.field) flags.push({ rule: "same_address_in_family", qboId: cl.sourceQboId, name: cl.name, detail: "This record's email address is also on another record in the same family in QuickBooks. Each person needs their own address." });
  }

  const grants: Grant[] = [], held: HeldAddress[] = [], personNames = new Map<string, string>();
  const byEmail = new Map<string, Claim[]>();
  for (const k of kept) byEmail.set(k.email, [...(byEmail.get(k.email) ?? []), k]);
  for (const [email, mine] of byEmail) {
    const names = allNames.get(email)!;
    personNames.set(email, names[0]!);
    if (new Set(names.map((n) => n.trim().toLowerCase())).size > 1) {
      flags.push({ rule: "name_differs", qboId: mine[0]!.sourceQboId, name: names[0]!, detail: "This person's email address is on records with different names in QuickBooks. The portal shows the first." });
    }
    const sets = i.holds.get(email) ?? { approved: [], rejected: [] };
    const heldHere = mine.length > 1 ? mine.filter((m) => !sets.approved.includes(m.familyQboId)) : [];
    for (const m of mine) {
      if (heldHere.includes(m)) denials.push({ sourceQboId: m.sourceQboId, familyQboId: m.familyQboId, name: m.name, email, reason: "held" });
      else if (i.requireActiveStudents && m.hasActiveStudent === false) denials.push({ sourceQboId: m.sourceQboId, familyQboId: m.familyQboId, name: m.name, email, reason: "no_active_students" });
      else grants.push({ email, familyQboId: m.familyQboId, sourceQboId: m.sourceQboId, name: m.name });
    }
    if (heldHere.length) {
      held.push({ email, names, pending: !heldHere.every((m) => sets.rejected.includes(m.familyQboId)),
        families: mine.map((m) => ({ qboId: m.familyQboId, name: m.familyName, held: heldHere.includes(m) })) });
      flags.push({ rule: "held_address", qboId: null, name: names[0]!, detail: "This person's email address is under more than one family in QuickBooks. Once parent sign-ins are on, nobody at that address can sign in to those families until someone with access to Parents says whether it is one person." });
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
