import { describe, expect, it } from "vitest";
import * as now from "@/lib/mail/messages";
import * as before from "../helpers/legacy-mail-messages";
import { EMAILS, defaultTemplate, emailByKey, renderEmail, rulesOf, sampleEmail, wordsFor } from "@/lib/email-templates/catalog";
import { checkTemplate, NO_ADDRESSES, type TemplateDoc } from "@/lib/email-templates/body";

/*
 * Email templates (docs/superpowers/specs/2026-11-28-email-templates-design.md), slice 1: an email the club never
 * changed is the same, byte for byte, as what the portal sent before the templates, for every variant of every email.
 */

const B = { clubName: "Lakeside <Band> & \"Boosters\"", color: "#336699" };
const shift = { event: "Fall concert", role: "Ushers", when: "Fri, Oct 9, 6 pm", location: "Auditorium" };
const noRole = { ...shift, role: null };
const kid = { self: false as const, name: "Maya O'Neil" };
const me = { self: true as const };
const link = { url: "https://p.example/sign-in/set-up/abc&x=1", life: "7 days", strict: false };

type Call = [string, (m: typeof now | typeof before) => unknown];
const CALLS: Call[] = [
  ["signin code", (m) => m.signinCodeMessage(B, "a@x.org", "123456", { passwordPage: "https://p/sign-in/password", minutes: 10 })],
  ["signin code, 1 minute", (m) => m.signinCodeMessage(B, "a@x.org", "654321", { passwordPage: "https://p/sign-in/password", minutes: 1 })],
  ["change code", (m) => m.changeCodeMessage(B, "a@x.org", "123456", { settingsPage: "https://p/family/sign-in", minutes: 4 })],
  ["welcome, link", (m) => m.welcomeMessage(B, "a@x.org", { appUrl: "https://p", contact: "club@x.org", link })],
  ["welcome, strict link, no contact", (m) => m.welcomeMessage(B, "a@x.org", { appUrl: "https://p", contact: null, link: { ...link, strict: true } })],
  ["welcome, earlier", (m) => m.welcomeMessage(B, "a@x.org", { appUrl: "https://p", contact: "club@x.org", link: { earlier: true, strict: false } })],
  ["welcome, earlier strict", (m) => m.welcomeMessage(B, "a@x.org", { appUrl: "https://p", contact: null, link: { earlier: true, strict: true } })],
  ["welcome, password", (m) => m.welcomeMessage(B, "a@x.org", { appUrl: "https://p", contact: "club@x.org", link: null })],
  ["choose password", (m) => m.choosePasswordMessage(B, "a@x.org", { appUrl: "https://p", contact: "club@x.org", link })],
  ["choose password, strict", (m) => m.choosePasswordMessage(B, "a@x.org", { appUrl: "https://p", contact: null, link: { ...link, strict: true } })],
  ["email change confirm", (m) => m.emailChangeConfirmMessage(B, "a@x.org", { link: "https://p/family/email/tok" })],
  ["email change notice", (m) => m.emailChangeNoticeMessage(B, "a@x.org")],
  ["password setup", (m) => m.passwordSetupMessage(B, "a@x.org", { link: "https://p/s/t", life: "7 days" })],
  ["password reset", (m) => m.passwordResetMessage(B, "a@x.org", { link: "https://p/r/t", life: "1 hour" })],
  ["signin reset", (m) => m.signinResetMessage(B, "a@x.org", { link: "https://p/s/t", life: "7 days", contact: "t@x.org", strict: false })],
  ["signin reset, strict, no contact", (m) => m.signinResetMessage(B, "a@x.org", { link: "https://p/s/t", life: "7 days", contact: null, strict: true })],
  ["password changed", (m) => m.passwordChangedMessage(B, "a@x.org", { passwordPage: "https://p/sign-in/password", contact: "t@x.org" })],
  ["password changed, no contact", (m) => m.passwordChangedMessage(B, "a@x.org", { passwordPage: "https://p/sign-in/password", contact: null })],
  ["volunteer signup", (m) => m.volunteerSignupMessage(B, "a@x.org", { who: kid, shift, contact: "Dana", cancelUntil: "Oct 7", link: "https://p/volunteer", calendar: "ICS" })],
  ["volunteer signup, self, no cancel", (m) => m.volunteerSignupMessage(B, "a@x.org", { who: me, shift: noRole, contact: "Dana", cancelUntil: null, link: "https://p/volunteer", calendar: "ICS" })],
  ["volunteer change", (m) => m.volunteerChangeMessage(B, "a@x.org", { who: kid, before: { ...shift, when: "earlier" }, after: shift, contact: "Dana", link: "https://p/v", calendar: "ICS" })],
  ["volunteer change, same", (m) => m.volunteerChangeMessage(B, "a@x.org", { who: me, before: noRole, after: noRole, contact: "Dana", link: "https://p/v", calendar: "ICS" })],
  ["volunteer cancel, event", (m) => m.volunteerCancelMessage(B, "a@x.org", { who: kid, shift, whole: "event", contact: "Dana", calendar: "ICS" })],
  ["volunteer cancel, shift, self", (m) => m.volunteerCancelMessage(B, "a@x.org", { who: me, shift: noRole, whole: "shift", contact: "Dana", calendar: "ICS" })],
  ["form copy, pdf", (m) => m.signedFormCopyMessage(B, "a@x.org", { formTitle: "Medical <release>", forName: "Maya", pdf: Buffer.from("%PDF-"), link: "https://p/f" })],
  ["form copy, parts", (m) => m.signedFormCopyMessage(B, "a@x.org", { formTitle: "Release", forName: "Maya", pdf: null, link: "https://p/f", parts: 3 })],
  ["form copy, link", (m) => m.signedFormCopyMessage(B, "a@x.org", { formTitle: "Release", forName: "Maya", pdf: null, link: "https://p/f" })],
  ["form reminder", (m) => m.formReminderMessage(B, "a@x.org", { formTitle: "Release", forNames: ["Maya", "Leo", "Ana"], due: "Sep 4", link: "https://p/forms/1" })],
  ["form reminder, past due", (m) => m.formReminderMessage(B, "a@x.org", { formTitle: "Release", forNames: ["Maya"], due: "Sep 4", pastDue: true, link: "https://p/forms" })],
  ["form reminder, no due", (m) => m.formReminderMessage(B, "a@x.org", { formTitle: "Release", forNames: [], due: null, link: "https://p/forms" })],
  ["volunteer removed, staff", (m) => m.volunteerRemovedMessage(B, "a@x.org", { who: kid, shift, why: "staff", contact: "Dana", link: "https://p/v", calendar: "ICS" })],
  ["volunteer removed, moved, self", (m) => m.volunteerRemovedMessage(B, "a@x.org", { who: me, shift: noRole, why: "moved", contact: "Dana", link: "https://p/v", calendar: "ICS" })],
  ["volunteer reminder", (m) => m.volunteerReminderMessage(B, "a@x.org", { who: kid, shift, contact: "Dana", link: "https://p/v" })],
  ["volunteer reminder, self", (m) => m.volunteerReminderMessage(B, "a@x.org", { who: me, shift: noRole, contact: "Dana", link: "https://p/v" })],
  ["volunteer due", (m) => m.volunteerDueMessage(B, "a@x.org", { dueWords: "Friday", daysLeft: 7, items: [{ title: "Hours", whoMust: "Anyone", standing: "2 of 6" }, { title: "B", whoMust: "C", standing: "D" }], link: "https://p/v" })],
  ["requirement due, one", (m) => m.requirementDueMessage(B, "a@x.org", { dueWords: "Friday", daysLeft: 3, items: [{ title: "Fee", forName: "Maya", standing: "Not paid yet" }], season: "https://p/season", payments: "https://p/payments" })],
  ["requirement due, many", (m) => m.requirementDueMessage(B, "a@x.org", { dueWords: "Friday", daysLeft: 3, items: [{ title: "Fee", forName: null, standing: "Due" }, { title: "Form", forName: "Leo", standing: "Not done" }], season: "https://p/season", payments: null })],
  ["club message", (m) => m.clubMessageMail(B, "a@x.org", { poster: "Dana", title: "Fittings <Sat>", update: false, body: { text: "Hi", html: "<p>Hi</p>" }, files: ["a.pdf", "b <x>.docx"], link: "https://p/messages/1" })],
  ["club message, update, empty body", (m) => m.clubMessageMail(B, "a@x.org", { poster: "Dana", title: "Fittings", update: true, body: { text: "", html: "" }, files: [], link: "https://p/messages/1" })],
  ["test", (m) => m.testMessage(B, "a@x.org")],
];

