import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { accountingWords, capitalized } from "@/lib/accounting/words";

/** The connected accounting system's words (src/lib/accounting/words.ts): QuickBooks' today, the one system there is. */
describe("the accounting words", () => {
  it("are QuickBooks' while it is the one system the portal connects to", () => {
    expect(accountingWords()).toEqual({
      system: "quickbooks", name: "QuickBooks", customerNoun: "customer", customerNounPlural: "customers",
      nests: true, canWrite: true, settingsHref: "/staff/settings/quickbooks",
    });
  });

  it("name a logo the portal serves", () => {
    expect(existsSync(`public/integrations/${accountingWords().system}/qb-ball.svg`)).toBe(true);
  });

  it("capitalize a noun for the start of a heading", () => {
    expect(capitalized(accountingWords().customerNounPlural)).toBe("Customers");
    expect(capitalized("contact")).toBe("Contact");
    expect(capitalized("")).toBe("");
  });
});
