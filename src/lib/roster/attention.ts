import type { MembershipShape } from "./shape";
import type { Cust, Roster } from "./model";

export type SignIn = { guardianId: string; familyQboId: string; name: string; email: string; status: "invited" | "active" | "disabled" };
export type AttentionRule = "family_no_parent" | "family_no_student" | "not_under_family" | "family_is_sub" | "no_email" | "same_email" | "signin_unknown" | "inactive_with_signin";
export type AttentionItem = { rule: AttentionRule; qboId: string | null; name: string; detail: string };

const item = (rule: AttentionRule, c: Cust, detail: string): AttentionItem => ({ rule, qboId: c.qboId, name: c.displayName, detail });

function sameEmail(people: Cust[], detail: string): AttentionItem[] {
  const seen = new Map<string, Cust[]>();
  for (const p of people) if (p.active && p.email) seen.set(p.email, [...(seen.get(p.email) ?? []), p]);
  return [...seen.values()].filter((group) => group.length > 1).flat().map((p) => item("same_email", p, detail));
}

/**
 * The club's clean-up list (spec §5 Needs attention). Pure; it changes nothing. Inactive customers are left out of the
 * QuickBooks clean-up rules; the two sign-in rules look at every customer.
 */
export function needsAttention(roster: Roster, shape: MembershipShape, signIns: SignIn[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  const known = new Map<string, Cust>();
  if (roster.kind === "flat") {
    for (const m of roster.members) {
      known.set(m.qboId, m);
      if (m.active && !m.email) out.push(item("no_email", m, "This member has no email address in QuickBooks."));
    }
    out.push(...sameEmail(roster.members, "Another member has the same email address in QuickBooks."));
  } else if (shape.kind === "layered") {
    for (const f of roster.families) {
      known.set(f.customer.qboId, f.customer);
      if (!f.customer.active) continue;
      if (shape.parentTypeId && !f.parents.some((p) => p.active)) out.push(item("family_no_parent", f.customer, "No parent is listed under this family in QuickBooks."));
      if (shape.studentTypeId && !f.students.some((s) => s.active)) out.push(item("family_no_student", f.customer, "No student is listed under this family in QuickBooks."));
      if (f.customer.parentQboId) out.push(item("family_is_sub", f.customer, "This family is a sub-customer of another customer in QuickBooks. A family should be a top-level customer."));
      for (const p of f.parents) if (p.active && !p.email) out.push(item("no_email", p, "This parent has no email address in QuickBooks, so they can't be given a sign-in."));
      out.push(...sameEmail(f.parents, "Another parent in this family has the same email address in QuickBooks."));
    }
    for (const s of roster.strays) if (s.active) out.push(item("not_under_family", s, "This student or parent isn't directly under a family in QuickBooks."));
  }
  for (const s of signIns) {
    const customer = known.get(s.familyQboId);
    if (!customer) {
      out.push({ rule: "signin_unknown", qboId: null, name: s.name,
        detail: `This portal sign-in is attached to QuickBooks ID ${s.familyQboId}, which isn't a ${roster.kind === "flat" ? "member" : "family"} in QuickBooks.` });
    } else if (!customer.active && s.status !== "disabled" && !out.some((o) => o.rule === "inactive_with_signin" && o.qboId === customer.qboId)) {
      out.push(item("inactive_with_signin", customer, "This is inactive in QuickBooks, but someone can still sign in to the portal for it."));
    }
  }
  return out;
}
