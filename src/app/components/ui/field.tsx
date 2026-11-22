import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cx } from "./cx";

/** What a control inside a Field is given: its id and the ids of its hint and error, and whether it is in error. */
export type ControlAria = { id: string; "aria-describedby"?: string; "aria-invalid"?: true };

type Described = {
  /** The control's id, from the page: a server component has no useId. Its hint and error take `${id}-hint` and `${id}-error`. */
  id: string;
  label: ReactNode; hint?: ReactNode;
  /** What is wrong and how to put it right, in words. Sets aria-invalid and is read with the control. */
  error?: ReactNode;
  className?: string;
};

const ErrorIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M8 4.8v3.6M8 10.9v.1" strokeLinecap="round" /></svg>
);

/** A label over any control, with its hint and error tied to it by aria-describedby. TextInput, Select and TextArea are built on it. */
export function Field({ id, label, hint, error, className, children }: Described & { children: (aria: ControlAria) => ReactNode }) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("field", className)}>
      <label className="field-label" htmlFor={id}>{label}</label>
      {hint && <p className="field-hint" id={hintId}>{hint}</p>}
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error && <p className="field-error" id={errorId}><ErrorIcon />{error}</p>}
    </div>
  );
}

/** A one-line text field (text, email, tel, number, search, date) with its label, hint and error. */
export function TextInput({ id, label, hint, error, className, ...input }: Described & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className">) {
  return <Field id={id} label={label} hint={hint} error={error} className={className}>{(aria) => <input type="text" {...input} {...aria} />}</Field>;
}

/** A text area for a few lines (a note, an event's description). */
export function TextArea({ id, label, hint, error, className, ...area }: Described & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id" | "className">) {
  return <Field id={id} label={label} hint={hint} error={error} className={className}>{(aria) => <textarea rows={4} {...area} {...aria} />}</Field>;
}

/** A dropdown of options. Prefer a ChoiceGroup when there are five or fewer and they need explaining. */
export function Select({ id, label, hint, error, className, children, ...select }: Described & Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "className">) {
  return <Field id={id} label={label} hint={hint} error={error} className={className}>{(aria) => <select {...select} {...aria}>{children}</select>}</Field>;
}

/** One check box with its words (and a hint under them), a 44px tap target. Several together: a `fieldset.checks` with a legend. */
export function Checkbox({ id, label, hint, className, ...input }: Omit<Described, "error"> & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className" | "type">) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cx("checks", className)}>
      <label htmlFor={id}><input type="checkbox" id={id} aria-describedby={hintId} {...input} />{label}</label>
      {hint && <p className="hint" id={hintId}>{hint}</p>}
    </div>
  );
}
