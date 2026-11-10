import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/env";
import { certificateDer } from "@/lib/auth/certificate-crypto";
import type { CertificateProviderKey } from "@/lib/auth/certificates";
import { downloadAccess, certificateForDownload } from "@/lib/setup/download-access";

export const dynamic = "force-dynamic";
const SCRIPTS = new Map<string, CertificateProviderKey>([
  ["New-BoosterRocketStaffApp.ps1", "staff-microsoft"],
]);

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const key = SCRIPTS.get(name);
  const access = key ? await downloadAccess() : null;
  if (!key || !access) return new Response("Not found", { status: 404 });
  const certificate = certificateDer((await certificateForDownload(key, access)).certificatePem).toString("base64");
  const text = (await readFile(path.join(process.cwd(), "scripts", "setup", name), "utf8"))
    .replaceAll("__BOOSTER_ROCKET_APP_URL__", env.APP_URL.replace(/\/+$/, ""))
    .replaceAll("__BOOSTER_ROCKET_CERTIFICATE__", certificate);
  return new Response(text, { headers: {
    "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store",
  } });
}
