/**
 * An email as a family gets it, with sample values (email templates, spec section 3): its subject, then its HTML in a
 * frame that runs nothing and loads nothing (`sandbox` with no permission; the mail loads nothing anyway), drawn on its
 * own light canvas as a mail program draws it. Every piece of text in the HTML was escaped when it was drawn
 * (src/lib/email-templates/body.ts): nothing here is written into the page.
 */
export function EmailPreview({ subject, html }: { subject: string; html: string }) {
  return (
    <div className="email-preview">
      <p className="email-preview-subject"><b>Subject:</b> {subject}</p>
      <iframe title="The email, with sample values" sandbox="" srcDoc={html} />
    </div>
  );
}
