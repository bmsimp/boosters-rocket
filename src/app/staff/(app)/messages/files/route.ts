import { NextResponse } from "next/server";
import { env } from "@/env";
import { getStaffIdentity } from "@/lib/auth/identity";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { clientIpFrom } from "@/lib/request";
import { MESSAGE_FILE_MAX_BYTES } from "@/lib/messages/file-types";
import { keptName } from "@/lib/messages/files";
import { POST_PERMISSION, uploadFile } from "@/lib/messages/staff";
import { isUuid } from "@/lib/seasons/ids";

export const dynamic = "force-dynamic";

type Fail = { ok: false; errors: string[] };
const REFUSED = "That didn't go through. Please try again. If it keeps happening, sign out and back in.";
const NOT_FROM_PAGE = "That didn't go through. Reload the page and try again.";
const answer = (status: number, body: unknown) => NextResponse.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
const fail = (status: number, error: string) => answer(status, { ok: false, errors: [error] } satisfies Fail);
const tooBig = (name: string) => fail(413, `${name} is over 10 MB. Make it smaller, or share it another way.`);

/**
 * One file a message's form adds (spec section 7), here and not in a server action so that no action's body may be
 * larger than Next.js's 1 MB default (the before-sign-in actions among them). The body is the file's bytes alone; the
 * query string carries `name` (the file's name) and `message` (the message's id for an edit, absent for a new one).
 * How many files the staff member already holds is counted by uploadFile(), never taken from the browser.
 *
 * A route handler has no guard wrapper, so, first: the staff session and Messages.Post.ReadWrite, refused with the same
 * words whatever the reason (a refused permission audited `access.refused`, as staffAction does); then the request must
 * come from the portal's own pages (its Origin), as Next.js checks for an action. The size is refused before the body
 * is read: a Content-Length is required and must be at most 10 MB, and the bytes are counted as they arrive, so a body
 * longer than it said, or over the limit, is dropped unread. The file's checks, its hold and its audit row are
 * uploadFile()'s (src/lib/messages/staff.ts), as they were for the action. Answered as JSON, never cached.
 */
export async function POST(req: Request): Promise<Response> {
  const who = await getStaffIdentity();
  if (!who) return fail(403, REFUSED);
  const ip = clientIpFrom(req.headers);
  if (!can(await effectivePermissions(who.staffUserId), POST_PERMISSION)) {
    await writeAudit({ actor: { door: "staff", id: who.staffUserId, label: who.email }, action: "access.refused", permission: POST_PERMISSION, ip });
    return fail(403, REFUSED);
  }
  if (req.headers.get("origin") !== new URL(env.APP_URL).origin) return fail(403, REFUSED);

  const url = new URL(req.url);
  const rawName = url.searchParams.get("name"), message = url.searchParams.get("message");
  if (rawName === null || rawName.length > 1000 || (message !== null && !isUuid(message))) return fail(400, NOT_FROM_PAGE);
  const name = keptName(rawName);

  const length = Number(req.headers.get("content-length") ?? NaN);
  if (!Number.isSafeInteger(length) || length < 0) return fail(411, NOT_FROM_PAGE);
  if (length > MESSAGE_FILE_MAX_BYTES) return tooBig(name);
  const bytes = await readAtMost(req, length);
  if (bytes === "over") return tooBig(name);
  if (bytes === "short") return fail(400, NOT_FROM_PAGE);

  const r = await uploadFile({ staffUserId: who.staffUserId, actor: { door: "staff", id: who.staffUserId, label: who.email }, ip, messageId: message, name: rawName, bytes });
  return answer(r.ok ? 200 : 400, r);
}

/**
 * The body, read as it arrives and given up as soon as it passes `length` (itself at most the limit): "over" for more
 * than it said, "short" for fewer.
 */
async function readAtMost(req: Request, length: number): Promise<Uint8Array | "over" | "short"> {
  if (!req.body) return length === 0 ? new Uint8Array() : "short";
  const reader = req.body.getReader();
  const out = new Uint8Array(length);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.byteLength > length) { await reader.cancel().catch(() => undefined); return "over"; }
    out.set(value, got);
    got += value.byteLength;
  }
  return got === length ? out : "short";
}
