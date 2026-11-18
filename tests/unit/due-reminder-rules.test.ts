import { describe, it, expect } from "vitest";
import type { StoredInvoice } from "@/lib/db/schema";
import { checklistVerdict, dueToday, FIGURES_TELL_MS, isReminded, owedReminders, paymentVerdict, type Verdict } from "@/lib/seasons/due-reminder-rules";
import { paymentStanding } from "@/lib/money/payment-rule";
import { requirementDueMessage } from "@/lib/mail/messages";
import type { Requirement, SubjectId } from "@/lib/seasons/progress";
import { asAppFamilyId, asAppStudentId } from "@/lib/families/ids";

/**
 * The reminders before a payment's or a checklist item's due date, as pure rules (src/lib/seasons/due-reminder-rules.ts):
 * the day, from 9:00 on the club's clock; which requirements; which families and students; and what a payment may say.
 */
const req = (o: Partial<Requirement> & Pick<Requirement, "id" | "title">): Requirement => ({ kind: "checklist", required: true, appliesTo: "family", amount: null, amountUnit: null,
  dueOn: "2027-03-24", covers: "everyone", coveredIds: [], ...o });
const invoice = (o: Partial<StoredInvoice>): StoredInvoice => ({ qboId: "1", number: "1001", customerQboId: "F1", forName: null, date: "2027-01-01", dueDate: null,
  totalCents: 12500, balanceCents: 12500, currency: "USD", payLink: null, itemQboIds: ["77"], ...o });
const NOW = Date.parse("2027-03-10T12:00:00Z");

describe("the day the reminders are for", () => {
  it("is the club's own date from 9:00 on its clock, never the server's: two zones that never share a day", () => {
    // 20:00 UTC on March 10 is 10:00 on March 11 in Kiritimati and 9:00 on March 10 in Pago Pago.
    const at = new Date("2027-03-10T20:00:00Z");
    expect(dueToday("Pacific/Kiritimati", at)).toEqual({ today: "2027-03-11", due: [{ kind: "due_14", days: 14, dueOn: "2027-03-25" }, { kind: "due_3", days: 3, dueOn: "2027-03-14" }] });
    expect(dueToday("Pacific/Pago_Pago", at)).toEqual({ today: "2027-03-10", due: [{ kind: "due_14", days: 14, dueOn: "2027-03-24" }, { kind: "due_3", days: 3, dueOn: "2027-03-13" }] });
    // A minute before 9:00 in Pago Pago, still 9:59 in Kiritimati.
    expect(dueToday("Pacific/Pago_Pago", new Date("2027-03-10T19:59:00Z"))).toBeNull();
    expect(dueToday("Pacific/Kiritimati", new Date("2027-03-10T19:59:00Z"))?.today).toBe("2027-03-11");
    // 8:59 in Kiritimati: nothing yet there either.
    expect(dueToday("Pacific/Kiritimati", new Date("2027-03-10T18:59:00Z"))).toBeNull();
    expect(dueToday("UTC", new Date("2027-03-10T09:00:00Z"))?.today).toBe("2027-03-10");
  });
});

describe("which requirements", () => {
  it("are required payments and checklist items with a due date, and nothing else", () => {
    expect(isReminded(req({ id: "r", title: "t" }))).toBe(true);
    expect(isReminded(req({ id: "r", title: "t", kind: "payment" }))).toBe(true);
    expect(isReminded(req({ id: "r", title: "t", required: false }))).toBe(false);
    expect(isReminded(req({ id: "r", title: "t", dueOn: null }))).toBe(false);
    // Forms and volunteering have reminders of their own (src/lib/signed-forms/reminders.ts, src/lib/volunteer/reminders.ts).
    expect(isReminded(req({ id: "r", title: "t", kind: "form" }))).toBe(false);
    expect(isReminded(req({ id: "r", title: "t", kind: "volunteer" }))).toBe(false);
  });
});

