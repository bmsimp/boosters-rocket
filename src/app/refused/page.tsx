export const metadata = { title: "Can't sign you in" };

export default function Refused() {
  return (
    <main className="wrap signin">
      <h1 className="page-title">We can&apos;t sign you in with that account</h1>
      <p className="lede">If you think you should have access, contact your booster club and ask them to check the email they have for you.</p>
      <p className="lede"><a href="/sign-in">Back to sign in</a></p>
    </main>
  );
}
