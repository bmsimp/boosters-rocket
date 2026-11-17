import { Notice } from "@/app/components/notice";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { providerSummaries, pendingOnlySummaries, PROVIDER_KEYS, type ProviderSummary } from "@/lib/auth/providers";
import { PROVIDER_LABELS } from "@/app/components/sign-in-settings/labels";
import { StateWords } from "@/app/components/state-words";
import { CalendarDate } from "@/app/components/calendar-date";
import { LocalTime } from "@/app/components/local-time";
import { MailWarning } from "../../mail-warning";
import { seesMailWarning } from "../../mail-warning-rule";
import { BackToSettings } from "../back-to-settings";

export const metadata = { title: "Sign-in settings" };
export const dynamic = "force-dynamic";

/** One way of signing in, in words: whether it works, and what to do next when it doesn't. */
function state(key: string, s: ProviderSummary | undefined): { state: "done" | "todo"; words: string } {
  if (!s) return { state: "todo", words: "Not set up" };
  if (!s.readable && s.pendingCertificate && !s.certificate) return { state: "todo", words: "Started: the certificate is made, and waits for its check" };
  if (!s.readable) return { state: "todo", words: "Saved, but this server can't read it, so nobody can sign in this way. Open the steps to fix it." };
  if (key === "staff-microsoft") return { state: "done", words: s.pendingCertificate ? "Working. A replacement certificate waits to be checked." : "Working. Microsoft accepted the certificate." };
  return { state: "done", words: "Working" };
}

/** What is set, shown plainly, with no inputs (the pattern the QuickBooks page set). The steps are on their own page. */
export default async function SignInSettingsPage() {
  const ctx = await requireStaffPage("Settings.SignIn.ReadWrite");
  const saved = await providerSummaries();
  const summaries = [...saved, ...(await pendingOnlySummaries(saved.map((x) => x.key)))];
  const working = saved.some((s) => s.readable);
  return (
    <main className="wrap single">
      <BackToSettings />
      <h1 className="page-title">Staff sign-in</h1>
      <p className="lede">How board members and directors sign in: with Microsoft, Google, or both. Only Admins can change this.</p>
      {seesMailWarning(ctx.effective) && <MailWarning canFix={can(ctx.effective, "Settings.Mail.ReadWrite")} />}
      {PROVIDER_KEYS.map((key) => {
        const s = summaries.find((x) => x.key === key);
        const st = state(key, s);
        const id = s?.config.clientId;
        return (
          <section key={key} className="box" aria-labelledby={`${key}-h`}><h2 id={`${key}-h`}>{PROVIDER_LABELS[key]}</h2>
            <StateWords state={st.state} words={st.words} />
            {s && (s.readable || s.certificate) && (
              <dl className="details">
                {s.config.tenantId && <><dt>Directory (tenant) ID</dt><dd><code>{s.config.tenantId}</code></dd></>}
                {id && <><dt>{key === "staff-google" ? "Client ID" : "Application (client) ID"}</dt><dd><code>{id}</code></dd></>}
                {s.certificate && <><dt>Certificate</dt><dd>Thumbprint <code>{s.certificate.thumbprintSha1}</code>, expires <CalendarDate iso={s.certificate.notAfter.toISOString()} /></dd></>}
                {key === "staff-google" && <><dt>Client secret</dt><dd>Saved <LocalTime iso={s.credentialUpdatedAt.toISOString()} />{s.expiresAt && <>, expires <CalendarDate iso={s.expiresAt.toISOString()} /></>}</dd></>}
              </dl>
            )}
            <p className="settings-open"><a className="btn btn-line" href="/staff/settings/sign-in/setup">{s ? "Change" : "Set up"}<span className="visually-hidden"> {PROVIDER_LABELS[key]}</span></a></p>
          </section>
        );
      })}
      {!working && <Notice tone="warning">Nobody can sign in as staff until one of these works.</Notice>}
    </main>
  );
}
