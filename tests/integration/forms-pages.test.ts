import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { asParent, asStaff, pageOutcome, renderPage, revalidatedPaths, signedOut } from "../helpers/signed-in";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, signatureConsent, signatureRequest } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import ParentHome from "@/app/(parent)/page";
import SeasonPage from "@/app/(parent)/season/page";
import FormsPage from "@/app/(parent)/forms/page";
import FormPage, { generateMetadata as generateFormMetadata } from "@/app/(parent)/forms/[id]/page";
import { agreeToSignAction, checkFormAction, startFormAgainAction } from "@/app/(parent)/forms/actions";
import { CONSENT_TEXT } from "@/lib/forms/consent";
import { resetDb, seedStaff } from "../helpers/db";
import { startDocumensoStub, type DocumensoStub } from "../helpers/documenso-stub";
import { connectForms, formSetting, requestNow, seedFormRequirement } from "../helpers/forms";
import { FAMILY_A, FAMILY_B, seedParentIn, seedSignedInParent, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { seedSeason } from "../helpers/season";
import { familyRecord, studentRecord } from "../helpers/volunteer";

/**
 * The parent's Forms pages and their actions (src/app/(parent)/forms/), run as signed-in parents without a browser.
 * Documenso is the stub; the portal's real client calls it.
 */
let stub: DocumensoStub;
beforeAll(async () => { stub = await startDocumensoStub(); });
afterAll(async () => { await stub.close(); });

const textOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const linksIn = (html: string) => [...html.matchAll(/href="(\/forms\/[^"]+)"/g)].map((m) => m[1]!);
const frameIn = (html: string) => /<iframe[^>]*src="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&") ?? null;
const NOT_YOURS = { ok: false, errors: ["That form isn't here. Go back to Forms and open it again."] };
const formPage = (id: string) => pageOutcome(FormPage, { params: { id } });