describe("what a checklist item and a payment say", () => {
  it("a checklist item is reminded while it isn't ticked or waived, in its words on the parent's pages", () => {
    expect(checklistVerdict({ met: false, words: "Not done yet" }, false)).toEqual({ remind: true, words: "Not done yet" });
    expect(checklistVerdict({ met: true, words: "Done" }, false)).toEqual({ remind: false });
    expect(checklistVerdict({ met: false, words: "Not done yet" }, true)).toEqual({ remind: false });
  });

  it("a payment says its amount only from fresh figures, and nothing more without it", () => {
    const open = [invoice({ balanceCents: 12500 })];
    const fresh = paymentStanding("77", open, { amount: true }), stale = paymentStanding("77", open, { amount: false });
    expect(paymentVerdict({ standing: fresh, readAt: new Date(NOW - 60_000), waived: false, nowMs: NOW })).toEqual({ remind: true, words: "Not paid yet ($125.00 left to pay)" });
    expect(paymentVerdict({ standing: stale, readAt: new Date(NOW - 3_600_000), waived: false, nowMs: NOW })).toEqual({ remind: true, words: "Not paid yet" });
  });

  it("a paid payment sends nothing, whatever the figures' age; nor one the figures can't tell about", () => {
    const paid = paymentStanding("77", [invoice({ balanceCents: 0 })]);
    for (const age of [0, 60_000, FIGURES_TELL_MS - 1000, FIGURES_TELL_MS + 1000, 30 * 86_400_000]) {
      expect(paymentVerdict({ standing: paid, readAt: new Date(NOW - age), waived: false, nowMs: NOW }), String(age)).toEqual({ remind: false });
    }
    const open = paymentStanding("77", [invoice({})], { amount: false });
    // No figures that may be shown: nobody can tell whether it has been paid.
    expect(paymentVerdict({ standing: undefined, readAt: null, waived: false, nowMs: NOW })).toEqual({ remind: false });
    // Figures so old they can't tell whether it was paid since: a second inside the limit is reminded, a second past it is not.
    expect(paymentVerdict({ standing: open, readAt: new Date(NOW - FIGURES_TELL_MS + 1000), waived: false, nowMs: NOW })).toEqual({ remind: true, words: "Not paid yet" });
    expect(paymentVerdict({ standing: open, readAt: new Date(NOW - FIGURES_TELL_MS - 1000), waived: false, nowMs: NOW })).toEqual({ remind: false });
    // No invoice for it yet, or no item chosen: there is nothing to pay.
    expect(paymentVerdict({ standing: paymentStanding("77", []), readAt: new Date(NOW), waived: false, nowMs: NOW })).toEqual({ remind: false });
    expect(paymentVerdict({ standing: paymentStanding(null, [invoice({})]), readAt: new Date(NOW), waived: false, nowMs: NOW })).toEqual({ remind: false });
    // Waived.
    expect(paymentVerdict({ standing: open, readAt: new Date(NOW), waived: true, nowMs: NOW })).toEqual({ remind: false });
  });
});

