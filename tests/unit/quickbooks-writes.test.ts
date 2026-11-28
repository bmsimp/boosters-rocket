import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A tripwire. Until 2026-11-15 this file held the portal to reading QuickBooks only. The owner then decided that a
 * parent edits their own phone and mailing address (roadmap, decisions of 2026-11-14; v1 spec §6.2), so the rule it
 * holds now is: the portal sends QuickBooks one write, a sparse update of one customer's phone and billing address,
 * and it can be sent from one place only, for one record only: the signed-in parent's own.
 *
 * A new write (an email change, a staff edit, an invoice) is a decision named in a slice brief: it adds its function
 * and its caller to the lists below on purpose, never to make this pass.
 *
 * The checks read the source as text, so each is written to refuse what it can't read rather than pass it: a request
 * method that isn't written out, a request whose method isn't in the call, a second function that reaches the write.
 * The last block feeds the checks code they must refuse, so a check that has gone blind fails here.
 */
const read = (dir: string) => (existsSync(path.resolve(dir)) ? readdirSync(path.resolve(dir), { recursive: true }).map(String) : [])
  .filter((f) => /\.tsx?$/.test(f)).map((f) => ({ file: `${dir}/${f.replaceAll("\\", "/")}`, text: readFileSync(path.resolve(dir, f), "utf8") }));
/** The code without comments: a method or a function that is only mentioned doesn't count. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const CLIENT = "src/lib/quickbooks/client.ts";
const CONTACT_EDITS = "src/lib/parents/contact-edits.ts";
/** The parent-facing module that queues a parent's change of their details in the save's transaction (stage 3's slice 11b). */
const CONTACT_QUEUE = "src/lib/parents/contact-queue.ts";
/** The roster's write module (ROSTER_WRITER below), named early for MAY_SEND_THE_WRITE. */
const ROSTER_WRITER_OF_CONTACT = "src/lib/roster/writes.ts";
/**
 * The check of the portal's own requests (roadmap step 7, src/lib/quickbooks/sandbox-check/): a deliberate caller of
 * every write, added to each MAY_SEND list below on purpose. It sends them only to an Intuit sandbox company, only for
 * records it made itself, and only through its own guard (CHECK_GUARD); it adds no sender of its own, so the client's
 * POSTs are still six.
 */
const CHECK_WRITER = "src/lib/quickbooks/sandbox-check/writes.ts";
const CHECK_FOLDER = "src/lib/quickbooks/sandbox-check/";
/** What starts a run: the check itself, and the one Admin action on its page. */
const CHECK_RUN = "runSandboxCheck";
const MAY_START_CHECK = ["src/lib/quickbooks/sandbox-check/run.ts", "src/app/staff/(app)/settings/quickbooks/check/actions.ts"];
/** The first write: a sparse update of one customer's phone and billing address, and the constant that holds its address and body. */
const WRITE = "qboUpdateCustomerContact";
/**
 * The only modules that may name that function: where it is written, the check of the portal's requests, and, since
 * stage 3's slice 11b, the roster's write module, whose one send (sendWrite()) sends a guardian's phone and address the
 * parent saved in the portal first, reached only through the one try of a change saved first (trySavedItem()). The
 * contact edits, and the parent-facing module that queues the change in the save's transaction, name none of it.
 */
const MAY_SEND_THE_WRITE = [CLIENT, CHECK_WRITER, ROSTER_WRITER_OF_CONTACT];
/** What reaches the contact edits' save from a browser: the parent's own server action, and nothing else. */
const SAVE = "saveMyContact";
const MAY_SAVE = [CONTACT_EDITS, "src/app/(parent)/family/details/actions.ts"];
/**
 * Everything the contact edits may export. Beside the parent's own save, the one save of a person's or a family's
 * details (saveDetails(), stage 3's slice 11b), which the parent's save calls and, since stage 3's slice 11c, the staff
 * actions of a person's page and a family's page; a third exported function would be another way to change a person's
 * details.
 */
const CONTACT_EDITS_EXPORTS = ["CONTACT_COPY", "ContactView", "SaveContactResult", "loadMyContact", SAVE, "saveDetails", "SaveDetailsOutcome"];
/** Every write the client sends, by its function's name: the contact edits name none of them (stage 3's slice 11a). */
const CLIENT_WRITES = ["qboUpdateCustomerContact", "qboUpdateCustomerEmail", "qboCreateCustomer", "qboRenameCustomer", "qboMoveCustomer", "qboSetCustomerActive",
  "qboCreateInvoice", "qboVoidInvoice"];

/**
 * The second write, decided in the slice brief of 2026-11-16 (roadmap step 5): a parent's own sign-in email, a sparse
 * update of one customer's email field. It is held to the same rules as the first, in lists of its own.
 */
const EMAIL_CHANGE = "src/lib/parents/email-change.ts";
const EMAIL_WRITE = "qboUpdateCustomerEmail";
/**
 * The only modules that may name the email write: where it is written, the check of the portal's requests, and, since
 * stage 3's slice S11e, the roster's write module, whose one send (sendWrite()) sends a person's sign-in email the
 * portal changed first, reached only through the one try of a change saved first (trySavedItem()). Since stage 3's
 * slice 11d a parent's confirmed change of sign-in email is the portal's alone, so the email change names none of the
 * client's writes (emailChangeProblems()), and nor does the parent-facing module that queues it in the confirm's
 * transaction (contact-queue.ts).
 */
const MAY_SEND_THE_EMAIL_WRITE = [CLIENT, CHECK_WRITER, ROSTER_WRITER_OF_CONTACT];
/** What reaches the email change's confirmation from a browser: the parent's own server action, and nothing else. */
const CONFIRM = "confirmMyEmailChange";
const MAY_CONFIRM = [EMAIL_CHANGE, "src/app/(parent)/family/email/actions.ts"];
/** Everything the email change may export. A second exported function is a second way to change a sign-in address. */
const EMAIL_CHANGE_EXPORTS = ["EMAIL_CHANGE_TTL_MS", "EMAIL_COPY", "EmailResult", "ConfirmResult", "emailChangeLink", "canChangeMyEmail",
  "requestMyEmailChange", "EmailLinkView", "findMyEmailChange", CONFIRM];

/**
 * The staff roster writes (roadmap step 5, v1 spec §6.1): a customer create and sparse updates of a name, a parent and
 * Active, each built from CUSTOMER_WRITES and sent by the client's one private sender. Only the roster's write module
 * may name them; only the staff roster actions and the write queue's job reach that module's send.
 */
const ROSTER_WRITES = ["qboCreateCustomer", "qboRenameCustomer", "qboMoveCustomer", "qboSetCustomerActive"];
const ROSTER_WRITER = "src/lib/roster/writes.ts";
const MAY_SEND_ROSTER_WRITES = [CLIENT, ROSTER_WRITER, CHECK_WRITER];
/** The write module's way to QuickBooks: its send (used by the module itself and the queue's job) and the staff ask. */
const ROSTER_SEND = "sendWrite", ROSTER_ASK = "askRosterWrite";
const MAY_ROSTER_SEND = [ROSTER_WRITER, "src/lib/roster/queue.ts"];
const MAY_ROSTER_ASK = [ROSTER_WRITER, "src/app/staff/(app)/roster/write-actions.ts"];
/**
 * "Create in QuickBooks and link" (stage 3's slice 9d): it sends the creates of a family made in the portal and of its
 * unlinked students, through the module's own send. Started only by the module itself and the one staff action.
 */
const ROSTER_LINK = "createInQuickBooksAndLink";
const MAY_ROSTER_LINK = [ROSTER_WRITER, "src/app/staff/(app)/roster/write-actions.ts"];
/**
 * Adding a family or member (stage 3's slice 9d): the portal's own record first, then, for a staff member who may link
 * families to accounting, its create sent through the module's own ask. Started only by the module itself and
 * QuickBooks' way of adding (its manifest's slot `families.howToAdd`, which the staff actions reach since stage 5's
 * slice P2), so no other module can send a family's create by way of it.
 */
const ROSTER_ADD = "addFamily";
const MAY_ROSTER_ADD = [ROSTER_WRITER, "src/plugins/quickbooks/plugin.ts"];
/** A student added to a linked family (stage 3's slice 9e), saved first: started, as a family's add, only through QuickBooks' slot. */
const SAVED_FIRST_ADD = "addStudentToLinked";
const MAY_SAVED_FIRST_ADD = [ROSTER_WRITER, "src/plugins/quickbooks/plugin.ts"];
/**
 * The changes saved in the portal first (stage 3's slices 9e and 9f): a linked record's rename, a student added to a
 * linked family, a student's move, and "Send the portal's value" for a change QuickBooks refused, each sent through the
 * module's own send without the staff ask. Each started only by the module itself and the one staff action. The one send of a rename (its send,
 * and its one resend after a stale answer and a live read) is the module's own; a try of a change saved first, which
 * settles its queue item (at once, on a press or by the worker), is the module's and the queue's.
 */
const SAVED_FIRST = ["renameLinked", "moveStudent", "sendPortalValue"];
const MAY_SAVED_FIRST = [ROSTER_WRITER, "src/app/staff/(app)/roster/write-actions.ts"];
const RENAME_TRY = "tryRename";
const MAY_RENAME_TRY = [ROSTER_WRITER];
/**
 * A linked student's or member's make-inactive (stage 3's slice 9g): QuickBooks first, under the balance rule, sent
 * through the module's own send without the staff ask. Started only by the module itself and the one staff action.
 */
const ROSTER_DEACTIVATE = "deactivateLinked";
const MAY_ROSTER_DEACTIVATE = [ROSTER_WRITER, "src/app/staff/(app)/roster/write-actions.ts"];
/**
 * Take QuickBooks' into the app (stage 4's slice M4a): a name, an inactive customer or a student's family taken from
 * the books into the portal's own record, sending nothing to QuickBooks. Started only by the module itself and the
 * accounting links screen's press.
 */
const TAKE = "takeFromBooks";
const MAY_TAKE = [ROSTER_WRITER, "src/app/staff/(app)/links/actions.ts"];
/**
 * A guardian's own Parent customer (stage 3's slice 9h): queued in the guardian's own transaction (an add, a reinstate,
 * a removal, a person's rename) and tried at once after it commits, through the module's own try of a change saved
 * first. Each named only by the module itself and the two guardian modules, since guardians and people now cause sends.
 */
const GUARDIAN_SENDS = ["queueForGuardian", "sendGuardianSaved"];
const MAY_GUARDIAN_SEND = [ROSTER_WRITER, "src/lib/parents/guardians.ts", "src/lib/parents/people.ts"];
/**
 * Since slice P6 of the accounting plugin spec the two guardian modules queue only through the save's event
 * (guardianSaved(), src/lib/families/guardian-events.ts: `records.events`), whose QuickBooks handler is in the module
 * itself: so the queueing is named by the module alone, and the event by the two guardian modules and its own.
 */
const MAY_GUARDIAN_QUEUE: Record<string, string[]> = { queueForGuardian: [ROSTER_WRITER] };
const GUARDIAN_EVENT = "guardianSaved";
const MAY_GUARDIAN_EVENT = ["src/lib/families/guardian-events.ts", "src/lib/parents/guardians.ts", "src/lib/parents/people.ts"];
/** The same for a person's or a family's details (slice P6): the contact edits' save and the email change's confirmation. */
const DETAILS_EVENT = "detailsSaved";
const MAY_DETAILS_EVENT = ["src/lib/families/events.ts", CONTACT_EDITS, EMAIL_CHANGE];
/**
 * A staff member's change of a guardian's phone and mailing address (stage 3's slice 11c): saved through the one save
 * (saveDetails()), then tried at once after its commit, through the module's own try of a change saved first. Named
 * only by the module itself and the two staff actions that save details: a person's page's and a family's page's.
 */
