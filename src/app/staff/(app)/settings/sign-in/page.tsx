import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { providerSummaries, pendingOnlySummaries, PROVIDER_KEYS, type ProviderSummary } from "@/lib/auth/providers";
import { PROVIDER_LABELS } from "@/app/components/sign-in-settings/labels";
import { CalendarDate, Card, KeyValue, LinkButton, LocalTime, Notice, StateWords } from "@/app/components/ui";
import { MailWarning } from "../../mail-warning";
import { seesMailWarning } from "../../mail-warning-rule";
import { IntegrationHead } from "../integration-head";
import { signInRows, systemStatus } from "../statuses";

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

/**
 * Staff sign-in, an integration's page (the Settings spec): its head with the status, then one card for each provider
 * (Microsoft, Google: the spec's decision 7), each with what is set, its credential's expiry (staff sign-in has no
 * Health line, so the expiry is said here), and the change. Each card is an anchor the Integrations page's rows lead
 * to (`#staff-microsoft`, `#staff-google`). Removing a provider is on the steps' page, as it is today.
 */
export default async function SignInSettingsPage() {
  const ctx = await requireStaffPage("Settings.SignIn.ReadWrite");
  const [saved, rows] = await Promise.all([providerSummaries(), signInRows()]);
  const summaries = [...saved, ...(await pendingOnlySummaries(saved.map((x) => x.key)))];
  const working = saved.some((s) => s.readable);
  return (
    <main className="wrap single">
      <IntegrationHead title="Staff sign-in" status={systemStatus(rows)}
        lede="How board members and directors sign in: with Microsoft, Google, or both. Only Admins can change this." />
      {seesMailWarning(ctx.effective) && <MailWarning canFix={can(ctx.effective, "Settings.Mail.ReadWrite")} />}
      <div className="settings-columns">
      {PROVIDER_KEYS.map((key) => {
        const s = summaries.find((x) => x.key === key);
        const st = state(key, s);
        const row = rows.find((r) => r.key === key);
        const id = s?.config.clientId;
        return (
          <Card key={key} id={key} title={PROVIDER_LABELS[key]} titleId={`${key}-h`}>
            <StateWords state={st.state} words={st.words} />
            {row?.expires && <Notice tone="warning" live="none">{row.expires.what} <CalendarDate iso={row.expires.iso} />{row.status.words === "Expired" ? ": staff can't sign in with it." : "."}</Notice>}
            {s && (s.readable || s.certificate) && (
              <KeyValue items={[
                s.config.tenantId ? { key: "tenant", label: "Directory (tenant) ID", value: <code>{s.config.tenantId}</code> } : null,
                id ? { key: "client", label: key === "staff-google" ? "Client ID" : "Application (client) ID", value: <code>{id}</code> } : null,
                s.certificate ? { key: "cert", label: "Certificate", value: <>Thumbprint <code>{s.certificate.thumbprintSha1}</code>, expires <CalendarDate iso={s.certificate.notAfter.toISOString()} /></> } : null,
                key === "staff-google" ? { key: "secret", label: "Client secret", value: <>Saved <LocalTime iso={s.credentialUpdatedAt.toISOString()} />{s.expiresAt && <>, expires <CalendarDate iso={s.expiresAt.toISOString()} /></>}</> } : null,
              ]} />
            )}
            <p className="settings-open"><LinkButton href="/staff/settings/sign-in/setup" variant="outlined">Configure<span className="visually-hidden"> {PROVIDER_LABELS[key]}</span></LinkButton></p>
          </Card>
        );
      })}
      </div>
      {!working && <Notice tone="warning">Nobody can sign in as staff until one of these works.</Notice>}
    </main>
  );
}
