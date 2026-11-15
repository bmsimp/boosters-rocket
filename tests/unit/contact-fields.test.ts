import { describe, it, expect } from "vitest";
import { CONTACT_FIELDS, NOT_THE_FORM, parseContactForm, sameAddress, samePhone, type ContactValues } from "@/lib/parents/contact-fields";

const GOOD: ContactValues = { phone: "512-555-0171", line1: "12 Heron Lane", line2: "", city: "Austin", region: "TX", postalCode: "78745", country: "" };
const sent = (over: Record<string, unknown> = {}) => ({ ...GOOD, version: "3", ...over });
const without = (name: string) => Object.fromEntries(Object.entries(sent()).filter(([field]) => field !== name));
const at = (code: number) => String.fromCodePoint(code);

describe("parseContactForm: what a browser sends for a parent's phone and address", () => {
  it("takes the form's fields as trimmed text, with the version it was shown", () => {
    expect(parseContactForm(sent({ phone: "  512-555-0171 ", city: "\tAustin\n" }))).toEqual({ ok: true, form: { values: GOOD, version: "3" } });
    // Everything may be empty: an empty field is a cleared one.
    const empty = Object.fromEntries(CONTACT_FIELDS.map((f) => [f.name, ""])) as ContactValues;
    expect(parseContactForm({ ...empty, version: "0" })).toEqual({ ok: true, form: { values: empty, version: "0" } });
  });

  it("reads nothing but its own fields: an id sent along is not in what comes out", () => {
    const parsed = parseContactForm(sent({ id: "8011", Id: "8011", customerId: "8011", familyQboId: "8010" }));
    expect(parsed).toEqual({ ok: true, form: { values: GOOD, version: "3" } });
    expect(JSON.stringify(parsed)).not.toMatch(/8011|8010/);
  });

  it("allows each field up to its limit and refuses one character more, naming the field", () => {
    for (const { name, label, max } of CONTACT_FIELDS) {
      expect(parseContactForm(sent({ [name]: "x".repeat(max) })), name).toMatchObject({ ok: true });
      expect(parseContactForm(sent({ [name]: "x".repeat(max + 1) })), name).toEqual({ ok: false, errors: [`${label} can be up to ${max} characters. Please shorten it.`] });
      // Spaces around a value don't count against it.
      expect(parseContactForm(sent({ [name]: `  ${"x".repeat(max)}  ` })), name).toMatchObject({ ok: true });
    }
    expect(CONTACT_FIELDS.find((f) => f.name === "phone")!.max).toBe(30);
  });

  it("refuses control characters, line and paragraph separators and characters that reorder text, inside any field", () => {
    for (const code of [0, 7, 9, 10, 13, 27, 127, 0x85, 0x9f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069]) {
      for (const { name, label } of CONTACT_FIELDS) {
        expect(parseContactForm(sent({ [name]: `a${at(code)}b` })), `${name} with U+${code.toString(16)}`).toEqual({ ok: false, errors: [`${label} has a character that can't be saved. Please type it again.`] });
      }
    }
  });

  it("keeps what is only text: markup, quotes, accents, other scripts, an emoji", () => {
    for (const text of ["<img src=x onerror=alert(1)>", `"quoted" & 'single'`, "Zoë Ångström", "東京都", "🏠 home", "+1 (512) 555-0171 ext. 22", "a  b"]) {
      expect(parseContactForm(sent({ line1: text })), text).toEqual({ ok: true, form: { values: { ...GOOD, line1: text }, version: "3" } });
    }
    // A decomposed accent is stored composed, so the same address typed two ways compares equal.
    expect(parseContactForm(sent({ city: `Zoe${at(0x308)}` }))).toMatchObject({ ok: true, form: { values: { city: `Zo${at(0xeb)}` } } });
  });

  it("reports every field that is wrong, in the form's order", () => {
    expect(parseContactForm(sent({ postalCode: "x".repeat(21), phone: "x".repeat(31), city: `a${at(7)}` }))).toEqual({ ok: false, errors: [
      "Phone can be up to 30 characters. Please shorten it.", "City has a character that can't be saved. Please type it again.", "ZIP or postal code can be up to 20 characters. Please shorten it."] });
  });

  it("refuses anything that isn't the form, with one answer that says nothing about why", () => {
    const notTheForm = [
      null, undefined, "phone=1", 7, [], [sent()], new Map(Object.entries(sent())),
      sent({ version: undefined }), sent({ version: 3 }), sent({ version: "" }), sent({ version: "3a" }), sent({ version: "-1" }), sent({ version: " 3" }), sent({ version: "1".repeat(21) }),
      sent({ phone: undefined }), sent({ phone: null }), sent({ phone: 5125550171 }), sent({ phone: ["512"] }), sent({ phone: { toString: () => "512" } }),
      sent({ line2: "x".repeat(2001) }), without("city"), without("country"),
    ];
    for (const input of notTheForm) expect(parseContactForm(input), JSON.stringify(input) ?? String(input)).toEqual({ ok: false, errors: [NOT_THE_FORM] });
  });
});

describe("samePhone and sameAddress", () => {
  it("compare the phone alone, and the address part for part", () => {
    expect(samePhone(GOOD, { ...GOOD, city: "Buda" })).toBe(true);
    expect(samePhone(GOOD, { ...GOOD, phone: "512-555-0172" })).toBe(false);
    expect(sameAddress(GOOD, { ...GOOD, phone: "512-555-0172" })).toBe(true);
    for (const name of ["line1", "line2", "city", "region", "postalCode", "country"] as const) expect(sameAddress(GOOD, { ...GOOD, [name]: "other" }), name).toBe(false);
  });
});
