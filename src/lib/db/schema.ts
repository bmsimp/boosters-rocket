import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, uuid, jsonb, uniqueIndex, index, inet, bigserial, bigint, integer, check, date, time, customType } from "drizzle-orm/pg-core";
import type { PgColumnBuilderBase } from "drizzle-orm/pg-core";

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Key/value runtime settings (club name, color, monogram, …). */
export const setting = pgTable("setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updated(),
});

/** Sign-in provider settings entered on the setup page. The secret is sealed (src/lib/crypto/secret-box.ts). */
export const authProvider = pgTable("auth_provider", {
  key: text("key", { enum: ["staff-microsoft", "staff-google"] }).primaryKey(),
  config: jsonb("config").notNull(),               // non-secret values only
  secretCiphertext: text("secret_ciphertext"),   // null for Microsoft providers, which use a certificate
  secretKeyId: text("secret_key_id"),   // null for Microsoft providers, which use a certificate
  secretExpiresAt: timestamp("secret_expires_at", { withTimezone: true }),
  secretUpdatedAt: timestamp("secret_updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: updated(),
  updatedBy: uuid("updated_by"),                    // staff_user.id; null when saved from the setup page
});

/** App-generated certificates for Microsoft staff sign-in. The private key is sealed. */
export const providerCertificate = pgTable("provider_certificate", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerKey: text("provider_key", { enum: ["staff-microsoft"] }).notNull(),
  status: text("status", { enum: ["pending", "active", "retired"] }).notNull(),
  certificatePem: text("certificate_pem").notNull(),
  thumbprintS256: text("thumbprint_s256").notNull(),
  thumbprintSha1: text("thumbprint_sha1").notNull(),
  notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
  privateKeyCiphertext: text("private_key_ciphertext"),
  privateKeyKeyId: text("private_key_key_id"),
  createdAt: created(),
  createdBy: uuid("created_by"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("provider_certificate_one_pending").on(t.providerKey).where(sql`status = 'pending'`),
  uniqueIndex("provider_certificate_one_active").on(t.providerKey).where(sql`status = 'active'`),
]);

/** People who sign in through the staff door. */
export const staffUser = pgTable("staff_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(), // stored trimmed + lower-cased
  status: text("status", { enum: ["invited", "active", "disabled"] }).notNull().default("invited"),
  authUserId: text("auth_user_id"), // staff_auth_user.id once bound at first sign-in
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("staff_user_email_uq").on(t.email),
  uniqueIndex("staff_user_auth_uq").on(t.authUserId),
]);

export type GuardianStatus = "invited" | "active" | "disabled";
export type DisabledReason = "no_active_students" | "removed" | "inactive" | "family_inactive" | "no_email" | "held" | "address_changed" | "not_in_quickbooks" | "company_changed";
const DISABLED_REASONS = ["no_active_students", "removed", "inactive", "family_inactive", "no_email", "held", "address_changed", "not_in_quickbooks", "company_changed"] as const;

/** One record per parent, whatever families they're in (spec §2). Everything refers to the id, never to the email. */
export const parent = pgTable("parent", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(), // stored trimmed + lower-cased
  phone: text("phone"),
  blocked: boolean("blocked").notNull().default(false),
  blockedAt: timestamp("blocked_at", { withTimezone: true }),
  blockedBy: uuid("blocked_by"),                       // staff_user.id
  blockedReason: text("blocked_reason"),               // staff see it; the parent never does
  welcomedAt: timestamp("welcomed_at", { withTimezone: true }),
  welcomeOwed: boolean("welcome_owed").notNull().default(false),
  welcomeTriedAt: timestamp("welcome_tried_at", { withTimezone: true }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [uniqueIndex("parent_email_uq").on(t.email)]);

/** "This person is a guardian in this family." Name, email and phone live on the person (`parent`). */
export const guardian = pgTable("guardian", {
  id: uuid("id").primaryKey().defaultRandom(),
  familyQboId: text("family_qbo_id").notNull(),
  parentId: uuid("parent_id").notNull().references(() => parent.id, { onDelete: "restrict" }),
  isPrimary: boolean("is_primary").notNull().default(false),
  status: text("status", { enum: ["invited", "active", "disabled"] }).notNull().default("invited"),
  sourceQboId: text("source_qbo_id"),                  // the QuickBooks customer this link came from; null for one made by hand
  disabledReason: text("disabled_reason", { enum: DISABLED_REASONS }),
  statusBeforeDisable: text("status_before_disable", { enum: ["invited", "active"] }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("guardian_family_parent_uq").on(t.familyQboId, t.parentId),
  index("guardian_family_ix").on(t.familyQboId),
  index("guardian_parent_ix").on(t.parentId),
]);

/** Sign-in codes (spec §1). Only the hash is stored; only the latest unused code per person exists. */
export const signinCode = pgTable("signin_code", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentId: uuid("parent_id").notNull().references(() => parent.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  tries: integer("tries").notNull().default(0),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: created(),
}, (t) => [uniqueIndex("signin_code_one_live").on(t.parentId).where(sql`used_at IS NULL`)]);

/** One row per counted event; rate-limit.ts counts rows in a sliding window (spec §1 Rate limits). */
export const rateLimitEvent = pgTable("rate_limit_event", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").notNull(),
  subject: text("subject").notNull(), // a normalized email or an IP address
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  // Set on the oldest event of a full window when its first refusal is audited; it goes when that event ages out.
  refusalAudited: boolean("refusal_audited").notNull().default(false),
}, (t) => [index("rate_limit_event_ix").on(t.kind, t.subject, t.at)]);

/**
 * A parent's own change of sign-in address, waiting for the link mailed to the new address (src/lib/parents/email-change.ts).
 * The token is stored hashed. A request belongs to the person, the link and family it was asked under and the
 * QuickBooks record it would change; it is confirmed only by that person, signed in to that family through that link,
 * while that is still their record. The three were added after the table (0016): a row without them is never confirmed.
 * The record's id names a customer of the connected company: a change of company deletes every row.
 */
export const parentEmailChange = pgTable("parent_email_change", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentId: uuid("parent_id").notNull().references(() => parent.id, { onDelete: "cascade" }),
  guardianId: uuid("guardian_id").references(() => guardian.id, { onDelete: "cascade" }),
  familyQboId: text("family_qbo_id"),
  recordQboId: text("record_qbo_id"),
  newEmail: text("new_email").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: created(),
}, (t) => [
  uniqueIndex("parent_email_change_token_uq").on(t.tokenHash),
  uniqueIndex("parent_email_change_one_live").on(t.parentId).where(sql`used_at IS NULL`),
]);

