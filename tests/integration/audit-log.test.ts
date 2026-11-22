import { describe, it, expect, beforeEach } from "vitest";
import { asRefusedStaff, asStaff, pageOutcome, renderPage } from "../helpers/signed-in";

import { db } from "@/lib/db/client";
import { auditLog, role, roleAssignment, roleRule } from "@/lib/db/schema";
import AuditPage from "@/app/staff/(app)/settings/audit/page";
import { GET as exportAudit } from "@/app/staff/(app)/settings/audit/export/route";
import { AUDIT_PAGE_SIZE, NO_FILTERS, auditPage, filtersQuery, parseAuditFilters, parseCursor, type AuditFilters } from "@/lib/audit/query";
import { ACTION_NAMES, actionName } from "@/lib/audit/actions";
import { csvCell } from "@/lib/audit/csv";
import { resetDb, seedStaff } from "../helpers/db";

type NewRow = typeof auditLog.$inferInsert;
const T0 = Date.parse("2026-11-01T12:00:00.000Z");
/** `n` rows a minute apart, oldest first, so ids and times rise together as they do in the real log. */
const seedRows = async (n: number, row: (i: number) => Partial<NewRow> = () => ({})) =>
  db.insert(auditLog).values(Array.from({ length: n }, (_, i) => ({ at: new Date(T0 + i * 60_000), door: "staff" as const, actorLabel: "sam@club.org", action: "signin", ...row(i) }))).returning({ id: auditLog.id });
const filters = (f: Partial<AuditFilters>): AuditFilters => ({ ...NO_FILTERS, ...f });
const allRows = async () => (await db.select().from(auditLog)).sort((a, b) => a.id - b.id);
const exportRequest = (query = "") => new Request(`http://localhost:3000/staff/settings/audit/export${query}`, { headers: { "cf-connecting-ip": "203.0.113.9" } });
/** A CSV file as rows of cells. Every cell is quoted, quotes are doubled, and a cell may hold a line break. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], i = 0;
  while (i < text.length) {
    if (text[i] !== '"') throw new Error(`cell not quoted at ${i}`);
    let cell = ""; i++;
    for (;;) {
      if (text[i] === '"' && text[i + 1] === '"') { cell += '"'; i += 2; }
      else if (text[i] === '"') { i++; break; }
      else { cell += text[i]; i++; }
    }
    row.push(cell);
    if (text[i] === ",") i++;
    else if (text.startsWith("\r\n", i)) { rows.push(row); row = []; i += 2; }
    else throw new Error(`unexpected ${JSON.stringify(text[i])} at ${i}`);
  }
  return rows;
}

/** The file an export answered with: whether it starts with the UTF-8 mark, and its rows. */
async function csvOf(res: Response): Promise<{ marked: boolean; rows: string[][] }> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const marked = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return { marked, rows: parseCsv(new TextDecoder("utf-8").decode(bytes)) };
}

async function admin() { const s = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }); asStaff(s); return s; }
/** A staff member holding the widest role a custom role can be: everything that isn't Admin-only. */
async function widestRole() {
  const s = await seedStaff({ email: "wide@club.org", name: "Wide Role" });
  const [r] = await db.insert(role).values({ key: "everything", name: "Everything" }).returning();
  await db.insert(roleRule).values([{ roleId: r!.id, kind: "include", pattern: "*" }, { roleId: r!.id, kind: "include", pattern: "Audit.Log.Read" }, { roleId: r!.id, kind: "include", pattern: "Audit.*" }]);
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  asStaff(s);
  return s;
}

