import type { AuditRow } from "./query";
import { actionName } from "./actions";

export const AUDIT_CSV_HEADER = ["When (UTC)", "Door", "Who", "Who (id)", "Action", "Action (code)", "Permission", "Record type", "Record id", "IP address", "Before", "After"];

/**
 * One CSV cell. Quoted always, with quotes doubled. A cell that a spreadsheet would run as a formula (it starts with
 * =, +, -, @, a tab or a carriage return) gets a leading apostrophe: names and addresses in the log are typed by
 * visitors, some of them before they sign in.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export const csvLine = (cells: unknown[]): string => `${cells.map(csvCell).join(",")}\r\n`;

/** An audit row as a CSV line: every column the log holds, the action in words and as its code. */
export function auditCsvLine(r: AuditRow): string {
  return csvLine([r.at.toISOString(), r.door, r.actorLabel ?? (r.door === "system" ? "system" : ""), r.actorId, actionName(r.action) ?? r.action, r.action, r.permission,
    r.targetType, r.targetId, r.ip, r.before, r.after]);
}
