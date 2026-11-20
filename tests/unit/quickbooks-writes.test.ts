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
 * details (saveDetails(), stage 3's slice 11b), which only the parent's save calls until S11c adds staff; a third
 * exported function would be another way to change a person's details.
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
/** The only modules that may name the email write: where it is written, and the parent's own email change that calls it. */
const MAY_SEND_THE_EMAIL_WRITE = [CLIENT, EMAIL_CHANGE, CHECK_WRITER];
/** What reaches the email change's confirmation from a browser: the parent's own server action, and nothing else. */
const CONFIRM = "confirmMyEmailChange";
const MAY_CONFIRM = [EMAIL_CHANGE, "src/app/(parent)/family/email/actions.ts"];
/** Everything the email change may export. A second exported function is a second way to the write. */
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
 * families to accounting, its create sent through the module's own ask. Started only by the module itself and the one
 * staff action, so no other module can send a family's create by way of it.
 */
const ROSTER_ADD = "addFamily";
const MAY_ROSTER_ADD = [ROSTER_WRITER, "src/app/staff/(app)/roster/write-actions.ts"];
/**
 * The changes saved in the portal first (stage 3's slices 9e and 9f): a linked record's rename, a student added to a
 * linked family, a student's move, and "Send the portal's value" for a change QuickBooks refused, each sent through the
 * module's own send without the staff ask. Each started only by the module itself and the one staff action. The one send of a rename (its send,
 * and its one resend after a stale answer and a live read) is the module's own; a try of a change saved first, which
 * settles its queue item (at once, on a press or by the worker), is the module's and the queue's.
 */
const SAVED_FIRST = ["renameLinked", "addStudentToLinked", "moveStudent", "sendPortalValue"];
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
 * A guardian's own Parent customer (stage 3's slice 9h): queued in the guardian's own transaction (an add, a reinstate,
 * a removal, a person's rename) and tried at once after it commits, through the module's own try of a change saved
 * first. Each named only by the module itself and the two guardian modules, since guardians and people now cause sends.
 */
const GUARDIAN_SENDS = ["queueForGuardian", "sendGuardianSaved"];
const MAY_GUARDIAN_SEND = [ROSTER_WRITER, "src/lib/parents/guardians.ts", "src/lib/parents/people.ts"];
/** One try of a change saved first, whoever makes it (at once, the press, the queue's worker), settling its own queue item. */
const SAVED_TRY = "trySavedItem";
const MAY_SAVED_TRY = [ROSTER_WRITER, "src/lib/roster/queue.ts"];
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
 * What is wrong with how the email change reaches its write; nothing when the write is imported under its own name,
 * called once, inside the confirmation, for the record loadMyRecordForMyEmailChange(ctx) found for the session (its own
 * record by the address it signs in with, or while the record's email field reads as its own live change: only this
 * module may ask for that, tests/unit/my-record-for-email-change.test.ts), and the module exports nothing but its list.
 * The checks the first write's sender in the contact edits was held to until stage 3's slice 11a, for the second write.
 */