/**
 * One row per email address that is, or was, under more than one family (spec §1 Held addresses). The three sets hold
 * family QuickBooks IDs: approved by staff as the same person, rejected as not the same person, and already announced
 * to staff by email. The IDs belong to the connected company; a company change deletes every row.
 */
export const heldAddress = pgTable("held_address", {
  email: text("email").primaryKey(),                   // trimmed + lower-cased
  approvedFamilyQboIds: jsonb("approved_family_qbo_ids").$type<string[]>().notNull().default([]),
  rejectedFamilyQboIds: jsonb("rejected_family_qbo_ids").$type<string[]>().notNull().default([]),
  announcedFamilyQboIds: jsonb("announced_family_qbo_ids").$type<string[]>().notNull().default([]),
  note: text("note"),
  decidedBy: uuid("decided_by"),                       // staff_user.id
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: created(),
  updatedAt: updated(),
});

/** "This family in the previous QuickBooks company is this family in the connected one" (spec §6). Kept for good. */
export const familyMatch = pgTable("family_match", {
  id: uuid("id").primaryKey().defaultRandom(),
  oldRealmId: text("old_realm_id").notNull(),
  oldFamilyQboId: text("old_family_qbo_id").notNull(),
  newRealmId: text("new_realm_id").notNull(),
  newFamilyQboId: text("new_family_qbo_id").notNull(),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("family_match_old_uq").on(t.oldRealmId, t.oldFamilyQboId)]);

export type QboEnvironment = "sandbox" | "production";

/**
 * The club's QuickBooks connection (spec §2, §3): the Intuit app's keys and, once connected, the company and its tokens.
 * One row at most: the `qbo_connection_singleton` check allows no `id` but "singleton", and the primary key stops a second. The secret and both tokens are sealed (src/lib/crypto/secret-box.ts).
 */
export const qboConnection = pgTable("qbo_connection", {
  id: text("id").primaryKey().default("singleton"),
  environment: text("environment", { enum: ["sandbox", "production"] }).notNull(),
  clientId: text("client_id").notNull(),
  clientSecretCiphertext: text("client_secret_ciphertext").notNull(),
  clientSecretKeyId: text("client_secret_key_id").notNull(),
  // A connect in progress: the state sent to Intuit (SHA-256), who started it, and when it stops being accepted.
  stateHash: text("state_hash"),
  stateStaffUserId: uuid("state_staff_user_id"),
  stateExpiresAt: timestamp("state_expires_at", { withTimezone: true }),
  // Set while connected; all null again after a disconnect.
  realmId: text("realm_id"),
  companyName: text("company_name"),
  accessTokenCiphertext: text("access_token_ciphertext"),
  accessTokenKeyId: text("access_token_key_id"),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  refreshTokenCiphertext: text("refresh_token_ciphertext"),
  refreshTokenKeyId: text("refresh_token_key_id"),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  connectedBy: uuid("connected_by"),                 // staff_user.id
  lastTokenRefreshAt: timestamp("last_token_refresh_at", { withTimezone: true }),
  lastError: text("last_error"),                     // a fixed sentence and a short code, never a response body
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  updatedAt: updated(),
}, (t) => [check("qbo_connection_singleton", sql`${t.id} = 'singleton'`)]);

