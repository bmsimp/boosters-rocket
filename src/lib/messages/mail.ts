import { and, asc, count, desc, eq, exists, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { clubMessage, guardian, messageFile, messageMail, messageVersion, messageVersionFile, parent, staffUser } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { env } from "@/env";
import { clubMessageMail } from "@/lib/mail/messages";
import { currentBrand, sendMail } from "@/lib/mail/send";
import { mailWorking } from "@/lib/mail/settings";
import { messagesEmailAllowed } from "@/lib/settings/messages";
import { guardianRowCounts, studentsRuleInForce } from "@/lib/parents/sessions";
import { bodyMail, storedBody } from "./body";
import { isPicture } from "./file-types";

/**
 * The mail of club messages (spec section 8): the queue, written in a post's or an edit's own transaction when the club
 * allows email and the poster left the box ticked, and the worker's job that sends it a batch at each wake. Staff only
 * (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts): it reads every parent's sign-in address, and the
 * results it gives (which addresses got it, which failed) are other families' addresses.
 */
export const MESSAGES_MAIL_JOB = "messages.mail";
/** How many emails go at one wake (the worker wakes every minute): a club's worth goes out over some minutes, not in one burst. */
export const MESSAGE_MAIL_BATCH = 20;
/**
 * How many times one address may be refused, at one wake each, before its email is counted as failed with its reason.
 * Only a refusal of the address counts: a failure of the mail itself (the server can't be reached, it refuses to send
 * anything) counts no try, and puts the whole queue off instead (MESSAGE_MAIL_WAITS).
 */
export const MESSAGE_MAIL_TRIES = 3;
/** How long the queue waits after a failure of the mail itself, in minutes: 5, then 15, then every 60. */
export const MESSAGE_MAIL_WAITS = [5, 15, 60] as const;
const REASON_MAX = 200;
/** Only one wake sends at a time: a second finds the lock taken and sends nothing, so an email is never sent twice at once. */
const SEND_LOCK = 7461057;
const ACTOR: Actor = { door: "system", id: null, label: "club messages mail" };

/**
 * Who a message is emailed to: the sign-in address of every parent who isn't blocked and has a guardian row that counts
 * at the gate (an active membership of an active family: guardianRowCounts()), so nobody is asked to open a message
 * they couldn't sign in to read. Each address once, however many families it is in. The portal's own addresses, never
 * QuickBooks'.
 */
async function recipients(tx?: Tx): Promise<string[]> {
  const rule = await studentsRuleInForce(tx);
  const q = tx ?? db;
  const rows = await q.selectDistinct({ email: sql<string>`lower(btrim(${parent.email}))` }).from(parent)
    .where(and(eq(parent.blocked, false), exists(q.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, parent.id), guardianRowCounts(rule))))));
  return rows.map((r) => r.email).filter((e) => e.length > 0).sort();
}

/** How many addresses a message would be emailed to now, for the form's preview. */
export async function addressesReached(): Promise<number> {
  return (await recipients()).length;
}

/** For the form: how many addresses a message would be emailed to, or null while the club doesn't allow messages to be emailed. */
export async function emailReach(): Promise<number | null> {
  return (await messagesEmailAllowed()) ? addressesReached() : null;
}

/**
 * Queues a version's email, in the post's or edit's own transaction: one row per address, each once. Returns how many.
 * The caller has checked the club allows it and the box was ticked.
 */
export async function queueMail(tx: Tx, versionId: string): Promise<number> {
  const addresses = await recipients(tx);
  for (let i = 0; i < addresses.length; i += 1000) {
    await tx.insert(messageMail).values(addresses.slice(i, i + 1000).map((address) => ({ versionId, address }))).onConflictDoNothing();
  }
  return addresses.length;
}

/**
 * In an edit's own transaction, after its new version is written: what becomes of the email still queued for the
 * message's earlier versions, which would otherwise send content the message no longer has. An emailed edit drops it,
 * since the edit queues every address again: each gets this edit's email alone. A quiet edit moves it onto the new
 * version: those addresses never got anything, so they get the message as it now is, as an ordinary first email (an
 * unemailed version's mail is never an update: mailOf()). An address is kept once. Returns how many rows it dropped
 * and moved.
 */
