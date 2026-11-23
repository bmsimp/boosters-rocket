import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { clubMessage, messageFile, messageRead, messageVersion, messageVersionFile, staffUser } from "@/lib/db/schema";
import { isUuid } from "@/lib/seasons/ids";
import { shownContactEmail } from "@/lib/staff/contact-email";
import { storedBody, type MessageBody } from "./body";
import { isPicture, type MessageFileType } from "./file-types";

/**
 * Club messages for parents (spec section 5). A message is the club's, the same for every family, so it is no family's
 * data; what is a person's is whether they have read it, and that is read and written here only for the parent the
 * caller names, which is always the session's own (`ctx.parentId`): never an id from the address. Two guardians of one
 * family each have their own. A deleted message is gone from every read: its content was erased, and a link to it, or
 * to one of its files, is "not found". Parent code (PARENT_CODE_ELSEWHERE in tests/integration/page-guards.test.ts):
 * it imports nothing staff-only.
 */

export type ParentFile = { id: string; name: string; type: MessageFileType; size: number; picture: boolean };
export type ParentVersion = { n: number; title: string; body: MessageBody; savedAt: Date; files: ParentFile[] };
export type ParentMessageRow = {
  id: string; title: string; poster: { id: string; name: string }; postedAt: Date;
  /** When it was last edited, for a message with more than one version. */
  editedAt: Date | null;
  /** This parent hasn't opened it yet. */
  isNew: boolean;
};
export type ParentMessage = Omit<ParentMessageRow, "isNew"> & {
  /** Newest first: the first is the current version, the rest its earlier ones. */
  versions: ParentVersion[];
};

/** Every message that isn't deleted, newest first, with its current title and whether this parent has read it; or a poster's alone. */
async function messageRows(parentId: string, postedBy?: string): Promise<ParentMessageRow[]> {
  const rows = await db.select({ id: clubMessage.id, postedAt: clubMessage.postedAt, posterId: staffUser.id, poster: staffUser.name, readN: messageRead.versionN })
    .from(clubMessage).innerJoin(staffUser, eq(staffUser.id, clubMessage.postedBy))
    .leftJoin(messageRead, and(eq(messageRead.messageId, clubMessage.id), eq(messageRead.parentId, parentId)))
    .where(and(isNull(clubMessage.deletedAt), postedBy ? eq(clubMessage.postedBy, postedBy) : undefined))
    .orderBy(desc(clubMessage.postedAt), desc(clubMessage.id));
  if (!rows.length) return [];
  const versions = await db.select({ messageId: messageVersion.messageId, title: messageVersion.title, savedAt: messageVersion.savedAt, n: messageVersion.n })
    .from(messageVersion).where(inArray(messageVersion.messageId, rows.map((r) => r.id))).orderBy(asc(messageVersion.n));
  const last = new Map<string, (typeof versions)[number]>();
  for (const v of versions) last.set(v.messageId, v);
  return rows.flatMap((r) => {
    const v = last.get(r.id);
    if (!v) return [];
    return [{ id: r.id, title: v.title, poster: { id: r.posterId, name: r.poster }, postedAt: r.postedAt, editedAt: v.n > 1 ? v.savedAt : null, isNew: r.readN === null }];
  });
}

/** The Messages page: every message, newest first, each with "new" for this parent. */
export const myMessages = (parentId: string): Promise<ParentMessageRow[]> => messageRows(parentId);

/** Home's card: how many messages there are, how many this parent hasn't read, and the newest of those. */
export async function myMessagesSummary(parentId: string): Promise<{ total: number; fresh: number; newest: { id: string; title: string } | null }> {
  const rows = await messageRows(parentId);
  const fresh = rows.filter((r) => r.isNew);
  return { total: rows.length, fresh: fresh.length, newest: fresh[0] ? { id: fresh[0].id, title: fresh[0].title } : null };
}

/**
 * One message as its page shows it, with every version, newest first, and each version's files, marked read for this
 * parent at its current version as it is read (markRead()); null, marking nothing, for an id that isn't a message or is
 * deleted.
 */
