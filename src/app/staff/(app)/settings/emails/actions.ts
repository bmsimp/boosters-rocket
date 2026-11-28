"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { saveEmailTemplate, sendTemplateTest, restoreDefaultWords, saveVersionAgain } from "@/lib/mail/template-store";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };

/** The words a page sends: a subject (a string, or null where the portal writes it) and the editor's document. Anything else is refused. */
function wordsFrom(raw: unknown): { subject: string | null; body: unknown } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { subject, body } = raw as Record<string, unknown>;
  if (subject !== null && (typeof subject !== "string" || subject.length > 1000)) return null;
  if (typeof body !== "object" || body === null) return null;
  return { subject, body };
}
const keyFrom = (raw: unknown): string | null => (typeof raw === "string" && /^[a-z_]{1,40}$/.test(raw) ? raw : null);
const who = (ctx: { staffUserId: string; email: string; ip: string | null }) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, staffUserId: ctx.staffUserId, ip: ctx.ip });
const refresh = () => revalidatePath("/staff/settings", "layout");

/** Save: the words on the page become the email's next version, live for the next send. */
export const saveEmailAction = staffAction("Settings.Emails.ReadWrite", async (ctx, key: unknown, words: unknown): Promise<Done> => {
  const k = keyFrom(key), w = wordsFrom(words);
  if (!k || !w) return NOT_FROM_PAGE;
  const r = await saveEmailTemplate(k, w, who(ctx));
  if (r.ok) refresh();
  return r;
});

/** Send me a test: the words on the page, saved or not, with sample values, to the staff member's own address. */
export const testEmailAction = staffAction("Settings.Emails.ReadWrite", async (ctx, key: unknown, words: unknown): Promise<Done> => {
  const k = keyFrom(key), w = wordsFrom(words);
  if (!k || !w) return NOT_FROM_PAGE;
  return sendTemplateTest(k, w, who(ctx));
});

/** Use the default words: saved as the next version, behind its confirm dialog. */
export const defaultWordsAction = staffAction("Settings.Emails.ReadWrite", async (ctx, key: unknown): Promise<Done> => {
  const k = keyFrom(key);
  if (!k) return NOT_FROM_PAGE;
  const r = await restoreDefaultWords(k, who(ctx));
  if (r.ok) refresh();
  return r;
});

/** Use these words again: an earlier version saved as the next. */
export const versionAgainAction = staffAction("Settings.Emails.ReadWrite", async (ctx, key: unknown, n: unknown): Promise<Done> => {
  const k = keyFrom(key);
  if (!k || typeof n !== "number" || !Number.isSafeInteger(n)) return NOT_FROM_PAGE;
  const r = await saveVersionAgain(k, n, who(ctx));
  if (r.ok) refresh();
  return r;
});
