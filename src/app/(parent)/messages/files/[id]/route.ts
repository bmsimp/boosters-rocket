import { parentLayoutCtx } from "@/lib/guards";
import { fixedFileName, isPicture, MESSAGE_FILE_MIME } from "@/lib/messages/file-types";
import { parentFile } from "@/lib/messages/parent";

export const dynamic = "force-dynamic";

/** The one answer for anything a parent may not have: the same words and status whatever the reason. */
const NOT_HERE = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });

/**
 * A picture or file of a club message, for a parent (spec section 7). A route handler has no page guard, so the parent
 * session is checked here, first (parentLayoutCtx(): a signed-in parent with a family chosen); without one, a staff
 * session among them, the answer is the same 404 as for a file that isn't there, with no bytes. Only a file a version
 * of a message that isn't deleted lists, an earlier version's included, is sent (parentFile()); a file a staff member's
 * form still holds, one of a deleted message, an unknown id and anything that isn't a uuid all get that 404. The type
 * is the one read from the bytes when the file was kept, pictures inline and everything else as `attachment.<ext>`, so
 * nothing staff typed reaches a header. Never cached. Not audited: a message's files are the same for every family.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await parentLayoutCtx();
  if (!ctx) return NOT_HERE();
  const { id } = await params;
  const found = await parentFile(id);
  if (!found) return NOT_HERE();
  return new Response(new Uint8Array(found.bytes), { status: 200, headers: {
    "content-type": MESSAGE_FILE_MIME[found.type],
    "content-disposition": `${isPicture(found.type) ? "inline" : "attachment"}; filename="${fixedFileName(found.type)}"`,
    "content-length": String(found.bytes.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  } });
}
