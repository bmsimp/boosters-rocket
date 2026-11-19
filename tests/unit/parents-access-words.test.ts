import { describe, it, expect } from "vitest";
import { accessWords } from "@/lib/parents/directory";

describe("accessWords: words for every closing reason, since old rows carry them", () => {
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
    // Old rows the retired held-address review closed keep their reason, and read in words, naming no family.
    [{ status: "disabled", reason: "held", blocked: false }, "cannot", "Can't sign in: the address was under more than one family, and held for staff to review"],
  ] as const)("%j", (input, kind, words) => {
    expect(accessWords(input)).toEqual({ kind, words });
  });
});
