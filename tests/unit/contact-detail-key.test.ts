import { describe, it, expect } from "vitest";
import { detailKey, type AddressValues } from "@/lib/parents/contact-fields";

const ADDRESS: AddressValues = { line1: "12 Heron Lane", line2: "Unit 4", city: "Austin", region: "TX", postalCode: "78745", country: "" };
const EMPTY: AddressValues = { line1: "", line2: "", city: "", region: "", postalCode: "", country: "" };

/**
 * The one normal form a phone or an address is compared by (stage 3's slice 11b): the take-in deciding whether a
 * person's records agree, and a parent's change sent on deciding whether QuickBooks still holds what the portal last
 * knew it held. Two details are the same when their keys are.
 */
describe("detailKey: one phone or address in the normal form every comparison uses", () => {
  it("a phone: as the form shows it, runs of white space as one, letter case ignored", () => {
    expect(detailKey("512-555-0171")).toBe("512-555-0171");
    expect(detailKey("  512   555\t0171 ")).toBe(detailKey("512 555 0171"));
    expect(detailKey("512-555-0171 EXT 4")).toBe(detailKey("512-555-0171 ext 4"));
    expect(detailKey("512-555-0171")).not.toBe(detailKey("512-555-0172"));
  });

  it("no phone is none, however it is written", () => {
    for (const none of ["", "   ", "\t", null, undefined]) expect(detailKey(none), JSON.stringify(none)).toBeNull();
  });

  it("an address: part by part, spacing and letter case ignored, a line break as the form shows it", () => {
    expect(detailKey(ADDRESS)).toBe(detailKey({ ...ADDRESS, line1: "12  HERON lane ", city: "austin" }));
    expect(detailKey({ ...ADDRESS, line2: "Unit 4\nBack door" })).toBe(detailKey({ ...ADDRESS, line2: "Unit 4, Back door" }));
    // A part moved to another line is another address.
    expect(detailKey(ADDRESS)).not.toBe(detailKey({ ...ADDRESS, line1: "12 Heron Lane Unit 4", line2: "" }));
    expect(detailKey(ADDRESS)).not.toBe(detailKey({ ...ADDRESS, postalCode: "78746" }));
  });

  it("an address whose parts are all empty is none, so an empty line never makes two addresses differ", () => {
    expect(detailKey(EMPTY)).toBeNull();
    expect(detailKey({ ...EMPTY, line2: "   " })).toBeNull();
    expect(detailKey({ line1: "12 Heron Lane" })).toBe(detailKey({ ...EMPTY, line1: "12 Heron Lane" }));
  });

  it("a phone is never the same as an address", () => {
    expect(detailKey("12 Heron Lane")).not.toBe(detailKey({ ...EMPTY, line1: "12 Heron Lane" }));
  });
});
