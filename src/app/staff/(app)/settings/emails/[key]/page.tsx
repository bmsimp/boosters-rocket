import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { currentBrand } from "@/lib/mail/send";
import { emailVersion, emailVersions, testAddress } from "@/lib/mail/template-store";
import { defaultTemplate, emailByKey, sampleEmail, wordsFor } from "@/lib/email-templates/catalog";
import { Card, ConfirmDialog, LocalTime, Notice } from "@/app/components/ui";
import { SettingsHeader } from "../../back-to-settings";
import { defaultWordsAction } from "../actions";
import { EmailForm } from "./email-form";
import { EmailPreview } from "./email-preview";
import { UseVersionAgain } from "./use-version-again";

export const metadata = { title: "Email" };
export const dynamic = "force-dynamic";

/**
 * One email the portal sends (email templates, spec sections 2 to 5): its words in the editor with a live preview and
 * its fields, Save and Send me a test, its earlier versions (each read at `?version=N`, found among its own) and Use the
 * default words. Seen with the Club's read, read only without Settings.Emails.ReadWrite. An address that names no email
 * is notFound(). Not audited: no family's data.
 */
export default async function EmailPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Settings.Club.Read");
  const { key } = await params;
  const e = emailByKey(key);
  if (!e) notFound();
  const canChange = can(ctx.effective, "Settings.Emails.ReadWrite");
  const [versions, full, testTo] = await Promise.all([emailVersions(e.key), currentBrand(), canChange ? testAddress(ctx.staffUserId) : null]);
  const brand = { clubName: full.clubName, color: full.color, portal: full.portal, contact: full.contact ?? null };
  const current = wordsFor(e, full.templates?.[e.key]);
  const asked = ((await searchParams) ?? {}).version;
  // The newest version is the editor's, unless the club's words were set aside: then it is read here like any other.
  const shownRow = versions.find((v) => typeof asked === "string" && String(v.n) === asked && (v.n !== versions[0]?.n || !current.usable)) ?? null;
  const shownWords = shownRow ? await emailVersion(e.key, shownRow.n) : null;
  const shown = shownRow && shownWords ? wordsFor(e, shownWords) : null;
  const d = defaultTemplate(e);
  const isDefault = current.subject === d.subject && JSON.stringify(current.body) === JSON.stringify(d.body);

  return (
    <main className="wrap single email-page">
      <SettingsHeader effective={ctx.effective} title={e.title} lede={e.sentWhen} />
      <p className="page-back"><Link href="/staff/settings/emails">Back to Emails</Link></p>
      {!current.usable && (
        <Notice tone="warning">The club&apos;s words for this email no longer fit it after an update, so it goes with the default words. Save new words to use your own again.{versions[0] && <> <a href={`/staff/settings/emails/${e.key}?version=${versions[0].n}`}>Read the words that were set aside</a></>}</Notice>
      )}
      {shownRow && shown ? (
        <Card title={`Version ${shownRow.n}`} titleId="version-h"
          description={<>{shownRow.reset ? "The default words, saved" : "Saved"} by {shownRow.savedBy}, <LocalTime iso={shownRow.savedAt.toISOString()} dateOnly />. <a className="link-line" href={`/staff/settings/emails/${e.key}`}>Back to the current words</a></>}>
          {(() => { const m = sampleEmail(e, brand, testTo ?? "", shown); return <EmailPreview subject={m.subject} html={m.html} />; })()}
          {!shown.usable && <p className="hint">These words no longer fit this email, so they can&apos;t be used again.</p>}
          {canChange && shown.usable && <div className="row-actions"><UseVersionAgain emailKey={e.key} n={shownRow.n} /></div>}
        </Card>
      ) : (
        <EmailForm key={versions[0]?.n ?? 0} emailKey={e.key} initial={{ subject: current.subject, body: current.body }} brand={brand} testTo={testTo} canChange={canChange} />
      )}
      {(versions.length > 0 || (canChange && !isDefault)) && (
        <Card title="Earlier versions" titleId="earlier-h">
          {versions.length > 0 && (
            <ul className="version-list">
              {versions.map((v, i) => (
                <li key={v.n}>
                  {i === 0 && !shownRow && current.usable
                    ? <span aria-current="true">Version {v.n} (now): {v.savedBy}, <LocalTime iso={v.savedAt.toISOString()} dateOnly /></span>
                    : <a className="link-line" href={i === 0 ? `/staff/settings/emails/${e.key}` : `/staff/settings/emails/${e.key}?version=${v.n}`} aria-current={shownRow?.n === v.n ? "true" : undefined}>
                      Version {v.n}{i === 0 ? " (now)" : ""}: {v.savedBy}, <LocalTime iso={v.savedAt.toISOString()} dateOnly />{v.reset ? ", the default words" : ""}</a>}
                </li>
              ))}
            </ul>
          )}
          {canChange && !isDefault && (
            <div className="box-foot">
              <ConfirmDialog label="Use the default words" variant="outlined" consequence="The club's words for this email are replaced with the default. Earlier versions stay in this list."
                act={defaultWordsAction.bind(null, e.key)} />
            </div>
          )}
        </Card>
      )}
    </main>
  );
}