describe("email templates' defaults", () => {
  it.each(CALLS)("%s is the same as before, byte for byte", (_name, call) => {
    expect(call(now)).toEqual(call(before));
  });

  it("are twenty emails, each with a unique key, and every default passes its own check", () => {
    expect(EMAILS).toHaveLength(20);
    expect(new Set(EMAILS.map((e) => e.key)).size).toBe(20);
    for (const e of EMAILS) {
      const d = defaultTemplate(emailByKey(e.key)!);
      expect(checkTemplate(rulesOf(e), d), e.key).toEqual({ ok: true, subject: d.subject, body: d.body });
    }
  });

  it("each draws its sample with no field left in braces", () => {
    for (const e of EMAILS) {
      const any = emailByKey(e.key)!;
      const m = sampleEmail(any, { clubName: "Lakeside", color: "#123456", portal: "https://portal.example" }, "me@x.org", defaultTemplate(any));
      expect(m.subject).not.toMatch(/[{}]/);
      expect(m.text).toContain("Powered by Boosters Rocket");
    }
  });
});

describe("the club's words", () => {
  const e = emailByKey("form_reminder")!;
  const body: TemplateDoc = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Hello <there>, ", marks: [{ type: "bold" }] }, { type: "field", attrs: { id: "formName" } }] },
    { type: "fixedPart", attrs: { id: "link" } },
    { type: "paragraph", content: [{ type: "text", text: "Write to " }, { type: "field", attrs: { id: "contact" } }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
    { type: "fixedPart", attrs: { id: "due" } },
  ] };
  const data = { formTitle: "Release & co", forNames: ["Maya"], due: null, link: "https://p/forms" };

  it("are sent in place of the default, escaped, with each fixed part where the club put it", () => {
    const m = renderEmail(e, { ...B, templates: { form_reminder: { subject: "Sign {Form name} for {Club name}", body } } }, "a@x.org", data);
    expect(m.subject).toBe(`Sign Release & co for ${B.clubName}`);
    expect(m.html).toContain("<strong>Hello &lt;there&gt;, </strong>Release &amp; co");
    expect(m.text).toContain("Hello <there>, Release & co\n\nYou can read and sign it here: https://p/forms\n\n- one");
    // No contact: the paragraph with the field is left out; no due date: its fixed part draws nothing.
    expect(m.text).not.toContain("Write to");
    expect(m.html).toContain(`<ul style="margin:0 0 16px"><li>one</li></ul>`);
  });

  it("that no longer pass this release's rules are set aside for the default", () => {
    const broken = { subject: "Sign it", body: { type: "doc", content: [{ type: "paragraph" }] } };
    const w = wordsFor(e, broken);
    expect(w).toMatchObject({ club: false, usable: false, subject: "Please sign: {Form name}" });
    expect(renderEmail(e, { ...B, templates: { form_reminder: broken } }, "a@x.org", data)).toEqual(before.formReminderMessage(B, "a@x.org", data));
  });
});

