import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { heldAddress, setting, staffUser } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { env } from "@/env";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { mailWorking } from "@/lib/mail/settings";
import { reviewNoticeMessage } from "@/lib/mail/messages";
import { loadDecision } from "./reconcile";
import { getParentSettings, type ParentSettings } from "./settings";

export const REVIEW_NOTICE_KEY = "parents.review_notice";
export const REVIEW_NOTICE_GAP_MS = 24 * 3_600_000;
const NOTICE_ACTOR: Actor = { door: "system", id: null, label: "review-notice" };

/** The held addresses waiting for a decision. The roster is built and the rules run only after the setting says they are needed. */
async function pending(needs: (s: ParentSettings) => boolean) {
  if (!needs(await getParentSettings())) return null;
  const loaded = await loadDecision();
  return loaded && needs(loaded.settings) ? { settings: loaded.settings, items: loaded.decision.held.filter((h) => h.pending) } : null;
}

/** How many held addresses are waiting for a decision: the number on the staff home (spec §5). */
export async function reviewWaiting(): Promise<number> {
  return (await pending((s) => s.signin))?.items.length ?? 0;
}

/**
 * Takes the 24-hour slot in one statement: it succeeds for one run only, and only while no notice has gone in the last
 * 24 hours. Times are stored as ISO strings, which sort the same as the times they name.
 */
async function takeSlot(now: Date): Promise<boolean> {
  const value = { lastSentAt: now.toISOString() };
  const cutoff = new Date(now.getTime() - REVIEW_NOTICE_GAP_MS).toISOString();
  const rows = await db.insert(setting).values({ key: REVIEW_NOTICE_KEY, value })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() },
      setWhere: sql`${setting.value}->>'lastSentAt' IS NULL OR ${setting.value}->>'lastSentAt' < ${cutoff}` })
    .returning({ key: setting.key });
  return rows.length > 0;
}

/** Gives the slot back after a run in which no email went, so the items are announced on the next wake. */
async function releaseSlot(claimed: Date, previous: unknown): Promise<void> {
  const ours = and(eq(setting.key, REVIEW_NOTICE_KEY), sql`${setting.value}->>'lastSentAt' = ${claimed.toISOString()}`);
  if (previous === undefined) await db.delete(setting).where(ours);
  else await db.update(setting).set({ value: previous, updatedAt: new Date() }).where(ours);
}

/**
 * The once-a-day email to staff who can decide held addresses (spec §5). An item is announced once: it is new while a
 * family it is held for is not in the row's announced set. The day's slot is taken before anything is sent, so two
 * overlapping runs never send twice. Nothing is marked announced unless at least one email went.
 */
export async function sendReviewNotice(now: Date = new Date()): Promise<{ sent: number; newItems: number }> {
  const p = await pending((s) => s.signin && s.reviewEmails);
  if (!p) return { sent: 0, newItems: 0 };
  const rows = new Map((await db.select().from(heldAddress)).map((r) => [r.email, r]));
  const heldFamilies = (email: string) => p.items.find((i) => i.email === email)!.families.filter((f) => f.held).map((f) => f.qboId);
  const fresh = p.items.filter((i) => heldFamilies(i.email).some((f) => !(rows.get(i.email)?.announcedFamilyQboIds ?? []).includes(f)));
  if (!fresh.length) return { sent: 0, newItems: 0 };
  if (!(await mailWorking())) return { sent: 0, newItems: fresh.length };

  const staff = await db.select().from(staffUser).where(eq(staffUser.status, "active"));
  const recipients: string[] = [];
  for (const s of staff) if (can(await effectivePermissions(s.id), "Parents.ReadWrite")) recipients.push(s.email);
  if (!recipients.length) return { sent: 0, newItems: fresh.length };

  const [last] = await db.select().from(setting).where(eq(setting.key, REVIEW_NOTICE_KEY));
  if (!(await takeSlot(now))) return { sent: 0, newItems: fresh.length };

  const brand = await currentBrand(), link = `${env.APP_URL.replace(/\/+$/, "")}/staff/parents`;
  let sent = 0;
  try {
    for (const to of recipients) {
      const r = await sendMail(reviewNoticeMessage(brand, to, { newCount: fresh.length, waiting: p.items.length, link }), { purpose: "review_notice", actor: NOTICE_ACTOR });
      if (r.ok) sent++;
    }
  } catch (e) {
    if (!sent) await releaseSlot(now, last?.value);
    throw e;
  }
  if (!sent) {
    await releaseSlot(now, last?.value);
    return { sent: 0, newItems: fresh.length };
  }
  await db.transaction(async (tx) => {
    for (const i of fresh) {
      const announced = [...new Set([...(rows.get(i.email)?.announcedFamilyQboIds ?? []), ...heldFamilies(i.email)])].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      await tx.insert(heldAddress).values({ email: i.email, announcedFamilyQboIds: announced })
        .onConflictDoUpdate({ target: heldAddress.email, set: { announcedFamilyQboIds: announced, updatedAt: new Date() } });
    }
    await writeAudit({ actor: NOTICE_ACTOR, action: "parent.review.notified", targetType: "setting", targetId: REVIEW_NOTICE_KEY,
      after: { newItems: fresh.length, waiting: p.items.length, recipients: recipients.length, failed: recipients.length - sent } }, tx);
  });
  return { sent, newItems: fresh.length };
}