export async function carryUnsentMail(tx: Tx, messageId: string, versionId: string, emailed: boolean): Promise<{ dropped: number; moved: number }> {
  const unsent = await tx.select({ id: messageMail.id, address: messageMail.address }).from(messageMail)
    .innerJoin(messageVersion, eq(messageVersion.id, messageMail.versionId))
    .where(and(eq(messageVersion.messageId, messageId), ne(messageMail.versionId, versionId), eq(messageMail.status, "queued")))
    .orderBy(asc(messageMail.createdAt), asc(messageMail.id)).for("update", { of: messageMail });
  if (!unsent.length) return { dropped: 0, moved: 0 };
  const seen = new Set<string>(), keep: string[] = [], drop: string[] = [];
  for (const r of unsent) {
    if (emailed || seen.has(r.address)) drop.push(r.id); else { seen.add(r.address); keep.push(r.id); }
  }
  for (let i = 0; i < drop.length; i += 1000) await tx.delete(messageMail).where(inArray(messageMail.id, drop.slice(i, i + 1000)));
  for (let i = 0; i < keep.length; i += 1000) await tx.update(messageMail).set({ versionId }).where(inArray(messageMail.id, keep.slice(i, i + 1000)));
  return { dropped: drop.length, moved: keep.length };
}

// --- results -----------------------------------------------------------------------------------------------------

export type MailCounts = { sent: number; failed: number; queued: number };
export type VersionMail = MailCounts & { versionId: string; n: number; failures: { address: string; reason: string }[] };

/** A version that has mail: emailed, or holding email a quiet edit moved onto it (carryUnsentMail()). */
const hasMail = () => exists(db.select({ id: messageMail.id }).from(messageMail).where(eq(messageMail.versionId, messageVersion.id)));

/** One message's mail, per version that has any, newest first: delivered, failed and waiting, and each failed address with its reason. */
export async function mailResults(messageId: string): Promise<VersionMail[]> {
  const versions = await db.select({ id: messageVersion.id, n: messageVersion.n }).from(messageVersion)
    .where(and(eq(messageVersion.messageId, messageId), hasMail())).orderBy(desc(messageVersion.n));
  if (!versions.length) return [];
  const rows = await db.select({ versionId: messageMail.versionId, status: messageMail.status, n: count() }).from(messageMail)
    .where(inArray(messageMail.versionId, versions.map((v) => v.id))).groupBy(messageMail.versionId, messageMail.status);
  const failures = await db.select({ versionId: messageMail.versionId, address: messageMail.address, reason: messageMail.reason }).from(messageMail)
    .where(and(inArray(messageMail.versionId, versions.map((v) => v.id)), eq(messageMail.status, "failed"))).orderBy(asc(messageMail.address));
  return versions.map((v) => ({
    versionId: v.id, n: v.n, ...countsOf(rows.filter((r) => r.versionId === v.id)),
    failures: failures.filter((f) => f.versionId === v.id).map((f) => ({ address: f.address, reason: f.reason ?? "It couldn't be delivered." })),
  }));
}

const countsOf = (rows: { status: "queued" | "sent" | "failed"; n: number }[]): MailCounts => ({
  sent: rows.find((r) => r.status === "sent")?.n ?? 0, failed: rows.find((r) => r.status === "failed")?.n ?? 0, queued: rows.find((r) => r.status === "queued")?.n ?? 0,
});

/** For the staff list: the counts of each message's latest version that has mail. A message never emailed has none. */
export async function latestMailCounts(): Promise<Map<string, MailCounts>> {
  const latest = db.select({ messageId: messageVersion.messageId, maxN: sql<number>`max(${messageVersion.n})`.as("max_n") }).from(messageVersion)
    .where(hasMail()).groupBy(messageVersion.messageId).as("latest");
  const rows = await db.select({ messageId: messageVersion.messageId, status: messageMail.status, n: count() }).from(messageVersion)
    .innerJoin(latest, and(eq(latest.messageId, messageVersion.messageId), eq(latest.maxN, messageVersion.n)))
    .innerJoin(messageMail, eq(messageMail.versionId, messageVersion.id))
    .groupBy(messageVersion.messageId, messageMail.status);
  const out = new Map<string, MailCounts>();
  for (const id of new Set(rows.map((r) => r.messageId))) out.set(id, countsOf(rows.filter((r) => r.messageId === id)));
  return out;
}

