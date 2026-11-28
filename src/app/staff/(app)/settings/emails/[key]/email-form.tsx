"use client";
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ActionOutcome, Button, Card, KeyValue, Notice, TextInput } from "@/app/components/ui";
import { RichTextEditor, type EmailEditing } from "@/app/components/rich-text-editor";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import type { Brand } from "@/lib/email-templates/frame";
import { checkTemplate, type TemplateDoc } from "@/lib/email-templates/body";
import { emailByKey, rulesOf, sampleEmail, sampleValues } from "@/lib/email-templates/catalog";
import { saveEmailAction, testEmailAction } from "../actions";
import { EmailPreview } from "./email-preview";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed = { ok: false as const, errors: [ACTION_FAILED] };

/**
 * One email's words, its live preview and its fields (email templates, spec sections 2 and 3). Given only what it shows:
 * the email's key, the words it opens on, the club's name, color, portal address and contact for the samples, and the
 * address a test goes to. With `canChange` false it shows the preview and fields alone.
 */
export function EmailForm({ emailKey, initial, brand, testTo, canChange }: {
  emailKey: string;
  initial: { subject: string | null; body: TemplateDoc };
  brand: Pick<Brand, "clubName" | "color" | "portal" | "contact">;
  testTo: string | null;
  canChange: boolean;
}) {
  const e = emailByKey(emailKey)!;
  const router = useRouter();
  const [subject, setSubject] = useState(initial.subject ?? "");
  const [body, setBody] = useState<unknown>(initial.body);
  const [outcome, setOutcome] = useState<Done | null>(null);
  const [saving, startSaving] = useTransition();
  const [testing, startTesting] = useTransition();
  const outcomeRef = useRef<HTMLDivElement>(null);
  const fixedSubject = "fixed" in e.subject;
  const fields = useMemo(() => sampleValues(e, brand), [e, brand]);
  const editing: EmailEditing = useMemo(() => {
    const sample = e.sample(brand);
    return { fields, links: e.links, fixed: e.fixed.map((f) => ({ id: f.id, label: f.label,
      words: f.render(sample, brand).map((b) => b.text ?? "").filter(Boolean).join(" ") })) };
  }, [e, brand, fields]);

  const words = { subject: fixedSubject ? null : subject, body };
  const checked = checkTemplate(rulesOf(e), words);
  const preview = sampleEmail(e, brand, testTo ?? "", checked.ok ? checked : initial);

  const say = (d: Done) => { setOutcome(d); requestAnimationFrame(() => outcomeRef.current?.focus()); };
  const save = () => {
    if (saving) return;
    if (!checked.ok) { say(checked); return; }
    startSaving(async () => {
      const r = await safely(() => saveEmailAction(e.key, words), failed);
      say(r);
      if (r.ok) router.refresh();
    });
  };
  const test = () => {
    if (testing) return;
    if (!checked.ok) { say(checked); return; }
    startTesting(async () => say(await safely(() => testEmailAction(e.key, words), failed)));
  };

  const fieldsCard = (
    <Card title="Fields" titleId="fields-h" description="Filled in for each email. The preview uses these samples.">
      <KeyValue items={fields.map((f) => ({ key: f.id, label: f.label, value: f.sample }))} />
    </Card>
  );
  const previewCard = (
    <Card title="Preview" titleId="preview-h" description={canChange ? "As a family gets it, with sample values. It follows what you type." : "As a family gets it, with sample values."}>
      <EmailPreview subject={preview.subject} html={preview.html} />
    </Card>
  );
  if (!canChange) {
    return (
      <div className="email-edit">
        {previewCard}
        <div className="stack">
          {fieldsCard}
          <p className="hint">Only someone allowed to change the emails can change them.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="email-edit">
      <Card title="Words" titleId="words-h">
        <form className="stack" onSubmit={(ev) => { ev.preventDefault(); save(); }}>
          {fixedSubject
            ? <p className="hint"><b>Subject:</b> {preview.subject}. The portal writes this subject, since it carries the code.</p>
            : <TextInput id="email-subject" label="Subject" hint="Put a field in braces, such as {Club name}." required maxLength={200} value={subject} onChange={(ev) => setSubject(ev.target.value)} />}
          <RichTextEditor id="email-body" label="Email" hint="Type { or press Insert field to add a field. Blocks marked Fixed are written by the portal and can be moved, not removed."
            initial={initial.body} email={editing} onChange={setBody} />
          {!checked.ok && <Notice tone="warning" live="none">{checked.errors.length === 1 ? checked.errors[0] : <ul className="notice-list">{checked.errors.map((x) => <li key={x}>{x}</li>)}</ul>}</Notice>}
          {outcome && <ActionOutcome state={outcome} ref={outcomeRef} />}
          <div className="row-actions">
            <Button type="submit" busy={saving}>Save the email</Button>
            <Button variant="tonal" busy={testing} onClick={test}>Send me a test</Button>
          </div>
          <p className="hint">{testTo ? `The test goes to ${testTo}, with the sample values. ` : ""}Saving changes the next &quot;{e.title}&quot; email families get.</p>
        </form>
      </Card>
      <div className="stack">
        {previewCard}
        {fieldsCard}
      </div>
    </div>
  );
}