function emailWriterProblems(source: string): string[] {
  const text = code(source), problems: string[] = [];
  const named = [...text.matchAll(new RegExp(`\\b${EMAIL_WRITE}\\b`, "g"))].length;
  const imports = [...text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@\/lib\/quickbooks\/client["']/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim()));
  if (!imports.includes(EMAIL_WRITE)) problems.push(`${EMAIL_WRITE} is not imported under its own name`);
  const confirm = exportedFunction(source, CONFIRM);
  const calls = [...confirm.matchAll(new RegExp(`\\b${EMAIL_WRITE}\\s*\\(\\s*([^,)]*)`, "g"))].map((m) => m[1]!.trim());
  if (calls.length !== 1) problems.push(`${CONFIRM} calls ${EMAIL_WRITE} ${calls.length} times, not once`);
  else if (calls[0] !== "record.qboId") problems.push(`${EMAIL_WRITE} is called for ${calls[0]}, not for record.qboId`);
  if (named !== 2) problems.push(`${EMAIL_WRITE} is named ${named} times: once to import it and once to call it is all`);
  const OWN = "const record = await loadMyRecordForMyEmailChange(ctx);";
  if (confirm.split(OWN).length !== 2) problems.push(`${CONFIRM} does not get its record from loadMyRecordForMyEmailChange(ctx), once`);
  if (/\b(?:const|let|var)\s+record\b|\brecord\s*=[^=>]|\brecord\.qboId\s*=[^=]/.test(confirm.replace(OWN, ""))) problems.push(`${CONFIRM} gives record another value`);
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
const GUARD_REFUSES = [`if (c.environment !== "sandbox") throw`, "if (c.realmId !== run.realmId) throw",
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
    for (const s of sources) expect(s.text, s.file).not.toMatch(/console\.\w+\(/);
  });

  it("sends nothing but GET, except to Intuit's token and revoke endpoints and the one customer update", () => {
    const posts = sources.flatMap((s) => Array.from({ length: postsIn(s.text) }, () => s.file));
    // The token request, the customer update, the email update, the roster writes' sender and the invoice writes'
    // sender in the client; the revoke in the connection.
    expect(posts.sort()).toEqual([CLIENT, CLIENT, CLIENT, CLIENT, CLIENT, "src/lib/quickbooks/connection.ts"]);
    const methods = (text: string) => methodsIn(text).map((m) => m.is);
    expect(methods(bodyOf("tokenRequest"))).toEqual(["POST"]);
    expect(bodyOf("tokenRequest")).toContain("qboEndpoints().token");
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

  it("lets only the parent's own email change send the email write, and only the parent's own action confirm through it", () => {
    const naming = (name: string) => everything.filter((s) => new RegExp(`\\b${name}\\b`).test(code(s.text))).map((s) => s.file).sort();
    expect(naming(EMAIL_WRITE), `${EMAIL_WRITE} is the portal's second write to QuickBooks. A new caller is a decision for a slice brief, not a fix made in passing.`).toEqual([...MAY_SEND_THE_EMAIL_WRITE].sort());
    expect(naming(CONFIRM)).toEqual([...MAY_CONFIRM].sort());
    // Called once, in the confirmation, for the session's own record, and the module is no second way to it.
    expect(emailWriterProblems(emailChange)).toEqual([]);
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
      expect(naming(RENAME_TRY), `${RENAME_TRY} sends a rename, and resends it once after a live read. A new caller is a decision for a slice brief.`).toEqual([...MAY_RENAME_TRY].sort());
      expect(naming(ROSTER_DEACTIVATE), `${ROSTER_DEACTIVATE} makes a linked record inactive in QuickBooks. A new caller is a decision for a slice brief.`).toEqual([...MAY_ROSTER_DEACTIVATE].sort());
      expect(naming(SAVED_TRY), `${SAVED_TRY} sends a change saved first and settles its queue item. A new caller is a decision for a slice brief.`).toEqual([...MAY_SAVED_TRY].sort());
      for (const name of GUARDIAN_SENDS) expect(naming(name), `${name} queues or sends a guardian's Parent customer change. A new caller is a decision for a slice brief.`).toEqual([...MAY_GUARDIAN_SEND].sort());
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
      expect(action).toContain(`const writes = (await getConnection())?.environment === "sandbox";`);
      expect(action).toContain("runSandboxCheck({ staffUserId: ctx.staffUserId, label: ctx.email, ip: ctx.ip, writes })");
      expect(action).toMatch(/export const runCheckAction = staffAction\(P, /);
      expect(action).toContain(`const P = "Settings.QuickBooks.ReadWrite" as const;`);
      const guard = code(writer).slice(code(writer).indexOf(CHECK_GUARD));
      expect(guard.indexOf("const c = await getConnection();")).toBeGreaterThan(0);
      expect(guard.indexOf(`if (c.environment !== "sandbox") throw`)).toBeGreaterThan(guard.indexOf("const c = await getConnection();"));
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
        inGuard(`if (c.environment !== "sandbox") throw`, `if (c.environment === "staging") throw`),
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

    it("a second way to the email write through the email change", () => {
      const added = (more: string) => `${emailChange}\n${more}\n`;
      const cut = emailChange.indexOf(`export async function ${CONFIRM}(`);
      const inConfirm = (from: string, to: string) => emailChange.slice(0, cut) + emailChange.slice(cut).replace(from, to);
      const OWN = "const record = await loadMyRecordForMyEmailChange(ctx);";
      const refused = [
        added(`export async function staffSetEmail(qboId: string, version: string, field: string) { return qboUpdateCustomerEmail(qboId, version, field, { realmId: "1" }); }`),
        added(`async function alsoSend(qboId: string) { return qboUpdateCustomerEmail(qboId, "0", "a@b.org", { realmId: "1" }); }`),
        added(`export const sendEmail = qboUpdateCustomerEmail;`),
        added(`export { qboUpdateCustomerEmail };`),
        added(`export * from "@/lib/quickbooks/client";`),
        added(`export async function confirmFor(ctx: ParentCtx, qboId: string) { return qboId; }`),
        emailChange.replace("qboUpdateCustomerEmail(record.qboId,", "qboUpdateCustomerEmail(row.recordQboId!,"),
        inConfirm(OWN, `${OWN}\n  record.qboId = String(token);`),
        inConfirm(OWN, "const record = await recordFor(token);"),
        emailChange.replace("qboUpdateCustomerEmail } from", "qboUpdateCustomerEmail as send } from").replace("await qboUpdateCustomerEmail(record.qboId,", "await send(record.qboId,"),
      ];
      for (const source of refused) {
        expect(source, "the case didn't change the module").not.toBe(emailChange);
        expect(emailWriterProblems(source), `case ${refused.indexOf(source)}`).not.toEqual([]);
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
});