/** A reference copy of QuickBooks' customer types (spec §2). Replaced on every refresh. */
export const qboCustomerType = pgTable("qbo_customer_type", {
  qboId: text("qbo_id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull(),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A reference copy of QuickBooks' customers (spec §2). Never a source of truth. Email and phone are kept only for
 * customers whose type the membership shape names.
 */
export const qboCustomer = pgTable("qbo_customer", {
  qboId: text("qbo_id").primaryKey(),
  displayName: text("display_name").notNull(),
  active: boolean("active").notNull(),
  parentQboId: text("parent_qbo_id"),
  typeQboId: text("type_qbo_id"),
  email: text("email"),
  phone: text("phone"),
  syncToken: text("sync_token").notNull(),
  qboUpdatedAt: timestamp("qbo_updated_at", { withTimezone: true }),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("qbo_customer_parent_ix").on(t.parentQboId), index("qbo_customer_type_ix").on(t.typeQboId)]);

/** An invoice as a parent sees it, kept in `family_money.invoices`. Amounts are integer cents; dates are calendar dates (YYYY-MM-DD). */
export type StoredInvoice = {
  qboId: string;
  number: string | null;            // QuickBooks' DocNumber: free text, shown as text only
  customerQboId: string;            // the customer it was raised on: the row is shown only while that customer is still the family's
  forName: string | null;           // the student or parent sub-customer it was raised on; null when on the family itself
  date: string | null;
  dueDate: string | null;
  totalCents: number;
  balanceCents: number;             // what is still due; 0 on a paid invoice
  currency: string;
  payLink: string | null;           // QuickBooks' hosted payment page, only when it passed src/lib/money/pay-link.ts
  /**
   * The products and services on its lines (each line's ItemRef id, src/lib/money/invoices.ts), which is what a payment
   * requirement is met by. Missing on a row stored before the portal read them: such a row is read again, never guessed at.
   */
  itemQboIds?: string[];
};

/**
 * QuickBooks' own balance for one customer whose invoices a family is shown, beside the sum of that customer's open
 * invoices as read at the same moment (the cross-check, v1 spec §8.3). They differ when the customer has a credit, an
 * unapplied payment or a charge that isn't an invoice: worth a look for the treasurer, never shown to a parent.
 */
export type CustomerCheck = {
  customerQboId: string;
  name: string | null;              // the student or parent it is; null for the family customer itself
  balanceCents: number;             // QuickBooks' Customer.Balance (sub-customers not included)
  invoicesCents: number;            // the sum of the open invoices raised on this customer
  currency: string;
};

/**
 * What QuickBooks last said one family owes (v1 spec §8.2): one row per family. The read columns are replaced only by
 * a successful read and are all null until the first one; `failed_at` and `failed_code` record the latest try that
 * failed. Never a source of truth. The ids belong to the company in `realm_id`; a company change deletes every row,
 * and so does a change of membership shape, which changes whose invoices are a family's.
 */
export const familyMoney = pgTable("family_money", {
  familyQboId: text("family_qbo_id").primaryKey(),
  realmId: text("realm_id"),                                         // the QuickBooks company the figures were read from
  readAt: timestamp("read_at", { withTimezone: true }),
  invoices: jsonb("invoices").$type<StoredInvoice[]>(),              // open invoices, then those paid in the last 12 months
  totalCents: bigint("total_cents", { mode: "number" }),             // the sum of the open invoices
  balanceWithJobsCents: bigint("balance_with_jobs_cents", { mode: "number" }), // QuickBooks' own figure, a cross-check only; null when it would count customers the total leaves out
  currency: text("currency"),                                        // null when the open invoices are in more than one
  mismatchAuditedAt: timestamp("mismatch_audited_at", { withTimezone: true }), // the last time a differing cross-check was audited
  checkedAt: timestamp("checked_at", { withTimezone: true }),         // when the worker last compared each customer's balance with its invoices
  customerChecks: jsonb("customer_checks").$type<CustomerCheck[]>(), // what that comparison found, one entry per customer compared
  failedAt: timestamp("failed_at", { withTimezone: true }),
  failedCode: text("failed_code"),                                   // a short code, never a response body
  updatedAt: updated(),
});

/**
 * QuickBooks' products and services, as the worker or a staff member last read them (`select * from Item`), for staff to
 * choose what a payment requirement is met by. Never a source of truth. The ids belong to the company in `realm_id`; a
 * company change deletes every row, and each read replaces them all.
 */
export const qboItem = pgTable("qbo_item", {
  qboId: text("qbo_id").primaryKey(),
  name: text("name").notNull(),                       // QuickBooks text: shown as text only
  type: text("type"),                                 // Service, NonInventory, Inventory, Group, ...
  active: boolean("active").notNull(),
  realmId: text("realm_id").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per run of a scheduled or hand-started job (spec §4). `outcome` is null while it runs. */
export const jobRun = pgTable("job_run", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  job: text("job").notNull(),                        // "quickbooks.token_refresh" | "roster.refresh" | "cleanup.daily"
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  outcome: text("outcome", { enum: ["ok", "failed"] }),
  detail: text("detail"),                            // counts, or a fixed sentence and a code
  startedBy: text("started_by").notNull(),           // "worker" or a staff_user.id
}, (t) => [index("job_run_job_ix").on(t.job, t.startedAt)]);

/** Who a roster write is about, in the membership shape's words: a family (layered), a student or parent under one, or a member (flat). */
export type RosterRole = "family" | "student" | "parent" | "member";
/**
 * One staff change to the roster, as it is sent to QuickBooks (src/lib/roster/writes.ts), kept in `write_queue.request`.
 * Every id is a QuickBooks id of the company the queue row names; a create holds the customer type it was given.
 */
export type RosterWrite =
  | { op: "create"; role: RosterRole; name: string; typeQboId: string; familyQboId: string | null; email: string | null }
  | { op: "rename"; role: RosterRole; qboId: string; syncToken: string; name: string; was: string }
  | { op: "move"; role: "student"; qboId: string; syncToken: string; fromFamilyQboId: string; toFamilyQboId: string }
  | { op: "deactivate"; role: RosterRole; qboId: string; syncToken: string };

/**
 * Staff roster writes that QuickBooks didn't take at the time and may take later (v1 spec §4, §8.4): it was busy, it
 * throttled, or it couldn't be reached or didn't answer. `sent` says whether QuickBooks may have acted on the last try:
 * such an item is never simply sent again (src/lib/roster/queue.ts looks in a fresh roster first). A done or given-up
 * item is kept 30 days (the daily clean-up); every item goes when a different company is connected.
 */
export const writeQueue = pgTable("write_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  realmId: text("realm_id").notNull(),               // the company it is for: never sent to another
  request: jsonb("request").$type<RosterWrite>().notNull(),
  targetQboId: text("target_qbo_id"),                // the customer it changes; null for a create
  familyQboId: text("family_qbo_id"),                // the family it is under or about, for the family's page
  state: text("state", { enum: ["waiting", "stuck", "done", "given_up"] }).notNull().default("waiting"),
  sent: boolean("sent").notNull(),                    // QuickBooks may have acted on the last try
  tries: integer("tries").notNull().default(1),
  lastCode: text("last_code"),                        // the last short code, never QuickBooks' words
  lastTriedAt: timestamp("last_tried_at", { withTimezone: true }).notNull().defaultNow(),
  nextTryAt: timestamp("next_try_at", { withTimezone: true }),
  askedBy: uuid("asked_by"),                          // staff_user.id
  askedByLabel: text("asked_by_label"),
  resultQboId: text("result_qbo_id"),                 // the customer QuickBooks made or changed, once done
  note: text("note"),                                 // why staff gave up: staff only
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  index("write_queue_state_ix").on(t.state, t.nextTryAt),
  index("write_queue_target_ix").on(t.targetQboId),
  index("write_queue_family_ix").on(t.familyQboId),
]);

/* ---- Seasons, steps and requirements (v1 spec §10). Calendar dates are `date` columns read as YYYY-MM-DD, in the club's own time zone. ---- */

export type RequirementKind = "form" | "payment" | "volunteer" | "checklist";

/**
 * What a form requirement points at (v1 spec §9.1), kept in `requirement.form`: the Documenso template staff attached,
 * as it was when the portal read and checked it, and who must sign. Documenso templates have no version: its id and
 * its last-changed time are what there is.
 */
export type FormSetting = {
  templateId: string;                 // Documenso's envelope id of the template
  templateTitle: string;              // Documenso's name for it, shown to staff only
  templateUpdatedAt: string;          // Documenso's last-changed time when staff attached it (ISO)
  signerRoles: 1 | 2;                 // how many signer roles the template had then
  signers: "any" | "every";           // any one guardian, or every guardian with a sign-in (up to the template's roles)
  attachedAt: string;                 // when staff attached it (ISO)
};

/** A season, such as "Fall 2027". At most one is the current season, the one parents see (`season_current_uq`). */
export const season = pgTable("season", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  isCurrent: boolean("is_current").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [uniqueIndex("season_current_uq").on(t.isCurrent).where(sql`is_current`)]);

/** A season's steps, in the order of `position` (the sets of the season ruler). Both dates are optional. */
export const seasonStep = pgTable("season_step", {
  id: uuid("id").primaryKey().defaultRandom(),
  seasonId: uuid("season_id").notNull().references(() => season.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: integer("position").notNull(),
  startsOn: date("starts_on", { mode: "string" }),
  endsOn: date("ends_on", { mode: "string" }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index("season_step_season_ix").on(t.seasonId, t.position)]);

/**
 * Something a step asks of each family or each student (v1 spec §10.1). `kind` and `applies_to` are fixed once it is
 * made. `amount` and `amount_unit` are for the volunteer kind only. `covers` says whether it is asked of everyone or of
 * the families or students listed in `requirement_cover`.
 */
export const requirement = pgTable("requirement", {
  id: uuid("id").primaryKey().defaultRandom(),
  stepId: uuid("step_id").notNull().references(() => seasonStep.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["form", "payment", "volunteer", "checklist"] }).notNull(), // how each is met: src/lib/seasons/kinds.ts
  title: text("title").notNull(),                       // in the club's own words
  required: boolean("required").notNull().default(true), // an optional one shows progress and never holds a step open
  appliesTo: text("applies_to", { enum: ["family", "student"] }).notNull(),
  amount: integer("amount"),
  amountUnit: text("amount_unit", { enum: ["shifts", "hours"] }),
  dueOn: date("due_on", { mode: "string" }),
  covers: text("covers", { enum: ["everyone", "chosen"] }).notNull().default("everyone"),
  itemQboId: text("item_qbo_id"),                      // payment only: the QuickBooks product or service it is met by (src/lib/money/payment-rule.ts)
  position: integer("position").notNull(),
  form: jsonb("form").$type<FormSetting>(),              // the form kind only: the Documenso template and who must sign; null until staff attach one
  formReminders: jsonb("form_reminders").$type<FormReminders>(), // the form kind only: when reminders go (staff Forms page); null for none
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index("requirement_step_ix").on(t.stepId, t.position)]);

/**
 * The families or students a requirement with `covers = 'chosen'` is asked of: QuickBooks customer ids, families for a
 * per-family requirement and students for a per-student one. No foreign key to the roster cache: one that has left the
 * roster stays listed and is simply not shown.
 */
export const requirementCover = pgTable("requirement_cover", {
  requirementId: uuid("requirement_id").notNull().references(() => requirement.id, { onDelete: "cascade" }),
  subjectQboId: text("subject_qbo_id").notNull(),
  createdAt: created(),
}, (t) => [uniqueIndex("requirement_cover_uq").on(t.requirementId, t.subjectQboId), index("requirement_cover_subject_ix").on(t.subjectQboId)]);

/**
 * What is recorded for one family or one student against one requirement: that it is met, a waiver, or both. A row
 * exists only while it records something. `subject_qbo_id` is the family's QuickBooks id for a per-family requirement
 * and the student's for a per-student one. `met_at` is a checklist item's tick; the other kinds are judged from their
 * own records and leave it null. A waiver always has a reason. The row keeps the requirement from being deleted.
 */
export const requirementProgress = pgTable("requirement_progress", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: uuid("requirement_id").notNull().references(() => requirement.id, { onDelete: "restrict" }),
  subjectQboId: text("subject_qbo_id").notNull(),
  metAt: timestamp("met_at", { withTimezone: true }),
  metBy: uuid("met_by"),                                 // staff_user.id
  waivedAt: timestamp("waived_at", { withTimezone: true }),
  waivedBy: uuid("waived_by"),                           // staff_user.id
  waivedReason: text("waived_reason"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("requirement_progress_subject_uq").on(t.requirementId, t.subjectQboId),
  index("requirement_progress_subject_ix").on(t.subjectQboId),
  check("requirement_progress_records_something", sql`${t.metAt} is not null or ${t.waivedAt} is not null`),
  check("requirement_progress_waiver_reason", sql`(${t.waivedAt} is null) = (${t.waivedReason} is null)`),
]);

/* ---- Volunteering (v1 spec §11). An event's date and a shift's times are the club's own wall-clock time, read in the club's time zone (src/lib/volunteer/clock.ts). ---- */

/**
 * A volunteer event (v1 spec §11.1): a name, the day, where, what it is, and who to contact. A cancelled event stays,
 * with its shifts and sign-ups, so what happened can still be read; parents no longer see it. `copied_from` names the
 * event it was copied from ("every home game").
 */
export const volunteerEvent = pgTable("volunteer_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  onDate: date("on_date", { mode: "string" }).notNull(),
  location: text("location").notNull(),
  description: text("description").notNull().default(""),
  contactName: text("contact_name").notNull(),
  contactEmail: text("contact_email"),                 // stored trimmed + lower-cased
  copiedFrom: uuid("copied_from"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledBy: uuid("cancelled_by"),                   // staff_user.id
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index("volunteer_event_date_ix").on(t.onDate)]);

/**
 * One shift of an event: its start and end on the event's day (an end at or before the start is the next morning), the
 * number of places, and an optional role ("concessions"). `revision` goes up whenever its time or place changes, so a
 * calendar that holds the shift takes the newer copy. A cancelled shift stays, with its sign-ups.
 */
export const volunteerShift = pgTable("volunteer_shift", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => volunteerEvent.id, { onDelete: "restrict" }),
  startsAt: time("starts_at").notNull(),
  endsAt: time("ends_at").notNull(),
  places: integer("places").notNull(),
  role: text("role"),
  revision: integer("revision").notNull().default(0),
  // The shift's check-in code (v1 spec §11.4): random, never the shift's id, which parents see in addresses. Staff can
  // make a new one (src/lib/volunteer/check-in-codes.ts); the old one then opens nothing.
  checkinCode: text("checkin_code").notNull().default(sql`replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')`),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledBy: uuid("cancelled_by"),                   // staff_user.id
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index("volunteer_shift_event_ix").on(t.eventId), uniqueIndex("volunteer_shift_checkin_code_uq").on(t.checkinCode), check("volunteer_shift_places", sql`${t.places} >= 1`)]);

/** The volunteer requirements a shift can count toward (v1 spec §11.1). The portal's own ids on both sides. */
export const volunteerShiftRequirement = pgTable("volunteer_shift_requirement", {
  shiftId: uuid("shift_id").notNull().references(() => volunteerShift.id, { onDelete: "cascade" }),
  requirementId: uuid("requirement_id").notNull().references(() => requirement.id, { onDelete: "cascade" }),
  createdAt: created(),
}, (t) => [uniqueIndex("volunteer_shift_requirement_uq").on(t.shiftId, t.requirementId), index("volunteer_shift_requirement_requirement_ix").on(t.requirementId)]);

/**
 * One place on a shift, taken by a guardian for themselves or for one of their students (v1 spec §11.2). The family
 * and the student are QuickBooks ids of the connected company: a company change deletes every row. `signed_up_by` is
 * the guardian who took it (parent.id), and `filler_name` the name of whoever fills it, as it was then. A cancelled
 * sign-up keeps its row and frees its place. One person holds one place on a shift at most.
 */
export const volunteerSignup = pgTable("volunteer_signup", {
  id: uuid("id").primaryKey().defaultRandom(),
  shiftId: uuid("shift_id").notNull().references(() => volunteerShift.id, { onDelete: "restrict" }),
  familyQboId: text("family_qbo_id").notNull(),
  signedUpBy: uuid("signed_up_by").notNull(),          // parent.id
  fillerKind: text("filler_kind", { enum: ["guardian", "student"] }).notNull(),
  fillerParentId: uuid("filler_parent_id"),            // parent.id, when a guardian fills it
  studentQboId: text("student_qbo_id"),                // when a student fills it
  fillerName: text("filler_name").notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledByDoor: text("cancelled_by_door", { enum: ["parent", "staff"] }),
  cancelledBy: uuid("cancelled_by"),                   // parent.id or staff_user.id
  createdAt: created(),
}, (t) => [
  index("volunteer_signup_shift_ix").on(t.shiftId),
  index("volunteer_signup_family_ix").on(t.familyQboId),
  index("volunteer_signup_student_ix").on(t.studentQboId),
  uniqueIndex("volunteer_signup_guardian_uq").on(t.shiftId, t.fillerParentId).where(sql`cancelled_at is null and filler_kind = 'guardian'`),
  uniqueIndex("volunteer_signup_student_uq").on(t.shiftId, t.studentQboId).where(sql`cancelled_at is null and filler_kind = 'student'`),
  check("volunteer_signup_filler", sql`(${t.fillerKind} = 'guardian' and ${t.fillerParentId} is not null and ${t.studentQboId} is null) or (${t.fillerKind} = 'student' and ${t.studentQboId} is not null and ${t.fillerParentId} is null)`),
]);

/**
 * Confirmed volunteer credit (v1 spec §11.4), one row per credit. A check-in (`checkin`, by the guardian with the
 * shift's code, or `staff_checkin`, added by staff for one that was missed) names the sign-up it came from, and so its
 * shift, family and filler; it credits the shift's length in minutes as it was then, and one shift. Volunteering done
 * outside the portal (`outside`) names the family, the student when it is one student's, the one requirement it counts
 * toward, and the amount in that requirement's unit (`minutes` for hours, `shifts` for shifts); its `note` is for staff
 * only. How credit fills requirements is src/lib/volunteer/allocation.ts. A removed credit keeps its row, with who and
 * why (the reason is for staff only), and counts for nothing. A sign-up holds one live credit at most. The family and
 * the student are QuickBooks ids of the connected company: a company change deletes every row.
 */
export const volunteerCredit = pgTable("volunteer_credit", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["checkin", "staff_checkin", "outside"] }).notNull(),
  signupId: uuid("signup_id").references(() => volunteerSignup.id, { onDelete: "restrict" }),
  familyQboId: text("family_qbo_id").notNull(),
  studentQboId: text("student_qbo_id"),                // outside credit for one student; a check-in's filler is its sign-up's
  requirementId: uuid("requirement_id").references(() => requirement.id, { onDelete: "cascade" }),
  minutes: integer("minutes").notNull(),
  shifts: integer("shifts").notNull(),
  note: text("note"),                                  // staff only
  createdByDoor: text("created_by_door", { enum: ["parent", "staff"] }).notNull(),
  createdBy: uuid("created_by").notNull(),             // parent.id or staff_user.id
  removedAt: timestamp("removed_at", { withTimezone: true }),
  removedBy: uuid("removed_by"),                       // staff_user.id
  removedReason: text("removed_reason"),               // staff only
  createdAt: created(),
}, (t) => [
  index("volunteer_credit_family_ix").on(t.familyQboId),
  uniqueIndex("volunteer_credit_signup_uq").on(t.signupId).where(sql`removed_at is null`),
  check("volunteer_credit_source", sql`(${t.kind} in ('checkin', 'staff_checkin') and ${t.signupId} is not null and ${t.requirementId} is null and ${t.studentQboId} is null) or (${t.kind} = 'outside' and ${t.signupId} is null and ${t.requirementId} is not null)`),
  check("volunteer_credit_amount", sql`${t.minutes} >= 0 and ${t.shifts} >= 0 and ${t.minutes} + ${t.shifts} > 0`),
]);

