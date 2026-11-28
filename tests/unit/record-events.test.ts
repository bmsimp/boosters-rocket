import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Slice P6 of the accounting plugin spec (section 3, "Events"): the core's saves of a guardian and of a person's or a
 * family's details reach the books only through their event (`records.events`), called in the save's own transaction,
 * never by naming the books' queueing themselves. The events' two modules hand each event to the accounting handler and
 * do nothing else, so what is queued, and the requests the worker sends for it, are the handler's: today's functions
 * (tests/integration/record-events.test.ts proves the rows and requests the same).
 */
const read = (file: string) => readFileSync(file, "utf8");
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const QUEUEING = ["queueContactChange", "queueEmailChange", "queueForGuardian"];
/** Each core save and the event it calls. */
const SAVES = [
  { file: "src/lib/parents/contact-edits.ts", event: "detailsSaved", from: "@/lib/families/events", calls: 1 },
  { file: "src/lib/parents/email-change.ts", event: "detailsSaved", from: "@/lib/families/events", calls: 1 },
  { file: "src/lib/parents/guardians.ts", event: "guardianSaved", from: "@/lib/families/guardian-events", calls: 3 },
  { file: "src/lib/parents/people.ts", event: "guardianSaved", from: "@/lib/families/guardian-events", calls: 1 },
];

describe("the core's saves reach the books through their events", () => {
  for (const s of SAVES) {
    it(`${s.file} names none of the queueing, and calls ${s.event}() inside its transaction`, () => {
      const text = code(read(s.file));
      for (const name of QUEUEING) expect(text, name).not.toMatch(new RegExp(`\\b${name}\\b`));
      expect(text).toContain(`import { ${s.event} } from "${s.from}";`);
      expect([...text.matchAll(new RegExp(`\\b${s.event}\\(tx, \\{ record: "`, "g"))]).toHaveLength(s.calls);
    });
  }

  // Since slices P1 and P2 the handler is the accounting plugin's slot `records.events` (its manifest), read through
  // accountingOn(); with none on, nothing is queued.
  it("the events' modules import only types and the plugin that is on, and read, write and send nothing themselves", () => {
    const details = code(read("src/lib/families/events.ts")), guardians = code(read("src/lib/families/guardian-events.ts"));
    const imports = (t: string) => [...t.matchAll(/^import\s+(?!type\b)([^;]*?)\s+from\s+"([^"]+)";/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(imports(details)).toEqual(["{ accountingOn } @/plugins"]);
    expect(imports(guardians)).toEqual(["{ accountingOn } @/plugins"]);
    const manifest = code(read("src/plugins/quickbooks/plugin.ts"));
    expect(manifest).toContain('contact: async (tx, e, o) => (await import("@/lib/parents/contact-queue")).QUICKBOOKS_DETAILS_EVENTS.contact(tx, e, o),');
    expect(manifest).toContain('email: async (tx, e, o) => (await import("@/lib/parents/contact-queue")).QUICKBOOKS_DETAILS_EVENTS.email(tx, e, o),');
    expect(manifest).toContain('guardian: async (tx, e, o) => (await import("@/lib/roster/writes")).QUICKBOOKS_GUARDIAN_EVENTS.guardian(tx, e, o),');
    for (const t of [details, guardians]) expect(t).not.toMatch(/\.(insert|update|delete|select|execute)\(|quickbooks\/client|advisory/);
  });

  it("QuickBooks' handlers call today's queueing functions, each once, with the event's own values", () => {
    const queue = code(read("src/lib/parents/contact-queue.ts"));
    const handler = queue.slice(queue.indexOf("export const QUICKBOOKS_DETAILS_EVENTS"));
    expect(handler).toContain("contact: (tx, e, o) => queueContactChange(tx, e.of, { change: e.change, was: e.was, now: e.now }, o),");
    expect(handler).toContain("email: (tx, e, o) => queueEmailChange(tx, e.parentId, { from: e.from, to: e.to }, o),");
    const writes = code(read("src/lib/roster/writes.ts"));
    const g = writes.slice(writes.indexOf("export const QUICKBOOKS_GUARDIAN_EVENTS"), writes.indexOf("export async function queueForGuardian("));
    expect([...g.matchAll(/\bqueueForGuardian\(/g)]).toHaveLength(1);
    for (const ask of ['{ op: "grant", guardianId: e.guardianId, familyId: e.familyId, name: e.name, email: e.email }',
      '{ op: "remove", guardianId: e.guardianId, familyId: e.familyId }', '{ op: "rename", rows: e.rows, name: e.name, was: e.was, email: e.email }']) expect(g).toContain(ask);
  });
});
