import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Tx } from "@/lib/db/client";
import { clubMessage, family, messageFile, messageVersion, messageVersionFile, staffUser } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { isUuid } from "@/lib/seasons/ids";
import { checkBody, storedBody, type MessageBody } from "./body";
import { isPicture, MESSAGE_FILES_MAX, type MessageFileType } from "./file-types";
import { checkUpload } from "./files";

/**
 * Club messages for staff (spec sections 4, 7 and 9): the list, one message with its versions, a post, an edit that
 * adds a version, and the files a form holds before it saves. Staff only (STAFF_ONLY_IMPORTS in
 * tests/integration/page-guards.test.ts): a held file is another staff member's draft, and slice 4 reads every parent's
 * address here. Every write is audited in its own transaction, and no audit row holds a title, a body or a file's name:
 * an Admin's delete erases those, and the audit log keeps what it is given.
 */
export const POST_PERMISSION = "Messages.Post.ReadWrite" as const;
export const TITLE_MAX = 120;

type Fail = { ok: false; errors: string[] };
type Who = { staffUserId: string; actor: Actor; ip: string | null };

const NOT_FROM_PAGE: Fail = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const FILE_GONE: Fail = { ok: false, errors: ["One of the files is no longer here: a file not posted within a day is removed. Add it again, then save."] };
const TOO_MANY: Fail = { ok: false, errors: [`A message can hold at most ${MESSAGE_FILES_MAX} files, its pictures included. Remove one to add another.`] };
const NOT_POSTER: Fail = { ok: false, errors: ["Only the person who posted a message can edit it."] };
const DELETED: Fail = { ok: false, errors: ["This message was deleted, so it can't be changed."] };

export type StaffFile = { id: string; name: string; type: MessageFileType; size: number; picture: boolean };
export type StaffVersion = { id: string; n: number; title: string; body: MessageBody; savedAt: Date; files: StaffFile[] };
export type StaffMessage = {
  id: string; postedBy: { id: string; name: string }; postedAt: Date;
  deleted: { at: Date; by: string | null } | null;
  /** Newest first: the first is the current version. Empty for a deleted message, whose content is gone. */
  versions: StaffVersion[];
};
export type StaffMessageRow = {
  id: string; title: string | null; poster: string; postedAt: Date; versions: number; editedAt: Date | null;
  deleted: { at: Date; by: string | null } | null;
};

const fileOf = (f: { id: string; name: string; type: MessageFileType; size: number }): StaffFile =>
  ({ id: f.id, name: f.name, type: f.type, size: f.size, picture: isPicture(f.type) });

/** Every message, newest first, with its current title, poster and whether it was edited or deleted. */
export async function listMessages(): Promise<StaffMessageRow[]> {
  const deleter = alias(staffUser, "deleter");
  const rows = await db.select({ id: clubMessage.id, postedAt: clubMessage.postedAt, poster: staffUser.name, deletedAt: clubMessage.deletedAt, deletedBy: deleter.name })
    .from(clubMessage).innerJoin(staffUser, eq(staffUser.id, clubMessage.postedBy)).leftJoin(deleter, eq(deleter.id, clubMessage.deletedBy));
  const versions = await db.select({ messageId: messageVersion.messageId, n: messageVersion.n, title: messageVersion.title, savedAt: messageVersion.savedAt })
    .from(messageVersion).orderBy(asc(messageVersion.n));
  const byMessage = new Map<string, typeof versions>();
  for (const v of versions) byMessage.set(v.messageId, [...(byMessage.get(v.messageId) ?? []), v]);
  return rows.map((r) => {
    const vs = byMessage.get(r.id) ?? [], last = vs.at(-1);
    return {
      id: r.id, title: r.deletedAt ? null : last?.title ?? null, poster: r.poster, postedAt: r.postedAt, versions: vs.length,
      editedAt: vs.length > 1 ? last!.savedAt : null,
      deleted: r.deletedAt ? { at: r.deletedAt, by: r.deletedBy } : null,
    };
  }).sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime() || (a.id < b.id ? 1 : -1));
}

/** The files each version lists, in order. */
async function filesOfVersions(ids: string[], tx: Tx | typeof db = db): Promise<Map<string, StaffFile[]>> {
  const out = new Map<string, StaffFile[]>();
  if (!ids.length) return out;
  const rows = await tx.select({ versionId: messageVersionFile.versionId, id: messageFile.id, name: messageFile.name, type: messageFile.type, size: messageFile.size })
    .from(messageVersionFile).innerJoin(messageFile, eq(messageFile.id, messageVersionFile.fileId))
    .where(inArray(messageVersionFile.versionId, ids)).orderBy(asc(messageVersionFile.position));
  for (const r of rows) out.set(r.versionId, [...(out.get(r.versionId) ?? []), fileOf(r)]);
  return out;
}

