import { HowThisWorks } from "@/app/components/ui";
import { QUICKBOOKS_USE } from "@/lib/quickbooks/what-it-does";

/**
 * What the portal does with QuickBooks (`QUICKBOOKS_USE`), on the QuickBooks settings page and in setup's step 2: its
 * two sentences of summary in the open, then every detail folded under "What the portal does with QuickBooks", in
 * short groups with a heading each. Headings are h3: both places draw it inside a card with an h2.
 */
export function QuickBooksUse() {
  return (
    <>
      <p>{QUICKBOOKS_USE.summary}</p>
      <HowThisWorks summary="What the portal does with QuickBooks">
        {QUICKBOOKS_USE.groups.map((g) => (
          <section key={g.key} aria-labelledby={`qbo-use-${g.key}-h`}>
            <h3 id={`qbo-use-${g.key}-h`}>{g.heading}</h3>
            <ul>{g.items.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
        ))}
      </HowThisWorks>
    </>
  );
}