/**
 * The volunteer reminders the worker sends (v1 spec §11.3), one row per email, claimed before it is sent so two
 * wakes never send it twice: the day-before reminder of one sign-up (`key` is the sign-up and the shift's date), and a
 * due-date nudge to one guardian of one family (`key` is the family, the due date, the guardian and which nudge).
 * `outcome` is null while the send is under way; a failed one may be claimed again after a while. The family is a
 * QuickBooks id of the connected company: a company change deletes every row.
 */
export const volunteerReminder = pgTable("volunteer_reminder", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["day_before", "due_14", "due_3"] }).notNull(),
  key: text("key").notNull(),
  familyQboId: text("family_qbo_id").notNull(),
  triedAt: timestamp("tried_at", { withTimezone: true }).notNull(),
  outcome: text("outcome", { enum: ["sent", "failed"] }),
  createdAt: created(),
}, (t) => [uniqueIndex("volunteer_reminder_kind_key_uq").on(t.kind, t.key)]);

/* ---- Forms signed in Documenso (v1 spec §9; docs/superpowers/specs/2026-11-15-documenso-verification.md) ---- */

export type SignatureRequestState = "not_opened" | "waiting" | "signed" | "complete" | "declined";
/** A guardian the Documenso document was made for. The signing token is never kept: it is read from Documenso at each open. */
export type RequestSigner = {
  parentId: string;                   // parent.id: the signed-in person this recipient is
  recipientId: number;                // Documenso's id of their recipient on this document
  name: string;                       // as filled into the document
  email: string;
  signedAt: string | null;            // Documenso's time, once it says they signed (ISO)
};

