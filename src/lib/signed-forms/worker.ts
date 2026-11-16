// The worker's one call into signed forms (src/lib/jobs/runner.ts): the evidence of completed forms, the guardians'
// copies, and the scheduled reminders. A throw in one never stops the other, and nothing of its text is kept.
import "server-only";
import { EVIDENCE_JOB, runEvidenceJob } from "./evidence-job";
import { runScheduledReminders } from "./reminders";

export const REMINDER_JOB = "forms.reminders";

/** One wake's share, as the runner reports jobs: an entry only for a part that did something or failed. */
export async function runSignedFormsJobs(now: Date): Promise<{ job: string; ok: boolean }[]> {
  const ran: { job: string; ok: boolean }[] = [];
  try {
    const r = await runEvidenceJob(now);
    if (r.fetched + r.copies.sent + r.copies.failed + r.copies.skipped + r.withdrawn > 0) ran.push({ job: EVIDENCE_JOB, ok: r.failed === 0 && r.copies.failed === 0 && r.mismatches === 0 });
  } catch {
    ran.push({ job: EVIDENCE_JOB, ok: false });
  }
  try {
    const r = await runScheduledReminders(now);
    if (r.rounds > 0) ran.push({ job: REMINDER_JOB, ok: r.failed === 0 });
  } catch {
    ran.push({ job: REMINDER_JOB, ok: false });
  }
  return ran;
}