/** A version's mail in words, for the staff pages: "Emailed 142 · 3 couldn't be delivered", or how far it has got. */
export function mailWords(c: MailCounts): string {
  const failed = c.failed ? ` · ${c.failed} couldn't be delivered` : "";
  if (c.queued) return `Emailing: ${c.sent} sent, ${c.queued} waiting${failed}`;
  return `Emailed ${c.sent}${failed}`;
}

// --- the worker ----------------------------------------------------------------------------------------------------

/**
 * What one email says, read once per version in a wake: null when its message was deleted (its versions are gone), and
 * "stale" when the version is no longer the message's newest (an edit moves or drops such email in its own
 * transaction, carryUnsentMail(); this is the worker's own check). An update only for an emailed edit: email a quiet
 * edit moved onto its version goes to addresses that never got the message.
 */
async function mailOf(versionId: string) {
  const [v] = await db.select({ id: messageVersion.id, n: messageVersion.n, emailed: messageVersion.emailed, title: messageVersion.title, body: messageVersion.body,
    messageId: clubMessage.id, poster: staffUser.name, deletedAt: clubMessage.deletedAt })
    .from(messageVersion).innerJoin(clubMessage, eq(clubMessage.id, messageVersion.messageId)).innerJoin(staffUser, eq(staffUser.id, clubMessage.postedBy))
    .where(eq(messageVersion.id, versionId));
  if (!v || v.deletedAt) return null;
  const [newest] = await db.select({ n: messageVersion.n }).from(messageVersion).where(eq(messageVersion.messageId, v.messageId)).orderBy(desc(messageVersion.n)).limit(1);
  if (newest && v.n < newest.n) return "stale" as const;
  const files = await db.select({ id: messageFile.id, name: messageFile.name, type: messageFile.type }).from(messageVersionFile)
    .innerJoin(messageFile, eq(messageFile.id, messageVersionFile.fileId)).where(eq(messageVersionFile.versionId, versionId)).orderBy(asc(messageVersionFile.position));
  const body = storedBody(v.body, files.filter((f) => isPicture(f.type)).map((f) => f.id));
  const inBody = new Set<string>();
  const walk = (blocks: typeof body.content) => { for (const b of blocks) { if (b.type === "image") inBody.add(b.attrs.attachment); else if (b.type === "bulletList" || b.type === "orderedList") for (const li of b.content) walk(li.content); } };
  walk(body.content);
  return {
    update: v.n > 1 && v.emailed, poster: v.poster, title: v.title, body: bodyMail(body),
    // The files a parent downloads: every file of the version but the pictures already shown, as lines, in the body.
    files: files.filter((f) => !inBody.has(f.id)).map((f) => f.name),
    link: `${env.APP_URL.replace(/\/+$/, "")}/messages/${v.messageId}`,
  };
}

/** Reads one queued email again right before it is sent: none when it was sent, failed or dropped by a delete in the meantime. */
async function claim(id: string): Promise<{ versionId: string; address: string; nextTryAt: Date | null; createdAt: Date } | null> {
  const [row] = await db.select({ versionId: messageMail.versionId, address: messageMail.address, nextTryAt: messageMail.nextTryAt, createdAt: messageMail.createdAt })
    .from(messageMail).where(and(eq(messageMail.id, id), eq(messageMail.status, "queued")));
  return row ?? null;
}

/**
 * How long the queue waits after the mail itself failed on this email: 5 minutes when it had not been put off before,
 * then 15 while it is under 20 minutes old (it was queued with the outage), then 60, every hour until the mail works.
 */
export function outageWaitMinutes(row: { nextTryAt: Date | null; createdAt: Date }, now: Date): number {
  const [first, second, last] = MESSAGE_MAIL_WAITS;
  if (row.nextTryAt === null) return first;
  return now.getTime() - row.createdAt.getTime() < 20 * 60_000 ? second : last;
}