/**
 * One form to be signed for one family or one student: one row per form requirement and subject, and so per season.
 * Its id is what Documenso holds as the document's `externalId`. `state` is what the portal last read from
 * Documenso's API, never what a webhook said: not opened (no document), waiting for a guardian, signed by everyone and
 * waiting for the sealed copy, complete (Documenso says COMPLETED: the only state that meets the requirement), or
 * declined. `family_qbo_id` is whose it is: every parent lookup starts from it. The ids belong to the connected
 * QuickBooks company; a company change deletes every row. `evidence_owed` is set when a request becomes complete and
 * cleared by whatever stores its sealed PDF and audit record. The row keeps the requirement from being deleted.
 */
export const signatureRequest = pgTable("signature_request", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: uuid("requirement_id").notNull().references(() => requirement.id, { onDelete: "restrict" }),
  familyQboId: text("family_qbo_id").notNull(),
  subjectQboId: text("subject_qbo_id").notNull(),          // the family's id for a per-family form, the student's for a per-student one
  state: text("state", { enum: ["not_opened", "waiting", "signed", "complete", "declined"] }).notNull().default("not_opened"),
  // The document in Documenso, and what it was made from. All null while there is none.
  envelopeId: text("envelope_id"),
  envelopeStatus: text("envelope_status"),                 // Documenso's own word, as last read
  templateId: text("template_id"),
  templateUpdatedAt: timestamp("template_updated_at", { withTimezone: true }), // the template's last-changed time when this document was made
  signersMode: text("signers_mode", { enum: ["any", "every"] }),
  subjectName: text("subject_name"),                       // the student's or family's name as filled in
  signers: jsonb("signers").$type<RequestSigner[]>().notNull().default([]),
  preparingAt: timestamp("preparing_at", { withTimezone: true }), // set while a document is being made or replaced, so two opens can't make two
  documentCreatedAt: timestamp("document_created_at", { withTimezone: true }),
  checkedAt: timestamp("checked_at", { withTimezone: true }),     // when Documenso's API was last read for it
  allSignedAt: timestamp("all_signed_at", { withTimezone: true }), // when the portal first read that every signer had signed
  sealAskedAt: timestamp("seal_asked_at", { withTimezone: true }), // when the portal last asked Documenso to seal it again
  completedAt: timestamp("completed_at", { withTimezone: true }),  // Documenso's completion time
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  evidenceOwed: boolean("evidence_owed").notNull().default(false),
  // The worker's tries at fetching the evidence (src/lib/signed-forms/evidence-job.ts): how many failed, the last short code, and when to try again.
  evidenceTries: integer("evidence_tries").notNull().default(0),
  evidenceError: text("evidence_error"),
  evidenceNextAt: timestamp("evidence_next_at", { withTimezone: true }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("signature_request_subject_uq").on(t.requirementId, t.subjectQboId),
  uniqueIndex("signature_request_envelope_uq").on(t.envelopeId).where(sql`envelope_id is not null`),
  index("signature_request_family_ix").on(t.familyQboId),
  index("signature_request_state_ix").on(t.state, t.checkedAt),
]);

