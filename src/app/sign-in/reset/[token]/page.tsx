import { PasswordLinkPage } from "../../password-link-page";

// The token is in the address, so it must never be sent on as a referrer. The answer's own header says so
// (`Referrer-Policy: no-referrer`, next.config.ts), so even the head's first requests (styles, scripts, fonts, icons),
// which go before this tag lands (the root layout's metadata is async, so Next.js streams it into the body), carry no
// address; the tag says the same to anything the page links to.
export const metadata = { title: "Choose a new password", referrer: "no-referrer" as const };
// Each open looks the link up again (a link is spent, or runs out, between one open and the next), and is sent no-store.
export const dynamic = "force-dynamic";

/** A reset link: a person chooses a new password, which ends their sessions. No session; the link is the guard (../../password-link-page.tsx). */
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PasswordLinkPage purpose="reset" token={token} />;
}
