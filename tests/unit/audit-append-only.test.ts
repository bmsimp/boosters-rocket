import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * v1 spec §13: the audit log is append-only from the app's point of view. Nothing under src/ updates or deletes an
 * audit row, by the query builder or in SQL text; rows are only ever inserted (writeAudit, src/lib/audit/log.ts).
 * The daily clean-up's own test proves it leaves the table alone (tests/integration/cleanup.test.ts).
 */
const root = path.resolve(__dirname, "../..");
const sources = readdirSync(path.join(root, "src"), { recursive: true }).map((f) => `src/${String(f).replaceAll("\\", "/")}`).filter((f) => /\.tsx?$/.test(f));

/** Every way a change to an audit row could be written, in code or in SQL. */
function changesAuditRows(source: string): string[] {
  const found: string[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  for (const m of code.matchAll(/\.(update|delete)\(\s*auditLog\b/g)) found.push(m[0]);
  for (const m of code.matchAll(/\b(update|delete\s+from|truncate(\s+table)?|alter\s+table|drop\s+table)\s+("?public"?\.)?"?audit_log"?\b/gi)) found.push(m[0]);
  return found;
}

describe("the audit log is append-only (v1 spec §13)", () => {
  it("finds the source files, and the one place that writes a row", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(readFileSync(path.join(root, "src/lib/audit/log.ts"), "utf8")).toMatch(/\.insert\(auditLog\)/);
  });

  it("catches an update, a delete or a truncate, in code or in SQL, and not a mention in a comment", () => {
    expect(changesAuditRows("await tx.update(auditLog).set({ ip: null })")).toHaveLength(1);
    expect(changesAuditRows("await db.delete( auditLog ).where(lt(auditLog.at, d))")).toHaveLength(1);
    expect(changesAuditRows("sql`DELETE FROM audit_log WHERE at < now()`")).toHaveLength(1);
    expect(changesAuditRows('sql`update "audit_log" set ip = null`')).toHaveLength(1);
    expect(changesAuditRows("sql`truncate table public.audit_log`")).toHaveLength(1);
    expect(changesAuditRows("// never tx.delete(auditLog)\n/* nor update audit_log */ db.insert(auditLog)")).toEqual([]);
    expect(changesAuditRows("db.select().from(auditLog).where(eq(auditLog.action, 'x'))")).toEqual([]);
  });

  it("finds no file under src/ that changes an audit row", () => {
    const offenders = sources.flatMap((file) => changesAuditRows(readFileSync(path.join(root, file), "utf8")).map((found) => `${file}: ${found}`));
    expect(offenders, "The audit log is append-only: write rows with writeAudit() and never change or remove one.").toEqual([]);
  });
});
