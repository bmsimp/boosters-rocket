import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parent, signinCode } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { env } from "@/env";
import { mailWorking } from "@/lib/mail/settings";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { signinCodeMessage } from "@/lib/mail/messages";
import { takeRateLimit } from "./rate-limit";
import { enabledGuardianRows, parentActor } from "./sessions";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_TRIES = 5;
export const RESEND_AFTER_MS = 60 * 1000;

export const generateSigninCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
/** Keyed with the server secret, so a copy of the database alone can't be searched for the 1,000,000 possible codes. */
export const hashSigninCode = (parentId: string, code: string) =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`signin-code:${parentId}:${code}`).digest("hex");

type Refusal = "unknown_email" | "blocked" | "no_enabled_guardian" | "rate_limited" | "mail_failed";
const anon = (label: string): Actor => ({ door: "parent", id: null, label });
const subjectIp = (ip: string | null) => ip ?? "unknown";
const DONE: { delivery: Promise<void> } = { delivery: Promise.resolve() };

async function refuse(reason: Refusal, label: string, who: { id: string; email: string } | null, ip: string | null, extra: Record<string, unknown> = {}) {
  await writeAudit({ actor: who ? parentActor(who) : anon(label), action: "signin.code_refused", targetType: who ? "parent" : undefined,
    targetId: who?.id, after: { reason, ...extra }, ip });
}

/**
 * Spec §1. Decides, stores the code and returns; the email goes out in `delivery`. The caller answers the parent with
 * the same sentence whatever happened here and must not await `delivery`.
 */
export async function requestSigninCode(rawEmail: string, ip: string | null, now = new Date()): Promise<{ delivery: Promise<void> }> {
  const email = normalizeEmail(rawEmail);
  const label = email ?? rawEmail.trim().toLowerCase().slice(0, 254);
  if (!(await mailWorking())) { await refuse("mail_failed", label, null, ip, { detail: "mail_not_working" }); return DONE; }
  if (!(await takeRateLimit("code_send_ip", subjectIp(ip), now))) { await refuse("rate_limited", label, null, ip, { limit: "ip" }); return DONE; }
  if (!email) { await refuse("unknown_email", label, null, ip); return DONE; }
  if (!(await takeRateLimit("code_send_email", email, now))) { await refuse("rate_limited", email, null, ip, { limit: "email" }); return DONE; }
  const [p] = await db.select().from(parent).where(eq(parent.email, email));
  if (!p) { await refuse("unknown_email", email, null, ip); return DONE; }
  if (p.blocked) { await refuse("blocked", email, p, ip); return DONE; }
  if ((await enabledGuardianRows(p.id)).length === 0) { await refuse("no_enabled_guardian", email, p, ip); return DONE; }

  const code = generateSigninCode();
  const stored = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.signin_code:${p.id}`}))`);
    const [last] = await tx.select({ createdAt: signinCode.createdAt }).from(signinCode).where(eq(signinCode.parentId, p.id))
      .orderBy(desc(signinCode.createdAt)).limit(1);
    if (last && now.getTime() - last.createdAt.getTime() < RESEND_AFTER_MS) return null;
    await tx.delete(signinCode).where(and(eq(signinCode.parentId, p.id), isNull(signinCode.usedAt)));
    const [row] = await tx.insert(signinCode).values({ parentId: p.id, codeHash: hashSigninCode(p.id, code), expiresAt: new Date(now.getTime() + CODE_TTL_MS), createdAt: now })
      .returning({ id: signinCode.id });
    return row!.id;
  });
  if (!stored) { await refuse("rate_limited", email, p, ip, { limit: "resend" }); return DONE; }

  const delivery = (async () => {
    const r = await sendMail(signinCodeMessage(await currentBrand(), p.email, code), { purpose: "signin_code", actor: parentActor(p), ip });
    if (r.ok) {
      await writeAudit({ actor: parentActor(p), action: "signin.code_sent", targetType: "parent", targetId: p.id,
        after: { expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString() }, ip });
    } else {
      await db.delete(signinCode).where(eq(signinCode.id, stored)); // nobody got it, so nobody may use it
      await refuse("mail_failed", email, p, ip);
    }
  })().catch(() => undefined); // every failure above is already audited; nothing here may surface to the caller
  return { delivery };
}

export type VerifyResult = { ok: true; parentId: string } | { ok: false; reason: "rejected" | "rate_limited" };
const REJECTED: VerifyResult = { ok: false, reason: "rejected" };

/** Spec §1. Single use, 10 minutes, 5 wrong tries, 30 checks per IP per 15 minutes. */
export async function verifySigninCode(rawEmail: string, rawCode: string, ip: string | null, now = new Date()): Promise<VerifyResult> {
  const email = normalizeEmail(rawEmail);
  const label = email ?? rawEmail.trim().toLowerCase().slice(0, 254);
  if (!(await takeRateLimit("code_check_ip", subjectIp(ip), now))) {
    await refuse("rate_limited", label, null, ip, { limit: "check_ip" });
    return { ok: false, reason: "rate_limited" };
  }
  const expired = (who: { id: string; email: string } | null, reason: "no_code" | "expired" | "too_many_tries") =>
    writeAudit({ actor: who ? parentActor(who) : anon(label), action: "signin.code_expired", targetType: who ? "parent" : undefined, targetId: who?.id, after: { reason }, ip });
  const [p] = email ? await db.select().from(parent).where(eq(parent.email, email)) : [];
  if (!p) { await expired(null, "no_code"); return REJECTED; }
  const code = rawCode.replace(/[\s-]/g, "");

  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(signinCode).where(and(eq(signinCode.parentId, p.id), isNull(signinCode.usedAt))).for("update");
    if (!row) return "no_code" as const;
    if (row.expiresAt.getTime() <= now.getTime()) return "expired" as const;
    if (row.tries >= CODE_MAX_TRIES) return "too_many_tries" as const;
    const want = Buffer.from(row.codeHash, "hex");
    const got = Buffer.from(hashSigninCode(p.id, /^\d{6}$/.test(code) ? code : "invalid"), "hex");
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      await tx.update(signinCode).set({ tries: row.tries + 1 }).where(eq(signinCode.id, row.id));
      return { wrong: row.tries + 1 } as const;
    }
    await tx.update(signinCode).set({ usedAt: now }).where(eq(signinCode.id, row.id));
    return "ok" as const;
  });
  if (outcome === "no_code" || outcome === "expired" || outcome === "too_many_tries") { await expired(p, outcome); return REJECTED; }
  if (typeof outcome === "object") {
    await writeAudit({ actor: parentActor(p), action: "signin.code_wrong", targetType: "parent", targetId: p.id, after: { try: outcome.wrong }, ip });
    return REJECTED;
  }
  // The code was right; the person must still be allowed in now (they may have been blocked or removed since it was sent).
  const [fresh] = await db.select().from(parent).where(eq(parent.id, p.id));
  const reason = !fresh || fresh.blocked ? "blocked" : (await enabledGuardianRows(p.id)).length === 0 ? "no_enabled_guardian" : null;
  if (reason) {
    await writeAudit({ actor: parentActor(p), action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason }, ip });
    return REJECTED;
  }
  return { ok: true, parentId: p.id };
}
