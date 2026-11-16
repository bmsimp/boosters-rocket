import { describe, it, expect } from "vitest";
import { CONTACT_FIELDS, NOT_THE_FORM, asShown, fieldErrors, parseContactForm, sameAddress, samePhone, type ContactValues } from "@/lib/parents/contact-fields";

const GOOD: ContactValues = { phone: "512-555-0171", line1: "12 Heron Lane", line2: "", city: "Austin", region: "TX", postalCode: "78745", country: "" };
const sent = (over: Record<string, unknown> = {}) => ({ ...GOOD, version: "3", ...over });
const without = (name: string) => Object.fromEntries(Object.entries(sent()).filter(([field]) => field !== name));
const at = (code: number) => String.fromCodePoint(code);
/** The form read, then every field checked as one the parent typed: what a save does with a form none of which is as it was shown. */
const checked = (input: unknown) => {
  const parsed = parseContactForm(input);
  if (!parsed.ok) return parsed;
  const errors = fieldErrors(parsed.form.values, null);
  return errors.length ? { ok: false, errors } : parsed;
};

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
      expect(checked(sent({ [name]: "x".repeat(max) })), name).toMatchObject({ ok: true });
      expect(checked(sent({ [name]: "x".repeat(max + 1) })), name).toEqual({ ok: false, errors: [`${label} can be up to ${max} characters. Please shorten it.`] });
      // Spaces around a value don't count against it.
      expect(checked(sent({ [name]: `  ${"x".repeat(max)}  ` })), name).toMatchObject({ ok: true });
    }
    expect(CONTACT_FIELDS.find((f) => f.name === "phone")!.max).toBe(30);
  });

  it("refuses control characters, line and paragraph separators and characters that reorder text, inside any field", () => {
    for (const code of [0, 7, 9, 10, 13, 27, 127, 0x85, 0x9f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069]) {
      for (const { name, label } of CONTACT_FIELDS) {
        expect(checked(sent({ [name]: `a${at(code)}b` })), `${name} with U+${code.toString(16)}`).toEqual({ ok: false, errors: [`${label} has a character that can't be saved. Please type it again.`] });
      }
    }
  });

  it("keeps what is only text: markup, quotes, accents, other scripts, an emoji", () => {
    for (const text of ["<img src=x onerror=alert(1)>", `"quoted" & 'single'`, "Zoë Ångström", "東京都", "🏠 home", "+1 (512) 555-0171 ext. 22", "a  b"]) {
      expect(checked(sent({ line1: text })), text).toEqual({ ok: true, form: { values: { ...GOOD, line1: text }, version: "3" } });
    }
    // A decomposed accent is stored composed, so the same address typed two ways compares equal.
    expect(parseContactForm(sent({ city: `Zoe${at(0x308)}` }))).toMatchObject({ ok: true, form: { values: { city: `Zo${at(0xeb)}` } } });
  });

  it("reports every field that is wrong, in the form's order", () => {
    expect(checked(sent({ postalCode: "x".repeat(21), phone: "x".repeat(31), city: `a${at(7)}` }))).toEqual({ ok: false, errors: [
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

describe("fieldErrors: length and characters are checked on what the parent changed", () => {
  const LONG_CITY = "x".repeat(150), LONG_ZIP = "9".repeat(25);
  const shown: ContactValues = { ...GOOD, city: LONG_CITY, postalCode: LONG_ZIP };

  it("leaves alone a field that still holds what the form was shown, however long", () => {
    expect(fieldErrors({ ...shown, phone: "512-555-0222" }, shown)).toEqual([]);
    expect(fieldErrors(shown, shown)).toEqual([]);
  });

  it("checks a field the parent changed, and only that one", () => {
    expect(fieldErrors({ ...shown, postalCode: `${LONG_ZIP}0` }, shown)).toEqual(["ZIP or postal code can be up to 20 characters. Please shorten it."]);
    expect(fieldErrors({ ...shown, phone: `512${at(9)}555` }, shown)).toEqual(["Phone has a character that can't be saved. Please type it again."]);
    // Shortened to fit, it is fine; the city nobody touched is still not theirs to fix.
    expect(fieldErrors({ ...shown, postalCode: "78745" }, shown)).toEqual([]);
  });

  it("with nothing shown, checks every field", () => {
    expect(fieldErrors(shown, null)).toEqual(["City can be up to 100 characters. Please shorten it.", "ZIP or postal code can be up to 20 characters. Please shorten it."]);
  });
});

describe("asShown: a QuickBooks value as one line of a form", () => {
  it("leaves an ordinary value as it is, trimmed", () => {
    for (const text of ["12 Heron Lane", "Zoë Ångström", "東京都", "🏠 home", "a  b", `"quoted" & <b>`, ""]) expect(asShown(text), text).toBe(text);
    expect(asShown("  Austin \t")).toBe("Austin");
  });

  it("writes a line break as a comma and a space, however the break is made and whatever stands around it", () => {
    for (const br of ["\n", "\r\n", "\r", "\n\n", " \n ", at(0x2028), at(0x2029), at(0x85), at(0x0b), at(0x0c), " \r\n\t\r\n "]) {
      expect(asShown(`12 Heron Lane${br}Apt 4`), JSON.stringify(br)).toBe("12 Heron Lane, Apt 4");
    }
    expect(asShown("\n12 Heron Lane\r\n")).toBe("12 Heron Lane");
  });

  it("writes any other control character as a space, and drops the characters that reorder text", () => {
    expect(asShown("Aus\ttin")).toBe("Aus tin");
    expect(asShown(`Aus${at(0)}tin${at(7)}`)).toBe("Aus tin");
    expect(asShown(`Aus${at(0x202e)}tin${at(0x2066)}`)).toBe("Austin");
  });

  it("leaves a browser nothing to change: a one-line field sends it back as it is, and the form's checks pass it", () => {
    const loneHigh = String.fromCharCode(0xd83c), loneLow = String.fromCharCode(0xdfe0);
    const awkward = ["12 Heron Lane\nApt 4", "a\r\nb\tc", `x${at(0)}y`, `e${at(0x202a)}${at(0x301)}`, `Zoe${at(0x308)}\n`, loneHigh, `ok${loneLow}`,
      `${at(0x2028)}${at(0x2029)}`, " \t ", `a${at(0x85)}b`, "🏠 home", `tab\tat the end${at(0x1f)}`];
    for (const raw of awkward) {
      const shown = asShown(raw);
      // An <input> drops line breaks from the value it is given, and a form sends text that is well formed.
      const sentBack = shown.replace(/[\r\n]/g, "").toWellFormed();
      expect(sentBack, JSON.stringify(raw)).toBe(shown);
      expect(asShown(shown), JSON.stringify(raw)).toBe(shown);
      expect(parseContactForm(sent({ line1: sentBack })), JSON.stringify(raw)).toMatchObject({ ok: true, form: { values: { line1: shown } } });
      expect(fieldErrors({ ...GOOD, line1: sentBack }, null), JSON.stringify(raw)).toEqual([]);
    }
    expect(asShown(`e${at(0x202a)}${at(0x301)}`)).toBe(at(0xe9)); // composed once the character between is gone
    expect(asShown(loneHigh)).toBe(at(0xfffd));
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