describe("the Forms page, from what the portal has stored (forms not set up)", () => {
  let a: SeededParent, b: SeededParent;
  beforeAll(async () => { await resetDb(); ({ a, b } = await seedTwoFamilies()); });

  it("lists this season's forms for the family and for each student, each with its state in words", async () => {
    asParent(a.identity);
    const html = await renderPage(FormsPage);
    const text = textOf(html);
    expect(text).toContain("Autumn Field Season: the forms for Alderquist Family");
    expect(text).toContain("The forms still to sign aren't ready yet. There's nothing you need to do right now");
    // The family's own forms, then each student's, with the set each belongs to.
    expect(text).toMatch(/Your family Signed once for Alderquist Family Travel consent \(optional\) Sign-up Not signed yet/);
    expect(text).toMatch(/Bus waiver QA74 \(optional\) Sign-up Not ready yet/);
    expect(text).toMatch(/Aurelio Alderquist Uniform agreement \(optional\) Uniforms Signed, being finished/);
    expect(text).toMatch(/Photo release \(optional\) Uniforms Declined/);
    expect(text).toMatch(/Azalea Alderquist Uniform agreement \(optional\) Uniforms Signed Open/);
    expect(text).toMatch(/Photo release \(optional\) Uniforms Waiting for the other guardian/);
    // A way to each form that has something behind it, by the family's own request ids; none for the one that isn't ready.
    const ids = a.forms!.ids;
    // and the download of the signed one, whose evidence is kept (src/lib/forms/my-evidence.ts).
    expect(linksIn(html).sort()).toEqual([...[ids.waiting, ids.signed, ids.complete, ids.declined, ids.waitingOther].map((id) => `/forms/${id}`), `/forms/${ids.complete}/signed`].sort());
    expect(html).not.toContain(ids.not_opened);
    for (const theirs of Object.values(b.forms!.ids)) expect(html).not.toContain(theirs);
    expect(html).toContain('Sign<span class="visually-hidden">: Travel consent</span>'); // the link names what it opens, for a screen reader
  });

  it("shows a stored form by its id, and answers 404 for another family's id or one that isn't an id", async () => {
    asParent(a.identity);
    const done = await formPage(a.forms!.ids.complete);
    expect("html" in done && textOf(done.html)).toContain("Uniform agreement For Azalea Alderquist · Uniforms");
    expect("html" in done && textOf(done.html)).toContain("This form Signed Thank you! There's nothing more to do for this form.");
    // "Signed" once, as the state: not again as the heading or in the thanks (docs/walkthrough.md).
    expect("html" in done && textOf(done.html).match(/\bSigned\b/g)).toEqual(["Signed"]);
    expect("html" in done && textOf(done.html)).toContain("Ansgar Alderquist (you) Has signed");
    for (const id of [...Object.values(b.forms!.ids), "not-an-id", "", "../payments", crypto.randomUUID()]) expect(await formPage(id), id).toEqual({ notFound: true });
  });

  it("titles a form's page with the form's own name, and with plain \"Form\" for another family's id or nobody signed in", async () => {
    asParent(a.identity);
    const title = async (id: string) => (await generateFormMetadata({ params: Promise.resolve({ id }) })).title;
    expect(await title(a.forms!.ids.complete)).toBe("Uniform agreement");
    expect(await title(a.forms!.ids.waiting)).toBe("Travel consent");
    // Family B's forms have titles of their own: none of them reaches family A's tab, nor does a made-up id.
    for (const id of [...Object.values(b.forms!.ids), "not-an-id", crypto.randomUUID()]) expect(await title(id), id).toBe("Form");
    signedOut();
    expect(await title(a.forms!.ids.complete)).toBe("Form");
  });

  it("says each stored state in words, and offers nothing that needs Documenso", async () => {
    asParent(a.identity);
    const page = async (id: string) => { const o = await formPage(id); if (!("html" in o)) throw new Error("no page"); return { html: o.html, text: textOf(o.html) }; };
    const waiting = await page(a.forms!.ids.waiting);
    expect(waiting.text).toContain("Not signed yet");
    expect(waiting.text).toContain("The club is still getting this form ready");
    const other = await page(a.forms!.ids.waitingOther);
    expect(other.text).toContain("Waiting for the other guardian");
    expect(other.text).toContain("Ansgar Alderquist (you) Has signed");
    expect(other.text).toContain("Ottoline Alderquist-Voss Hasn't signed yet");
    const declined = await page(a.forms!.ids.declined);
    expect(declined.text).toContain("This form was declined, so it isn't signed. If that wasn't meant, ask the club and they'll help.");
    expect(declined.html).not.toContain("Start this form again");
    const unopened = await page(a.forms!.ids.not_opened);
    expect(unopened.text).toContain("Bus waiver QA74");
    expect(unopened.text).toContain("Not ready yet");
    for (const p of [waiting, other, declined, unopened]) { expect(p.html).not.toContain("<iframe"); expect(p.html).not.toContain(CONSENT_TEXT.agree); }
  });

  it("refuses every action called as family A with family B's request, in the same words as for no request at all", async () => {
    const before = await db.select().from(signatureRequest).orderBy(signatureRequest.id);
    asParent(a.identity);
    // B's request ids, and B's own app family and student ids (uuids too, never a request of A's).
    const bRecords = [String(await familyRecord(FAMILY_B.family.qboId)), ...(await Promise.all(FAMILY_B.students.map(async (s) => String(await studentRecord(s.qboId)))))];
    for (const theirs of [...Object.values(b.forms!.ids), ...bRecords, crypto.randomUUID()]) {
      expect(await agreeToSignAction(theirs)).toEqual(NOT_YOURS);
      expect(await checkFormAction(theirs)).toEqual(NOT_YOURS);
      expect(await startFormAgainAction(theirs)).toEqual(NOT_YOURS);
    }
    // Whatever the browser sends in place of an id.
    for (const odd of [null, undefined, 7, {}, [b.forms!.ids.declined], "x".repeat(65), `${b.forms!.ids.declined} `]) {
      expect(await agreeToSignAction(odd as never)).toEqual(NOT_YOURS);
      expect(await checkFormAction(odd as never)).toEqual(NOT_YOURS);
      expect(await startFormAgainAction(odd as never)).toEqual(NOT_YOURS);
    }
    expect(await db.select().from(signatureRequest).orderBy(signatureRequest.id)).toEqual(before);
    expect(await db.select().from(signatureConsent)).toEqual([]);
    expect((await db.select().from(auditLog)).filter((r) => r.action.startsWith("form."))).toEqual([]);
    expect(revalidatedPaths()).toEqual([]);
  });

  it("starts a family's own declined form again, and nobody else's", async () => {
    asParent(a.identity);
    expect(await startFormAgainAction(a.forms!.ids.waiting)).toEqual({ ok: false, errors: ["This form can't be started again: it wasn't declined."] });
    expect(await startFormAgainAction(a.forms!.ids.declined)).toEqual({ ok: true, message: "Started again. You can sign it now." });
    expect(revalidatedPaths()).toEqual(expect.arrayContaining(["/forms", "/", "/season", "/forms/[id]"]));
    expect((await requestNow(a.forms!.ids.declined)).state).toBe("not_opened");
    expect((await requestNow(b.forms!.ids.declined)).state).toBe("declined");
  });

  it("lets nobody act who isn't a signed-in parent", async () => {
    signedOut();
    for (const act of [agreeToSignAction, checkFormAction, startFormAgainAction]) await expect(act(a.forms!.ids.waiting)).rejects.toBeInstanceOf(AccessDenied);
    asStaff(await seedStaff({ email: "admin@club.org", admin: true }));
    for (const act of [agreeToSignAction, checkFormAction, startFormAgainAction]) await expect(act(a.forms!.ids.waiting)).rejects.toBeInstanceOf(AccessDenied);
  });
});

