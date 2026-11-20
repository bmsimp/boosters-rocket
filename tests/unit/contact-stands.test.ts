import { describe, it, expect } from "vitest";
import { beforeResend, contactStands, heldInCache, type CachedCustomer } from "@/lib/roster/write-rules";
import type { RosterWrite } from "@/lib/db/schema";

/**
 * Stage 3's slice 11b: how QuickBooks' details stand against a parent's change of their phone and address, field by
 * field on the take-in's normal form (detailKey()), and what the queue makes of one that may have been sent.
 */
type ContactWrite = Extract<RosterWrite, { op: "contact" }>;
const NONE = { line1: "", line2: "", city: "", region: "", postalCode: "", country: "" };
const write = (w: Partial<ContactWrite> = {}): ContactWrite => ({ op: "contact", role: "parent", qboId: "11", syncToken: "4", change: { phone: "512-555-0222" },
  was: { phone: "555-0101" }, guardianId: "g", ...w });
const held = (phone: string, address = NONE) => ({ phone, address });

describe("contactStands()", () => {
  it("in place when QuickBooks holds the new value, but for case and spacing", () => {
    expect(contactStands(held(" 512-555-0222 "), write())).toBe("in_place");
    expect(contactStands(held("555-0101", { ...NONE, line1: "7  KESTREL way" }), write({ change: { address: { ...NONE, line1: "7 Kestrel Way" } }, was: { address: NONE } }))).toBe("in_place");
  });

  it("sendable when QuickBooks holds the before-value, or what any earlier change that may have been sent asked for", () => {
    expect(contactStands(held("555-0101"), write())).toBe("sendable");
    const earlier = write({ orWas: [{ phone: "512-555-0111" }, { phone: "512-555-0122" }] });
    expect(contactStands(held("512-555-0111"), earlier)).toBe("sendable");
    expect(contactStands(held("512-555-0122"), earlier)).toBe("sendable");
  });

  it("differs when QuickBooks holds anything the portal never knew of, in any field it sends", () => {
    expect(contactStands(held("555-9999"), write())).toBe("differs");
    const both = write({ change: { phone: "512-555-0222", address: { ...NONE, line1: "7 Kestrel Way" } }, was: { phone: "555-0101", address: NONE } });
    expect(contactStands(held("555-0101", { ...NONE, line1: "1 Somewhere Else" }), both)).toBe("differs");
    // A field the change doesn't send is never compared.
    expect(contactStands(held("555-0101", { ...NONE, line1: "1 Somewhere Else" }), write())).toBe("sendable");
  });

  it("an empty field there is the portal's to fill only where the portal knew it empty, whatever the version", () => {
    // Someone may have cleared it in QuickBooks: a difference, as any other value the portal never knew of.
    expect(contactStands(held(""), write())).toBe("differs");
    expect(contactStands(held(""), write({ syncToken: "" }))).toBe("differs");
    // The portal knew it empty (a Parent customer made with no phone): sendable.
    expect(contactStands(held(""), write({ was: { phone: "" } }))).toBe("sendable");
    expect(contactStands(held("", NONE), write({ change: { address: { ...NONE, line1: "7 Kestrel Way" } }, was: { address: NONE } }))).toBe("sendable");
    // Or an earlier change that may have been sent asked for it empty.
    expect(contactStands(held(""), write({ orWas: [{ phone: "" }] }))).toBe("sendable");
    expect(contactStands(held(""), write({ orWas: [{ phone: "512-555-0111" }] }))).toBe("differs");
    // Field by field: the address known empty, the phone not.
    const both = write({ change: { phone: "512-555-0222", address: { ...NONE, line1: "7 Kestrel Way" } }, was: { phone: "555-0101", address: NONE } });
    expect(contactStands(held("555-0101", NONE), both)).toBe("sendable");
    expect(contactStands(held("", NONE), both)).toBe("differs");
    expect(contactStands(held("", NONE), { ...both, was: { phone: "", address: { ...NONE, line1: "1 Somewhere" } } })).toBe("differs");
    expect(contactStands(held("", NONE), { ...both, was: { phone: "", address: NONE } })).toBe("sendable");
  });
});

describe("beforeResend() for a contact change that may have been sent", () => {
  const cached = (c: Partial<CachedCustomer>): CachedCustomer => ({ qboId: "11", displayName: "Ana Rivera", active: true, parentQboId: "10", typeQboId: "2", syncToken: "4",
    phone: "555-0101", addressLine1: null, addressLine2: null, addressCity: null, addressRegion: null, addressPostalCode: null, addressCountry: null, ...c });
  it("done when the roster's copy holds the change", () => {
    expect(beforeResend(write(), [cached({ phone: "512-555-0222", syncToken: "5" })])).toEqual({ is: "done", qboId: "11" });
  });
  it("sent again only while it holds the before-value at the version it was sent with", () => {
    expect(beforeResend(write(), [cached({})])).toEqual({ is: "send" });
    expect(beforeResend(write(), [cached({ syncToken: "5" })])).toEqual({ is: "stuck", code: "moved_on" });
    expect(beforeResend(write(), [cached({ phone: "555-9999" })])).toEqual({ is: "stuck", code: "moved_on" });
    // Empty where the portal knew a phone: settled by the field, read live, at the version it was sent with too.
    expect(beforeResend(write(), [cached({ phone: null })])).toEqual({ is: "stuck", code: "moved_on" });
    expect(beforeResend(write(), [cached({ phone: null, syncToken: "5" })])).toEqual({ is: "stuck", code: "moved_on" });
    // Empty where the portal knew it empty: sent again at the same version.
    expect(beforeResend(write({ was: { phone: "" } }), [cached({ phone: null })])).toEqual({ is: "send" });
  });
  it("gone from the roster: stuck", () => {
    expect(beforeResend(write(), [])).toEqual({ is: "stuck", code: "gone" });
  });
  it("reads the cache's columns as the form shows them", () => {
    expect(heldInCache({ phone: null, addressCity: "Austin" })).toEqual({ phone: "", address: { ...NONE, city: "Austin" } });
  });
});
