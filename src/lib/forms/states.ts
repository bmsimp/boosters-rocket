/**
 * The states of a form to be signed, and the words for each (v1 spec §9.2, as the Documenso verification changed it).
 * Pure: what Documenso's API says about a document goes in, the portal's state comes out. A webhook's own words are
 * never read here; neither is the signing frame's "completed" message, which only means one guardian finished.
 */
import type { RequestSigner, SignatureRequestState } from "@/lib/db/schema";
import type { Envelope } from "@/lib/documenso/client";

export type { SignatureRequestState };

/** What a parent reads for each state. A form is done only when it reads "Signed". */
export const STATE_WORDS = {
  notSigned: "Not signed yet",
  waitingOther: "Waiting for the other guardian",
  sealing: "Signed, being finished",
  complete: "Signed",
  declined: "Declined",
  notReady: "Not ready yet",
} as const;

/**
 * The state in words, for the guardian looking (`viewer`, their parent id; null for staff): the lines on Home and
 * Season, the Forms list and the form page. A form that waits for another guardian reads "Not signed yet" to a
 * guardian who still has to sign it themselves.
 */
export function wordsFor(state: SignatureRequestState, signers: readonly Pick<RequestSigner, "signedAt" | "parentId">[], viewer: string | null): string {
  if (state === "complete") return STATE_WORDS.complete;
  if (state === "signed") return STATE_WORDS.sealing;
  if (state === "declined") return STATE_WORDS.declined;
  const mustSign = viewer !== null && signers.some((s) => s.parentId === viewer && s.signedAt === null);
  if (state === "waiting" && !mustSign && signers.some((s) => s.signedAt !== null)) return STATE_WORDS.waitingOther;
  return STATE_WORDS.notSigned;
}

/** Only a document Documenso has sealed meets the requirement (verification, section 5 point 6). */
export const isMet = (state: SignatureRequestState): boolean => state === "complete";
/** States the worker keeps asking Documenso about: a document is out and not finished. */
export const UNFINISHED: readonly SignatureRequestState[] = ["waiting", "signed"];

export type DocumentReading = {
  /**
   * "gone" is a document that can't be signed any more and holds no signature worth keeping: a draft a crash left
   * behind, one that was cancelled, or one deleted in Documenso. The request goes back to not opened.
   */
  state: Exclude<SignatureRequestState, "not_opened"> | "gone";
  /** Documenso's own word for the document, kept as read. */
  status: string;
  /** When each recipient signed, by Documenso's recipient id; null for one who hasn't. */
  signedAt: Map<number, string | null>;
  anySigned: boolean;
  completedAt: string | null;
};

/**
 * What a document's own record says. Completion is Documenso's status COMPLETED and nothing else: not `completedAt`
 * (a rejected document has one too) and not every recipient having signed (the sealed copy is made afterwards, by a
 * job that can fail and be run again).
 */
export function readDocument(envelope: Pick<Envelope, "status" | "recipients" | "completedAt" | "deletedAt" | "type">): DocumentReading {
  const signedAt = new Map(envelope.recipients.map((r) => [r.id, r.signingStatus === "SIGNED" ? (r.signedAt ?? null) : null] as const));
  const signed = envelope.recipients.filter((r) => r.signingStatus === "SIGNED");
  const base = { status: envelope.status, signedAt, anySigned: signed.length > 0, completedAt: envelope.completedAt };
  if (envelope.type !== "DOCUMENT" || envelope.deletedAt !== null) return { ...base, state: "gone" };
  if (envelope.status === "COMPLETED") return { ...base, state: "complete" };
  if (envelope.status === "REJECTED" || envelope.recipients.some((r) => r.signingStatus === "REJECTED")) return { ...base, state: "declined" };
  if (envelope.status !== "PENDING") return { ...base, state: "gone" }; // DRAFT, CANCELLED, or a word a later Documenso adds
  const signers = envelope.recipients.filter((r) => r.role === "SIGNER");
  if (signers.length > 0 && signers.every((r) => r.signingStatus === "SIGNED")) return { ...base, state: "signed" };
  return { ...base, state: "waiting" };
}

/** A guardian as a document names them. Compared without regard to case in the address. */
export type SignerIdentity = { parentId: string; name: string; email: string };
const same = (a: SignerIdentity, b: SignerIdentity) => a.parentId === b.parentId && a.name === b.name && a.email.toLowerCase() === b.email.toLowerCase();

/**
 * Who a document is made for (v1 spec §9.1, verification section 5 point 2). "Any one guardian": the guardian who
 * opens it. "Every guardian": the guardians with a sign-in for the family, the one who opens it first, up to the
 * number of signers the template has. `guardians` is the family's, in a steady order; the viewer is always among
 * those chosen, so whoever opens a form can sign it.
 */
export function signersFor(mode: "any" | "every", roles: number, viewer: SignerIdentity, guardians: readonly SignerIdentity[]): SignerIdentity[] {
  if (mode === "any") return [viewer];
  return [viewer, ...guardians.filter((g) => g.parentId !== viewer.parentId)].slice(0, Math.max(1, roles));
}

/**
 * True when a document nobody has signed is still the right one for this guardian to open: made from the template
 * attached now (and not from an older state of it than the one staff attached), for the same student or family by the
 * same name, for guardians who are all still the family's by the same names and addresses, the viewer among them, and
 * as many of them as the template and the family allow. Anything else, and the document is withdrawn and made again
 * (a sent document can't be edited). Times are milliseconds.
 */
export function stillRight(made: { templateId: string | null; templateUpdatedAt: number | null; mode: "any" | "every" | null; subjectName: string | null; signers: readonly SignerIdentity[] },
  now: { templateId: string; templateUpdatedAt: number; mode: "any" | "every"; roles: number; subjectName: string; viewer: SignerIdentity; guardians: readonly SignerIdentity[] }): boolean {
  if (made.templateId !== now.templateId || made.mode !== now.mode || made.subjectName !== now.subjectName) return false;
  if (made.templateUpdatedAt === null || made.templateUpdatedAt < now.templateUpdatedAt) return false;
  if (!made.signers.some((s) => same(s, now.viewer))) return false;
  const current = [now.viewer, ...now.guardians];
  if (!made.signers.every((s) => current.some((g) => same(g, s)))) return false;
  return made.signers.length === signersFor(now.mode, now.roles, now.viewer, now.guardians).length;
}
