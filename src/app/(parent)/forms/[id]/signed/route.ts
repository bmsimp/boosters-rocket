import { requireParentPage } from "@/lib/guards";
import { findMySignedPdf } from "@/lib/forms/my-evidence";

export const dynamic = "force-dynamic";

/** The one answer for anything that isn't the family's own signed form: the same words and status whatever the reason. */
const NOT_HERE = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });

/**
 * A parent downloads their own family's signed form (v1 spec §9.2 step 6). A route handler has no page guard, so the
 * parent session is checked here, first, as a parent page checks it: someone signed out is sent to sign in and brought
 * back, and someone refused is sent where the pages send them. The id in the address is untrusted: it is looked up
 * within the session's family (findMySignedPdf), and an id that isn't a uuid, is nobody's, is another family's, or is
 * a form with no kept evidence all get the same 404 and no bytes. The file name is fixed: no QuickBooks text goes into
 * a header. Never cached.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const ctx = await requireParentPage(`/forms/${id}/signed`);
  const pdf = await findMySignedPdf(ctx, id, new URL(req.url).searchParams.get("part") ?? 1);
  if (!pdf) return NOT_HERE();
  return new Response(new Uint8Array(pdf), { status: 200, headers: {
    "content-type": "application/pdf",
    "content-disposition": 'attachment; filename="signed-form.pdf"',
    "content-length": String(pdf.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  } });
}
