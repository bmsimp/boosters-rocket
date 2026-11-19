import { PasswordLinkPage } from "../../password-link-page";

// The token is in the address, so the page asks the browser not to send it on as a referrer to anything it links to.
// The root layout's metadata is async, so Next.js streams this tag into the body: the head's own requests (styles,
// scripts, fonts, icons) go before it lands, all to this site, which may log the address with the token. The site's
// header (strict-origin-when-cross-origin, next.config.ts) already keeps the path from every other site.
export const metadata = { title: "Choose a new password", referrer: "no-referrer" as const };
// Each open looks the link up again (a link is spent, or runs out, between one open and the next), and is sent no-store.
export const dynamic = "force-dynamic";

/** A reset link: a person chooses a new password, which ends their sessions. No session; the link is the guard (../../password-link-page.tsx). */
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PasswordLinkPage purpose="reset" token={token} />;
}
