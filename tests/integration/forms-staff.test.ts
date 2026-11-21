import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { asStaff, pageOutcome, renderPage, revalidatedPaths } from "../helpers/signed-in";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, requirement, role, roleAssignment, roleRule, setting, signatureConsent, signatureRequest, type FormSetting } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { ADMIN_ONLY, GRANTABLE } from "@/lib/permissions/registry";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import FormsSettingsPage from "@/app/staff/(app)/settings/forms/page";
import FormsSetupPage from "@/app/staff/(app)/settings/forms/setup/page";
import HealthPage from "@/app/staff/(app)/health/page";
import RequirementPage from "@/app/staff/(app)/seasons/[id]/requirements/[requirementId]/page";
import SeasonSetupPage from "@/app/staff/(app)/seasons/[id]/page";
import { checkFormsConnectionAction, newWebhookSecretAction, saveFormsSettingsAction } from "@/app/staff/(app)/settings/forms/actions";
import { attachFormTemplateAction } from "@/app/staff/(app)/seasons/form-actions";
import { addRequirementAction, removeRequirementAction, removeStepAction } from "@/app/staff/(app)/seasons/actions";
import { FORMS_KEY, getFormsConfig, getFormsStatus, isWebhookSecret, noteApiFailure, noteApiOk, parseOrigin } from "@/lib/forms/settings";
import { SEALING_LATE_MS } from "@/lib/forms/job";
import { healthReport } from "@/lib/health/report";
import { resetDb, seedStaff } from "../helpers/db";
import { startDocumensoStub, type DocumensoStub } from "../helpers/documenso-stub";
import { connectForms, formSetting, seedConsent, seedFormRequirement, seedRequest } from "../helpers/forms";
import { seedSeason, type SeededSeason } from "../helpers/season";

/**
 * The staff side of forms: the Admin's settings for Documenso, attaching a template to a form requirement, what
 * keeps a form requirement from being removed, the Health line, and what a change of QuickBooks company deletes.
 */
let stub: DocumensoStub;
beforeAll(async () => { stub = await startDocumensoStub(); });
afterAll(async () => { await stub.close(); });

