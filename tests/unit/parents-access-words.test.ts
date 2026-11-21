import { describe, it, expect } from "vitest";
import { accessWords } from "@/lib/parents/directory";

describe("accessWords: words for every closing reason, since old rows carry them", () => {
  it.each([
    [{ status: "active", reason: null, blocked: false, hasPassword: true }, "can", "Can sign in"],
    [{ status: "invited", reason: null, blocked: false, hasPassword: true }, "can", "Can sign in (hasn't yet)"],
    [{ status: "active", reason: null, blocked: true, hasPassword: true }, "blocked", "Blocked"],
    [{ status: "disabled", reason: "inactive", blocked: false, hasPassword: true }, "cannot", "Can't sign in: inactive in QuickBooks"],
    [{ status: "disabled", reason: "family_inactive", blocked: false, hasPassword: true }, "cannot", "Can't sign in: the family is inactive in QuickBooks"],
    [{ status: "disabled", reason: "no_email", blocked: false, hasPassword: true }, "cannot", "Can't sign in: no email address in QuickBooks"],
    [{ status: "disabled", reason: "no_active_students", blocked: false, hasPassword: true }, "cannot", "Can't sign in: the family has no active students"],
    [{ status: "disabled", reason: "not_in_quickbooks", blocked: false, hasPassword: true }, "cannot", "Can't sign in: not listed under this family in QuickBooks"],
    [{ status: "disabled", reason: "address_changed", blocked: false, hasPassword: true }, "cannot", "Can't sign in: the email address changed in QuickBooks"],
    [{ status: "disabled", reason: "company_changed", blocked: false, hasPassword: true }, "cannot", "Can't sign in: a different QuickBooks company was connected"],
    [{ status: "disabled", reason: "removed", blocked: false, hasPassword: true }, "cannot", "Can't sign in: removed by staff"],
    [{ status: "disabled", reason: null, blocked: false, hasPassword: true }, "cannot", "Can't sign in"],
    // Old rows the retired held-address review closed keep their reason, and read in words, naming no family.
    [{ status: "disabled", reason: "held", blocked: false, hasPassword: true }, "cannot", "Can't sign in: the address was under more than one family, and held for staff to review"],
  ] as const)("%j", (input, kind, words) => {
    expect(accessWords(input)).toEqual({ kind, words });
  });

  // An open row whose family the gate won't let its person into now: nothing closed it, and the words say why not.
  it.each([
    [{ status: "invited", reason: null, blocked: false, hasPassword: true, family: "counts" }, "can", "Can sign in (hasn't yet)"],
    [{ status: "active", reason: null, blocked: false, hasPassword: true, family: "inactive" }, "cannot", "Can't sign in now: the family is inactive"],
    [{ status: "invited", reason: null, blocked: false, hasPassword: true, family: "no_students" }, "cannot", "Can't sign in now: the family has no active students"],
    [{ status: "active", reason: null, blocked: false, hasPassword: true, family: "held" }, "cannot", "Can't sign in now: the family was made active again from the books, and its guardians wait for someone who may change families to let them in on its page"],
    [{ status: "active", reason: null, blocked: false, hasPassword: true, family: "no_record" }, "cannot", "Can't sign in now: the family isn't set up in the portal"],
    [{ status: "active", reason: null, blocked: true, hasPassword: true, family: "inactive" }, "blocked", "Blocked"],
    [{ status: "disabled", reason: "removed", blocked: false, hasPassword: true, family: "inactive" }, "cannot", "Can't sign in: removed by staff"],
  ] as const)("%j", (input, kind, words) => {
    expect(accessWords(input)).toEqual({ kind, words });
  });

  // A person who may sign in but hasn't chosen a password yet (the sign-in release, slice SI-4) can still be welcomed
  // again (`can`), in words that say what is missing; every other standing reads as it did.
  it.each([
    [{ status: "invited", reason: null, blocked: false, hasPassword: false }, "can", "Hasn't chosen a password yet"],
    [{ status: "active", reason: null, blocked: false, hasPassword: false, family: "counts" }, "can", "Hasn't chosen a password yet"],
    [{ status: "active", reason: null, blocked: true, hasPassword: false }, "blocked", "Blocked"],
    [{ status: "invited", reason: null, blocked: false, hasPassword: false, family: "inactive" }, "cannot", "Can't sign in now: the family is inactive"],
    [{ status: "disabled", reason: "removed", blocked: false, hasPassword: false }, "cannot", "Can't sign in: removed by staff"],
  ] as const)("%j", (input, kind, words) => {
    expect(accessWords(input)).toEqual({ kind, words });
  });
});