describe("who is owed a reminder", () => {
  const families = [
    { id: asAppFamilyId("F1"), students: [{ id: asAppStudentId("S11"), name: "Ana One" }, { id: asAppStudentId("S12"), name: "Ben One" }] },
    { id: asAppFamilyId("F2"), students: [{ id: asAppStudentId("S21"), name: "Cy Two" }] },
  ];
  const due = [{ kind: "due_14" as const, days: 14, dueOn: "2027-03-24" }, { kind: "due_3" as const, days: 3, dueOn: "2027-03-13" }];

  it("each family once per due date, with every requirement of theirs due that day still to do, in season order", () => {
    const requirements = [
      req({ id: "fee", title: "Band fee", kind: "payment" }),
      req({ id: "locker", title: "Locker returned", appliesTo: "student" }),
      req({ id: "medical", title: "Medical form", dueOn: "2027-03-13" }),
      req({ id: "chosen", title: "Drum key", covers: "chosen", coveredIds: [asAppFamilyId("F2")] }),
      req({ id: "optional", title: "Raffle tickets", required: false }),
      req({ id: "later", title: "Not today", dueOn: "2027-03-25" }),
      req({ id: "form", title: "A form", kind: "form" }),
    ];
    // F1 has paid the fee; Ben's locker is waived (or ticked: the verdict says); F2 has handed in the medical form.
    const done = new Set(["fee|F1", "locker|S12", "medical|F2"]);
    const verdict = (r: Requirement, s: SubjectId): Verdict => (done.has(`${r.id}|${String(s)}`) ? { remind: false } : { remind: true, words: r.kind === "payment" ? "Not paid yet" : "Not done yet" });
    expect(owedReminders({ due, requirements, families, verdict })).toEqual([
      { kind: "due_14", days: 14, dueOn: "2027-03-24", familyId: asAppFamilyId("F1"), items: [
        { requirementId: "locker", kind: "checklist", title: "Locker returned", forName: "Ana One", words: "Not done yet" }] },
      { kind: "due_14", days: 14, dueOn: "2027-03-24", familyId: asAppFamilyId("F2"), items: [
        { requirementId: "fee", kind: "payment", title: "Band fee", forName: null, words: "Not paid yet" },
        { requirementId: "locker", kind: "checklist", title: "Locker returned", forName: "Cy Two", words: "Not done yet" },
        { requirementId: "chosen", kind: "checklist", title: "Drum key", forName: null, words: "Not done yet" }] },
      { kind: "due_3", days: 3, dueOn: "2027-03-13", familyId: asAppFamilyId("F1"), items: [
        { requirementId: "medical", kind: "checklist", title: "Medical form", forName: null, words: "Not done yet" }] },
    ]);
  });

  it("a family with nothing left is owed nothing, and a day with nothing due owes nothing", () => {
    const requirements = [req({ id: "medical", title: "Medical form", dueOn: "2027-03-13" })];
    expect(owedReminders({ due, requirements, families, verdict: () => ({ remind: false }) })).toEqual([]);
    expect(owedReminders({ due: [{ kind: "due_3", days: 3, dueOn: "2027-04-01" }], requirements, families, verdict: () => ({ remind: true, words: "Not done yet" }) })).toEqual([]);
  });
});

describe("the email", () => {
  const b = { clubName: "FZN <Band> Boosters", color: "#5b2a86" };
  it("says each requirement, who it is for and where it stands, the date, and the links; Payments only with a payment", () => {
    const m = requirementDueMessage(b, "ana@example.com", { dueWords: "Wednesday, March 24, 2027", daysLeft: 14, season: "https://portal.example.org/season", payments: "https://portal.example.org/payments",
      items: [{ title: "Band fee", forName: null, standing: "Not paid yet ($125.00 left to pay)" }, { title: "Locker <returned>", forName: "Ana One", standing: "Not done yet" }] });
    expect(m.subject).toBe("Due Wednesday, March 24, 2027: 2 things for the club");
    expect(m.text).toContain("a few things the club asks of your family are due Wednesday, March 24, 2027, 14 days from now.");
    expect(m.text).toContain("Band fee: Not paid yet ($125.00 left to pay).");
    expect(m.text).toContain("Locker <returned> for Ana One: Not done yet.");
    expect(m.text).toContain("https://portal.example.org/payments");
    expect(m.text).toContain("https://portal.example.org/season");
    // The club's text is text in the HTML part.
    expect(m.html).toContain("Locker &lt;returned&gt;");
    expect(m.html).not.toContain("<returned>");
    const one = requirementDueMessage(b, "ana@example.com", { dueWords: "Saturday, March 13, 2027", daysLeft: 3, season: "https://portal.example.org/season", payments: null,
      items: [{ title: "Medical form", forName: null, standing: "Not done yet" }] });
    expect(one.subject).toBe("Due Saturday, March 13, 2027: Medical form");
    expect(one.text).toContain("something the club asks of your family is due Saturday, March 13, 2027, 3 days from now.");
    expect(one.text).not.toContain("/payments");
  });
});