/**
 * A guardian's agreement to sign one form electronically (v1 spec §9.2): who, when, from which address, and which
 * version of the consent text they were shown (src/lib/forms/consent.ts). Without a row for the signed-in guardian no
 * document is made and no signing token is handed out. Kept with the request as part of its evidence (§9.4). The
 * request is the family's (signature_request.family_qbo_id), so a company change deletes these with it.
 */
export const signatureConsent = pgTable("signature_consent", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id").notNull().references(() => signatureRequest.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id").notNull(),                   // parent.id, with no foreign key: the record outlives the person's row
  parentName: text("parent_name").notNull(),               // as the portal knew them then
  parentEmail: text("parent_email").notNull(),
  textVersion: text("text_version").notNull(),
  agreedAt: timestamp("agreed_at", { withTimezone: true }).notNull().defaultNow(),
  ip: inet("ip"),
  userAgent: text("user_agent"),
}, (t) => [uniqueIndex("signature_consent_uq").on(t.requestId, t.parentId, t.textVersion)]);

/* ---- Signed forms kept (v1 spec §9.4): the evidence of each completed form, the copies sent, and reminders ---- */

/** Bytes, as Postgres keeps them. postgres.js reads a bytea as a Buffer and writes a Buffer as one. */
const bytes = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** A signer of a kept form, as the request recorded them when the evidence was stored. */
export type EvidenceSigner = { parentId: string | null; name: string; email: string; signedAt: string | null };
/** A guardian's consent to sign electronically, copied from signature_consent as it was when the evidence was stored. */
export type EvidenceConsent = { parentId: string; name: string; email: string; textVersion: string; agreedAt: string; ip: string | null; userAgent: string | null };
/** The original PDF of each item of the document: Documenso keeps it with every document. Only its hash is kept. */
export type EvidenceOriginal = { itemId: string; sha256: string; size: number };

