import Link from "next/link";

export const metadata = { title: "Not ready yet" };

// Also covers the parent tabs (Forms, Payments, Family) until those pages are built.
export default function NotFound() {
  return (
    <main className="wrap signin">
      <h1 className="page-title">This part of the portal isn&apos;t ready yet</h1>
      <p className="lede">We&apos;re still building some pages, and this is one of them. It may also have moved. Everything else is still where you left it.</p>
      <p className="lede"><Link href="/">Back to the home page</Link></p>
    </main>
  );
}