/**
 * One wake's share of the club messages' mail, while outgoing mail works: at most MESSAGE_MAIL_BATCH emails that are
 * due, oldest first, each read again before it is sent. An address the server refuses is tried again at a later wake,
 * at most MESSAGE_MAIL_TRIES times in all, then counted as failed with its reason (a short sentence, never a secret):
 * only such a refusal is the address's own, and only it counts a try or marks a row failed. A failure that is the
 * mail's own (the server can't be reached, it sends nothing) counts no try: it ends the wake's batch, keeps its reason
 * on that email, and puts every queued email off (`next_try_at`, outageWaitMinutes()), so an outage is asked about
 * once in 5, 15, then 60 minutes and uses up no address's tries. Two refused addresses and nothing sent also end the
 * batch, which may be a server refusing to relay. A message deleted in the meantime sends nothing more: its queued rows
 * are gone. Audited once per wake that sent or tried something, with counts, never an address. `now` is for tests.
 */
export async function sendMessageMail(now: Date = new Date()): Promise<{ sent: number; failed: number; retrying: number }> {
  const none = { sent: 0, failed: 0, retrying: 0 };
  if (!(await mailWorking())) return none;
  return db.transaction(async (lockTx) => {
    const [lock] = (await lockTx.execute(sql`select pg_try_advisory_xact_lock(${SEND_LOCK}) as locked`)) as unknown as { locked: boolean }[];
    if (!lock?.locked) return none;
    const due = await db.select({ id: messageMail.id }).from(messageMail)
      .where(and(eq(messageMail.status, "queued"), or(isNull(messageMail.nextTryAt), lte(messageMail.nextTryAt, now))))
      .orderBy(asc(messageMail.createdAt), asc(messageMail.id)).limit(MESSAGE_MAIL_BATCH);
    if (!due.length) return none;
    const brand = await currentBrand();
    const mails = new Map<string, Awaited<ReturnType<typeof mailOf>>>();
    let sent = 0, failed = 0, retrying = 0, refused = 0;
    for (const { id } of due) {
      const row = await claim(id);
      if (!row) continue;
      if (!mails.has(row.versionId)) mails.set(row.versionId, await mailOf(row.versionId));
      const m = mails.get(row.versionId);
      if (!m) continue; // its message was deleted: the delete drops its rows
      if (m === "stale") { await db.delete(messageMail).where(and(eq(messageMail.id, id), eq(messageMail.status, "queued"))); continue; }
      const out = await sendMail(clubMessageMail(brand, row.address, m), { purpose: m.update ? "club_message_update" : "club_message", actor: ACTOR });
      if (out.ok) {
        await db.update(messageMail).set({ status: "sent", sentAt: new Date(), reason: null, nextTryAt: null }).where(eq(messageMail.id, id));
        sent++;
        continue;
      }
      const reason = out.error.slice(0, REASON_MAX);
      if (!out.recipientRefused) {
        // The mail's own failure: no try is counted, and the whole queue waits (never sooner than it already does).
        const until = new Date(now.getTime() + outageWaitMinutes(row, now) * 60_000);
        await db.update(messageMail).set({ reason }).where(eq(messageMail.id, id));
        await db.update(messageMail).set({ nextTryAt: sql`greatest(${messageMail.nextTryAt}, ${until.toISOString()}::timestamptz)` }).where(eq(messageMail.status, "queued"));
        retrying++;
        break;
      }
      const [tried] = await db.update(messageMail).set({ tries: sql`${messageMail.tries} + 1`, reason })
        .where(eq(messageMail.id, id)).returning({ tries: messageMail.tries });
      const last = (tried?.tries ?? MESSAGE_MAIL_TRIES) >= MESSAGE_MAIL_TRIES;
      if (last) await db.update(messageMail).set({ status: "failed" }).where(eq(messageMail.id, id));
      if (last) failed++; else retrying++;
      if (++refused >= 2 && sent === 0) break;
    }
    if (sent + failed + retrying > 0) {
      await writeAudit({ actor: ACTOR, action: "message.mail.sent", targetType: "message_mail", after: { sent, failed, retrying } });
    }
    return { sent, failed, retrying };
  });
}
