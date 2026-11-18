/**
 * The app's own ids for a family and a student (stage 1 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md).
 * At run time each is the uuid of its row in `family` or `student`. To TypeScript neither is a string, and a QuickBooks
 * id is a plain string everywhere in the portal, so comparing one kind with the other, or passing one where the other
 * is asked for, fails the typecheck (tests/unit/app-ids.test.ts). `String(id)` gives the text, for an audit row.
 */
declare const appFamily: unique symbol;
declare const appStudent: unique symbol;

/** A family's own id in the portal: `family.id`. Never a QuickBooks customer id. */
export type AppFamilyId = { readonly [appFamily]: true };
/** A student's own id in the portal: `student.id`. Never a QuickBooks customer id. */
export type AppStudentId = { readonly [appStudent]: true };

/** Only for a uuid read from `family.id`, or one just made for a new row of it. */
export const asAppFamilyId = (uuid: string): AppFamilyId => uuid as unknown as AppFamilyId;
/** Only for a uuid read from `student.id`, or one just made for a new row of it. */
export const asAppStudentId = (uuid: string): AppStudentId => uuid as unknown as AppStudentId;

/** The accounting system a link names (`accounting_link.system`): QuickBooks Online, the only one the portal knows. */
export const QUICKBOOKS = "quickbooks" as const;
