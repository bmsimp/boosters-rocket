import { and, asc, eq, exists, isNull, lt, ne, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, parent } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { env } from "@/env";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { getStoredMailConfig, mailWorking } from "@/lib/mail/settings";
import { welcomeMessage } from "@/lib/mail/messages";
import type { StaffOp } from "./people";
import { getParentSettings, parentDoorClosed } from "./settings";

export const WELCOME_BATCH = 5;
export const WELCOME_RETRY_MS = 15 * 60_000;
const WELCOME_ACTOR: Actor = { door: "system", id: null, label: "welcome" };

async function message(to: string) {
  const stored = await getStoredMailConfig();
  // The club's own sending address is the one a reply reaches (spec §3). Both settings hold a bare address.
  const contact = stored ? (stored.method === "graph" ? stored.mailbox : stored.from) : null;
  return welcomeMessage(await currentBrand(), to, { appUrl: env.APP_URL.replace(/\/+$/, ""), contact });
}
const hasOpenLink = exists(db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, parent.id), ne(guardian.status, "disabled"))));

/**
 * Takes one person for sending, in a single statement: it succeeds for one run only, and only while the person is still
 * owed, not blocked, not tried in the last 15 minutes, and has an open link. The claim time is the back-off after a failure.
 */
async function claim(id: string, now: Date): Promise<boolean> {
  const rows = await db.update(parent).set({ welcomeTriedAt: now })
    .where(and(eq(parent.id, id), eq(parent.welcomeOwed, true), eq(parent.blocked, false), hasOpenLink,
      or(isNull(parent.welcomeTriedAt), lt(parent.welcomeTriedAt, new Date(now.getTime() - WELCOME_RETRY_MS)))))
    .returning({ id: parent.id });
  return rows.length > 0;
}
const welcomesOn = async () => { const s = await getParentSettings(); return s.welcome && s.signin; };

/**
 * Sends welcomes the reconcile or the switch marked as owed (spec §2 Welcome emails). Called on every wake of the
 * worker: at most five a wake, so a whole roster goes out over some minutes, not in one burst from the club's mailbox.
 * Each person is claimed before their email goes, so two overlapping runs never welcome the same person twice.
 */
export async function sendOwedWelcomes(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  if (!(await welcomesOn()) || !(await mailWorking())) return { sent: 0, failed: 0 };
  const due = await db.select().from(parent)
    .where(and(eq(parent.welcomeOwed, true), eq(parent.blocked, false), hasOpenLink,
      or(isNull(parent.welcomeTriedAt), lt(parent.welcomeTriedAt, new Date(now.getTime() - WELCOME_RETRY_MS)))))
    .orderBy(asc(parent.createdAt), asc(parent.id)).limit(WELCOME_BATCH);
  let sent = 0, failed = 0;
  for (const p of due) {
    if (!(await welcomesOn())) break; // switched off while this run was going
    if (!(await claim(p.id, now))) continue;
    const r = await sendMail(await message(p.email), { purpose: "welcome", actor: WELCOME_ACTOR });
    if (r.ok) {
      await db.update(parent).set({ welcomedAt: new Date(), welcomeOwed: false, welcomeTriedAt: null, updatedAt: new Date() }).where(eq(parent.id, p.id));
      await writeAudit({ actor: WELCOME_ACTOR, action: "parent.welcome.sent", targetType: "parent", targetId: p.id, after: { to: p.email } });
      sent++;
    } else {
      // welcomeTriedAt stays as claimed: that is the 15-minute back-off.
      await writeAudit({ actor: WELCOME_ACTOR, action: "parent.welcome.failed", targetType: "parent", targetId: p.id, after: { to: p.email, error: r.error } });
      failed++;
    }
  }
  return { sent, failed };
}

/** **Resend welcome email** on a person's page. It goes at once and does not depend on the welcome switch. */
export async function resendWelcome(parentId: string, o: StaffOp): Promise<{ ok: true } | { ok: false; reason: "not_found" | "no_access" | "blocked" | "mail_failed" }> {
  const [p] = await db.select().from(parent).where(eq(parent.id, parentId));
  if (!p) return { ok: false, reason: "not_found" };
  if (p.blocked) return { ok: false, reason: "blocked" };
  if (parentDoorClosed(await getParentSettings())) return { ok: false, reason: "no_access" }; // they could not sign in
  const [open] = await db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, p.id), ne(guardian.status, "disabled"))).limit(1);
  if (!open) return { ok: false, reason: "no_access" };
  const r = await sendMail(await message(p.email), { purpose: "welcome", actor: o.actor, ip: o.ip });
  if (!r.ok) {
    await writeAudit({ actor: o.actor, action: "parent.welcome.failed", permission: o.permission, targetType: "parent", targetId: p.id, after: { to: p.email, error: r.error, resend: true }, ip: o.ip });
    return { ok: false, reason: "mail_failed" };
  }
  await db.update(parent).set({ welcomedAt: new Date(), welcomeOwed: false, welcomeTriedAt: null, updatedAt: new Date() }).where(eq(parent.id, p.id));
  await writeAudit({ actor: o.actor, action: "parent.welcome.sent", permission: o.permission, targetType: "parent", targetId: p.id, after: { to: p.email, resend: true }, ip: o.ip });
  return { ok: true };
}
