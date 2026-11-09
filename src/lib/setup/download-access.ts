import "server-only";
import { hasSetupSession } from "./session";
import { getStaffIdentity } from "@/lib/auth/identity";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { certificateRows, getOrCreatePendingCertificate, type CertificateProviderKey, type CertificateRow } from "@/lib/auth/certificates";
import { requestIp } from "@/lib/request";
import type { Actor } from "@/lib/audit/log";

export type DownloadAccess = { actor: Actor; createdBy: string | null; permission?: string; ip: string | null };

/** Setup (unlocked) or an Admin with Settings.SignIn.ReadWrite may download certificates and scripts. */
export async function downloadAccess(): Promise<DownloadAccess | null> {
  const ip = await requestIp();
  if (await hasSetupSession()) return { actor: { door: "system", id: null, label: "setup" }, createdBy: null, ip };
  const id = await getStaffIdentity();
  if (!id || !can(await effectivePermissions(id.staffUserId), "Settings.SignIn.ReadWrite")) return null;
  return { actor: { door: "staff", id: id.staffUserId, label: id.email }, createdBy: id.staffUserId, permission: "Settings.SignIn.ReadWrite", ip };
}

/**
 * The certificate to put on the app: pending if a replacement is under way, else active, else a new pending one.
 * With `replace` (staff with Settings.SignIn.ReadWrite only) an active certificate with nothing pending gets a new pending one.
 */
export async function certificateForDownload(key: CertificateProviderKey, a: DownloadAccess, opts: { replace?: boolean } = {}): Promise<CertificateRow> {
  const { pending, active } = await certificateRows(key);
  const make = () => getOrCreatePendingCertificate(key, { actor: a.actor, ip: a.ip, createdBy: a.createdBy, permission: a.permission });
  if (opts.replace && a.permission && active && !pending) return make();
  return pending ?? active ?? make();
}
