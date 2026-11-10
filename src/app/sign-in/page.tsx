import { getClubSettings } from "@/lib/settings/club";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function ParentSignIn() {
  const club = await getClubSettings();
  return (
    <main className="wrap signin">
      <h1 className="page-title">{club.name}</h1>
      <p role="status">Parent sign-in isn&apos;t available yet.</p>
      <p className="lede"><a href="/staff/sign-in">Board and staff sign in here</a></p>
    </main>
  );
}