const CONTACT_SEND = "sendContactSaved";
const MAY_CONTACT_SEND = [ROSTER_WRITER, "src/app/staff/(app)/parents/actions.ts", "src/app/staff/(app)/roster/write-actions.ts"];
/** One try of a change saved first, whoever makes it (at once, the press, the queue's worker), settling its own queue item. */
const SAVED_TRY = "trySavedItem";
const MAY_SAVED_TRY = [ROSTER_WRITER, "src/lib/roster/queue.ts"];
/**
 * Send the app's to QuickBooks (stage 4's slice M5a): a name, a student's family or a student or member made inactive,
 * sent from a difference on the accounting links screen over the books' value. It reaches QuickBooks only through the
 * try of a change saved first (trySavedItem()) and the make-inactive's try (tryDeactivate()), today's writes and bodies,
 * so MAY_SAVED_TRY and MAY_ROSTER_DEACTIVATE are unchanged. Started only by the module itself and the screen's press.
 */
const SEND = "sendToBooks";
const MAY_SEND = [ROSTER_WRITER, "src/app/staff/(app)/links/actions.ts"];
/**
 * Send the app's to QuickBooks for a guardian's difference (stage 4's slice M3c4): a guardian's name sent to their own
 * Parent customer, and a removed guardian's Parent customer made inactive by the balance rule. Each is a private function
 * of sendToBooks()'s block, named only by the roster's write module, and reaches QuickBooks only through the saved-first
 * try (queueSaved(), trySavedItem()) and the make-inactive's try (tryDeactivate()), never through the guardian functions
 * (GUARDIAN_SENDS), whose rename compares QuickBooks' name with the last agreed one rather than the one the row showed.
 * GUARDIAN_SENDS, MAY_GUARDIAN_SEND, MAY_SAVED_TRY and MAY_SEND are unchanged by it.
 */
const GUARDIAN_DIFFERENCE_SENDS = ["sendGuardianName", "sendGuardianInactive"];
const MAY_GUARDIAN_DIFFERENCE_SEND = [ROSTER_WRITER];
/** Which body each roster write sends. */
const ROSTER_BODY = { qboCreateCustomer: "create", qboRenameCustomer: "rename", qboMoveCustomer: "reparent", qboSetCustomerActive: "active" } as const;
/** The fields the roster writes' bodies can carry, in the order CUSTOMER_WRITES writes them. */
const ROSTER_BODY_FIELDS = ["DisplayName", "CustomerTypeRef", "ParentRef", "Job", "BillWithParent", "PrimaryEmailAddr", "Address",
  "Id", "SyncToken", "DisplayName", "Id", "SyncToken", "ParentRef", "Job", "BillWithParent", "Id", "SyncToken", "Active"];

/**
 * The buy-out invoice writes (roadmap step 6, v1 spec §11.5): the only invoices the portal ever creates and voids, an
 * invoice create and an invoice void, each built from INVOICE_WRITES and sent by the client's own private sender for
 * them, the first writes that go to the invoice endpoint rather than the customer endpoint. Only the buy-out module may
 * name them; only the parent's own pay-instead actions reach its confirm and switch-back, and only the module itself
 * and the write queue's job reach its send.
 */
const INVOICE_WRITE_FUNCTIONS = ["qboCreateInvoice", "qboVoidInvoice"];
const BUYOUT_WRITER = "src/lib/buyouts/writes.ts";
const MAY_SEND_INVOICE_WRITES = [CLIENT, BUYOUT_WRITER, CHECK_WRITER];
const BUYOUT_SEND = "sendBuyoutWrite";
const MAY_BUYOUT_SEND = [BUYOUT_WRITER, "src/lib/roster/queue.ts"];
const BUYOUT_ASKS = ["confirmMyBuyout", "switchMyBuyoutBack"];
const MAY_BUYOUT_ASK = [BUYOUT_WRITER, "src/app/(parent)/volunteer/pay-instead/actions.ts"];
/** Where the queued create's type is written: it carries the bill-to address from the confirm to every try. */
const SCHEMA = "src/lib/db/schema.ts";
/**
 * The bill-to address (InvoiceCreate.billEmail) in the buy-out writer, decided by the owner on 2026-11-17: named twice
 * and nowhere else in it. Once to put the session's own sign-in address on the queued create, in confirmMyBuyout(),
 * and once to send the address that item carries, in sendBuyoutWrite(). Never from an argument, a lookup or the browser.
 */
const BUYOUT_BILL_EMAIL = { put: "billEmail: ctx.email", sent: "billEmail: w.billEmail" } as const;
function buyoutBillEmailProblems(source: string): string[] {
  const text = code(source), problems: string[] = [];
  const uses = [...text.matchAll(/\bbillEmail\b[^,)}\n]*/g)].map((m) => ({ at: m.index, what: m[0].trim() }));
  if (uses.map((u) => u.what).sort().join(" | ") !== [BUYOUT_BILL_EMAIL.put, BUYOUT_BILL_EMAIL.sent].sort().join(" | ")) problems.push(`billEmail is given as ${uses.map((u) => u.what).join(" | ")}`);
  if (/BillEmail/.test(text)) problems.push("the writer builds a body field itself");
  const within = (name: string) => {
    const at = text.indexOf(`export async function ${name}(`), next = text.indexOf("\nexport ", at + 1);
    return { from: at, to: next < 0 ? text.length : next };
  };
  const put = uses.find((u) => u.what === BUYOUT_BILL_EMAIL.put), sent = uses.find((u) => u.what === BUYOUT_BILL_EMAIL.sent);
  const confirm = within("confirmMyBuyout"), send = within(BUYOUT_SEND);
  if (!put || confirm.from < 0 || put.at < confirm.from || put.at > confirm.to) problems.push("the address is not put on the queued create inside confirmMyBuyout");
  if (!sent || send.from < 0 || sent.at < send.from || sent.at > send.to) problems.push(`the address is not sent from the queued item inside ${BUYOUT_SEND}`);
  const confirmText = text.slice(confirm.from, confirm.to);
  if (!confirmText.startsWith("export async function confirmMyBuyout(ctx: ParentCtx, ")) problems.push("confirmMyBuyout does not take the session's ParentCtx first");
  if (/\bctx\s*=[^=>]|\bctx\.email\s*=[^=]|\b(?:const|let|var)\s+ctx\b/.test(confirmText)) problems.push("confirmMyBuyout gives ctx or its email another value");
  return problems;
}
/** Which body each invoice write sends. */
const INVOICE_BODY = { qboCreateInvoice: "create", qboVoidInvoice: "void" } as const;
/** The fields the invoice writes' bodies can carry, in the order INVOICE_WRITES writes them. */
// `BillEmail` (with its `Address`) was added on purpose on 2026-11-17, named in that slice's brief: the check of the
// portal's requests sends one on its Pay link probe. After its second run the owner decided, the same day, that a
// buy-out invoice carries the sign-in address of the guardian who chose it; nobody else gives one (the test below).
const INVOICE_BODY_FIELDS = ["CustomerRef", "Line", "DetailType", "Amount", "SalesItemLineDetail", "ItemRef", "Qty", "UnitPrice", "PrivateNote", "AllowOnlineACHPayment", "EmailStatus",
  "BillEmail", "Address", "Id", "SyncToken"];

/**
 * Every place the word `method` stands in the code. `is` is the request method when it is written out as a plain key
 * with one of the two the portal uses, `method: "GET"` or `method: "POST"`, and null for anything else: a shorthand
 * (`{ method }`), a computed or quoted key (`["method"]: ...`), a property set later (`init.method = ...`), a value
 * built from parts. Those could be any method, so none of them is allowed.
 */
function methodsIn(source: string): { is: "GET" | "POST" | null; where: string }[] {
  const text = code(source);
  return [...text.matchAll(/\bmethod\b/g)].map((m) => {
    const at = m.index, before = text.slice(Math.max(0, at - 1), at);
    const written = /^\s*:\s*"(GET|POST)"\s*[,}]/.exec(text.slice(at + m[0].length));
    const plainKey = !/["'`[.$]/.test(before);
    return { is: plainKey && written ? (written[1] as "GET" | "POST") : null, where: text.slice(Math.max(0, at - 30), at + 40).replace(/\s+/g, " ").trim() };
  });
}