describe("the audit log page", () => {
  beforeEach(resetDb);

  it("is Admin only: the widest custom role is refused, and the refusal is audited", async () => {
    await seedRows(3, () => ({ action: "parent.block", after: { reason: "A NOTE ONLY ADMINS SEE" } }));
    const wide = await widestRole();
    expect(await pageOutcome(AuditPage)).toEqual({ redirect: "/refused" });
    const refusals = (await allRows()).filter((r) => r.action === "access.refused");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ actorId: wide.id, permission: "Audit.Log.Read", ip: "203.0.113.50" });
  });

  it("sends a visitor who isn't signed in to the staff sign-in", async () => {
    expect(await pageOutcome(AuditPage)).toEqual({ redirect: "/staff/sign-in" });
  });

  it("shows actions in words where they have a name, and as stored where they don't", async () => {
    await admin();
    await db.insert(auditLog).values([
      { door: "staff", actorLabel: "sam@club.org", action: "parent.block", targetType: "parent", targetId: "p-1", after: { reason: "asked to be removed" }, ip: "203.0.113.7" },
      { door: "system", action: "something.from_a_later_version" },
    ]);
    const html = await renderPage(AuditPage);
    expect(html).toContain("Parent blocked");
    expect(html).toContain("<code>parent.block</code>");
    expect(html).toContain("something.from_a_later_version");
    expect(html).toContain("asked to be removed");
    expect(html).toContain("2 rows");
    expect(html).toContain("203.0.113.7");
    // The record is a link to that record's own history.
    expect(html).toContain('href="/staff/settings/audit?record=parent%3Ap-1"');
  });

  it("names every action the portal writes", () => {
    for (const [code, name] of Object.entries(ACTION_NAMES)) { expect(code).toMatch(/^[a-z_]+(\.[a-z_]+)*$/); expect(name.length).toBeGreaterThan(3); }
    expect(actionName("signin")).toBe("Signed in");
    expect(actionName("constructor")).toBeNull();
    expect(actionName("nope")).toBeNull();
  });

  it("pages through every row, not only the newest", async () => {
    await admin();
    const ids = (await seedRows(AUDIT_PAGE_SIZE * 2 + 20)).map((r) => r.id);
    const newest = ids.at(-1)!, oldest = ids[0]!;
    const first = await auditPage(NO_FILTERS);
    expect(first.total).toBe(120);
    expect(first.rows.map((r) => r.id)).toEqual(ids.slice(-AUDIT_PAGE_SIZE).reverse());
    expect(first.newer).toBeNull();
    const second = await auditPage(NO_FILTERS, { before: first.older });
    expect(second.rows).toHaveLength(AUDIT_PAGE_SIZE);
    expect(second.rows[0]!.id).toBe(first.rows.at(-1)!.id - 1);
    const third = await auditPage(NO_FILTERS, { before: second.older });
    expect(third.rows).toHaveLength(20);
    expect(third.rows.at(-1)!.id).toBe(oldest);
    expect(third.older).toBeNull();
    // And back again: the page of newer rows is the same page it was.
    expect((await auditPage(NO_FILTERS, { after: third.newer })).rows.map((r) => r.id)).toEqual(second.rows.map((r) => r.id));
    expect((await auditPage(NO_FILTERS, { after: second.newer })).rows[0]!.id).toBe(newest);
    // A page keeps its rows while new ones arrive.
    await seedRows(5);
    expect((await auditPage(NO_FILTERS, { before: first.older })).rows.map((r) => r.id)).toEqual(second.rows.map((r) => r.id));

    const html = await renderPage(AuditPage, { searchParams: { before: String(first.older) } });
    expect(html).toContain("125 rows");
    expect(html).toContain(`href="/staff/settings/audit?after=${second.rows[0]!.id}"`);
    expect(html).toContain(`href="/staff/settings/audit?before=${second.rows.at(-1)!.id}"`);
    expect(html).toContain('href="/staff/settings/audit/export"');
  });

  it("filters by action, by who, by the record and by date, alone and together", async () => {
    await admin();
    await db.insert(auditLog).values([
      { at: new Date("2026-11-10T05:00:00Z"), door: "staff", actorId: "11111111-1111-4111-8111-111111111111", actorLabel: "sam@club.org", action: "parent.block", targetType: "parent", targetId: "p-1" },
      { at: new Date("2026-11-11T05:00:00Z"), door: "staff", actorId: "11111111-1111-4111-8111-111111111111", actorLabel: "sam@club.org", action: "roster.family.read", targetType: "qbo_customer", targetId: "101" },
      { at: new Date("2026-11-12T05:00:00Z"), door: "parent", actorId: "22222222-2222-4222-8222-222222222222", actorLabel: "Ana.Rivera@example.com", action: "signin", targetType: "parent", targetId: "p-1" },
      { at: new Date("2026-11-13T05:00:00Z"), door: "parent", actorLabel: "100%_real@example.com", action: "signin.code_refused" },
      { at: new Date("2026-11-14T05:00:00Z"), door: "system", action: "cleanup.run", targetType: "job_run", targetId: "7" },
    ]);
    const found = async (f: Partial<AuditFilters>) => (await auditPage(filters(f))).rows.map((r) => r.action);
    expect(await found({ action: "signin" })).toEqual(["signin"]);
    expect(await found({ action: "sign" })).toEqual([]); // the whole action, not part of one
    expect(await found({ who: "SAM@" })).toEqual(["roster.family.read", "parent.block"]);
    expect(await found({ who: "rivera" })).toEqual(["signin"]);
    expect(await found({ who: "22222222-2222-4222-8222-222222222222" })).toEqual(["signin"]);
    // What is typed is looked for as written: % and _ are not wildcards.
    expect(await found({ who: "%" })).toEqual(["signin.code_refused"]);
    expect(await found({ who: "0%_r" })).toEqual(["signin.code_refused"]);
    expect(await found({ who: "s_m" })).toEqual([]);
    expect(await found({ record: { type: "parent", id: "p-1" } })).toEqual(["signin", "parent.block"]);
    expect(await found({ record: { either: "p-1" } })).toEqual(["signin", "parent.block"]);
    expect(await found({ record: { either: "job_run" } })).toEqual(["cleanup.run"]);
    expect(await found({ record: { type: "parent", id: "101" } })).toEqual([]);
    expect(await found({ from: new Date("2026-11-12T05:00:00Z") })).toEqual(["cleanup.run", "signin.code_refused", "signin"]);
    expect(await found({ to: new Date("2026-11-12T05:00:00Z") })).toEqual(["roster.family.read", "parent.block"]); // the end is not included
    expect(await found({ from: new Date("2026-11-11T00:00:00Z"), to: new Date("2026-11-13T00:00:00Z") })).toEqual(["signin", "roster.family.read"]);
    expect(await found({ who: "sam", action: "parent.block", record: { either: "parent" }, from: new Date("2026-11-10T00:00:00Z") })).toEqual(["parent.block"]);
    expect((await auditPage(filters({ who: "sam" }))).total).toBe(2);

    const html = await renderPage(AuditPage, { searchParams: { who: "sam", action: "parent.block" } });
    expect(html).toContain("1 row found");
    expect(html).toContain("Parent blocked");
    expect(html).not.toContain("<code>roster.family.read</code>");
    expect(html).toContain('href="/staff/settings/audit/export?action=parent.block&amp;who=sam"');
  });

  it("reads filters from an address strictly: what it can't read is no filter, never a guess", () => {
    expect(parseAuditFilters({})).toEqual(NO_FILTERS);
    expect(parseAuditFilters({ action: " signin ", who: ["sam", "x"], record: "parent:p-1" })).toEqual(filters({ action: "signin", who: "sam", record: { type: "parent", id: "p-1" } }));
    expect(parseAuditFilters({ record: "p-1" }).record).toEqual({ either: "p-1" });
    expect(parseAuditFilters({ record: ":p-1" }).record).toEqual({ either: "p-1" });
    expect(parseAuditFilters({ record: "a:b:c" }).record).toEqual({ type: "a", id: "b:c" });
    for (const empty of [":", "::", " : ", " "]) expect(parseAuditFilters({ record: empty }).record, empty).toBeNull();
    // A day is that day in UTC, both ends included; an instant is itself.
    expect(parseAuditFilters({ from: "2026-11-15", to: "2026-11-15" })).toMatchObject({ from: new Date("2026-11-15T00:00:00Z"), to: new Date("2026-11-16T00:00:00Z") });
    expect(parseAuditFilters({ from: "2026-11-15T06:00:00.000Z", to: "2026-11-16T06:00:00.000Z" })).toMatchObject({ from: new Date("2026-11-15T06:00:00Z"), to: new Date("2026-11-16T06:00:00Z") });
    for (const bad of ["yesterday", "2026-13-45", "15/11/2026", "2026-11-15 06:00", "1; drop table audit_log", "2026-11-15T06:00"]) {
      expect(parseAuditFilters({ from: bad, to: bad }), bad).toMatchObject({ from: null, to: null });
    }
    expect(parseAuditFilters({ who: "x".repeat(5000) }).who).toHaveLength(200);
    expect(parseAuditFilters(new URLSearchParams("action=signin&who=sam"))).toEqual(filters({ action: "signin", who: "sam" }));
    for (const bad of ["", "0", "-1", "1.5", "1e3", "abc", "1 or 1=1", "99999999999999999"]) expect(parseCursor({ before: bad }, "before"), bad).toBeNull();
    expect(parseCursor({ before: "42" }, "before")).toBe(42);
    // What the page links carry reads back as the same filters.
    const f = filters({ action: "parent.block", who: "sam & co", from: new Date("2026-11-15T06:00:00Z"), to: new Date("2026-11-16T06:00:00Z"), record: { type: "parent", id: "p-1" } });
    expect(parseAuditFilters(new URLSearchParams(filtersQuery(f).slice(1)))).toEqual(f);
    expect(filtersQuery(NO_FILTERS)).toBe("");
  });
});

