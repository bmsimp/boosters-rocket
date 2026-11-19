import { PasswordLinkPage } from "../../password-link-page";

// The token is in the address, so the page asks the browser not to send it on as a referrer to anything it links to.
export const metadata = { title: "Choose a password", referrer: "no-referrer" as const };
// Each open looks the link up again (a link is spent, or runs out, between one open and the next), and is sent no-store.
export const dynamic = "force-dynamic";

/** A set-up link: a person with no password yet chooses one. No session; the link is the guard (../../password-link-page.tsx). */
export default async function SetUpPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PasswordLinkPage purpose="setup" token={token} />;
}