export async function openMyMessage(parentId: string, id: unknown): Promise<ParentMessage | null> {
  if (!isUuid(id)) return null;
  const [m] = await db.select({ id: clubMessage.id, postedAt: clubMessage.postedAt, posterId: staffUser.id, poster: staffUser.name })
    .from(clubMessage).innerJoin(staffUser, eq(staffUser.id, clubMessage.postedBy)).where(and(eq(clubMessage.id, id), isNull(clubMessage.deletedAt)));
  if (!m) return null;
  const versions = await db.select().from(messageVersion).where(eq(messageVersion.messageId, id)).orderBy(desc(messageVersion.n));
  if (!versions.length) return null;
  const files = await db.select({ versionId: messageVersionFile.versionId, id: messageFile.id, name: messageFile.name, type: messageFile.type, size: messageFile.size })
    .from(messageVersionFile).innerJoin(messageFile, eq(messageFile.id, messageVersionFile.fileId))
    .where(inArray(messageVersionFile.versionId, versions.map((v) => v.id))).orderBy(asc(messageVersionFile.position));
  const byVersion = new Map<string, ParentFile[]>();
  for (const f of files) byVersion.set(f.versionId, [...(byVersion.get(f.versionId) ?? []), { id: f.id, name: f.name, type: f.type, size: f.size, picture: isPicture(f.type) }]);
  const current = versions[0]!;
  await markRead(parentId, m.id, current.n);
  return {
    id: m.id, title: current.title, poster: { id: m.posterId, name: m.poster }, postedAt: m.postedAt, editedAt: versions.length > 1 ? current.savedAt : null,
    versions: versions.map((v) => {
      const fs = byVersion.get(v.id) ?? [];
      return { n: v.n, title: v.title, savedAt: v.savedAt, files: fs, body: storedBody(v.body, fs.filter((f) => f.picture).map((f) => f.id)) };
    }),
  };
}

/**
 * Marks a message read for this parent at the version they are shown, as its page is drawn (spec section 12: no
 * action). One row per message and parent: opening it again moves the row on to the version shown and its time.
 */
async function markRead(parentId: string, messageId: string, versionN: number): Promise<void> {
  await db.insert(messageRead).values({ messageId, parentId, versionN })
    .onConflictDoUpdate({ target: [messageRead.messageId, messageRead.parentId], set: { versionN, readAt: sql`now()` } });
}

/**
 * A staff member's profile (spec section 5): their name, the address they show families (their contact email, else
 * their sign-in address) and the messages they posted, each with "new" for this parent. Only for someone with at least
 * one message that isn't deleted: anyone else, a staff member who never posted included, is null, so a parent can't
 * list the club's staff.
 */
export async function staffProfile(parentId: string, staffId: unknown): Promise<{ name: string; email: string; messages: ParentMessageRow[] } | null> {
  if (!isUuid(staffId)) return null;
  const messages = await messageRows(parentId, staffId);
  if (!messages.length) return null;
  const [s] = await db.select({ name: staffUser.name, email: staffUser.email, contactEmail: staffUser.contactEmail }).from(staffUser).where(eq(staffUser.id, staffId));
  return s ? { name: s.name, email: shownContactEmail(s), messages } : null;
}

/**
 * A file for the parent file route: one a version of a message that isn't deleted lists (an earlier version's
 * included), and so posted, never one a staff member's form still holds. Null for anything else.
 */
export async function parentFile(id: unknown): Promise<{ type: MessageFileType; bytes: Uint8Array } | null> {
  if (!isUuid(id)) return null;
  const [f] = await db.select({ type: messageFile.type, bytes: messageFile.bytes }).from(messageFile)
    .innerJoin(messageVersionFile, eq(messageVersionFile.fileId, messageFile.id))
    .innerJoin(messageVersion, eq(messageVersion.id, messageVersionFile.versionId))
    .innerJoin(clubMessage, eq(clubMessage.id, messageVersion.messageId))
    .where(and(eq(messageFile.id, id), isNull(messageFile.heldBy), isNull(clubMessage.deletedAt), eq(messageFile.messageId, clubMessage.id)))
    .limit(1);
  return f ? { type: f.type, bytes: f.bytes } : null;
}