/** One message with every version, newest first, or null for an id that isn't one. */
export async function staffMessage(id: unknown): Promise<StaffMessage | null> {
  if (!isUuid(id)) return null;
  const deleter = alias(staffUser, "deleter");
  const [m] = await db.select({ id: clubMessage.id, postedAt: clubMessage.postedAt, posterId: staffUser.id, poster: staffUser.name, deletedAt: clubMessage.deletedAt, deletedBy: deleter.name })
    .from(clubMessage).innerJoin(staffUser, eq(staffUser.id, clubMessage.postedBy)).leftJoin(deleter, eq(deleter.id, clubMessage.deletedBy))
    .where(eq(clubMessage.id, id));
  if (!m) return null;
  const versions = m.deletedAt ? [] : await db.select().from(messageVersion).where(eq(messageVersion.messageId, id)).orderBy(asc(messageVersion.n));
  const files = await filesOfVersions(versions.map((v) => v.id));
  return {
    id: m.id, postedBy: { id: m.posterId, name: m.poster }, postedAt: m.postedAt,
    deleted: m.deletedAt ? { at: m.deletedAt, by: m.deletedBy } : null,
    versions: versions.reverse().map((v) => {
      const fs = files.get(v.id) ?? [];
      return { id: v.id, n: v.n, title: v.title, savedAt: v.savedAt, files: fs, body: storedBody(v.body, fs.filter((f) => f.picture).map((f) => f.id)) };
    }),
  };
}

/** How many families a message goes to: every active family in the club. */
export async function familiesReached(): Promise<number> {
  const [r] = await db.select({ n: count() }).from(family).where(eq(family.active, true));
  return r?.n ?? 0;
}

/**
 * A file for the staff file route: a posted file of a message that isn't deleted, for anyone who may see messages, or
 * a held one for the staff member whose form holds it alone. Null for anything else.
 */
export async function staffFile(id: unknown, staffUserId: string): Promise<{ type: MessageFileType; bytes: Uint8Array } | null> {
  if (!isUuid(id)) return null;
  const [f] = await db.select({ type: messageFile.type, bytes: messageFile.bytes, heldBy: messageFile.heldBy, messageId: messageFile.messageId, deletedAt: clubMessage.deletedAt })
    .from(messageFile).leftJoin(clubMessage, eq(clubMessage.id, messageFile.messageId)).where(eq(messageFile.id, id));
  if (!f || f.deletedAt) return null;
  if (f.heldBy !== null ? f.heldBy !== staffUserId : f.messageId === null) return null;
  return { type: f.type, bytes: f.bytes };
}

// --- writes ----------------------------------------------------------------------------------------------------

/** A title as it is kept: trimmed, control characters gone, 1 to 120 characters; or why it can't be. */
export function checkTitle(raw: unknown): { ok: true; title: string } | Fail {
  if (typeof raw !== "string" || raw.length > 2000) return NOT_FROM_PAGE;
  const title = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return { ok: false, errors: ["Give the message a title."] };
  if ([...title].length > TITLE_MAX) return { ok: false, errors: [`A title can be at most ${TITLE_MAX} characters.`] };
  return { ok: true, title };
}

/** The files a form lists: distinct ids, at most MESSAGE_FILES_MAX. */
function checkFileList(raw: unknown): { ok: true; ids: string[] } | Fail {
  if (!Array.isArray(raw) || raw.length > 100 || !raw.every(isUuid)) return NOT_FROM_PAGE;
  const ids = [...new Set(raw as string[])];
  return ids.length > MESSAGE_FILES_MAX ? TOO_MANY : { ok: true, ids };
}

/** The poster's message, locked, for an edit or a file held for one: null with why when it can't be. */
async function ownMessage(tx: Tx, messageId: string, staffUserId: string): Promise<{ ok: true } | Fail> {
  const [m] = await tx.select({ postedBy: clubMessage.postedBy, deletedAt: clubMessage.deletedAt }).from(clubMessage).where(eq(clubMessage.id, messageId)).for("update");
  if (!m) return NOT_FROM_PAGE;
  if (m.deletedAt) return DELETED;
  if (m.postedBy !== staffUserId) return NOT_POSTER;
  return { ok: true };
}