/**
 * The evidence of one signed form (v1 spec §9.4, as the Documenso verification changed it): one row per completed
 * request, stored once every file of it is in signed_form_file. It is the club's record and outlives everything it came
 * from: it has no foreign key to the request, the requirement or the consents, and nothing in the portal deletes it.
 * The names, signers and consents are copies as they were. `realm_id` is the QuickBooks company the family belonged to
 * (the roster cache's company then); when a different company is connected the row is kept, `request_id` is cut
 * (`earlier_company_at` is set), and from then on it is shown only in the staff archive: its QuickBooks ids may name
 * another family in the new company. `mismatch_at` is set when a later fetch gave a stored file a different hash.
 */
export const signedFormEvidence = pgTable("signed_form_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id"),                           // signature_request.id, with no foreign key; null once its company is an earlier one
  realmId: text("realm_id"),                               // the QuickBooks company the request's family belonged to
  earlierCompanyAt: timestamp("earlier_company_at", { withTimezone: true }),
  requirementId: uuid("requirement_id"),                   // requirement.id, with no foreign key
  familyQboId: text("family_qbo_id").notNull(),
  subjectQboId: text("subject_qbo_id").notNull(),
  subjectKind: text("subject_kind", { enum: ["family", "student"] }).notNull(),
  formTitle: text("form_title").notNull(),                 // the names as they were
  familyName: text("family_name"),
  subjectName: text("subject_name"),
  seasonName: text("season_name"),
  envelopeId: text("envelope_id").notNull(),
  templateId: text("template_id"),
  templateUpdatedAt: timestamp("template_updated_at", { withTimezone: true }),
  signers: jsonb("signers").$type<EvidenceSigner[]>().notNull(),
  consents: jsonb("consents").$type<EvidenceConsent[]>().notNull(),
  originals: jsonb("originals").$type<EvidenceOriginal[]>().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),   // Documenso's completion time
  copiesDoneAt: timestamp("copies_done_at", { withTimezone: true }), // when the guardians' copies were all dealt with
  mismatchAt: timestamp("mismatch_at", { withTimezone: true }),
  storedAt: timestamp("stored_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("signed_form_evidence_request_uq").on(t.requestId).where(sql`request_id is not null`),
  index("signed_form_evidence_family_ix").on(t.familyQboId),
  index("signed_form_evidence_earlier_ix").on(t.earlierCompanyAt),
]);

/**
 * One file of a signed form's evidence, its bytes kept in the portal's database: each item's sealed PDF, the signing
 * certificate and the audit log as PDFs, and the audit log as JSON (every page, in order). The certificate and the
 * audit log are kept as their own files whether or not Documenso also put them inside the sealed PDF. Never deleted.
 */
export const signedFormFile = pgTable("signed_form_file", {
  id: uuid("id").primaryKey().defaultRandom(),
  evidenceId: uuid("evidence_id").notNull().references(() => signedFormEvidence.id, { onDelete: "restrict" }),
  kind: text("kind", { enum: ["sealed_pdf", "certificate_pdf", "audit_log_pdf", "audit_log_json"] }).notNull(),
  position: integer("position").notNull().default(1),     // the item's place, for a document of several items
  itemId: text("item_id"),                                 // Documenso's envelope item, for a sealed PDF
  bytes: bytes("bytes").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: created(),
}, (t) => [uniqueIndex("signed_form_file_uq").on(t.evidenceId, t.kind, t.position)]);

/**
 * The copy of a signed form each guardian who signed it is sent, once: the row is the claim, made in one statement
 * before the send, so two wakes can't send twice. Kept with the evidence.
 */
