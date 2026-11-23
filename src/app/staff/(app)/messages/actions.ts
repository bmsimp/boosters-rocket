"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { editMessage, postMessage, removeHeldFile } from "@/lib/messages/staff";
import { isUuid } from "@/lib/seasons/ids";

type Fail = { ok: false; errors: string[] };
const NOT_FROM_PAGE: Fail = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The form's save: a title, the editor's document and the ids of the files the form lists, in order. Whose message
 * comes from the session alone; staff.ts checks every value again, whatever the browser sent.
 */
type Draft = { title: unknown; body: unknown; files: unknown };
const draftOf = (v: unknown): Draft | null => (isObject(v) ? { title: v.title, body: v.body, files: v.files } : null);

/** Posts a message to every family. */
export const postMessageAction = staffAction("Messages.Post.ReadWrite", async (ctx, input: unknown): Promise<{ ok: true; message: string; id: string } | Fail> => {
  const draft = draftOf(input);
  if (!draft) return NOT_FROM_PAGE;
  const r = await postMessage({ staffUserId: ctx.staffUserId, actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, ...draft });
  if (r.ok) revalidatePath("/staff/messages");
  return r;
});

/** Saves an edit of the session's own message as its next version; anyone else's is refused. */
export const editMessageAction = staffAction("Messages.Post.ReadWrite", async (ctx, messageId: unknown, input: unknown): Promise<{ ok: true; message: string } | Fail> => {
  const draft = draftOf(input);
  if (!draft || !isUuid(messageId)) return NOT_FROM_PAGE;
  const r = await editMessage({ staffUserId: ctx.staffUserId, actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, messageId, ...draft });
  if (!r.ok) return r;
  revalidatePath("/staff/messages");
  revalidatePath(`/staff/messages/${messageId}`);
  return { ok: true, message: r.message };
});

/** Removes a file the form holds and hasn't saved: the session's own, never one a version lists. */
export const removeHeldFileAction = staffAction("Messages.Post.ReadWrite", async (ctx, fileId: unknown): Promise<{ ok: true; message: string } | Fail> =>
  removeHeldFile({ staffUserId: ctx.staffUserId, actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, fileId }));
