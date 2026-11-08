"use client";
import Link from "next/link";

// Shown when a page fails to load. Nothing about the failure is shown: the same words whatever went wrong.
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="wrap signin">
      <h1 className="page-title">Something went wrong on our side</h1>
      <p className="lede">This page didn&apos;t load just now. Nothing you did caused it. Please try again in a moment.</p>
      <button type="button" className="btn" onClick={reset}>Try again</button>
      <p className="lede"><Link href="/">Back to the home page</Link></p>
    </main>
  );
}
