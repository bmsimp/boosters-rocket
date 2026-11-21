// What a run of the import, importRecordsFromRoster() (./roster-import.ts), made and changed, and how an audit row says
// so. It reads nothing and imports nothing, so any code may use it: roster-import.ts itself is staff only
// (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).

/** What one run made or changed. Nothing is ever removed: a record nothing needs is made inactive, which is a change. */
export type AppRecordChanges = {
  families: { made: number; changed: number };
  students: { made: number; changed: number };
};

export const noAppRecordChanges = (): AppRecordChanges => ({ families: { made: 0, changed: 0 }, students: { made: 0, changed: 0 } });

/** Whether a run made or changed anything: then the audit row of the change that ran it says what (appRecordsAudit()). */
export const changedAppRecords = (c: AppRecordChanges): boolean =>
  [c.families.made, c.families.changed, c.students.made, c.students.changed].some((n) => n > 0);

/** The part of an audit row's `after` that says what a run made or changed: nothing when it changed nothing. */
export const appRecordsAudit = (c: AppRecordChanges): { appRecords?: AppRecordChanges } => (changedAppRecords(c) ? { appRecords: c } : {});