describe("the audit log export", () => {
  beforeEach(resetDb);

  it("gives an Admin every matching row as CSV, never cached, and audits the export with its filters and count", async () => {
    const a = await admin();
    await seedRows(1100, (i) => ({ action: i % 2 ? "signin" : "signout", actorLabel: i === 0 ? "José Ñandú" : "sam@club.org", targetType: "parent", targetId: `p-${i}`,
      after: i === 1 ? { note: 'said "no", twice\nthen left' } : null, ip: "203.0.113.7" }));
    const res = await exportAudit(exportRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    const { marked, rows } = await csvOf(res);
    expect(marked).toBe(true);
    expect(rows[0]).toEqual(["When (UTC)", "Door", "Who", "Who (id)", "Action", "Action (code)", "Permission", "Record type", "Record id", "IP address", "Before", "After"]);
    // Every row that was there when it was asked for, newest first; not the export's own audit row.
    expect(rows).toHaveLength(1101);
    expect(rows[1]).toEqual([new Date(T0 + 1099 * 60_000).toISOString(), "staff", "sam@club.org", "", "Signed in", "signin", "", "parent", "p-1099", "203.0.113.7", "", ""]);
    expect(rows.at(-1)![2]).toBe("José Ñandú");
    expect(rows.at(-2)![11]).toBe('{"note":"said \\"no\\", twice\\nthen left"}');
    expect(rows.map((r) => r[5])).not.toContain("audit.export");

    const exported = (await allRows()).filter((r) => r.action === "audit.export");
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ door: "staff", actorId: a.id, actorLabel: "admin@club.org", permission: "Audit.Log.Read", targetType: "audit_log", ip: "203.0.113.9",
      after: { rows: 1100, action: null, who: null, from: null, to: null, record: null } });
  });

  it("exports only what the filters match, and says which filters in its audit row", async () => {
    await admin();
    await seedRows(6, (i) => ({ action: i < 2 ? "parent.block" : "signin", actorLabel: i % 2 ? "sam@club.org" : "kit@club.org", targetType: "parent", targetId: "p-1" }));
    const res = await exportAudit(exportRequest("?action=signin&who=sam&record=parent:p-1&from=2026-11-01&to=2026-11-01T12:04:00.000Z"));
    const { rows } = await csvOf(res);
    expect(rows.slice(1).map((r) => [r[0], r[2], r[5]])).toEqual([[new Date(T0 + 3 * 60_000).toISOString(), "sam@club.org", "signin"]]);
    const [exported] = (await allRows()).filter((r) => r.action === "audit.export");
    expect(exported!.after).toEqual({ rows: 1, action: "signin", who: "sam", from: "2026-11-01T00:00:00.000Z", to: "2026-11-01T12:04:00.000Z", record: "parent:p-1" });
    // An export that matches nothing is a header alone, and is still audited.
    const none = await exportAudit(exportRequest("?action=no.such.action"));
    expect((await csvOf(none)).rows).toHaveLength(1);
    expect((await allRows()).filter((r) => r.action === "audit.export")).toHaveLength(2);
  });

  it("can't be made into a formula by a name someone typed", async () => {
    await admin();
    await db.insert(auditLog).values([
      { door: "parent", actorLabel: "=HYPERLINK(\"http://evil.example\",\"x\")", action: "signin.code_refused" },
      { door: "parent", actorLabel: "+1+cmd|' /C calc'!A0", action: "signin.code_refused" },
      { door: "parent", actorLabel: "@SUM(1+1)", action: "signin.code_refused", targetId: "-2+3" },
    ]);
    const rows = (await csvOf(await exportAudit(exportRequest("?action=signin.code_refused")))).rows.slice(1);
    for (const r of rows) for (const cell of r) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    expect(rows.map((r) => r[2])).toEqual(["'@SUM(1+1)", "'+1+cmd|' /C calc'!A0", "'=HYPERLINK(\"http://evil.example\",\"x\")"]);
    expect(rows[0]![8]).toBe("'-2+3");
    expect(csvCell("plain")).toBe('"plain"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell("\tx")).toBe("\"'\tx\"");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it("gives nothing to the widest custom role, and audits the refusal", async () => {
    await seedRows(3, () => ({ action: "parent.block", after: { reason: "A NOTE ONLY ADMINS SEE" } }));
    const wide = await widestRole();
    const res = await exportAudit(exportRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/refused");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toContain("A NOTE ONLY ADMINS SEE");
    const rows = await allRows();
    expect(rows.filter((r) => r.action === "audit.export")).toEqual([]);
    expect(rows.filter((r) => r.action === "access.refused")).toMatchObject([{ actorId: wide.id, permission: "Audit.Log.Read", ip: "203.0.113.9" }]);
  });

  it("sends a visitor who isn't signed in to the staff sign-in, with nothing written", async () => {
    await seedRows(1);
    const res = await exportAudit(exportRequest());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/staff/sign-in");
    expect(await res.text()).toBe("");
    expect(await allRows()).toHaveLength(1);
  });

  it("gives nothing to a staff member whose sign-in was turned off", async () => {
    await seedRows(1);
    const off = await seedStaff({ email: "gone@club.org", admin: true, status: "disabled" });
    expect(off.status).toBe("disabled");
    // What the real session read gives for a disabled person: a session, and nobody behind it (src/lib/auth/resolve.ts).
    asRefusedStaff();
    const res = await exportAudit(exportRequest());
    expect(res.headers.get("location")).toBe("http://localhost:3000/refused");
    expect(await res.text()).toBe("");
  });
});
