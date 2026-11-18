import { describe, it, expect, beforeAll } from "vitest";
import { asParent, pageOutcome, type Page } from "../helpers/signed-in";
import { readdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import { accountingLink, family, signedFormEvidence, signedFormFile } from "@/lib/db/schema";
import { findMySignedPdf } from "@/lib/forms/my-evidence";
import { resetDb } from "../helpers/db";
import { seedTwoFamilies, FAMILY_A, type SeededParent } from "../helpers/parent";
import { fakePdf } from "../helpers/forms";
import { syncAppRecords } from "../helpers/app-records";

/**
 * Signed-form evidence of an earlier company (`earlier_company_at` set) is the club's record, kept for staff alone. Its
 * QuickBooks ids are that company's: a number there may be a different family's number now. So it gets no app family
 * (stage 1 of the app-owned families spec, src/lib/families/in-step.ts), and no parent of the family that has that
 * number now sees anything of it, on any page or in the download. Run again after every later stage: each moves
 * something closer to the app's own ids, and this must stay true.
 */
const root = path.resolve(__dirname, "../..");
const PARENT_DIR = "src/app/(parent)";
const routeOf = (file: string) => `/${file.slice(PARENT_DIR.length + 1).split("/").slice(0, -1).filter((s) => !/^\(.*\)$/.test(s)).join("/")}`;
const pages = readdirSync(path.join(root, PARENT_DIR), { recursive: true }).map((f) => `${PARENT_DIR}/${String(f).replaceAll("\\", "/")}`)
  .filter((f) => /\/page\.(tsx|ts|jsx|js)$/.test(f)).map((file) => ({ file, route: routeOf(file) }));
const load = async (file: string): Promise<Page> => ((await import(path.join(root, file))) as { default: Page }).default;

const ARCHIVED = {
  formTitle: "Quillfeather Archive Waiver 5511", familyName: "Quillfeather Earlier Family 5512", subjectName: "Quillfeather Earlier Student 5513",
  signer: "Ottoline Quillfeather 5514", email: "ottoline.quillfeather@earlier.example", envelope: "envelope_quillfeatherearlier5515",
};
const ONLY_THERE = "QBO-EARLIER-ONLY-FAMILY-5520";
const archivedPdf = fakePdf("sealed Quillfeather archive 5516");
const markers = [...Object.values(ARCHIVED), ONLY_THERE, createHash("sha256").update(archivedPdf).digest("hex")];

describe("an earlier company's signed forms", () => {
  let a: SeededParent;
  let archivedIds: string[];
  beforeAll(async () => {
    await resetDb();
    ({ a } = await seedTwoFamilies());
    // The earlier company's evidence under family A's number, for the same form and subject as A's own complete one, and
    // one under a number nothing of the current company names.
    const [complete] = await db.select().from(signedFormEvidence);
    const archived = (familyQboId: string, subjectQboId: string, tag: string) => ({
      requestId: null, realmId: "EARLIER-COMPANY-REALM", earlierCompanyAt: new Date("2026-11-01T00:00:00Z"), requirementId: complete!.requirementId,
      familyQboId, subjectQboId, subjectKind: "family" as const, formTitle: ARCHIVED.formTitle, familyName: ARCHIVED.familyName, subjectName: ARCHIVED.subjectName,
      seasonName: "Earlier season", envelopeId: `${ARCHIVED.envelope}${tag}`, signers: [{ parentId: null, name: ARCHIVED.signer, email: ARCHIVED.email, signedAt: "2026-10-01T12:00:00.000Z" }],
      consents: [], originals: [], completedAt: new Date("2026-10-01T12:00:00Z"),
    });
    const rows = await db.insert(signedFormEvidence).values([archived(FAMILY_A.family.qboId, FAMILY_A.family.qboId, "a"), archived(ONLY_THERE, ONLY_THERE, "b")])
      .returning({ id: signedFormEvidence.id });
    archivedIds = rows.map((r) => r.id);
    const sha = createHash("sha256").update(archivedPdf).digest("hex");
    await db.insert(signedFormFile).values(rows.map((r) => ({ evidenceId: r.id, kind: "sealed_pdf" as const, position: 1, itemId: "envelope_item_quillfeather", bytes: archivedPdf, size: archivedPdf.byteLength, sha256: sha })));
    // Keep the app's records in step with it there, as the next roster read would.
    await syncAppRecords();
  });

  it("gets no app family, even under a current family's number", async () => {
    const links = await db.select().from(accountingLink);
    expect(links.map((l) => l.customerId)).not.toContain(ONLY_THERE);
    expect((await db.select().from(family)).map((f) => f.name)).not.toContain(ARCHIVED.familyName);
    // Family A's own record is named from the roster, never from the earlier company's form.
    const aLink = links.find((l) => l.customerId === FAMILY_A.family.qboId && l.familyId !== null)!;
    expect((await db.select().from(family)).find((f) => f.id === aLink.familyId)!.name).toBe(FAMILY_A.family.name);
  });

  // Every parent page with no dynamic segment, and a form's page asked for each of A's own requests and each archived
  // evidence's id. The other dynamic pages name a shift, a check-in code, a link's token or a buy-out, never a form.
  const shown = pages.filter((p) => !p.route.includes("[") || p.route === "/forms/[id]");
  it("finds the pages on disk", () => expect(shown.map((p) => p.route)).toEqual(expect.arrayContaining(["/", "/forms", "/forms/[id]", "/family"])));

  it.each(shown.map((p) => [p.route, p.file] as const))("%s shows family A's parent nothing of it", async (route, file) => {
    const page = await load(file);
    asParent(a.identity);
    const paramSets: Record<string, string>[] = route === "/forms/[id]" ? [...Object.values(a.forms!.ids), ...archivedIds].map((id) => ({ id })) : [{}];
    for (const params of paramSets) {
      const outcome = await pageOutcome(page, { params });
      if (!("html" in outcome)) continue;                  // a 404 or a redirect shows nothing
      const text = outcome.html.toLowerCase();
      expect(markers.filter((m) => text.includes(m.toLowerCase())), `${file} with ${JSON.stringify(params)}`).toEqual([]);
    }
  });

  it("is never the PDF a parent of family A downloads", async () => {
    const ctx = { ...a.identity, ip: null };
    for (const id of [...Object.values(a.forms!.ids), ...archivedIds]) {
      const pdf = await findMySignedPdf(ctx, id);
      if (pdf) expect(Buffer.compare(pdf, archivedPdf), id).not.toBe(0);
    }
    for (const id of archivedIds) expect(await findMySignedPdf(ctx, id)).toBeNull();
  });
});