/** The current (highest) version of a message, with its files. */
async function currentVersion(tx: Tx, messageId: string) {
  const [cur] = await tx.select().from(messageVersion).where(eq(messageVersion.messageId, messageId)).orderBy(desc(messageVersion.n)).limit(1);
  if (!cur) throw new Error(`message ${messageId} has no version`);
  const files = (await filesOfVersions([cur.id], tx)).get(cur.id) ?? [];
  return { ...cur, files };
}

/**
 * Keeps an uploaded file, held against the staff member until their post or edit saves it (spec section 7): at most
 * 10 MB, of an allowed type by its bytes, and only while the form lists fewer than MESSAGE_FILES_MAX files. For an edit
 * (`messageId`), only the message's poster may upload, to a message that isn't deleted. Audited `message.file.upload`
 * with its type and size, never its name.
 */
export async function uploadFile(o: Who & { messageId: string | null; name: string; bytes: Uint8Array; listed: unknown }):
  Promise<{ ok: true; message: string; file: StaffFile } | Fail> {
  const list = checkFileList(Array.isArray(o.listed) ? o.listed.slice(0, 100) : o.listed);
  if (!list.ok) return list;
  const checked = checkUpload(o.name, o.bytes);
  if (!checked.ok) return { ok: false, errors: [checked.error] };
  return db.transaction(async (tx) => {
    let current: string[] = [];
    if (o.messageId !== null) {
      const own = await ownMessage(tx, o.messageId, o.staffUserId);
      if (!own.ok) return own;
      current = (await currentVersion(tx, o.messageId)).files.map((f) => f.id);
    }
    // The files the form lists that are truly its own: held by this person for this message, or in its current version.
    const held = list.ids.length ? await tx.select({ id: messageFile.id }).from(messageFile).where(and(inArray(messageFile.id, list.ids),
      eq(messageFile.heldBy, o.staffUserId), o.messageId === null ? isNull(messageFile.messageId) : eq(messageFile.messageId, o.messageId))) : [];
    const listed = new Set([...held.map((f) => f.id), ...current.filter((id) => list.ids.includes(id))]);
    if (listed.size >= MESSAGE_FILES_MAX) return TOO_MANY;
    const [f] = await tx.insert(messageFile).values({ messageId: o.messageId, heldBy: o.staffUserId, name: checked.name, type: checked.type, size: o.bytes.byteLength, bytes: Buffer.from(o.bytes) })
      .returning({ id: messageFile.id, name: messageFile.name, type: messageFile.type, size: messageFile.size });
    await writeAudit({ actor: o.actor, action: "message.file.upload", permission: POST_PERMISSION, targetType: "message_file", targetId: f!.id,
      after: { type: checked.type, size: o.bytes.byteLength, messageId: o.messageId }, ip: o.ip }, tx);
    return { ok: true as const, message: `Added ${checked.name}.`, file: fileOf(f!) };
  });
}

/**
 * Removes a file the staff member's form holds and no version lists (they took it out before saving), audited
 * `message.file.remove`. A file that isn't theirs, or is posted, is left as it is: a posted file stays with the versions
 * that have it, and an edit simply leaves it out of the next one.
 */
export async function removeHeldFile(o: Who & { fileId: unknown }): Promise<{ ok: true; message: string } | Fail> {
  if (!isUuid(o.fileId)) return NOT_FROM_PAGE;
  const fileId = o.fileId;
  return db.transaction(async (tx) => {
    const [f] = await tx.select({ id: messageFile.id, messageId: messageFile.messageId, type: messageFile.type, size: messageFile.size }).from(messageFile)
      .where(and(eq(messageFile.id, fileId), eq(messageFile.heldBy, o.staffUserId))).for("update");
    const listed = f ? await tx.select({ id: messageVersionFile.id }).from(messageVersionFile).where(eq(messageVersionFile.fileId, fileId)).limit(1) : [];
    if (f && listed.length === 0) {
      await tx.delete(messageFile).where(eq(messageFile.id, fileId));
      await writeAudit({ actor: o.actor, action: "message.file.remove", permission: POST_PERMISSION, targetType: "message_file", targetId: fileId,
        before: { type: f.type, size: f.size, messageId: f.messageId }, ip: o.ip }, tx);
    }
    return { ok: true as const, message: "Removed." };
  });
}

/** Key order doesn't count: jsonb keeps its own. */
const canonical = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));

/** Saves a version's files: clears the hold on those still held and lists them all, in the form's order. */
async function saveFiles(tx: Tx, versionId: string, messageId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await tx.update(messageFile).set({ heldBy: null, messageId }).where(inArray(messageFile.id, ids));
  await tx.insert(messageVersionFile).values(ids.map((fileId, position) => ({ versionId, fileId, position })));
}