describe("signing a form on its page", () => {
  let a: SeededParent, requirementId: string;
  beforeEach(async () => {
    await resetDb(); stub.reset();
    a = await seedSignedInParent(FAMILY_A);
    const season = await seedSeason({ name: "Fall 2027", steps: [{ name: "Forms" }] });
    const template = stub.addTemplate({ signers: 2 });
    requirementId = await seedFormRequirement({ stepId: season.stepIds.Forms!, title: "Medical release", appliesTo: "student", required: true,
      form: formSetting({ id: template.id, updatedAt: template.updatedAt }, { signers: "every", signerRoles: 2 }) });
    await connectForms(stub);
  });
  const myFormId = async (studentIndex = 0) => {
    asParent(a.identity);
    await renderPage(FormsPage); // the list makes the family's requests
    const [row] = await db.select().from(signatureRequest).where(eq(signatureRequest.studentId, await studentRecord(FAMILY_A.students[studentIndex]!.qboId)));
    return row!.id;
  };

  it("shows the consent first, with no frame and nothing asked of Documenso; then the frame with the guardian's own token", async () => {
    const id = await myFormId();
    const listed = textOf(await renderPage(FormsPage));
    expect(listed).toMatch(/Aurelio Alderquist Medical release Forms Not signed yet Sign for Aurelio/);
    expect(listed).not.toContain("aren't ready");

    const consent = await renderPage(FormPage, { params: { id } });
    expect(textOf(consent)).toContain(CONSENT_TEXT.heading);
    for (const paragraph of CONSENT_TEXT.paragraphs) expect(textOf(consent)).toContain(paragraph);
    expect(consent).toContain(CONSENT_TEXT.agree);
    expect(consent).not.toContain("<iframe");
    expect(stub.calls).toEqual([]);
    expect((await requestNow(id)).envelopeId).toBeNull();

    expect(await agreeToSignAction(id)).toEqual({ ok: true, message: "Thank you. The form is next." });
    expect(revalidatedPaths()).toEqual(expect.arrayContaining(["/forms", "/forms/[id]"]));
    const [consented] = await db.select().from(signatureConsent);
    expect(consented).toMatchObject({ requestId: id, parentId: a.identity.parentId, ip: "203.0.113.50" });

    const signing = await renderPage(FormPage, { params: { id } });
    const document = stub.documentFor(id)!;
    const mine = document.recipients.find((r) => r.email === FAMILY_A.parent.email)!;
    expect(frameIn(signing)).toBe(`${stub.origin}/embed/sign/${mine.token}#${frameIn(signing)!.split("#")[1]}`);
    expect(signing).toContain(`title="Sign: Medical release"`);
    expect(signing).not.toContain(CONSENT_TEXT.agree);
    expect(textOf(signing)).toContain("Ansgar Alderquist (you) Hasn't signed yet");
    // Nothing of Documenso's API token, and no other recipient's token (the template's second signer was deleted).
    expect(signing).not.toContain(stub.token);
    expect(document.recipients).toHaveLength(1);
  });

  it("gives each of two guardians a page with their own token and never the other's", async () => {
    const other = await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Astrid Alderquist", email: "astrid.alderquist@family-a.example" });
    const id = await myFormId();
    await agreeToSignAction(id);
    const mine = await renderPage(FormPage, { params: { id } });
    const document = stub.documentFor(id)!;
    const token = (email: string) => document.recipients.find((r) => r.email === email)!.token;
    expect(mine).toContain(token(FAMILY_A.parent.email));
    expect(mine).not.toContain(token("astrid.alderquist@family-a.example"));
    expect(textOf(mine)).toContain("Astrid Alderquist Hasn't signed yet");

    asParent(other.identity);
    const beforeConsent = await renderPage(FormPage, { params: { id } });
    expect(beforeConsent).not.toContain("<iframe"); // a document exists, and still no token before this guardian agrees
    for (const r of document.recipients) expect(beforeConsent).not.toContain(r.token);
    await agreeToSignAction(id);
    const theirs = await renderPage(FormPage, { params: { id } });
    expect(theirs).toContain(token("astrid.alderquist@family-a.example"));
    expect(theirs).not.toContain(token(FAMILY_A.parent.email));

    // The first guardian signs: their page says so, holds no token, and names who is still to sign.
    stub.sign(document.id, FAMILY_A.parent.email);
    asParent(a.identity);
    expect(await checkFormAction(id)).toEqual({ ok: true, message: "Waiting for the other guardian", settled: true });
    const waiting = await renderPage(FormPage, { params: { id } });
    expect(waiting).not.toContain("<iframe");
    for (const r of document.recipients) expect(waiting).not.toContain(r.token);
    expect(textOf(waiting)).toContain("Thank you, you've signed. It still needs Astrid Alderquist to sign.");
    expect(textOf(await renderPage(FormsPage))).toContain("Waiting for the other guardian");
  });

  it("shows on Home and on Season the same words as the Forms page, and done only when the document is complete", async () => {
    const id = await myFormId();
    const everywhere = async () => { asParent(a.identity); return [textOf(await renderPage(ParentHome)), textOf(await renderPage(SeasonPage)), textOf(await renderPage(FormsPage))]; };
    for (const text of await everywhere()) expect(text).toMatch(/Medical release (Forms )?Not signed yet/);
    expect((await everywhere())[0]).toContain("Aurelio Alderquist 0 of 1 done 1 thing left to do in Forms Medical release Not signed yet");

    await agreeToSignAction(id);
    await renderPage(FormPage, { params: { id } });
    const document = stub.documentFor(id)!;
    stub.sealing = "held";
    stub.sign(document.id, FAMILY_A.parent.email);
    expect(await checkFormAction(id)).toEqual({ ok: true, message: "Signed, being finished", settled: false });
    for (const text of await everywhere()) expect(text).toMatch(/Medical release (Forms )?Signed, being finished/);
    expect((await everywhere())[0]).toContain("Aurelio Alderquist 0 of 1 done 1 thing left to do in Forms Medical release Signed, being finished"); // signed by everyone is not yet done
    const sealing = textOf(await renderPage(FormPage, { params: { id } }));
    expect(sealing).toContain("Everyone has signed. The signed copy is being finished");

    stub.seal(document.id);
    expect(await checkFormAction(id)).toEqual({ ok: true, message: "Signed", settled: true });
    const [home, season, forms] = await everywhere();
    expect(home).toContain("Aurelio Alderquist 1 of 1 done Done with Forms Medical release Signed");
    expect(home).toContain("Azalea Alderquist 0 of 1 done 1 thing left to do in Forms Medical release Not signed yet"); // her own form is another request
    expect(season).toMatch(/Medical release Signed/);
    expect(forms).toMatch(/Medical release Forms Signed Open/);
    expect(textOf(await renderPage(FormPage, { params: { id } }))).toContain("Signed Thank you! There's nothing more to do for this form.");
  });

  it("offers to start a declined form again, and says calmly when Documenso can't be reached", async () => {
    const id = await myFormId();
    await agreeToSignAction(id);
    await renderPage(FormPage, { params: { id } });
    stub.drop = true;
    const down = await renderPage(FormPage, { params: { id } });
    expect(textOf(down)).toContain("We can't show this form right now. Nothing is lost. Please try again in a few minutes.");
    expect(down).not.toContain("<iframe");
    expect(await checkFormAction(id)).toEqual({ ok: false, errors: ["We couldn't check this form just now. Please try again in a few minutes."] });
    stub.drop = false;
    stub.reject(stub.documentFor(id)!.id, FAMILY_A.parent.email);
    await checkFormAction(id);
    const declined = await renderPage(FormPage, { params: { id } });
    expect(textOf(declined)).toContain("This form was declined, so it isn't signed. If that wasn't meant, you can start it again and sign it.");
    expect(declined).toContain("Start this form again");
    expect(textOf(await renderPage(FormsPage))).toMatch(/Medical release Forms Declined Open/);
  });

  it("shows a family with no forms that there is nothing to sign, and a family that isn't set up nothing at all", async () => {
    const { requirement } = await import("@/lib/db/schema");
    await db.delete(requirement).where(eq(requirement.id, requirementId));
    asParent(a.identity);
    expect(textOf(await renderPage(FormsPage))).toContain("There are no forms for Alderquist Family to sign right now. There's nothing you need to do.");
    const b = await seedSignedInParent(FAMILY_B);
    const { qboCustomer } = await import("@/lib/db/schema");
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, FAMILY_B.family.qboId));
    asParent(b.identity);
    const html = await renderPage(FormsPage);
    expect(textOf(html)).toContain("Your family isn't set up here yet");
    expect(html).not.toContain("Brackenmoor");
  });
});

describe("the note that forms can't be signed yet (forms not set up)", () => {
  it("is about the forms still to sign, and is not shown when every form is signed", async () => {
    await resetDb();
    const a = await seedSignedInParent(FAMILY_A);
    const season = await seedSeason({ name: "Fall 2027", steps: [{ name: "Forms" }] });
    const requirementId = await seedFormRequirement({ stepId: season.stepIds.Forms!, title: "Travel consent", appliesTo: "family", form: formSetting({ id: "envelope_seedtemplate", updatedAt: "2026-11-01T12:00:00.000Z" }) });
    asParent(a.identity);
    expect(textOf(await renderPage(FormsPage))).toContain("The forms still to sign aren't ready yet.");
    await db.update(signatureRequest).set({ state: "complete", envelopeId: "envelope_seeddone", envelopeStatus: "COMPLETED", completedAt: new Date(), allSignedAt: new Date() })
      .where(eq(signatureRequest.requirementId, requirementId));
    const text = textOf(await renderPage(FormsPage));
    expect(text).toMatch(/Travel consent \(optional\) Forms Signed/);
    expect(text).not.toContain("aren't ready");
  });
});
