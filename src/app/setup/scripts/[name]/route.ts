import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/env";
import { hasSetupSession } from "@/lib/setup/session";
import { getStaffIdentity } from "@/lib/auth/identity";
import { effectivePermissions, can } from "@/lib/permissions/effective";

export const dynamic = "force-dynamic";
const SCRIPTS = new Set(["New-BoosterRocketStaffApp.ps1", "New-BoosterRocketParentApp.ps1"]);

async function allowed(): Promise<boolean> {
  if (await hasSetupSession()) return true;
  const id = await getStaffIdentity();
  return id ? can(await effectivePermissions(id.staffUserId), "Settings.SignIn.ReadWrite") : false;
}

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!SCRIPTS.has(name) || !(await allowed())) return new Response("Not found", { status: 404 });
  const text = (await readFile(path.join(process.cwd(), "scripts", "setup", name), "utf8"))
    .replaceAll("__BOOSTER_ROCKET_APP_URL__", env.APP_URL.replace(/\/+$/, ""));
  return new Response(text, { headers: {
    "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store",
  } });
}