/**
 * Posts a message to every family (spec section 4): version 1 with its title, its body as checkBody() rebuilt it, and
 * the files the form holds, each held by the poster for a new message. Audited `message.post` with its version and
 * how many files, never its title. (Slice 4 adds its email.)
 */
export async function postMessage(o: Who & { title: unknown; body: unknown; files: unknown }): Promise<{ ok: true; message: string; id: string } | Fail> {
  const title = checkTitle(o.title);
  if (!title.ok) return title;
  const list = checkFileList(o.files);
  if (!list.ok) return list;
  return db.transaction(async (tx) => {
    const files = list.ids.length ? await tx.select({ id: messageFile.id, type: messageFile.type }).from(messageFile)
      .where(and(inArray(messageFile.id, list.ids), eq(messageFile.heldBy, o.staffUserId), isNull(messageFile.messageId))).for("update") : [];
    if (files.length !== list.ids.length) return FILE_GONE;
    const body = checkBody(o.body, new Set(files.filter((f) => isPicture(f.type)).map((f) => f.id)));
    if (!body.ok) return { ok: false as const, errors: [body.error] };
    const [m] = await tx.insert(clubMessage).values({ postedBy: o.staffUserId }).returning({ id: clubMessage.id });
    const [v] = await tx.insert(messageVersion).values({ messageId: m!.id, n: 1, title: title.title, body: body.body, emailed: false }).returning({ id: messageVersion.id });
    await saveFiles(tx, v!.id, m!.id, list.ids);
    await writeAudit({ actor: o.actor, action: "message.post", permission: POST_PERMISSION, targetType: "message", targetId: m!.id,
      after: { version: 1, files: list.ids.length, emailed: false }, ip: o.ip }, tx);
    return { ok: true as const, message: "Posted. Every family can read it in the portal.", id: m!.id };
  });
}

/**
 * Saves an edit as the next version (spec section 9): only the message's poster, checked against the session's staff
 * member whatever their permissions (an Admin's edit of someone else's message is refused and audited
 * `access.refused`). The files may be those of the current version and those the poster holds for this message. A
 * version is never changed: the earlier ones stay as they were. Audited `message.edit` with the version number and
 * whether it was emailed, never its title.
 */
export async function editMessage(o: Who & { messageId: unknown; title: unknown; body: unknown; files: unknown }): Promise<{ ok: true; message: string; n: number } | Fail> {
  if (!isUuid(o.messageId)) return NOT_FROM_PAGE;
  const messageId = o.messageId;
  const title = checkTitle(o.title);
  if (!title.ok) return title;
  const list = checkFileList(o.files);
  if (!list.ok) return list;
  return db.transaction(async (tx) => {
    const own = await ownMessage(tx, messageId, o.staffUserId);
    if (!own.ok) {
      if (own === NOT_POSTER) {
        await writeAudit({ actor: o.actor, action: "access.refused", permission: POST_PERMISSION, targetType: "message", targetId: messageId,
          after: { reason: "not_poster" }, ip: o.ip }, tx);
      }
      return own;
    }
    const cur = await currentVersion(tx, messageId);
    const held = list.ids.length ? await tx.select({ id: messageFile.id, type: messageFile.type }).from(messageFile)
      .where(and(inArray(messageFile.id, list.ids), eq(messageFile.heldBy, o.staffUserId), eq(messageFile.messageId, messageId))).for("update") : [];
    const allowed = new Map<string, MessageFileType>([...cur.files.map((f) => [f.id, f.type] as const), ...held.map((f) => [f.id, f.type] as const)]);
    if (!list.ids.every((id) => allowed.has(id))) return FILE_GONE;
    const body = checkBody(o.body, new Set(list.ids.filter((id) => isPicture(allowed.get(id)!))));
    if (!body.ok) return { ok: false as const, errors: [body.error] };
    if (title.title === cur.title && canonical(body.body) === canonical(cur.body) && list.ids.join() === cur.files.map((f) => f.id).join()) {
      return { ok: false as const, errors: ["Nothing has changed since the last version, so nothing was saved."] };
    }
    const n = cur.n + 1;
    const [v] = await tx.insert(messageVersion).values({ messageId, n, title: title.title, body: body.body, emailed: false }).returning({ id: messageVersion.id });
    await saveFiles(tx, v!.id, messageId, list.ids);
    await writeAudit({ actor: o.actor, action: "message.edit", permission: POST_PERMISSION, targetType: "message", targetId: messageId,
      after: { version: n, files: list.ids.length, emailed: false }, ip: o.ip }, tx);
    return { ok: true as const, message: "Saved. Families now see this version, and can still open the earlier ones.", n };
  });
}