/** Where the call that opens at `open` (its parenthesis) closes. Strings and template text are skipped; `${...}` is code again. */
function endOfCall(text: string, open: number): number {
  const frames: { template: boolean; braces: number }[] = [{ template: false, braces: 0 }];
  let depth = 0, quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!, frame = frames.at(-1)!;
    if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = null; continue; }
    if (frame.template) {
      if (ch === "\\") i++;
      else if (ch === "`") frames.pop();
      else if (ch === "$" && text[i + 1] === "{") { frames.push({ template: false, braces: 0 }); i++; }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "`") frames.push({ template: true, braces: 0 });
    else if (ch === "{") frame.braces++;
    else if (ch === "}") { if (frame.braces === 0 && frames.length > 1) frames.pop(); else frame.braces--; }
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return text.length;
}
/** Each call to fetch in the code, as written, arguments and all. */
function fetchCalls(source: string): string[] {
  const text = code(source);
  return [...text.matchAll(/\bfetch\s*\(/g)].map((m) => text.slice(m.index, endOfCall(text, m.index + m[0].length - 1) + 1));
}
/** Any way of sending a request that isn't a plain fetch call: nothing in the QuickBooks code uses one. */
const OTHER_SENDERS = /\bnew\s+Request\b|\bXMLHttpRequest\b|\bsendBeacon\b|["'](?:node:)?https?["']|\bundici\b|\baxios\b/;

/**
 * What is wrong with how a module sends requests; nothing when every request is a fetch call that says, in the call
 * itself, that it is a GET or a POST.
 */
function requestProblems(source: string): string[] {
  const problems: string[] = [];
  const methods = methodsIn(source), calls = fetchCalls(source);
  for (const m of methods) if (m.is === null) problems.push(`a request method this scan can't read: ${m.where}`);
  if (/["'`](PUT|PATCH|DELETE)["'`]/i.test(code(source))) problems.push("PUT, PATCH or DELETE written as a string");
  for (const call of calls) {
    const own = methodsIn(call);
    if (own.length !== 1 || own[0]!.is === null) problems.push(`a request that doesn't say in the call itself whether it is a GET or a POST: ${call.slice(0, 70).replace(/\s+/g, " ")}`);
  }
  // No method stands anywhere but in a fetch call: an options object built to one side could be handed to any request.
  if (methods.length !== calls.length) problems.push(`${methods.length} request methods for ${calls.length} fetch calls`);
  if (OTHER_SENDERS.test(code(source))) problems.push("a request sent some way other than a fetch call");
  return problems;
}
const postsIn = (source: string) => methodsIn(source).filter((m) => m.is === "POST").length;

/** One exported function of a module, from its `export` to the next one. */
function exportedFunction(source: string, name: string): string {
  const text = code(source), at = text.indexOf(`export async function ${name}(`);
  if (at < 0) return "";
  const next = text.indexOf("\nexport ", at + 1);
  return text.slice(at, next < 0 ? undefined : next);
}

/**
 * What is wrong with the contact edits (stage 3's slice 11a: a guardian's phone and address saved in the portal alone);
 * nothing when the module imports nothing from the QuickBooks client, names none of its writes, takes the session's
 * ParentCtx first in its save, and exports nothing but its list.
 */
function contactEditsProblems(source: string): string[] {
  const text = code(source), problems: string[] = [];
  if (/from\s*["'][^"']*quickbooks\/client["']|import\(\s*["'][^"']*quickbooks\/client["']|require\(\s*["'][^"']*quickbooks\/client["']/.test(text)) problems.push("imports the QuickBooks client");
  for (const name of CLIENT_WRITES) if (new RegExp(`\\b${name}\\b`).test(text)) problems.push(`names ${name}`);
  const save = exportedFunction(source, SAVE);
  if (!/^export async function saveMyContact\(ctx: ParentCtx, /.test(save)) problems.push(`${SAVE} does not take the session's ParentCtx first`);
  const exported = [...text.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+(\w+)/gm)].map((m) => m[1]!);
  if ([...exported].sort().join() !== [...CONTACT_EDITS_EXPORTS].sort().join()) problems.push(`exports ${exported.join(", ")}`);
  if ([...text.matchAll(/^export\b/gm)].length !== exported.length) problems.push("an export this scan can't read (a re-export, a default, a list)");
  return problems;
}

/**
 * What is wrong with the email change (stage 3's slice 11d: a parent's sign-in email changed in the portal alone);
 * nothing when the module imports nothing from the QuickBooks client, names none of its writes, takes the session's
 * ParentCtx first in its confirmation, and exports nothing but its list. The checks the contact edits are held to
 * (contactEditsProblems()), for the email change.
 */
function emailChangeProblems(source: string): string[] {
  const text = code(source), problems: string[] = [];
  if (/from\s*["'][^"']*quickbooks\/client["']|import\(\s*["'][^"']*quickbooks\/client["']|require\(\s*["'][^"']*quickbooks\/client["']/.test(text)) problems.push("imports the QuickBooks client");
  for (const name of CLIENT_WRITES) if (new RegExp(`\\b${name}\\b`).test(text)) problems.push(`names ${name}`);
  const confirm = exportedFunction(source, CONFIRM);
  if (!confirm.startsWith(`export async function ${CONFIRM}(ctx: ParentCtx, `)) problems.push(`${CONFIRM} does not take the session's ParentCtx first`);
  const exported = [...text.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+(\w+)/gm)].map((m) => m[1]!);
  if ([...exported].sort().join() !== [...EMAIL_CHANGE_EXPORTS].sort().join()) problems.push(`exports ${exported.join(", ")}`);
  if ([...text.matchAll(/^export\b/gm)].length !== exported.length) problems.push("an export this scan can't read (a re-export, a default, a list)");
  return problems;
}

/** `export const EMAIL_UPDATE = { ... } as const;` as written in the client. */
function emailUpdateConstant(clientSource: string): string {
  const text = code(clientSource), at = text.indexOf("export const EMAIL_UPDATE = {");
  return at < 0 ? "" : text.slice(at, text.indexOf("\n} as const;", at));
}
/** The fields the email update's body carries, in order: nothing is left out, and nothing spread in. */
const EMAIL_BODY_FIELDS = ["Id", "SyncToken", "PrimaryEmailAddr", "Address"];
function emailBodyProblems(constant: string): string[] {
  const problems: string[] = [];
  if (!constant.includes(`path: "customer",`)) problems.push("the path is not the customer endpoint");
  if (!constant.includes("body: (customerId: string, syncToken: string, field: string) => ({")) problems.push("the body is not built from an id, a version and the field alone");
  const fields = [...constant.matchAll(/(?:^|[{\s])["'`]?([A-Z]\w*)["'`]?\]?\s*:/g)].map((m) => m[1]!);
  if (fields.join() !== EMAIL_BODY_FIELDS.join()) problems.push(`the body carries ${fields.join(", ")}`);
  if (!constant.includes("Id: customerId, SyncToken: syncToken, sparse: true, PrimaryEmailAddr: { Address: field },")) problems.push("the update is not sparse, or not of the customer, version and field it was given");
  if (constant.includes("...")) problems.push("the body spreads something in");
  if (/\[[^\]]*\]\s*:/.test(constant.replace(/\/\^.*?\$\//g, ""))) problems.push("the body has a computed key");
  return problems;
}

/** `export const CUSTOMER_UPDATE = { ... } as const;` as written in the client. */
function updateConstant(clientSource: string): string {
  const text = code(clientSource), at = text.indexOf("export const CUSTOMER_UPDATE = {");
  return at < 0 ? "" : text.slice(at, text.indexOf("\n} as const;", at));
}
/** `export const CUSTOMER_WRITES = { ... } as const;` as written in the client. */
function rosterWritesConstant(clientSource: string): string {
  const text = code(clientSource), at = text.indexOf("export const CUSTOMER_WRITES = {");
  return at < 0 ? "" : text.slice(at, text.indexOf("\n} as const;", at));
}
/** What is wrong with the roster writes' bodies: a field that isn't on the list, a spread of anything but its optional parts, a computed key. */
function rosterBodyProblems(constant: string): string[] {
  const problems: string[] = [];
  if (!constant.includes(`path: "customer",`)) problems.push("the path is not the customer endpoint");
  const fields = [...constant.matchAll(/(?:^|[{\s(])["'`]?([A-Z]\w*)["'`]?\]?\s*:/g)].map((m) => m[1]!);
  if (fields.join() !== ROSTER_BODY_FIELDS.join()) problems.push(`the bodies carry ${fields.join(", ")}`);
  const spreads = [...constant.matchAll(/\.\.\./g)].map((m) => constant.slice(m.index, m.index + 40).replace(/\s+/g, " "));
  if (spreads.length !== 2 || !spreads[0]!.startsWith("...(c.parentQboId !== null ? {") || !spreads[1]!.startsWith("...(c.email !== null ? {")) problems.push(`the bodies spread something else: ${spreads.join(" | ")}`);
  if ([...constant.matchAll(/sparse: true/g)].length !== 3) problems.push("an update is not sparse");
  if (/\[[^\]]*\]\s*:/.test(constant)) problems.push("a body has a computed key");
  return problems;
}

/** `export const INVOICE_WRITES = { ... } as const;` as written in the client. */
function invoiceWritesConstant(clientSource: string): string {
  const text = code(clientSource), at = text.indexOf("export const INVOICE_WRITES = {");
  return at < 0 ? "" : text.slice(at, text.indexOf("\n} as const;", at));
}
/** What is wrong with the invoice writes' bodies: a field that isn't on the list, any spread, a computed key, another endpoint. */
function invoiceBodyProblems(constant: string): string[] {
  const problems: string[] = [];
  if (!constant.includes(`path: "invoice",`)) problems.push("the path is not the invoice endpoint");
  if (!constant.includes(`voidOperation: "void",`)) problems.push("the void is not operation=void");
  const fields = [...constant.matchAll(/(?:^|[{\s(])["'`]?([A-Z]\w*)["'`]?\]?\s*:/g)].map((m) => m[1]!);
  if (fields.join() !== INVOICE_BODY_FIELDS.join()) problems.push(`the bodies carry ${fields.join(", ")}`);
  if (constant.includes("...")) problems.push("a body spreads something in");
  if (/\[[^\]]*\]\s*:/.test(constant)) problems.push("a body has a computed key");
  if (!constant.includes("create: (c: InvoiceCreate) => ({") || !constant.includes("void: (invoiceId: string, syncToken: string) => ({ Id: invoiceId, SyncToken: syncToken }),")) problems.push("a body is built from something else");
  if (!constant.includes(`EmailStatus: "NotSet"`)) problems.push("QuickBooks may email the invoice");
  return problems;
}

/** The top-level and nested fields the update's body can carry, in order. */
const BODY_FIELDS = ["Id", "SyncToken", "PrimaryPhone", "FreeFormNumber", "BillAddr", "Line1", "Line2", "Line3", "Line4", "Line5", "City", "CountrySubDivisionCode", "PostalCode", "Country"];
/** The two parts of the body that are left out when unchanged. Any other spread could carry any field. */
const BODY_SPREADS = ["...(change.phone !== undefined ? { PrimaryPhone: {", "...(change.address !== undefined ? { BillAddr: {"];
function bodyProblems(constant: string): string[] {
  const problems: string[] = [];
  if (!constant.includes(`path: "customer",`)) problems.push("the path is not the customer endpoint");
  if (!constant.includes("body: (customerId: string, syncToken: string, change: CustomerContactChange) => ({")) problems.push("the body is not built from an id, a version and a contact change alone");
  const fields = [...constant.matchAll(/(?:^|[{\s])["'`]?([A-Z]\w*)["'`]?\]?\s*:/g)].map((m) => m[1]!);
  if (fields.join() !== BODY_FIELDS.join()) problems.push(`the body carries ${fields.join(", ")}`);
  if (!constant.includes("Id: customerId, SyncToken: syncToken, sparse: true,")) problems.push("the update is not sparse, or not of the customer and version it was given");
  const spreads = [...constant.matchAll(/\.\.\./g)].map((m) => constant.slice(m.index, m.index + 60).replace(/\s+/g, " "));
  if (spreads.length !== BODY_SPREADS.length || spreads.some((s, i) => !s.startsWith(BODY_SPREADS[i]!))) problems.push(`the body spreads something other than its two parts: ${spreads.join(" | ")}`);
  if (/\[[^\]]*\]\s*:/.test(constant.replace(/\/\^.*?\$\//g, ""))) problems.push("the body has a computed key");
  return problems;
}

/** Every write the client offers, as the check calls them. */
const ALL_WRITES = [WRITE, EMAIL_WRITE, ...ROSTER_WRITES, ...INVOICE_WRITE_FUNCTIONS];
/** The guard every write of the check goes through first, and what it must refuse, written out. */
const CHECK_GUARD = "async function allowed(run: CheckRun, targets: Target[]): Promise<void> {";
const GUARD_REFUSES = [`if (environmentOf(c, c.tokenMode) !== "sandbox") throw`, "if (c.realmId !== run.realmId) throw",
  "if (!row || row.runId !== (t.runId ?? run.id)) throw refused("];

/**
 * What is wrong with how the check reaches the client's writes; nothing when each write is imported under its own name
 * and called once, inside an exported function that first awaits the guard, and the guard refuses a company that isn't a
 * sandbox, another company, and an id the check didn't record.
 */
function checkWriterProblems(source: string): string[] {
  const text = code(source), problems: string[] = [];
  const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/quickbooks\/client["']/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()));
  const at = text.indexOf(CHECK_GUARD);
  if (at < 0) problems.push("the guard is not there");
  const guard = at < 0 ? "" : text.slice(at, text.indexOf("\n}\n", at));
  for (const refusal of GUARD_REFUSES) if (!guard.includes(refusal)) problems.push(`the guard doesn't refuse: ${refusal}`);
  if (/export\s+(async\s+)?function\s+allowed\b|export\s*\{[^}]*\ballowed\b/.test(text)) problems.push("the guard is exported");
  for (const name of ALL_WRITES) {
    if (!imports.includes(name)) problems.push(`${name} is not imported under its own name`);
    const uses = [...text.matchAll(new RegExp(`\\b${name}\\b`, "g"))];
    if (uses.length !== 2) problems.push(`${name} is named ${uses.length} times: once to import it and once to call it is all`);
    const call = uses[1];
    if (!call) continue;
    const fn = text.lastIndexOf("\nexport async function ", call.index);
    const before = text.slice(fn, call.index);
    if (fn < 0 || !/^\s*\(/.test(text.slice(call.index + name.length))) problems.push(`${name} is not called inside an exported function`);
    else if (!/\n {2}await allowed\(run, /.test(before)) problems.push(`${name} is called before the guard`);
    else if (before.slice(before.indexOf("await allowed(run, ")).includes("\n}\n")) problems.push(`${name} is called outside the function that awaited the guard`);
  }
  return problems;
}

/**
 * Open question 12 of the app-owned families spec: the portal never makes a customer active again (stage 4's critic,
 * risk 1). It holds only because the roster's write module calls the client's active flag write once, in sendWrite(),
 * with the literal `false`, and nothing else in `src/` but the client and the check of the portal's requests (an Intuit
 * sandbox only, its own records) names it. A send from a difference on the accounting links screen (slice M5a) reaches
 * QuickBooks through that one call and no other.
 */
const ACTIVE_FLAG = "qboSetCustomerActive";
const ACTIVE_FLAG_CALL = "qboSetCustomerActive(w.qboId, w.syncToken, false, opts)";
const MAY_NAME_ACTIVE_FLAG = [CLIENT, CHECK_WRITER, ROSTER_WRITER];
/** What is wrong with how the active flag write is reached; nothing when only the client, the check and the roster's write module name it, and the module imports it once and calls it once, with `false`. */
function activeFlagProblems(sources: { file: string; text: string }[]): string[] {
  const problems: string[] = [];
  const naming = sources.filter((s) => new RegExp(`\\b${ACTIVE_FLAG}\\b`).test(code(s.text))).map((s) => s.file);
  const others = naming.filter((f) => !MAY_NAME_ACTIVE_FLAG.includes(f));
  if (others.length) problems.push(`${ACTIVE_FLAG} is named by ${others.sort().join(", ")}`);
  const writer = code(sources.find((s) => s.file === ROSTER_WRITER)?.text ?? "");
  const names = [...writer.matchAll(new RegExp(`\\b${ACTIVE_FLAG}\\b`, "g"))];
  if (names.length !== 2) problems.push(`${ROSTER_WRITER} names ${ACTIVE_FLAG} ${names.length} times: once to import it and once to call it is all`);
  const calls = [...writer.matchAll(new RegExp(`\\b${ACTIVE_FLAG}\\s*\\(`, "g"))];
  if (calls.length !== 1) problems.push(`${ROSTER_WRITER} calls ${ACTIVE_FLAG} ${calls.length} times, not once`);
  for (const call of calls) {
    const rest = writer.slice(call.index);
    if (!rest.startsWith(ACTIVE_FLAG_CALL) || !/^\s*;/.test(rest.slice(ACTIVE_FLAG_CALL.length))) problems.push(`${ACTIVE_FLAG} is called otherwise than ${ACTIVE_FLAG_CALL}: ${rest.slice(0, 70)}`);
  }
  return problems;
}

/**
 * What is wrong with the send from a difference's own block (sendToBooks() up to portalValueStamp(), slice M5a):
 * nothing when it names no client write and not sendWrite(), and reaches QuickBooks through trySavedItem() and
 * tryDeactivate(), and, since slice M5b, a layered family made inactive with everyone under it only through the family
 * action's own body (familyInactiveHolding()): never its press's entry (askFamilyInactive(), which takes the family's
 * "being sent" lock the send already holds), its checks (prepareFamily()) or its steps (sendDeactivate(), stepStopped())
 * by themselves.
 */
const SEND_FAMILY = "familyInactiveHolding";
const FAMILY_ACTION_PARTS = ["askFamilyInactive", "prepareFamily", "sendDeactivate", "stepStopped"];
function sendBlockProblems(writerText: string): string[] {
  const writer = code(writerText);
  const start = writer.indexOf(`export async function ${SEND}(`), end = writer.indexOf("export function portalValueStamp(");
  if (start < 0 || end <= start) return [`${SEND}'s block isn't found before portalValueStamp()`];
  const block = writer.slice(start, end);
  const problems = [...CLIENT_WRITES, ROSTER_SEND].filter((name) => new RegExp(`\\b${name}\\b`).test(block)).map((name) => `${SEND}'s block names ${name}`);
  for (const via of ["trySavedItem", "tryDeactivate"]) if (!new RegExp(`\\b${via}\\(`).test(block)) problems.push(`${SEND}'s block doesn't send through ${via}()`);
  if (!new RegExp(`\\b${SEND_FAMILY}\\(`).test(block)) problems.push(`${SEND}'s block doesn't make a layered family inactive through ${SEND_FAMILY}(), the family action's own body`);
  for (const name of FAMILY_ACTION_PARTS) {
    if (new RegExp(`\\b${name}\\b`).test(block)) problems.push(`${SEND}'s block reaches the family action otherwise than through ${SEND_FAMILY}(): it names ${name}`);
  }
  // Slice M3c4: a guardian's sends are the block's own functions, so the checks above read them too.
  for (const name of GUARDIAN_DIFFERENCE_SENDS) if (!new RegExp(`\\basync function ${name}\\(`).test(block)) problems.push(`${SEND}'s block doesn't define ${name}()`);
  return problems;
}
/**
 * What is wrong with a guardian's sends from a difference (slice M3c4): nothing when each is a function of the roster's
 * write module whose body names neither of GUARDIAN_SENDS (it queues through queueSaved() and tries through
 * trySavedItem() and tryDeactivate(), with `was` the books' name the row showed).
 */
function guardianDifferenceSendProblems(writerText: string): string[] {
  const writer = code(writerText), problems: string[] = [];
  for (const name of GUARDIAN_DIFFERENCE_SENDS) {
    const at = writer.indexOf(`async function ${name}(`);
    if (at < 0) { problems.push(`${ROSTER_WRITER} doesn't define ${name}()`); continue; }
    const end = writer.indexOf("\n}\n", at);
    const body = writer.slice(at, end < 0 ? undefined : end);
    for (const forbidden of GUARDIAN_SENDS) if (new RegExp(`\\b${forbidden}\\b`).test(body)) problems.push(`${name}() names ${forbidden}: a difference's send overwrites only what the row showed`);
  }
  return problems;
}
/** A copy of the writer with sendToBooks()'s block (to portalValueStamp()) changed by `change`, for the cases a check must refuse. */
function inSendBlock(writerText: string, change: (block: string) => string): string {
  const start = writerText.indexOf(`export async function ${SEND}(`), end = writerText.indexOf("export function portalValueStamp(");
  return writerText.slice(0, start) + change(writerText.slice(start, end)) + writerText.slice(end);
}
describe("what the portal writes to QuickBooks, and who may send each", () => {
  const everything = read("src");
  // src/lib/money reads invoices for parents, and src/lib/parents/contact-edits.ts, which changed a parent's own record
  // until stage 3's slice 11a and names none of the client's writes since (contactEditsProblems()), and email-change.ts:
  // scanned with the rest, on purpose. src/lib/accounting (stage 4's slice M3a: the link presses take the client's own
  // isQboId(), and send nothing) is scanned too, so nothing there ever names a write. A new folder that calls QuickBooks
  // is found by the test below.
  const sources = [...read("src/lib/quickbooks"), ...read("src/lib/roster"), ...read("src/lib/jobs"), ...read("src/lib/money"), ...read("src/lib/buyouts"), ...read("src/lib/accounting"),
    ...everything.filter((s) => s.file === CONTACT_EDITS || s.file === CONTACT_QUEUE || s.file === EMAIL_CHANGE)];
  const clientSource = sources.find((s) => s.file === CLIENT)!.text;
  const client = code(clientSource);
  const contactEdits = sources.find((s) => s.file === CONTACT_EDITS)!.text;
  const contactQueue = sources.find((s) => s.file === CONTACT_QUEUE)!.text;
  const emailChange = sources.find((s) => s.file === EMAIL_CHANGE)!.text;
  const bodyOf = (name: string) => {
    const body = exportedFunction(clientSource, name);
    expect(body, `${CLIENT} has no exported function ${name}`).not.toBe("");
    return body;
  };

  it("finds the QuickBooks code", () => {
    expect(sources.length).toBeGreaterThan(2);
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining([CLIENT, "src/lib/money/family-money.ts", CONTACT_EDITS, EMAIL_CHANGE]));
  });

  it("scans every module that calls the QuickBooks client", () => {
    const callsClient = (text: string, file: string) => /from\s*["'][^"']*quickbooks\/client["']/.test(text) || (file.startsWith("src/lib/quickbooks/") && /from\s*["']\.\/client["']/.test(text));
    const callers = everything.filter((s) => callsClient(code(s.text), s.file));
    expect(callers.map((s) => s.file)).toEqual(expect.arrayContaining(["src/lib/roster/refresh.ts", "src/lib/quickbooks/connection.ts"]));
    const unscanned = callers.map((s) => s.file).filter((f) => !sources.some((s) => s.file === f));
    expect(unscanned, `These modules call the QuickBooks client and are not scanned here: ${unscanned.join(", ")}. Add their folder to \`sources\` in tests/unit/quickbooks-writes.test.ts.`).toEqual([]);
  });

  it("still has no PUT, PATCH or DELETE, and never a request whose method it can't read", () => {
    for (const s of sources) {
      expect(s.text, s.file).not.toMatch(/["']?method["']?\s*:\s*["'](PUT|PATCH|DELETE)["']/i);
      // Every request is a fetch call with `method: "GET"` or `method: "POST"` written in it: a method that is a
      // variable, a shorthand, a computed key or part of an options object built elsewhere could be anything.
      expect(requestProblems(s.text), s.file).toEqual([]);
    }
  });

  it("writes nothing to the log, so no token, request or response body can end up there", () => {
    // The one line: the discovery document's fallback, with the environment and a fixed reason word only.
    const DISCOVERY = "src/lib/quickbooks/discovery.ts";
    for (const s of sources) if (s.file !== DISCOVERY) expect(s.text, s.file).not.toMatch(/console\.\w+\(/);
    const discovery = sources.find((s) => s.file === DISCOVERY)!.text;
    expect(discovery.match(/console\.\w+\([^\n]*/g)).toEqual(['console.warn(JSON.stringify({ event: "quickbooks.discovery_fallback", environment, reason: read }));']);
    expect(discovery).toMatch(/async function readDocument\(address: string\): Promise<OAuthEndpoints \| string>/);
  });

  it("sends nothing but GET, except to Intuit's token and revoke endpoints and the one customer update", () => {
    const posts = sources.flatMap((s) => Array.from({ length: postsIn(s.text) }, () => s.file));
    // The token request, the customer update, the email update, the roster writes' sender and the invoice writes'
    // sender in the client; the revoke in the connection; the signed call to Boosters Rocket Connect, the relay
    // (Connect through Boosters Rocket's slice 1), which reaches the relay's address alone and never QuickBooks' API.
    expect(posts.sort()).toEqual([CLIENT, CLIENT, CLIENT, CLIENT, CLIENT, "src/lib/quickbooks/connection.ts", "src/lib/quickbooks/relay.ts"]);
    const relay = sources.find((s) => s.file === "src/lib/quickbooks/relay.ts")!.text;
    expect(fetchCalls(relay)).toHaveLength(1);
    expect(fetchCalls(relay)[0]).toContain("`${qboRelayUrl()}${path}`");
    const methods = (text: string) => methodsIn(text).map((m) => m.is);
    expect(methods(bodyOf("tokenRequest"))).toEqual(["POST"]);
    expect(bodyOf("tokenRequest")).toContain("(await oauthEndpoints(environment)).token"); // Intuit's discovery document, or its checked fallback
    expect(methods(bodyOf(WRITE))).toEqual(["POST"]);
    // Everything else in the client that reaches the API is a GET: qboGet, and what is built on it.
    expect(methods(bodyOf("qboGet"))).toEqual(["GET"]);
    expect(methods(bodyOf(EMAIL_WRITE))).toEqual(["POST"]);
    expect(methods(clientSource)).toEqual(["POST", "GET", "POST", "POST", "POST", "POST"]);
  });

  it("can send the update to the customer endpoint only, with nothing in it but an Id, a SyncToken, the phone and the billing address", () => {
    const write = bodyOf(WRITE);
    // Its address is the constant's, not an argument: the function takes no path.
    expect(write).toContain("/${CUSTOMER_UPDATE.path}`");
    expect(/export async function \w+\(([^)]*)\)/.exec(write)![1]).not.toMatch(/\bpath\b|\burl\b|\bbody\b/);
    expect(write).toContain("JSON.stringify(CUSTOMER_UPDATE.body(customerId, syncToken, change))");
    expect(client).toContain("export const CUSTOMER_UPDATE = {");
    // The fields the body can carry, and no way to carry another: `sparse: true` keeps every field not sent as it was.
    expect(bodyProblems(updateConstant(clientSource))).toEqual([]);
  });

  it("lets only the check of the portal's requests send it, and only the parent's own action save through the contact edits", () => {
    const naming = (name: string) => everything.filter((s) => new RegExp(`\\b${name}\\b`).test(code(s.text))).map((s) => s.file).sort();
    expect(naming(WRITE), `${WRITE} is sent by the roster's write module alone (stage 3's slice 11b). A new caller is a decision for a slice brief, not a fix made in passing.`).toEqual([...MAY_SEND_THE_WRITE].sort());
    // In the write module: imported once, called once, inside its one send.
    const writer = code(everything.find((s) => s.file === ROSTER_WRITER_OF_CONTACT)?.text ?? "");
    expect([...writer.matchAll(new RegExp(`\\b${WRITE}\\b`, "g"))]).toHaveLength(2);
    expect(writer.slice(writer.indexOf("export async function sendWrite("), writer.indexOf("\nconst AUDIT_ACTION"))).toMatch(new RegExp(`\\b${WRITE}\\(`));
    expect(naming(SAVE)).toEqual([...MAY_SAVE].sort());
    // Nobody reaches the client's write by taking the module whole.
    for (const s of everything) expect(code(s.text), s.file).not.toMatch(/import\s*\*\s*as\s+\w+\s+from\s*["'][^"']*quickbooks\/client["']|import\(\s*["'][^"']*quickbooks\/client["']\s*\)|require\(\s*["'][^"']*quickbooks\/client["']\s*\)/);
  });

  it("the contact edits send nothing to QuickBooks, and the module is no way to it (stage 3's slice 11a)", () => {
    // A guardian's phone and address are the portal's own: the contact edits import nothing from the client, name none
    // of its writes, and export nothing but their two functions, their copy and their types.
    expect(contactEditsProblems(contactEdits)).toEqual([]);
    // Since stage 3's slice 11b the save queues each change in its own transaction, through a parent-facing module that
    // is no way to QuickBooks either: it imports nothing from the client and names none of its writes, nor the roster's
    // write module or the queue, which send it (the worker's, through trySavedItem()).
    const queueText = code(contactQueue);
    expect(queueText).not.toMatch(/quickbooks\/client|roster\/(writes|queue)["']/);
    for (const name of [...CLIENT_WRITES, ROSTER_SEND, SAVED_TRY]) expect(queueText, name).not.toMatch(new RegExp(`\\b${name}\\b`));
    // The client itself only defines the write: nothing in it calls it.
    expect([...client.matchAll(new RegExp(`\\b${WRITE}\\b`, "g"))]).toHaveLength(1);
  });

  it("can send the email update to the customer endpoint only, with nothing in it but an Id, a SyncToken and the email field", () => {
    const write = bodyOf(EMAIL_WRITE);
    expect(write).toContain("/${EMAIL_UPDATE.path}`");
    expect(/export async function \w+\(([^)]*)\)/.exec(write)![1]).not.toMatch(/\bpath\b|\burl\b|\bbody\b/);
    expect(write).toContain("JSON.stringify(EMAIL_UPDATE.body(customerId, syncToken, field))");
    expect(emailBodyProblems(emailUpdateConstant(clientSource))).toEqual([]);
  });

  it("lets only the check of the portal's requests and the roster's write module send the email write, and only the parent's own action confirm a change of sign-in email", () => {
    const naming = (name: string) => everything.filter((s) => new RegExp(`\\b${name}\\b`).test(code(s.text))).map((s) => s.file).sort();
    expect(naming(EMAIL_WRITE), `${EMAIL_WRITE} is the portal's second write to QuickBooks. A new caller is a decision for a slice brief, not a fix made in passing.`).toEqual([...MAY_SEND_THE_EMAIL_WRITE].sort());
    // In the roster's write module (stage 3's slice S11e): imported once, called once, inside its one send.
    const writer = code(everything.find((s) => s.file === ROSTER_WRITER_OF_CONTACT)?.text ?? "");
    expect([...writer.matchAll(new RegExp(`\\b${EMAIL_WRITE}\\b`, "g"))]).toHaveLength(2);
    expect(writer.slice(writer.indexOf("export async function sendWrite("), writer.indexOf("\nconst AUDIT_ACTION"))).toMatch(new RegExp(`\\b${EMAIL_WRITE}\\(`));
    // The module that queues it in the confirm's transaction is no way to QuickBooks: no client, no write, no send.
    const queueText = code(contactQueue);
    expect(queueText).not.toMatch(/quickbooks\/client|roster\/(writes|queue)["']/);
    for (const name of [...CLIENT_WRITES, ROSTER_SEND, SAVED_TRY]) expect(queueText, name).not.toMatch(new RegExp(`\\b${name}\\b`));
    expect(naming(CONFIRM)).toEqual([...MAY_CONFIRM].sort());
    // Since stage 3's slice 11d the email change sends nothing to QuickBooks, and the module is no way to it.
    expect(emailChangeProblems(emailChange)).toEqual([]);
    expect([...client.matchAll(new RegExp(`\\b${EMAIL_WRITE}\\b`, "g"))]).toHaveLength(1);
  });

  describe("and the staff roster writes, sent from one place, for the roster's own records (roadmap step 5)", () => {
    const naming = (name: string) => everything.filter((s) => new RegExp(`\\b${name}\\b`).test(code(s.text))).map((s) => s.file).sort();
    const writer = code(everything.find((s) => s.file === ROSTER_WRITER)?.text ?? "");

    it("are sent by one private function of the client, a POST to the customer endpoint", () => {
      const sender = client.slice(client.indexOf("async function sendRosterWrite("), client.indexOf("\nexport async function qboCreateCustomer("));
      expect(methodsIn(sender).map((m) => m.is)).toEqual(["POST"]);
      expect(sender).toContain("/${CUSTOMER_WRITES.path}`");
      // Defined once, and called once by each of the four writes: nothing else reaches it.
      expect([...client.matchAll(/\bsendRosterWrite\b/g)]).toHaveLength(1 + ROSTER_WRITES.length);
      expect(client).not.toMatch(/export\s+(async\s+)?function\s+sendRosterWrite|export\s*\{[^}]*sendRosterWrite/);
    });

    it("each build their body from CUSTOMER_WRITES, refuse an id that isn't one, and carry nothing but their fields", () => {
      for (const name of ROSTER_WRITES) {
        const body = bodyOf(name);
        expect(body, name).toContain(`return sendRosterWrite(CUSTOMER_WRITES.${ROSTER_BODY[name as keyof typeof ROSTER_BODY]}(`);
        expect(body, name).toMatch(/if \(!isQboId\(/);
        expect(/export async function \w+\(([^)]*)\)/.exec(body)![1], name).not.toMatch(/\bpath\b|\burl\b|\bbody\b|\bpayload\b/);
      }
      expect(rosterBodyProblems(rosterWritesConstant(clientSource))).toEqual([]);
    });

    it("are named by the client and the roster's write module alone, and reached only from the staff roster actions and the queue", () => {
      for (const name of ROSTER_WRITES) {
        expect(naming(name), `${name} is a roster write. A new caller is a decision for a slice brief, not a fix made in passing.`).toEqual([...MAY_SEND_ROSTER_WRITES].sort());
        // In the write module: imported once, called once, inside its send.
        expect([...writer.matchAll(new RegExp(`\\b${name}\\b`, "g"))], name).toHaveLength(2);
      }
      const send = writer.slice(writer.indexOf(`export async function ${ROSTER_SEND}(`), writer.indexOf("\nconst AUDIT_ACTION"));
      for (const name of ROSTER_WRITES) expect(send, name).toMatch(new RegExp(`\\b${name}\\(`));
      expect(naming(ROSTER_SEND)).toEqual([...MAY_ROSTER_SEND].sort());
      expect(naming(ROSTER_ASK)).toEqual([...MAY_ROSTER_ASK].sort());
      expect(naming(ROSTER_LINK), `${ROSTER_LINK} sends creates to QuickBooks. A new caller is a decision for a slice brief.`).toEqual([...MAY_ROSTER_LINK].sort());
      expect(naming(ROSTER_ADD), `${ROSTER_ADD} sends a family's create to QuickBooks. A new caller is a decision for a slice brief.`).toEqual([...MAY_ROSTER_ADD].sort());
      for (const name of SAVED_FIRST) expect(naming(name), `${name} sends a change saved in the portal first. A new caller is a decision for a slice brief.`).toEqual([...MAY_SAVED_FIRST].sort());
      expect(naming(SAVED_FIRST_ADD), `${SAVED_FIRST_ADD} sends a change saved in the portal first. A new caller is a decision for a slice brief.`).toEqual([...MAY_SAVED_FIRST_ADD].sort());
      expect(naming(RENAME_TRY), `${RENAME_TRY} sends a rename, and resends it once after a live read. A new caller is a decision for a slice brief.`).toEqual([...MAY_RENAME_TRY].sort());
      expect(naming(ROSTER_DEACTIVATE), `${ROSTER_DEACTIVATE} makes a linked record inactive in QuickBooks. A new caller is a decision for a slice brief.`).toEqual([...MAY_ROSTER_DEACTIVATE].sort());
      expect(naming(TAKE), `${TAKE} takes the books' value into the portal and sends nothing to QuickBooks. A new caller is a decision for a slice brief.`).toEqual([...MAY_TAKE].sort());
      expect(naming(SAVED_TRY), `${SAVED_TRY} sends a change saved first and settles its queue item. A new caller is a decision for a slice brief.`).toEqual([...MAY_SAVED_TRY].sort());
      for (const name of GUARDIAN_SENDS) expect(naming(name), `${name} queues or sends a guardian's Parent customer change. A new caller is a decision for a slice brief.`).toEqual([...(MAY_GUARDIAN_QUEUE[name] ?? MAY_GUARDIAN_SEND)].sort());
      expect(naming(GUARDIAN_EVENT), `${GUARDIAN_EVENT} queues a guardian's Parent customer change through QuickBooks' handler. A new caller is a decision for a slice brief.`).toEqual([...MAY_GUARDIAN_EVENT].sort());
      expect(naming(DETAILS_EVENT), `${DETAILS_EVENT} queues a change of a person's or a family's details through QuickBooks' handler. A new caller is a decision for a slice brief.`).toEqual([...MAY_DETAILS_EVENT].sort());
      expect(naming(CONTACT_SEND), `${CONTACT_SEND} sends a staff member's change of a guardian's details at once. A new caller is a decision for a slice brief.`).toEqual([...MAY_CONTACT_SEND].sort());
    });

    it("refuse a body that could carry another field", () => {
      const constant = rosterWritesConstant(clientSource);
      const refused = [
        constant.replace("sparse: true, DisplayName: name", "sparse: true, DisplayName: name, ...extra"),
        constant.replace("Active: active }", "Active: active, Balance: 0 }"),
        constant.replace("sparse: true, Active", "sparse: false, Active"),
        constant.replace(`path: "customer",`, `path: "invoice",`),
        constant.replace("DisplayName: c.name,", `["DisplayName"]: c.name,`),
      ];
      for (const source of refused) {
        expect(source, "the case didn't change the constant").not.toBe(constant);
        expect(rosterBodyProblems(source), source).not.toEqual([]);
      }
    });
  });

  describe("and the buy-out invoice writes, the only invoices the portal makes (roadmap step 6)", () => {
    const naming = (name: string) => everything.filter((s) => new RegExp(`\\b${name}\\b`).test(code(s.text))).map((s) => s.file).sort();
    const writer = code(everything.find((s) => s.file === BUYOUT_WRITER)?.text ?? "");

    it("are sent by one private function of the client, a POST to the invoice endpoint", () => {
      const sender = client.slice(client.indexOf("async function sendInvoiceWrite("), client.indexOf("\nexport async function qboCreateInvoice("));
      expect(methodsIn(sender).map((m) => m.is)).toEqual(["POST"]);
      expect(sender).toContain("/${INVOICE_WRITES.path}`");
      expect(sender).toContain(`url.searchParams.set("operation", INVOICE_WRITES.voidOperation)`);
      expect([...client.matchAll(/\bsendInvoiceWrite\b/g)]).toHaveLength(1 + INVOICE_WRITE_FUNCTIONS.length);
      expect(client).not.toMatch(/export\s+(async\s+)?function\s+sendInvoiceWrite|export\s*\{[^}]*sendInvoiceWrite/);
    });

    it("each build their body from INVOICE_WRITES, refuse an id that isn't one, and carry nothing but their fields", () => {
      for (const name of INVOICE_WRITE_FUNCTIONS) {
        const body = bodyOf(name);
        expect(body, name).toContain(`return sendInvoiceWrite(INVOICE_WRITES.${INVOICE_BODY[name as keyof typeof INVOICE_BODY]}(`);
        expect(body, name).toMatch(/if \(!isQboId\(/);
        expect(/export async function \w+\(([^)]*)\)/.exec(body)![1], name).not.toMatch(/\bpath\b|\burl\b|\bbody\b|\bpayload\b/);
      }
      expect(invoiceBodyProblems(invoiceWritesConstant(clientSource))).toEqual([]);
    });

    it("are named by the client and the buy-out module alone, sent from the module and the queue, and asked for from the parent's own actions", () => {
      for (const name of INVOICE_WRITE_FUNCTIONS) {
        expect(naming(name), `${name} is a buy-out invoice write. A new caller is a decision for a slice brief, not a fix made in passing.`).toEqual([...MAY_SEND_INVOICE_WRITES].sort());
        expect([...writer.matchAll(new RegExp(`\\b${name}\\b`, "g"))], name).toHaveLength(2);
      }
      expect(naming(BUYOUT_SEND)).toEqual([...MAY_BUYOUT_SEND].sort());
      for (const ask of BUYOUT_ASKS) expect(naming(ask), ask).toEqual([...MAY_BUYOUT_ASK].sort());
      // Both writes are called inside the module's send, and nowhere else in it.
      const send = writer.slice(writer.indexOf(`export async function ${BUYOUT_SEND}(`), writer.indexOf("\nasync function queueItem("));
      for (const name of INVOICE_WRITE_FUNCTIONS) expect(send, name).toMatch(new RegExp(`\\b${name}\\(`));
    });

    it("send a bill-to email address only from the check of the portal's requests and the buy-out writer, which sends the chooser's own", () => {
      // The one optional field of the create (InvoiceCreate.billEmail). The check's Pay link probe gives its own address
      // at example.com; since the owner's decision of 2026-11-17 the buy-out writer gives the sign-in address of the
      // guardian who chose the buy-out, from their session, kept with the queued create (its type, in the schema). Nobody else.
      const giving = everything.filter((s) => s.file !== CLIENT && /\bbillEmail\b/.test(code(s.text))).map((s) => s.file).sort();
      expect(giving, "billEmail is a bill-to address QuickBooks keeps. A new giver is a decision for a slice brief, not a fix made in passing.")
        .toEqual([CHECK_WRITER, `${CHECK_FOLDER}run.ts`, BUYOUT_WRITER, SCHEMA].sort());
      // In the schema it is the queued create's field alone.
      const schema = code(everything.find((s) => s.file === SCHEMA)!.text);
      expect([...schema.matchAll(/\bbillEmail\b/g)]).toHaveLength(1);
      expect(schema).toMatch(/\{ op: "invoice_create"; [^}\n]*; billEmail\?: string \}/);
      // In the buy-out writer: the session's own address put on the queued create, and that item's address sent.
      const source = everything.find((s) => s.file === BUYOUT_WRITER)!.text;
      expect(buyoutBillEmailProblems(source)).toEqual([]);
      const refused = [
        source.replace(BUYOUT_BILL_EMAIL.put, "billEmail: String(stamp)"),                       // from the browser
        source.replace(BUYOUT_BILL_EMAIL.put, "billEmail: customer.email"),                      // looked up
        source.replace(BUYOUT_BILL_EMAIL.sent, "billEmail: b.chosenByLabel"),                    // looked up again at each try
        source.replace(`${BUYOUT_BILL_EMAIL.sent} }`, "billEmail: w.billEmail, BillEmail: { Address: w.billEmail } }"),
        source.replace("  if (!t || t.view.subjectStamp !== subject) return no(BUYOUT_COPY.notFromPage);", "  if (!t || t.view.subjectStamp !== subject) return no(BUYOUT_COPY.notFromPage);\n  ctx.email = String(key);"), // the session's address replaced
        `${source}\nexport async function alsoBill(item: Item) { return qboCreateInvoice({ ...item.request, billEmail: "anyone@example.org" } as never, { realmId: "1", mayWait: true }); }\n`,
      ];
      for (const s of refused) {
        expect(s, `case ${refused.indexOf(s)} didn't change the module`).not.toBe(source);
        expect(buyoutBillEmailProblems(s), `case ${refused.indexOf(s)}`).not.toEqual([]);
      }
    });

    it("refuse a body that could carry another field, or go elsewhere", () => {
      const constant = invoiceWritesConstant(clientSource);
      const refused = [
        constant.replace("SyncToken: syncToken })", "SyncToken: syncToken, ...extra })"),
        constant.replace(`EmailStatus: "NotSet",`, `EmailStatus: "NeedToSend",`),
        constant.replace(`EmailStatus: "NotSet",`, `EmailStatus: "NotSet", BillEmail: { Address: c.email },`),
        constant.replace(`path: "invoice",`, `path: "customer",`),
        constant.replace("PrivateNote:", `["PrivateNote"]:`),
        constant.replace(`voidOperation: "void",`, `voidOperation: "delete",`),
      ];
      for (const source of refused) {
        expect(source, "the case didn't change the constant").not.toBe(constant);
        expect(invoiceBodyProblems(source), source).not.toEqual([]);
      }
    });
  });

  describe("and the check of the portal's requests, sent only to an Intuit sandbox and only for its own records (roadmap step 7)", () => {
    const naming = (name: string) => everything.filter((s) => new RegExp(`\\b${name}\\b`).test(code(s.text))).map((s) => s.file).sort();
    const writer = everything.find((s) => s.file === CHECK_WRITER)?.text ?? "";
    const check = everything.filter((s) => s.file.startsWith(CHECK_FOLDER));

    it("is scanned with the QuickBooks code, and calls each write once, after its guard", () => {
      expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(check.map((s) => s.file)));
      expect(check.map((s) => s.file)).toContain(CHECK_WRITER);
      expect(checkWriterProblems(writer)).toEqual([]);
      // No module of the check but its writer names a write.
      for (const s of check.filter((x) => x.file !== CHECK_WRITER)) for (const name of ALL_WRITES) expect(code(s.text), `${s.file} names ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
    });

    it("refuses a company that isn't an Intuit sandbox in the action that starts it, and again in its guard", () => {
      // The action asks for the writes only for a sandbox connection; the guard reads the connection again before each one.
      const action = code(everything.find((s) => s.file === MAY_START_CHECK[1])!.text);
      expect(action).toContain(`const writes = ready.environment === "sandbox";`);
      expect(action).toContain("runSandboxCheck({ staffUserId: ctx.staffUserId, label: ctx.email, ip: ctx.ip, writes })");
      expect(action).toMatch(/export const runCheckAction = staffAction\(P, /);
      expect(action).toContain(`const P = "Settings.QuickBooks.ReadWrite" as const;`);
      const guard = code(writer).slice(code(writer).indexOf(CHECK_GUARD));
      expect(guard.indexOf("const c = await getConnection();")).toBeGreaterThan(0);
      expect(guard.indexOf(`if (environmentOf(c, c.tokenMode) !== "sandbox") throw`)).toBeGreaterThan(guard.indexOf("const c = await getConnection();"));
      const run = code(everything.find((s) => s.file === MAY_START_CHECK[0])!.text);
      expect(run).toContain(`ask.writes && ready.environment === "sandbox"`);
    });

    it("is started only from its own Admin action", () => {
      expect(naming(CHECK_RUN), `${CHECK_RUN} runs the check. Another caller is a decision for a slice brief.`).toEqual([...MAY_START_CHECK].sort());
    });

    it("never uses the write queue, the roster cache or the reconcile, and writes no table but its own", () => {
      for (const s of check) {
        const text = code(s.text);
        expect(text, s.file).not.toMatch(/\b(writeQueue|reconcileAccess|refreshRoster|sendWrite|askRosterWrite|sendBuyoutWrite|clearRosterOfOtherCompanyLocked|setRosterSource)\b/);
        expect(text, s.file).not.toMatch(/from\s*["']@\/lib\/(roster\/(queue|writes|refresh)|buyouts\/|parents\/(reconcile|contact-edits|email-change))/);
        expect(text, s.file).not.toMatch(/import\s*\{[^}]*\bqboCustomer(Type)?\b[^}]*\}\s*from\s*["']@\/lib\/db\/schema["']/);
        for (const m of text.matchAll(/\.(insert|update|delete)\((\w+)\)/g)) expect(["qboCheckRun", "qboCheckRecord"], `${s.file} writes ${m[2]}`).toContain(m[2]);
        expect(text, s.file).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+qbo_customer/i);
      }
    });

    it("refuses a write path that could reach a company that isn't a sandbox, or a record it didn't make", () => {
      const cut = writer.indexOf(CHECK_GUARD);
      const inGuard = (from: string, to: string) => writer.slice(0, cut) + writer.slice(cut).replace(from, to);
      const refused = [
        inGuard(`if (environmentOf(c, c.tokenMode) !== "sandbox") throw`, `if (environmentOf(c, c.tokenMode) === "staging") throw`),
        inGuard("if (c.realmId !== run.realmId) throw", "if (!c.realmId) throw"),
        inGuard("if (!row || row.runId !== (t.runId ?? run.id)) throw", "if (!row) throw"),
        writer.replace("  await allowed(run, [target]);\n  return qboUpdateCustomerContact(", "  return qboUpdateCustomerContact("),
        writer.replace("  await allowed(run, [target]);\n  return qboUpdateCustomerEmail(", "  void allowed(run, [target]);\n  return qboUpdateCustomerEmail("),
        `${writer}\nexport async function alsoRename(run: CheckRun, id: string) {\n  await allowed(run, []);\n  return qboRenameCustomer(id, "0", "x", { realmId: run.realmId });\n}\n`,
        `${writer}\nexport const sendVoid = qboVoidInvoice;\n`,
        writer.replace("async function allowed(", "export async function allowed("),
      ];
      for (const source of refused) {
        expect(source, "the case didn't change the module").not.toBe(writer);
        expect(checkWriterProblems(source), `case ${refused.indexOf(source)}`).not.toEqual([]);
      }
    });
  });

  describe("and these checks refuse what would get past a careless scan", () => {
    const fetchWith = (init: string, before = "") => `${before}\nexport async function send(url: string) { return fetch(url, ${init}); }\n`;

    it("a request method that isn't written out as GET or POST", () => {
      expect(requestProblems(fetchWith(`{ method: "GET", headers: { accept: "application/json" } }`))).toEqual([]);
      expect(requestProblems(fetchWith(`{ method: "POST", body }`))).toEqual([]);
      const refused = [
        fetchWith(`{ method }`, `const method = "PUT";`),                    // shorthand
        fetchWith(`{ method, body }`, `const method = "P" + "UT";`),
        fetchWith(`{ ["method"]: "DELETE" }`),                              // computed key
        fetchWith(`{ "method": "PATCH" }`),                                 // quoted key
        fetchWith(`{ method: verb }`, `const verb = "PUT";`),               // a variable
        fetchWith(`{ method: "P" + "UT" }`),                                // built from parts
        fetchWith(`{ method: "put" }`),
        fetchWith(`{ method: \`PUT\` }`),
        fetchWith(`init`, `const init = { method: "POST" };`),              // options built to one side
        fetchWith(`{ ...init }`, `const init = { method: "POST" };`),
        fetchWith(`init`, `const init: RequestInit = {}; init.method = "DELETE";`),
        fetchWith(`{ ...WRITE_OPTIONS }`),                                  // options from a module this test doesn't scan
        fetchWith(`options`),
        `export const send = (url: string) => fetch(new Request(url, { method: "POST" }));`,
        `import { request } from "node:https";\nexport const send = (url: string) => request(url, { method: "POST" });`,
      ];
      for (const source of refused) expect(requestProblems(source), source).not.toEqual([]);
    });

    it("a fetch call is read whole, through strings and templates with brackets in them", () => {
      const call = "fetch(`${base}/v3/company/${encodeURIComponent(realm)}/customer`, { method: \"POST\", headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString(\"base64\")}` }, body: \")\" })";
      expect(fetchCalls(`const res = await ${call};\nconst next = 1;`)).toEqual([call]);
      expect(fetchCalls(clientSource)).toHaveLength(6);
    });

    it("a way to QuickBooks through the contact edits", () => {
      expect(contactEditsProblems(contactEdits)).toEqual([]);
      const added = (more: string) => `${contactEdits}\n${more}\n`;
      const cut = contactEdits.indexOf(`export async function ${SAVE}(`);
      const refused = [
        // The write imported and called, from a function of its own or from the save.
        added(`import { qboUpdateCustomerContact } from "@/lib/quickbooks/client";\nasync function alsoSend(qboId: string) { return qboUpdateCustomerContact(qboId, "0", { phone: "" }, { realmId: "1" }); }`),
        added(`async function viaImport(qboId: string) { const c = await import("@/lib/quickbooks/client"); return c.qboUpdateCustomerContact(qboId, "0", {}, { realmId: "1" }); }`),
        contactEdits.slice(0, cut) + contactEdits.slice(cut).replace("const parsed = parseContactForm(input);", "const parsed = parseContactForm(input);\n  await qboUpdateCustomerEmail(\"1\", \"0\", \"\", { realmId: \"1\" });"),
        added(`import { qboRenameCustomer as rename } from "@/lib/quickbooks/client";`),
        // A second way in: another export, a re-export, a default.
        added(`export async function staffSaveContact(parentId: string, input: unknown) { return { parentId, input }; }`),
        added(`export { saveMyContact as save };`),
        added(`export * from "@/lib/quickbooks/client";`),
        added(`export default saveMyContact;`),
        // The save taking something else first.
        contactEdits.replace(`export async function ${SAVE}(ctx: ParentCtx, `, `export async function ${SAVE}(parentId: string, ctx: ParentCtx, `),
      ];
      for (const source of refused) {
        expect(source, "the case didn't change the module").not.toBe(contactEdits);
        expect(contactEditsProblems(source), `case ${refused.indexOf(source)}`).not.toEqual([]);
      }
    });

    it("a way to QuickBooks through the email change", () => {
      expect(emailChangeProblems(emailChange)).toEqual([]);
      const added = (more: string) => `${emailChange}\n${more}\n`;
      const cut = emailChange.indexOf(`export async function ${CONFIRM}(`);
      const inConfirm = (from: string, to: string) => emailChange.slice(0, cut) + emailChange.slice(cut).replace(from, to);
      const FINISH = "const finish = () => db.transaction(async (tx)";
      const refused = [
        // The email write imported and called, from a function of its own or from the confirmation.
        added(`import { qboUpdateCustomerEmail } from "@/lib/quickbooks/client";\nasync function alsoSend(qboId: string) { return qboUpdateCustomerEmail(qboId, "0", "a@b.org", { realmId: "1" }); }`),
        added(`async function viaImport(qboId: string) { const c = await import("@/lib/quickbooks/client"); return c.qboUpdateCustomerEmail(qboId, "0", "", { realmId: "1" }); }`),
        inConfirm(FINISH, `await qboUpdateCustomerEmail("1", "0", row.newEmail, { realmId: "1" });\n  ${FINISH}`),
        added(`import { qboRenameCustomer as rename } from "@/lib/quickbooks/client";`),
        // A second way in: another export, a re-export, a default.
        added(`export async function staffSetEmail(parentId: string, email: string) { return { parentId, email }; }`),
        added(`export const sendEmail = confirmMyEmailChange;`),
        added(`export { confirmMyEmailChange as confirm };`),
        added(`export * from "@/lib/quickbooks/client";`),
        added(`export default confirmMyEmailChange;`),
        // The confirmation taking something else first.
        emailChange.replace(`export async function ${CONFIRM}(ctx: ParentCtx, `, `export async function ${CONFIRM}(parentId: string, ctx: ParentCtx, `),
      ];
      for (const source of refused) {
        expect(source, "the case didn't change the module").not.toBe(emailChange);
        expect(emailChangeProblems(source), `case ${refused.indexOf(source)}`).not.toEqual([]);
      }
    });

    it("an email body that could carry another field", () => {
      const constant = emailUpdateConstant(clientSource);
      expect(emailBodyProblems(constant)).toEqual([]);
      const refused = [
        constant.replace("sparse: true,", "sparse: true, ...extra,"),
        constant.replace("sparse: true,", "sparse: false,"),
        constant.replace("PrimaryEmailAddr: { Address: field },", "PrimaryEmailAddr: { Address: field }, DisplayName: field,"),
        constant.replace("PrimaryEmailAddr: { Address: field },", `PrimaryEmailAddr: { Address: field }, ["Notes"]: field,`),
        constant.replace("field: string) => ({", "field: string, extra: object) => ({"),
        constant.replace(`path: "customer",`, `path: "invoice",`),
      ];
      for (const source of refused) {
        expect(source, "the case didn't change the constant").not.toBe(constant);
        expect(emailBodyProblems(source), source).not.toEqual([]);
      }
    });

    it("a body that could carry another field", () => {
      const constant = updateConstant(clientSource);
      expect(bodyProblems(constant)).toEqual([]);
      const refused = [
        constant.replace("sparse: true,", "sparse: true, ...extra,"),
        constant.replace("sparse: true,", "sparse: true, ...change,"),
        constant.replace("Country: change.address.country,", "Country: change.address.country, ...change.address.more,"),
        constant.replace("sparse: true,", "sparse: true, PrimaryEmailAddr: { Address: change.email },"),
        constant.replace("sparse: true,", `sparse: true, ["DisplayName"]: change.name,`),
        constant.replace("sparse: true,", "sparse: false,"),
        constant.replace("change: CustomerContactChange) => ({", "change: CustomerContactChange, extra: object) => ({"),
        constant.replace(`path: "customer",`, `path: "invoice",`),
      ];
      for (const source of refused) {
        expect(source, "the case didn't change the constant").not.toBe(constant);
        expect(bodyProblems(source), source).not.toEqual([]);
      }
    });
  });

  describe("and never a customer made active again (open question 12)", () => {
    it("the roster's write module calls the active flag write once, with false, and nothing else in src but the client and the check names it", () => {
      expect(activeFlagProblems(everything)).toEqual([]);
    });

    it("a send from a difference is started only by the accounting links screen's press, and a new caller is found", () => {
      const naming = (sources: { file: string; text: string }[]) => sources.filter((s) => new RegExp(`\\b${SEND}\\b`).test(code(s.text))).map((s) => s.file).sort();
      const why = `${SEND} sends a difference's portal value to QuickBooks, only through the saved-first try and the make-inactive's try. A new caller is a decision for a slice brief.`;
      expect(naming(everything), why).toEqual([...MAY_SEND].sort());
      const another = [...everything, { file: "src/app/staff/(app)/roster/send-actions.ts", text: `import { ${SEND} } from "@/lib/roster/writes";\nexport const go = () => ${SEND};\n` }];
      expect(naming(another)).not.toEqual([...MAY_SEND].sort());
      // The send itself names no client write: it goes through the module's own tries.
      const writerSource = everything.find((s) => s.file === ROSTER_WRITER)!.text;
      expect(sendBlockProblems(writerSource)).toEqual([]);
      // Each check proved on a copy of the writer it must refuse: sendWrite() or a client write inside the block, a try
      // taken out of it, or the block's end moved above its start.
      const intoSendName = (line: string) => writerSource.replace(/(async function sendName\([^\n]*\{\n)/, `$1${line}\n`);
      const cases = [
        intoSendName(`  await sendWrite({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "x", was: "y" }, "", {});`),
        intoSendName(`  await qboRenameCustomer("10", "0", "x", {} as never);`),
        writerSource.replaceAll("tryDeactivate(", "tryDeactivateElsewhere("),
        `export function portalValueStamp(): void {}\n${writerSource.replace("export function portalValueStamp(", "function portalValueStampMoved(")}`,
        // Slice M5b: the family reached through its press's entry, its checks or its sender, or not through its body at all.
        inSendBlock(writerSource, (b) => b.replaceAll(`${SEND_FAMILY}(`, "askFamilyInactive(")),
        inSendBlock(writerSource, (b) => b.replaceAll(`${SEND_FAMILY}(`, "familyInactiveElsewhere(")),
        intoSendName(`  void prepareFamily;`),
        intoSendName(`  void sendDeactivate;`),
        // Slice M3c4: a guardian's send not defined in the block (moved out of it, or gone).
        inSendBlock(writerSource, (b) => b.replace("async function sendGuardianName(", "async function sendGuardianNameMoved(")),
        inSendBlock(writerSource, (b) => b.replace("async function sendGuardianInactive(", "async function sendGuardianInactiveMoved(")),
      ];
      for (const text of cases) {
        expect(text, `case ${cases.indexOf(text)} didn't change the writer`).not.toBe(writerSource);
        expect(sendBlockProblems(text), `case ${cases.indexOf(text)}`).not.toEqual([]);
      }
    });

    it("a guardian's send from a difference is the roster's write module's own, and never goes through the guardian functions (slice M3c4)", () => {
      const naming = (sources: { file: string; text: string }[], name: string) => sources.filter((s) => new RegExp(`\\b${name}\\b`).test(code(s.text))).map((s) => s.file).sort();
      for (const name of GUARDIAN_DIFFERENCE_SENDS) {
        expect(naming(everything, name), `${name} sends a guardian's difference to QuickBooks. A new caller is a decision for a slice brief.`).toEqual([...MAY_GUARDIAN_DIFFERENCE_SEND].sort());
        const another = [...everything, { file: "src/lib/accounting/guardian-send.ts", text: `import { ${name} } from "@/lib/roster/writes";\nexport const go = () => ${name};\n` }];
        expect(naming(another, name)).not.toEqual([...MAY_GUARDIAN_DIFFERENCE_SEND].sort());
      }
      const writerSource = everything.find((s) => s.file === ROSTER_WRITER)!.text;
      expect(guardianDifferenceSendProblems(writerSource)).toEqual([]);
      // Each proved on a copy of the writer it must refuse: a guardian function called from either send, or a send gone.
      const into = (name: string, line: string) => writerSource.replace(new RegExp(`(async function ${name}\\([^\\n]*\\{\\n)`), `$1${line}\n`);
      const cases = [
        into("sendGuardianName", `  await queueForGuardian({} as never, {} as never, {} as never);`),
        into("sendGuardianName", `  await sendGuardianSaved([], {} as never, {} as never);`),
        into("sendGuardianInactive", `  await queueForGuardian({} as never, {} as never, {} as never);`),
        into("sendGuardianInactive", `  void sendGuardianSaved;`),
        writerSource.replace("async function sendGuardianInactive(", "async function sendRemovedGuardianInactive("),
      ];
      for (const text of cases) {
        expect(text, `case ${cases.indexOf(text)} didn't change the writer`).not.toBe(writerSource);
        expect(guardianDifferenceSendProblems(text), `case ${cases.indexOf(text)}`).not.toEqual([]);
      }
    });

    it("a second call, true or a value in place of false, an alias, or another module naming it, each refused", () => {
      const writerSource = everything.find((s) => s.file === ROSTER_WRITER)!.text;
      const withWriter = (text: string) => everything.map((s) => (s.file === ROSTER_WRITER ? { file: s.file, text } : s));
      const cases = [
        withWriter(writerSource.replace(ACTIVE_FLAG_CALL, "qboSetCustomerActive(w.qboId, w.syncToken, true, opts)")),
        withWriter(writerSource.replace(ACTIVE_FLAG_CALL, "qboSetCustomerActive(w.qboId, w.syncToken, w.op === \"deactivate\" ? false : true, opts)")),
        withWriter(writerSource.replace(ACTIVE_FLAG_CALL, "qboSetCustomerActive(w.qboId, w.syncToken, false, opts).then((a) => a)")),
        withWriter(`${writerSource}\nasync function wake(qboId: string) { return qboSetCustomerActive(qboId, "0", true, {} as never); }\n`),
        withWriter(writerSource.replace(`${ACTIVE_FLAG},`, `${ACTIVE_FLAG} as setActive, ${ACTIVE_FLAG},`)),
        [...everything, { file: "src/lib/accounting/send.ts", text: `import { ${ACTIVE_FLAG} } from "@/lib/quickbooks/client";\nexport const wake = (id: string) => ${ACTIVE_FLAG}(id, "0", true, {} as never);\n` }],
      ];
      for (const sources of cases) {
        expect(sources, "the case didn't change the sources").not.toEqual(everything);
        expect(activeFlagProblems(sources), `case ${cases.indexOf(sources)}`).not.toEqual([]);
      }
    });
  });
});

/**
 * Send the app's for all (stage 4's slice M5b): every name and student's family the accounting links screen's list
 * shows, queued as changes saved first in one transaction and sent by the queue's worker, never at the press. Its
 * per-difference work is the in-transaction half of a single send, moved out of sendName() and sendPlace() into
 * queueSendIn() (which those two call too), named only by the roster's write module and the bulk's home; the bulk
 * itself (sendAllDifferences(), src/lib/accounting/link-writes.ts) is named only there and by the screen's action. Neither
 * body names a try, the family action, sendWrite() or a client write: the bulk queues and never sends, and never
 * makes anything inactive. MAY_SAVED_TRY, MAY_ROSTER_DEACTIVATE and the active flag's rule are unchanged.
 */
const SEND_QUEUE = "queueSendIn";
const MAY_SEND_QUEUE = [ROSTER_WRITER, "src/lib/accounting/link-writes.ts"];
const SEND_ALL = "sendAllDifferences";
const MAY_SEND_ALL = ["src/lib/accounting/link-writes.ts", "src/app/staff/(app)/links/actions.ts"];
const LINK_WRITES = "src/lib/accounting/link-writes.ts";
/** What a queue-only body must never name: a try, the family action, the one send, or a client write. */
const NOT_IN_A_QUEUE_ONLY_BODY = [...CLIENT_WRITES, ROSTER_SEND, SAVED_TRY, "tryDeactivate", SEND_FAMILY];

/**
 * What is wrong with the two queue-only bodies: queueSendIn() with the helpers after it, up to sendName() in the
 * roster's write module, and sendAllDifferences() in its own module; nothing when each is found and names none of
 * NOT_IN_A_QUEUE_ONLY_BODY.
 */
function queueOnlyProblems(writerText: string, linkWritesText: string): string[] {
  const writer = code(writerText);
  const start = writer.indexOf(`export async function ${SEND_QUEUE}(`), end = writer.indexOf("async function sendName(", start);
  const problems: string[] = [];
  if (start < 0 || end <= start) problems.push(`${SEND_QUEUE}'s body isn't found before sendName()`);
  const bulk = exportedFunction(linkWritesText, SEND_ALL);
  if (bulk === "") problems.push(`${LINK_WRITES} has no exported function ${SEND_ALL}`);
  const bodies: [string, string][] = [[SEND_QUEUE, start < 0 || end <= start ? "" : writer.slice(start, end)], [SEND_ALL, bulk]];
  for (const [name, body] of bodies) {
    for (const forbidden of NOT_IN_A_QUEUE_ONLY_BODY) if (new RegExp(`\\b${forbidden}\\b`).test(body)) problems.push(`${name}'s body names ${forbidden}: it queues, and never sends`);
  }
  return problems;
}

describe("and Send the app's for all, which queues and never sends at the press (stage 4's slice M5b)", () => {
  const everything = read("src");
  const naming = (sources: { file: string; text: string }[], name: string) => sources.filter((s) => new RegExp(`\\b${name}\\b`).test(code(s.text))).map((s) => s.file).sort();
  const writerSource = everything.find((s) => s.file === ROSTER_WRITER)?.text ?? "";
  const linkWritesSource = everything.find((s) => s.file === LINK_WRITES)?.text ?? "";

  it("is reached only from the screen's press, and its per-difference work only from the module and the bulk, and a new caller is found", () => {
    expect(naming(everything, SEND_QUEUE), `${SEND_QUEUE} queues a difference's send in the caller's transaction. A new caller is a decision for a slice brief.`).toEqual([...MAY_SEND_QUEUE].sort());
    expect(naming(everything, SEND_ALL), `${SEND_ALL} queues every name and student's family the list shows. A new caller is a decision for a slice brief.`).toEqual([...MAY_SEND_ALL].sort());
    const another = (name: string) => [...everything, { file: "src/app/staff/(app)/roster/send-all-actions.ts", text: `import { ${name} } from "@/lib/accounting/link-writes";\nexport const go = () => ${name};\n` }];
    expect(naming(another(SEND_QUEUE), SEND_QUEUE)).not.toEqual([...MAY_SEND_QUEUE].sort());
    expect(naming(another(SEND_ALL), SEND_ALL)).not.toEqual([...MAY_SEND_ALL].sort());
  });

  it("names no try, no family action, no send and no client write in either body", () => {
    expect(queueOnlyProblems(writerSource, linkWritesSource)).toEqual([]);
    // Each proved on a copy it must refuse: a try, the family action, sendWrite() or a client write put into either body,
    // or the queue's body's end gone.
    const intoQueue = (line: string) => writerSource.replace(new RegExp(`(export async function ${SEND_QUEUE}\\([^\\n]*\\{\\n)`), `$1${line}\n`);
    const intoBulk = (line: string) => linkWritesSource.replace(new RegExp(`(export async function ${SEND_ALL}\\([^\\n]*\\{\\n)`), `$1${line}\n`);
    const cases: [string, string][] = [
      [intoQueue(`  await trySavedItem({} as never, {} as never, {} as never);`), linkWritesSource],
      [intoQueue(`  await tryDeactivate({} as never, "", {} as never);`), linkWritesSource],
      [intoQueue(`  await familyInactiveHolding({} as never, "", "", {} as never, {} as never);`), linkWritesSource],
      [intoQueue(`  await sendWrite({} as never, "", {});`), linkWritesSource],
      [intoQueue(`  await qboRenameCustomer("10", "0", "x", {} as never);`), linkWritesSource],
      [writerSource, intoBulk(`  await trySavedItem({} as never, {} as never, {} as never);`)],
      [writerSource, intoBulk(`  await tryDeactivate({} as never, "", {} as never);`)],
      [writerSource, intoBulk(`  await qboSetCustomerActive("10", "0", false, {} as never);`)],
      [writerSource.replace("async function sendName(", "async function sendNameMoved("), linkWritesSource],
      [writerSource, linkWritesSource.replace(`export async function ${SEND_ALL}(`, `async function ${SEND_ALL}(`)],
    ];
    for (const [i, [writer, bulk]] of cases.entries()) {
      expect(writer === writerSource && bulk === linkWritesSource, `case ${i} didn't change either source`).toBe(false);
      expect(queueOnlyProblems(writer, bulk), `case ${i}`).not.toEqual([]);
    }
  });
});