describe("a code email whose words leave the code's sentence out", () => {
  it("still has the code in its plain text, on a line of its own", () => {
    for (const key of ["signin_code", "change_code"] as const) {
      const e = emailByKey(key)!;
      const body = { type: "doc" as const, content: defaultTemplate(e).body.content.filter((b) => b.type === "fixedPart") };
      const m = renderEmail(e, { ...B, templates: { [key]: { subject: null, body } } }, "a@x.org", { code: "482913", minutes: 10, passwordPage: "https://p/pw", settingsPage: "https://p/s" });
      expect(m.text.startsWith("Your code is 482913.\n\n"), key).toBe(true);
      expect(m.html).toContain(">482913</p>");
    }
  });
});

describe("checkTemplate()", () => {
  const signin = rulesOf(emailByKey("password_reset")!);
  const ok = { type: "doc", content: [{ type: "fixedPart", attrs: { id: "link" } }, { type: "fixedPart", attrs: { id: "neverAsks" } }, { type: "fixedPart", attrs: { id: "didNotAsk" } }] };
  const withPara = (p: unknown) => ({ ...ok, content: [p, ...ok.content] });

  it("keeps a body with every fixed part once", () => {
    expect(checkTemplate(signin, { subject: "Reset your {Club name} password", body: ok }).ok).toBe(true);
  });
  it("refuses a missing or doubled fixed part, naming it", () => {
    expect(checkTemplate(signin, { subject: "x", body: { ...ok, content: ok.content.slice(1) } }))
      .toEqual({ ok: false, errors: ['Put the fixed part "the link, and how long it works" back in the email. It can be moved, not removed.'] });
    expect(checkTemplate(signin, { subject: "x", body: { ...ok, content: [...ok.content, ok.content[0]] } }).ok).toBe(false);
  });
  it("refuses a link of the club's own in a sign-in email, and allows a safe one elsewhere", () => {
    const linked = { type: "paragraph", content: [{ type: "text", text: "here", marks: [{ type: "link", attrs: { href: "https://evil.example" } }] }] };
    expect(checkTemplate(signin, { subject: "x", body: withPara(linked) }).ok).toBe(false);
    const forms = rulesOf(emailByKey("form_reminder")!);
    const fbody = (href: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "here", marks: [{ type: "link", attrs: { href } }] }] },
      { type: "fixedPart", attrs: { id: "due" } }, { type: "fixedPart", attrs: { id: "link" } }] });
    expect(checkTemplate(forms, { subject: "x", body: fbody("https://club.example/info") }).ok).toBe(true);
    expect(checkTemplate(forms, { subject: "x", body: fbody("javascript:alert(1)") }).ok).toBe(false);
  });
  it("refuses an unknown field in the body or the subject, and nodes off the list", () => {
    expect(checkTemplate(signin, { subject: "x", body: withPara({ type: "paragraph", content: [{ type: "field", attrs: { id: "familySecret" } }] }) }).ok).toBe(false);
    expect(checkTemplate(signin, { subject: "Hi {Nope}", body: ok })).toMatchObject({ ok: false, errors: ["There's no field called {Nope} in this email. Pick one from Insert field."] });
    expect(checkTemplate(signin, { subject: "x", body: withPara({ type: "heading", attrs: { level: 2 } }) }).ok).toBe(false);
    expect(checkTemplate(signin, { subject: "x", body: withPara({ type: "image", attrs: { src: "https://x/y.png" } }) }).ok).toBe(false);
  });
  it("refuses an empty or overlong subject, and ignores one where the portal writes it", () => {
    expect(checkTemplate(signin, { subject: "  ", body: ok }).ok).toBe(false);
    expect(checkTemplate(signin, { subject: "x".repeat(201), body: ok }).ok).toBe(false);
    const code = rulesOf(emailByKey("signin_code")!);
    const codeBody = { type: "doc", content: ["bigCode", "life", "notYou"].map((id) => ({ type: "fixedPart", attrs: { id } })) };
    expect(checkTemplate(code, { subject: "anything", body: codeBody })).toMatchObject({ ok: true, subject: null });
  });
  it("refuses a web or email address typed into a Sign-in email's words or subject, and keeps one in the other emails", () => {
    const typed = (text: string) => withPara({ type: "paragraph", content: [{ type: "text", text }] });
    for (const text of ["Reset at https://evil.example/reset", "or go to www.evil.example", "write to help@evil.example", "visit evil-site.com today"]) {
      expect(checkTemplate(signin, { subject: "x", body: typed(text) }), text).toEqual({ ok: false, errors: [NO_ADDRESSES] });
    }
    expect(checkTemplate(signin, { subject: "Reset at https://evil.example {Club name}", body: ok })).toEqual({ ok: false, errors: [NO_ADDRESSES] });
    expect(checkTemplate(signin, { subject: "Reset your {Club name} password", body: typed("Sign in. Then choose a password, e.g. a long one.") }).ok).toBe(true);
    const forms = rulesOf(emailByKey("form_reminder")!);
    const fbody = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Questions? help@club.example" }] }, { type: "fixedPart", attrs: { id: "due" } }, { type: "fixedPart", attrs: { id: "link" } }] };
    expect(checkTemplate(forms, { subject: "x", body: fbody }).ok).toBe(true);
  });

  it("drops the marks that turn text around or hide in it, and refuses half a character in words", () => {
    const r = checkTemplate(signin, { subject: "Reset‮ drowssap​", body: withPara({ type: "paragraph", content: [{ type: "text", text: "a⁦b﻿c" }] }) });
    expect(r).toMatchObject({ ok: true, subject: "Reset drowssap" });
    expect(JSON.stringify(r)).toContain("\"abc\"");
    const broken = "The email has a character that can't be saved. Type that part again and try once more.";
    expect(checkTemplate(signin, { subject: "x", body: withPara({ type: "paragraph", content: [{ type: "text", text: "a\ud800b" }] }) })).toEqual({ ok: false, errors: [broken] });
    expect(checkTemplate(signin, { subject: "x\udc00", body: ok })).toEqual({ ok: false, errors: [broken] });
    expect(checkTemplate(signin, { subject: "Reset 🚀", body: ok }).ok).toBe(true);
  });

  it("refuses a body over its size and drops control characters", () => {
    expect(checkTemplate(signin, { subject: "x", body: withPara({ type: "paragraph", content: [{ type: "text", text: "a".repeat(6000) }] }) }).ok).toBe(false);
    const r = checkTemplate(signin, { subject: "a\u0000b", body: withPara({ type: "paragraph", content: [{ type: "text", text: "x\u0007y" }] }) });
    expect(r).toMatchObject({ ok: true, subject: "ab" });
    expect(JSON.stringify(r)).toContain("\"xy\"");
  });
});
