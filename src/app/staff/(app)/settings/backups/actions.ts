"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { askForBackup, askForDownload, askForRestore, parseSchedule, saveSchedule, type Asked } from "@/lib/backups/requests";
import { offsiteFields, parseOffsite, readOffsite, saveOffsite, stopOffsite, testOffsite } from "@/lib/backups/offsite";

const P = "Admin.Backups.ReadWrite" as const;
const NOT_FROM_PAGE: Asked = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const who = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip });
const done = (r: Asked) => { revalidatePath("/staff", "layout"); return r; };

/** Back up now (Admin only). Takes nothing from the page. */
export const backUpNowAction = staffAction(P, async (ctx): Promise<Asked> => done(await askForBackup(who(ctx))));

/** The schedule's Drawer: a time or off, and how many to keep. */
export const saveScheduleAction = staffAction(P, async (ctx, form: unknown): Promise<Asked> => {
  if (!(form instanceof FormData)) return NOT_FROM_PAGE;
  const parsed = parseSchedule({ at: form.get("at"), off: form.get("off"), keep: form.get("keep") });
  if (!parsed.ok) return parsed;
  return done(await saveSchedule(parsed.schedule, who(ctx)));
});

/** Prepare one backup (its time, bound by the page and checked against the server's backups) as a download. */
export const prepareDownloadAction = staffAction(P, async (ctx, stamp: unknown): Promise<Asked> => done(await askForDownload(stamp, who(ctx))));

/** Put one backup back (its time, bound by the page and checked again). */
export const restoreBackupAction = staffAction(P, async (ctx, stamp: unknown): Promise<Asked> => done(await askForRestore(stamp, who(ctx))));

/** Set up off-site copies, or change them. A blank secret keeps the saved one. */
export const saveOffsiteAction = staffAction(P, async (ctx, form: unknown): Promise<Asked> => {
  if (!(form instanceof FormData)) return NOT_FROM_PAGE;
  const saved = await readOffsite();
  const parsed = parseOffsite(offsiteFields(form), saved !== null);
  if (!parsed.ok) return parsed;
  return done(await saveOffsite(parsed.draft, who(ctx)));
});

/** Write one small file to the off-site storage, to see the settings work. */
export const testOffsiteAction = staffAction(P, async (ctx): Promise<Asked> => done(await testOffsite(who(ctx))));

/** Stop off-site copies. Copies already there stay. */
export const stopOffsiteAction = staffAction(P, async (ctx): Promise<Asked> => done(await stopOffsite(who(ctx))));
