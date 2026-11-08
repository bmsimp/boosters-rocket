"use client";
import "./booster.css";

// Replaces the root layout when that layout itself fails (for example, the database is unreachable),
// so it brings its own <html> and <body> and reads nothing from the server.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="wrap signin">
          <h1 className="page-title">The portal is taking a break</h1>
          <p className="lede">It couldn&apos;t load just now. Nothing you did caused it. Please try again in a few minutes.</p>
          <button type="button" className="btn" onClick={reset}>Try again</button>
        </main>
      </body>
    </html>
  );
}
