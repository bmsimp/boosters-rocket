import { certificateKeyForFile } from "@/lib/auth/certificates";
import { certificateDer } from "@/lib/auth/certificate-crypto";
import { downloadAccess, certificateForDownload } from "@/lib/setup/download-access";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const key = certificateKeyForFile(name);
  const access = key ? await downloadAccess() : null;
  if (!key || !access) return new Response("Not found", { status: 404 });
  const der = certificateDer((await certificateForDownload(key, access, { replace: new URL(req.url).searchParams.get("replace") === "1" })).certificatePem);
  return new Response(new Uint8Array(der), { headers: {
    "content-type": "application/pkix-cert", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store",
  } });
}
