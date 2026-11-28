import { desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { emailTemplateVersion } from "@/lib/db/schema";
import type { ClubTemplates } from "@/lib/email-templates/catalog";

/** The newest saved version of each email the club changed: what every send reads (currentBrand()). */
export async function clubTemplates(): Promise<ClubTemplates> {
  const rows = await db.selectDistinctOn([emailTemplateVersion.emailKey], { key: emailTemplateVersion.emailKey, subject: emailTemplateVersion.subject, body: emailTemplateVersion.body })
    .from(emailTemplateVersion).orderBy(emailTemplateVersion.emailKey, desc(emailTemplateVersion.n));
  return Object.fromEntries(rows.map((r) => [r.key, { subject: r.subject, body: r.body }]));
}