type Staff = Awaited<ReturnType<typeof seedStaff>>;
const textOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => r.action === action);
const withRole = async (email: string, patterns: string[]): Promise<Staff> => {
  const s = await seedStaff({ email, name: email });
  const [r] = await db.insert(role).values({ key: email, name: email }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  return s;
};
const storedForms = async () => (await db.select().from(setting).where(eq(setting.key, FORMS_KEY)))[0]?.value as Record<string, string | null> | undefined;
const BROWSER = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const SYSTEM = { actor: { door: "system" as const, id: null, label: "test" }, ip: null };

let admin: Staff;
// A request names the app's own family and student (stage 2), and records are made only in the roster's company: one is set first.
beforeEach(async () => {
  await resetDb(); stub.reset(); admin = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
  await db.transaction((tx) => setRosterSource(tx, "1111"));
});

describe("forms settings", () => {
  it("is for Admins only: no custom role can hold its permission by any pattern", async () => {
    expect(ADMIN_ONLY).toContain("Settings.Forms.ReadWrite");
    expect(GRANTABLE).not.toContain("Settings.Forms.ReadWrite");
    expect(await pageOutcome(FormsSettingsPage)).toEqual({ redirect: "/staff/sign-in" });
    asStaff(await withRole("everything@club.org", ["*", "Settings.*", "Settings.Forms.*", "Settings.Forms.ReadWrite"]));
    expect(await pageOutcome(FormsSettingsPage)).toEqual({ redirect: "/refused" });
    expect(await pageOutcome(FormsSetupPage)).toEqual({ redirect: "/refused" });
    await expect(saveFormsSettingsAction("https://sign.club.example", "api_x")).rejects.toBeInstanceOf(AccessDenied);
    await expect(checkFormsConnectionAction()).rejects.toBeInstanceOf(AccessDenied);
    await expect(newWebhookSecretAction()).rejects.toBeInstanceOf(AccessDenied);
    expect((await audits("access.refused")).map((a) => a.permission)).toEqual(Array(5).fill("Settings.Forms.ReadWrite"));
    expect(await storedForms()).toBeUndefined();
  });

  it("says forms aren't set up, gives the webhook address, and tells an Admin what to do in Documenso", async () => {
    asStaff(admin);
    expect(textOf(await renderPage(FormsSettingsPage))).toContain("Forms aren't set up yet. Until they are, parents read that forms aren't ready, and nothing else changes for them.");
    // The steps are on their own page (the pattern the QuickBooks page set).
    const text = textOf(await renderPage(FormsSetupPage));
    expect(text).toContain("Open the team's settings, then API Tokens . Create a token that doesn't expire");
    expect(text).toContain("The address must be exactly the one Documenso itself is set up with");
    expect(text).toContain("open the team's settings, then Webhooks , and add a webhook");
    expect(await renderPage(FormsSetupPage)).toContain('value="http://localhost:3000/api/documenso/webhook"');
  });

  it("takes Documenso's address as an origin only: https, or http on this machine itself", () => {
    expect(parseOrigin(" https://sign.club.example/ ")).toBe("https://sign.club.example");
    expect(parseOrigin("https://sign.club.example:8443")).toBe("https://sign.club.example:8443");
    expect(parseOrigin("http://localhost:3500")).toBe("http://localhost:3500");
    expect(parseOrigin("http://127.0.0.1:3500/")).toBe("http://127.0.0.1:3500");
    for (const bad of ["", "sign.club.example", "http://sign.club.example", "https://sign.club.example/t/team", "https://user:pw@sign.club.example", "https://sign.club.example?x=1",
      "https://sign.club.example/#frag", "ftp://sign.club.example", "javascript:alert(1)", "http://localhost.evil.example", `https://${"a".repeat(300)}.example`]) expect(parseOrigin(bad), bad).toBeNull();
  });

  it("saves the address and seals the token, audits the save without it, and never sends it back to the page", async () => {
    asStaff(admin);
    expect(await saveFormsSettingsAction("sign.club.example", stub.token)).toEqual({ ok: false, errors: [expect.stringContaining("Enter Documenso's address as people open it")] });
    expect(await saveFormsSettingsAction(stub.origin, "")).toEqual({ ok: false, errors: ["Enter the API token from Documenso."] });
    expect(await saveFormsSettingsAction(stub.origin, "has spaces in it")).toEqual({ ok: false, errors: [expect.stringContaining("doesn't look right")] });
    for (const odd of [[7, "t"], [stub.origin, null], ["x".repeat(401), "t"], [stub.origin, "t".repeat(601)]]) expect(await saveFormsSettingsAction(odd[0] as never, odd[1] as never)).toEqual(BROWSER);
    expect(await storedForms()).toBeUndefined();

    expect(await saveFormsSettingsAction(`${stub.origin}/`, ` ${stub.token} `)).toEqual({ ok: true, message: "Saved. Check the connection next." });
    expect(revalidatedPaths()).toContain("/");
    const stored = (await storedForms())!;
    expect(stored.origin).toBe(stub.origin);
    expect(JSON.stringify(stored)).not.toContain(stub.token);
    expect(await getFormsConfig()).toEqual({ origin: stub.origin, token: stub.token });
    const [saved] = await audits("settings.forms.save");
    expect(saved).toMatchObject({ door: "staff", actorId: admin.id, permission: "Settings.Forms.ReadWrite", before: null, after: { origin: stub.origin, tokenChanged: true } });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(stub.token);

    const html = await renderPage(FormsSettingsPage);
    expect(html).not.toContain(stub.token);
    expect(html).not.toContain(stored.tokenCiphertext!);
    expect(textOf(html)).toContain(`Documenso ${stub.origin} API token Saved`);
    const steps = await renderPage(FormsSetupPage);
    expect(steps).not.toContain(stub.token);
    expect(steps).not.toContain(stored.tokenCiphertext!);
    expect(textOf(steps)).toContain("leave blank to keep the saved one");

    // A blank token keeps the saved one, for the same address only.
    expect(await saveFormsSettingsAction(stub.origin, "")).toEqual({ ok: true, message: "Saved. Check the connection next." });
    expect((await getFormsConfig())!.token).toBe(stub.token);
    expect(await saveFormsSettingsAction("https://elsewhere.example", "")).toEqual({ ok: false, errors: [expect.stringContaining("Enter the API token again. The address changed")] });
    expect((await getFormsConfig())!.origin).toBe(stub.origin);
  });

  it("checks the connection: Documenso's health, then one call with the token, and says which failed", async () => {
    asStaff(admin);
    expect(await checkFormsConnectionAction()).toEqual({ ok: false, errors: ["Save Documenso's address and API token first."] });
    await saveFormsSettingsAction(stub.origin, stub.token);
    stub.addTemplate(); stub.addTemplate({ title: "Photo release" });
    stub.calls.length = 0;
    expect(await checkFormsConnectionAction()).toEqual({ ok: true, message: "Connected. Documenso is healthy and accepted the API token. It has 2 templates." });
    expect(stub.calls.map((c) => [c.path, c.auth])).toEqual([["/api/health", ""], ["/api/v2/envelope", stub.token]]); // the token is not sent with the health question
    expect((await getFormsStatus()).lastApiOkAt).not.toBeNull();

    stub.healthy = false;
    expect(await checkFormsConnectionAction()).toEqual({ ok: false, errors: [expect.stringContaining("says it isn't healthy")] });
    stub.healthy = true;
    await saveFormsSettingsAction(stub.origin, "api_notthetoken");
    const refused = await checkFormsConnectionAction();
    expect(refused).toEqual({ ok: false, errors: [expect.stringContaining("it refused the API token")] });
    expect(JSON.stringify(refused)).not.toContain("api_notthetoken");
    expect((await getFormsStatus()).lastApiError).toBe("unauthorized");
    stub.drop = true;
    expect(await checkFormsConnectionAction()).toEqual({ ok: false, errors: [expect.stringContaining("couldn't be reached at that address. Check the address")] });
  });

  it("makes a webhook secret, shows it once, keeps only its seal, and a new one replaces it", async () => {
    asStaff(admin);
    expect(await newWebhookSecretAction()).toEqual({ ok: false, errors: ["Save Documenso's address and API token first."] });
    await saveFormsSettingsAction(stub.origin, stub.token);
    expect(textOf(await renderPage(FormsSettingsPage))).toContain("Webhook secret Not made yet");
    const first = await newWebhookSecretAction();
    if (!first.ok) throw new Error("no secret");
    expect(first.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(await isWebhookSecret(first.secret)).toBe(true);
    expect(await isWebhookSecret(`${first.secret}x`)).toBe(false);
    const stored = (await storedForms())!;
    expect(JSON.stringify(stored)).not.toContain(first.secret);
    const html = await renderPage(FormsSettingsPage);
    expect(html).not.toContain(first.secret); // the page can't show it again
    expect(textOf(html)).toContain("Webhook secret Saved");
    expect(await audits("settings.forms.webhook_secret")).toMatchObject([{ actorId: admin.id, permission: "Settings.Forms.ReadWrite", before: { hadSecret: false }, after: { hasSecret: true } }]);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(first.secret);

    const second = await newWebhookSecretAction();
    if (!second.ok) throw new Error("no secret");
    expect(second.secret).not.toBe(first.secret);
    expect(await isWebhookSecret(first.secret)).toBe(false);
    expect(await isWebhookSecret(second.secret)).toBe(true);
    // Saving the address and token again keeps the secret.
    await saveFormsSettingsAction(stub.origin, "");
    expect(await isWebhookSecret(second.secret)).toBe(true);
  });
});

describe("attaching a template to a form requirement", () => {
  let fall: SeededSeason, formId: string, setter: Staff, reader: Staff;
  const page = (id = formId) => renderPage(RequirementPage, { params: { id: fall.seasonId, requirementId: id } });
  const settingNow = async () => (await db.select().from(requirement).where(eq(requirement.id, formId)))[0]!.form as FormSetting | null;
  beforeEach(async () => {
    fall = await seedSeason({ name: "Fall 2027", steps: [{ name: "Forms", requirements: [{ title: "Uniform fitting attended", appliesTo: "student" }] }] });
    formId = await seedFormRequirement({ stepId: fall.stepIds.Forms!, title: "Medical release", appliesTo: "student", form: null, required: true });
    setter = await withRole("setter@club.org", ["Season.Steps.*"]);
    reader = await withRole("reader@club.org", ["Season.Steps.Read"]);
  });

  it("lets staff add a requirement of the kind Form, and says it needs its template", async () => {
    asStaff(setter);
    const fields = { title: "Photo release", required: true, amount: null, amountUnit: null, dueOn: null };
    expect(await addRequirementAction(fall.stepIds.Forms!, "form", "family", fields)).toEqual({ ok: true, message: "Added. Open it to attach its template: until then parents read that it isn't ready." });
    const [made] = await db.select().from(requirement).where(eq(requirement.title, "Photo release"));
    expect(made).toMatchObject({ kind: "form", appliesTo: "family", form: null });
    const season = await renderPage(SeasonSetupPage, { params: { id: fall.seasonId } });
    expect(season).toMatch(/<option value="form"(?! disabled)[^>]*>Form<\/option>/);
    expect(season).toMatch(/<option value="payment">Payment<\/option>/); // every kind is built now
  });

  it("shows the form part only on a form requirement, and asks Documenso for its templates only for staff who can attach one", async () => {
    await connectForms(stub);
    stub.addTemplate({ title: "Medical release 2027" });
    asStaff(reader);
    stub.calls.length = 0;
    const read = await page();
    expect(textOf(read)).toContain("The form to sign No template is attached yet, so parents read that this form isn't ready.");
    expect(read).not.toContain("Attach a template");
    // v1 spec 9.4: clubs should have a lawyer review their form text, and the portal says so where a form is set up.
    expect(textOf(read)).toContain("Have the club's lawyer read the form's words before families sign it. The portal checks the template's fields, not what it says, and gives no legal advice.");
    expect(stub.calls).toEqual([]);
    expect(await page(fall.requirementIds["Uniform fitting attended"]!)).not.toContain("The form to sign");

    asStaff(setter);
    const change = await page();
    expect(change).toMatch(/<option value="envelope_[a-f0-9]+"[^>]*>Medical release 2027<\/option>/);
    expect(textOf(change)).toContain("a text field labelled Student name for the first signer");
    expect(textOf(change)).toContain("Every one of those name fields must be set to Read only");
    expect(stub.apiCalls().map((c) => c.path)).toEqual(["/api/v2/envelope"]);
    // Documenso unreachable: the address is pasted instead.
    stub.drop = true;
    expect(textOf(await page())).toContain("Documenso's templates couldn't be listed just now. Paste the address of the template's page instead.");
  });

  it("says forms must be set up first while they aren't", async () => {
    asStaff(setter);
    expect(textOf(await page())).toContain("Forms aren't set up yet. An Admin connects the club's Documenso under Forms settings");
    expect(await attachFormTemplateAction(formId, "envelope_abcdef123456", "any")).toEqual({ ok: false, errors: [expect.stringContaining("Forms aren't set up yet")] });
  });

  it("reads the template, checks it, and keeps its id and last-changed time with the requirement", async () => {
    await connectForms(stub);
    const template = stub.addTemplate({ title: "Medical release 2027", signers: 2 });
    asStaff(setter);
    // Pasted as the address of the template's page in Documenso.
    expect(await attachFormTemplateAction(formId, `${stub.origin}/t/club/templates/${template.id}/edit`, "every")).toEqual({ ok: true, message: "Attached. Parents can sign it now." });
    expect(revalidatedPaths()).toContain("/");
    const saved = (await settingNow())!;
    expect(saved).toMatchObject({ templateId: template.id, templateTitle: "Medical release 2027", templateUpdatedAt: template.updatedAt, signerRoles: 2, signers: "every" });
    expect(Date.parse(saved.attachedAt)).toBeGreaterThan(Date.now() - 60_000);
    const [audit] = await audits("season.requirement.form.attach");
    expect(audit).toMatchObject({ door: "staff", actorId: setter.id, permission: "Season.Steps.ReadWrite", targetType: "requirement", targetId: formId,
      before: { title: "Medical release", form: null }, after: { title: "Medical release", form: { templateId: template.id, templateUpdatedAt: template.updatedAt, signerRoles: 2, signers: "every" } } });
    const text = textOf(await page());
    expect(text).toContain("Template Medical release 2027 Who signs Every guardian who has a sign-in, up to two");
    expect(text).toContain("Attach another template, or change who signs");

    // Attached again with one signer: the audit row holds what it was before.
    const single = stub.addTemplate({ title: "One signer", signers: 1 });
    expect(await attachFormTemplateAction(formId, single.id, "every")).toEqual({ ok: true, message: "Attached. The template has one signer, so one guardian signs each form." });
    expect((await audits("season.requirement.form.attach"))[1]!.before).toMatchObject({ form: { templateId: template.id } });
    expect(await settingNow()).toMatchObject({ templateId: single.id, signerRoles: 1 });
  });

  it("refuses, in plain words, a template the portal can't safely fill, and saves nothing", async () => {
    await connectForms(stub);
    asStaff(setter);
    const refusal = async (spec: Parameters<DocumensoStub["addTemplate"]>[0]) => {
      const r = await attachFormTemplateAction(formId, stub.addTemplate(spec).id, "any");
      if (r.ok) throw new Error("attached");
      return r.errors.join(" ");
    };
    expect(await refusal({ readOnly: false })).toContain("not read-only");
    expect(await refusal({ readOnly: { except: ["Student name"] } })).toContain('The field "Student name" is not read-only. A signer could change a name on the form.');
    expect(await refusal({ signers: 3 })).toContain("The template has 3 signers");
    expect(await refusal({ subjectLabel: null })).toContain('no field labelled "Student name"');
    expect(await refusal({ subjectLabel: "Family name" })).toContain("signed once for each student");
    expect(await refusal({ noSignatureFor: 2 })).toContain("Signer 2 has no signature field");
    expect(await refusal({ extraRole: "CC" })).toContain("Every recipient of the template must be a signer");
    expect(await attachFormTemplateAction(formId, "envelope_doesnotexist", "any")).toEqual({ ok: false, errors: [expect.stringContaining("Documenso has no template with that id")] });
    expect(await attachFormTemplateAction(formId, "the medical one", "any")).toEqual({ ok: false, errors: [expect.stringContaining("Choose a template, or paste the address")] });
    // A document is not a template.
    const template = stub.addTemplate();
    const made = await (await fetch(`${stub.origin}/api/v2/envelope/use`, { method: "POST", headers: { authorization: stub.token, "content-type": "application/json" }, body: JSON.stringify({ envelopeId: template.id, externalId: "x" }) })).json() as { id: string };
    expect(await attachFormTemplateAction(formId, made.id, "any")).toEqual({ ok: false, errors: [expect.stringContaining("That is a document, not a template")] });
    stub.drop = true;
    expect(await attachFormTemplateAction(formId, template.id, "any")).toEqual({ ok: false, errors: ["The template couldn't be read. Documenso couldn't be reached at that address."] });
    expect(await settingNow()).toBeNull();
    expect(await audits("season.requirement.form.attach")).toEqual([]);
  });

  it("checks every argument, refuses a requirement of another kind, and needs the set-up permission", async () => {
    await connectForms(stub);
    const template = stub.addTemplate();
    asStaff(setter);
    for (const odd of [["not-an-id", template.id, "any"], [formId, 7, "any"], [formId, "x".repeat(501), "any"], [formId, template.id, "both"], [formId, template.id, null]]) {
      expect(await attachFormTemplateAction(odd[0] as never, odd[1] as never, odd[2] as never)).toEqual(BROWSER);
    }
    expect(await attachFormTemplateAction(fall.requirementIds["Uniform fitting attended"]!, template.id, "any")).toEqual({ ok: false, errors: ["Only a form requirement has a template."] });
    expect(await attachFormTemplateAction(crypto.randomUUID(), template.id, "any")).toEqual({ ok: false, errors: ["That isn't there any more. Reload the page."] });
    asStaff(reader);
    await expect(attachFormTemplateAction(formId, template.id, "any")).rejects.toBeInstanceOf(AccessDenied);
    expect(await settingNow()).toBeNull();
  });

  it("won't remove a form requirement, or its step, once a form was made for a family; one nobody opened goes with it", async () => {
    asStaff(setter);
    const unopened = await seedRequest({ requirementId: formId, familyQboId: "10", subjectQboId: "12" });
    await seedConsent(unopened, { parentId: crypto.randomUUID(), name: "Ana Rivera", email: "ana@example.com" });
    const made = await seedRequest({ requirementId: formId, familyQboId: "10", subjectQboId: "13", state: "waiting" });
    expect(await removeRequirementAction(formId)).toEqual({ ok: false, errors: ["Medical release can't be removed: a form has been made for families to sign. Make it optional so it no longer holds the step open, or keep it."] });
    expect(await removeStepAction(fall.stepIds.Forms!)).toEqual({ ok: false, errors: [expect.stringContaining("Forms can't be removed: a form has been made for families to sign.")] });
    expect(await db.select().from(signatureRequest)).toHaveLength(2);

    await db.delete(signatureRequest).where(eq(signatureRequest.id, made));
    expect(await removeRequirementAction(formId)).toEqual({ ok: true, message: "Removed." });
    expect(await db.select().from(signatureRequest)).toEqual([]);
    expect(await db.select().from(signatureConsent)).toEqual([]);
    expect(await db.select().from(requirement).where(eq(requirement.id, formId))).toEqual([]);
  });
});

describe("the Health page's line for forms", () => {
  const formsLine = async (now?: Date) => (await healthReport(now)).find((l) => l.key === "forms")!;

  it("says forms aren't set up, as something that may be by choice", async () => {
    expect(await formsLine()).toMatchObject({ state: "off", word: "Not set up", fix: { href: "/staff/settings/forms", label: "Open Forms settings" }, times: [] });
    asStaff(admin);
    expect(await renderPage(HealthPage)).toContain('data-health="forms"');
  });

  it("says connected once a call has worked, with when Documenso last answered and when a webhook last arrived", async () => {
    await connectForms(stub);
    expect(await formsLine()).toMatchObject({ state: "attention", word: "Not checked" });
    asStaff(admin);
    await checkFormsConnectionAction();
    const line = await formsLine();
    expect(line).toMatchObject({ state: "ok", word: "Connected", says: `Connected to Documenso at ${stub.origin}.`, fix: null, notes: [] });
    expect(line.times.map((t) => [t.label, t.at !== null])).toEqual([["Last answered", true], ["Last webhook", false], ["Last asked about open forms", false]]);
    const html = await renderPage(HealthPage);
    expect(html).toContain("Last webhook: never");
    expect(html).not.toContain(stub.token);
  });

  it("asks for attention when the last call failed, when a signed form waits too long, and notes what is missing", async () => {
    await connectForms(stub, { webhookSecret: null });
    // Two calls noted in one millisecond have equal times: which came last is what was recorded last, in either order.
    const atOneInstant = async (calls: () => Promise<void>) => {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      try { await calls(); } finally { vi.useRealTimers(); }
    };
    await atOneInstant(async () => { await noteApiOk(); await noteApiFailure("unauthorized"); });
    expect(await formsLine()).toMatchObject({ state: "attention", word: "Needs attention", says: expect.stringContaining("The last call to Documenso failed"),
      notes: expect.arrayContaining(["The failure: unauthorized.", expect.stringContaining("No webhook secret is made")]) });
    await atOneInstant(async () => { await noteApiFailure("unauthorized"); await noteApiOk(); });
    expect((await formsLine()).state).toBe("ok");

    const fall = await seedSeason({ name: "Fall", steps: [{ name: "Forms" }] });
    await seedFormRequirement({ stepId: fall.stepIds.Forms!, title: "No template yet", appliesTo: "family", form: null });
    const withTemplate = await seedFormRequirement({ stepId: fall.stepIds.Forms!, title: "Medical release", appliesTo: "student", form: formSetting({ id: "envelope_seedtemplate" }) });
    await seedRequest({ requirementId: withTemplate, familyQboId: "10", subjectQboId: "12", state: "waiting" });
    const late = await seedRequest({ requirementId: withTemplate, familyQboId: "10", subjectQboId: "13", state: "signed", allSignedAt: new Date(Date.now() - SEALING_LATE_MS - 60_000) });
    const line = await formsLine();
    expect(line).toMatchObject({ state: "attention", says: expect.stringContaining("signed forms are waiting too long to be finished") });
    expect(line.notes).toEqual(expect.arrayContaining([
      "2 forms are out for signing and not finished. The worker asks Documenso about each every few minutes.",
      expect.stringContaining("1 form was signed by everyone more than an hour ago and Documenso still hasn't finished the signed copy."),
      "1 form requirement of the current season has no template attached, so parents read that it isn't ready.",
    ]));
    await db.delete(signatureRequest).where(eq(signatureRequest.id, late));
    expect((await formsLine()).state).toBe("ok");
  });
});

describe("a different QuickBooks company", () => {
  // Since stage 4's slice M7a the clear a change of company would run keeps every form (open question 16), as the
  // families and students the requests name are kept: it was "deletes every signature request and consent" while the
  // clear removed those records too. A change of company is still refused until slice M8.
  it("keeps every signature request and consent, and the requirements' templates", async () => {
    const fall = await seedSeason({ name: "Fall", steps: [{ name: "Forms" }] });
    const form = formSetting({ id: "envelope_seedtemplate" });
    const requirementId = await seedFormRequirement({ stepId: fall.stepIds.Forms!, title: "Medical release", appliesTo: "student", form });
    const done = await seedRequest({ requirementId, familyQboId: "10", subjectQboId: "12", state: "complete" });
    await seedRequest({ requirementId, familyQboId: "10", subjectQboId: "13", state: "waiting" });
    await seedRequest({ requirementId, familyQboId: "20", subjectQboId: "22" });
    await seedConsent(done, { parentId: crypto.randomUUID(), name: "Ana Rivera", email: "ana@example.com" });
    await db.transaction((tx) => setRosterSource(tx, "1111"));
    const rows = async () => ({ requests: await db.select().from(signatureRequest).orderBy(asc(signatureRequest.id)), consents: await db.select().from(signatureConsent).orderBy(asc(signatureConsent.id)),
      requirements: await db.select().from(requirement).orderBy(asc(requirement.id)) });
    const before = await rows();
    expect([before.requests.length, before.consents.length]).toEqual([3, 1]);
    // The same company keeps it all, and so does another.
    expect(await clearRosterOfOtherCompany("1111", SYSTEM)).toBe(false);
    expect(await rows()).toEqual(before);
    expect(await clearRosterOfOtherCompany("2222", SYSTEM)).toBe(true);
    expect(await rows()).toEqual(before);
    expect((await db.select().from(requirement).where(eq(requirement.id, requirementId)))[0]!.form).toEqual(form);
    expect(await clearRosterOfOtherCompany("3333", SYSTEM)).toBe(true);
    expect(await rows()).toEqual(before);
    expect(await audits("form.records.cleared")).toEqual([]);
  });
});