export const signedFormCopy = pgTable("signed_form_copy", {
  id: uuid("id").primaryKey().defaultRandom(),
  evidenceId: uuid("evidence_id").notNull().references(() => signedFormEvidence.id, { onDelete: "restrict" }),
  parentId: uuid("parent_id").notNull(),                   // parent.id, with no foreign key
  outcome: text("outcome", { enum: ["sending", "sent", "failed", "skipped"] }).notNull().default("sending"),
  how: text("how", { enum: ["attached", "link"] }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  doneAt: timestamp("done_at", { withTimezone: true }),
}, (t) => [uniqueIndex("signed_form_copy_uq").on(t.evidenceId, t.parentId)]);

/**
 * When a form's reminders go (v1 spec §9.3), set on the staff Forms page: on any of these days before the
 * requirement's due date, and, optionally, once a week after it, at most four times.
 */
export type FormReminders = { before: (14 | 7 | 3 | 1)[]; weeklyAfter: boolean };

/**
 * One reminder to one guardian about one form on one day of the club's calendar: the claim, made before the send. At
 * most one per guardian per form a day, whatever is pressed. Deleted after a year by the daily clean-up, and on a
 * change of company.
 */
export const formReminderClaim = pgTable("form_reminder_claim", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: uuid("requirement_id").notNull(),
  parentId: uuid("parent_id").notNull(),
  onDate: date("on_date", { mode: "string" }).notNull(),   // the club's date
  createdAt: created(),
}, (t) => [uniqueIndex("form_reminder_claim_uq").on(t.requirementId, t.parentId, t.onDate), index("form_reminder_claim_created_ix").on(t.createdAt)]);

/** A scheduled round of reminders for one form on one club day: claimed before it is sent, so each goes once. Cleaned like the claims. */
export const formReminderRound = pgTable("form_reminder_round", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: uuid("requirement_id").notNull(),
  onDate: date("on_date", { mode: "string" }).notNull(),
  createdAt: created(),
}, (t) => [uniqueIndex("form_reminder_round_uq").on(t.requirementId, t.onDate), index("form_reminder_round_created_ix").on(t.createdAt)]);

/**
 * A document to withdraw in Documenso after a transaction that could not call it (a student moved to another family):
 * deleted when nobody had signed it, cancelled when someone had. The worker does it and removes the row.
 */
export const formWithdrawal = pgTable("form_withdrawal", {
  envelopeId: text("envelope_id").primaryKey(),
  anySigned: boolean("any_signed").notNull(),
  tries: integer("tries").notNull().default(0),
  createdAt: created(),
});

/** Roles. The built-in Admin role has key 'admin' and builtin=true. */
export const role = pgTable("role", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  builtin: boolean("builtin").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [uniqueIndex("role_key_uq").on(t.key)]);

export const roleRule = pgTable("role_rule", {
  id: uuid("id").primaryKey().defaultRandom(),
  roleId: uuid("role_id").notNull().references(() => role.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["include", "exclude"] }).notNull(),
  pattern: text("pattern").notNull(),
}, (t) => [index("role_rule_role_ix").on(t.roleId)]);

export const roleAssignment = pgTable("role_assignment", {
  roleId: uuid("role_id").notNull().references(() => role.id, { onDelete: "cascade" }),
  staffUserId: uuid("staff_user_id").notNull().references(() => staffUser.id, { onDelete: "cascade" }),
  createdAt: created(),
}, (t) => [uniqueIndex("role_assignment_uq").on(t.roleId, t.staffUserId)]);

/**
 * Append-only audit trail (spec §13). The audit page reads it newest first, a page at a time by id, filtered by action,
 * by who acted or by the record acted on (src/lib/audit/query.ts): each of those has an index that ends in the id.
 */
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  door: text("door", { enum: ["staff", "parent", "system"] }).notNull(),
  actorId: text("actor_id"),        // staff_user.id, parent.id, or null for system
  actorLabel: text("actor_label"),  // name/email at the time
  action: text("action").notNull(), // e.g. "role.assign", "signin.refused"
  permission: text("permission"),
  targetType: text("target_type"),
  targetId: text("target_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  ip: inet("ip"),
}, (t) => [
  index("audit_at_ix").on(t.at),
  index("audit_action_ix").on(t.action, t.id),
  index("audit_actor_ix").on(t.actorId, t.id),
  index("audit_target_ix").on(t.targetType, t.targetId, t.id),
]);

/* ---- Better Auth tables, one set per door (Better Auth core schema) ---- */
function authTables<
  U extends Record<string, PgColumnBuilderBase> = Record<never, never>,
  S extends Record<string, PgColumnBuilderBase> = Record<never, never>,
>(prefix: "staff_auth" | "parent_auth", extraUser: U = {} as U, extraSession: S = {} as S) {
  const user = pgTable(`${prefix}_user`, {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    ...extraUser,
    createdAt: created(),
    updatedAt: updated(),
  });
  const session = pgTable(`${prefix}_session`, {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: created(),
    updatedAt: updated(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    ...extraSession,
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  });
  const account = pgTable(`${prefix}_account`, {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: created(),
    updatedAt: updated(),
  });
  const verification = pgTable(`${prefix}_verification`, {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: created(),
    updatedAt: updated(),
  });
  return { user, session, account, verification };
}

const staffAuth = authTables("staff_auth");
export const staffAuthUser = staffAuth.user;
export const staffAuthSession = staffAuth.session;
export const staffAuthAccount = staffAuth.account;
export const staffAuthVerification = staffAuth.verification;

const parentAuth = authTables("parent_auth",
  { parentId: uuid("parent_id").notNull().unique().references(() => parent.id, { onDelete: "cascade" }) },
  { familyQboId: text("family_qbo_id") });
export const parentAuthUser = parentAuth.user;
export const parentAuthSession = parentAuth.session;
export const parentAuthAccount = parentAuth.account;
export const parentAuthVerification = parentAuth.verification;
