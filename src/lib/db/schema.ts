import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, uuid, jsonb, uniqueIndex, index, inet, bigserial, bigint, integer, check, date, time, customType } from "drizzle-orm/pg-core";
import type { PgColumn, PgColumnBuilderBase, PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import type { AppFamilyId, AppStudentId } from "../families/ids";

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

/*
 * ---- The app's own records (stage 1 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md) ----
 * A family and a student with the portal's own ids, and the links that tie each to its QuickBooks customer. Migration
 * 0023 made them from the roster cache, and until stage 3's slice 9c every change of the cache brought them into step
 * with it; since then they stand alone: a staff roster write changes its own record (changeOwnRecord(),
 * src/lib/roster/writes.ts), and nothing QuickBooks holds changes one (the import that made them,
 * src/lib/families/roster-import.ts, has no caller in the portal). Every link belongs to the company the cache came
 * from. Nothing deletes a record or a link but a change of company, which empties all three tables
 * (src/lib/families/company-change.ts).
 */

/**
 * A family, with the portal's own id: made by migration 0023 (or the import) from a family customer of the roster
 * cache (a member, in flat books), or by a staff member's new family or member once QuickBooks made its customer.
 * Named and made active or inactive by the app alone since stage 3's slice 9c (a staff rename or make-inactive sent to
 * QuickBooks changes it too); what QuickBooks holds changes nothing here. Its QuickBooks customer is in its link
 * (`accounting_link`).
 */
export const family = pgTable("family", {
  id: uuid("id").primaryKey().defaultRandom().$type<AppFamilyId>(),
  name: text("name"),                                 // QuickBooks text, shown as text only; null when the portal never knew one
  active: boolean("active").notNull(),
  createdAt: created(),
  updatedAt: updated(),
});

/**
 * A student, with the portal's own id: made by migration 0023 (or the import) from a student customer directly under a
 * family of the roster cache, or by a staff member's new student once QuickBooks made its customer. `family_id` is the
 * family the app holds them in: changed only by a move staff make (since stage 3's slice 9c a move made in QuickBooks
 * changes nothing here); null only for an inactive student never held under a family.
 */
export const student = pgTable("student", {
  id: uuid("id").primaryKey().defaultRandom().$type<AppStudentId>(),
  familyId: uuid("family_id").references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
  name: text("name"),                                 // QuickBooks text, shown as text only; null when the portal never knew one
  active: boolean("active").notNull(),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  index("student_family_ix").on(t.familyId),
  check("student_active_in_family", sql`not ${t.active} or ${t.familyId} is not null`),
]);

/**
 * "This person is a guardian in this family." Name, email and phone live on the person (`parent`). `family_qbo_id` is
 * the customer the family's link named when the row was made: null for a membership made while its family had no link
 * (stage 3's slice 9d, migration 0040), which is never filled in later, even once the family is linked, and by which
 * nothing finds a family. A person is in a family record at most once (`guardian_family_id_parent_uq`); the old unique
 * index by customer stays, for the rows that name one.
 */
export const guardian = pgTable("guardian", {
  id: uuid("id").primaryKey().defaultRandom(),
  familyQboId: text("family_qbo_id"),
  // The same family as the app's own record: written by whoever makes or reinstates the row (src/lib/parents/guardians.ts),
  // never by a roster read (stage 3's slice 9c). Null for a row a change of company closed (its QuickBooks ids are
  // another company's), and for a row made before its family had a record that nothing has given one since.
  familyId: uuid("family_id").references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
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
  uniqueIndex("guardian_family_id_parent_uq").on(t.familyId, t.parentId).where(sql`family_id is not null`),
  index("guardian_family_ix").on(t.familyQboId),
  index("guardian_family_id_ix").on(t.familyId),
  index("guardian_parent_ix").on(t.parentId),
]);

/**
 * A link: one app record tied to its customer in the accounting system (today QuickBooks, `system`) of one company
 * (`realm_id`). Exactly one of `family_id`, `student_id` and `guardian_id` is set, and that is the link's kind: a family
 * to the family's customer, a student to theirs, and a membership (a `guardian` row) to the customer record its sign-in
 * came from, where the books give a guardian a record of their own. Within a company a customer has at most one family
 * link and one student link (it can be both, when records name it as both), and each record one link. Several guardian
 * rows may have come from one record (a closed one and the one open now), so a membership link is unique by its row
 * only. `origin` says how the link came to be: every link stage 1 makes is `carried_over` from the roster cache on
 * `linked_at`, with nobody named; one the portal makes for a customer it has just created in QuickBooks (a staff
 * member's new family, member or student, stage 3's slice 9c) is `created`, with `linked_by` the staff member who asked;
 * one "Create a family from this" makes (stage 3's slice 10, src/lib/roster/no-family.ts), for a customer no family
 * was linked to and the students under it, is `confirmed`, with `linked_by` the staff member with the linking
 * permission (Accounting.Link.ReadWrite, not Admin-only) who pressed it. Nothing deletes one but a change of company, which
 * deletes every row. A lookup always asks for one kind (src/lib/families/links.ts).
 */
export const accountingLink = pgTable("accounting_link", {
  id: uuid("id").primaryKey().defaultRandom(),
  system: text("system", { enum: ["quickbooks"] }).notNull(),
  realmId: text("realm_id").notNull(),                 // the company the customer is in
  customerId: text("customer_id").notNull(),           // the accounting system's own id of the customer (QuickBooks' Customer Id)
  familyId: uuid("family_id").references(() => family.id, { onDelete: "cascade" }).$type<AppFamilyId>(),
  studentId: uuid("student_id").references(() => student.id, { onDelete: "cascade" }).$type<AppStudentId>(),
  guardianId: uuid("guardian_id").references(() => guardian.id, { onDelete: "cascade" }),
  origin: text("origin", { enum: ["carried_over", "created", "confirmed"] }).notNull(),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  linkedBy: uuid("linked_by"),                         // staff_user.id of who asked for it or confirmed it; null for a link carried over
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("accounting_link_family_customer_uq").on(t.system, t.realmId, t.customerId).where(sql`family_id is not null`),
  uniqueIndex("accounting_link_student_customer_uq").on(t.system, t.realmId, t.customerId).where(sql`student_id is not null`),
  uniqueIndex("accounting_link_family_uq").on(t.familyId, t.system, t.realmId),
  uniqueIndex("accounting_link_student_uq").on(t.studentId, t.system, t.realmId),
  uniqueIndex("accounting_link_guardian_uq").on(t.guardianId, t.system, t.realmId),
  check("accounting_link_one_record", sql`num_nonnulls(${t.familyId}, ${t.studentId}, ${t.guardianId}) = 1`),
  check("accounting_link_carried_over_by_nobody", sql`${t.origin} <> 'carried_over' or ${t.linkedBy} is null`),
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

/**
 * A one-time link's token for a person, of the sign-in release (section 6 of the app-owned families spec, "Signing in"):
 * a set-up link, which chooses a first password, or a reset link, which chooses a new one. Only the keyed hash of the
 * token is stored (an HMAC, as a sign-in code's is), never the token. At most one unused token per person and purpose;
 * a token is spent by setting `used_at`. An unused token past its expiry still holds that place until the clean-up
 * deletes it, so making a link first deletes or spends the person's unused link of that purpose, expired or not, under
 * the person's lock and in the same transaction, as a new sign-in code replaces the old one (signin-codes.ts); an insert
 * alone would fail on `parent_signin_token_one_live_uq`. It goes with the person. The daily clean-up deletes an unused one past its
 * expiry, and one spent a code's life ago. A link whose mail is still on its way (slice SI-3a, the request page) is held:
 * `used_at` set to its own `created_at`, so it works for nobody and holds no place, until the mail has been handed over
 * and it is put in place (holdSigninLink(), putHeldLinkInPlace()).
 * Made by mintSigninLink() and spent by choosePasswordFromLink() since slice SI-2 (src/lib/parents/signin-links.ts,
 * password-set.ts); blocking, sign-ins switched off, the change-of-company clear, a confirmed change of sign-in email
 * and closing a person's last open membership delete the unused ones.
 */
export const parentSigninToken = pgTable("parent_signin_token", {
  id: uuid("id").primaryKey().defaultRandom(),
  purpose: text("purpose", { enum: ["setup", "reset"] }).notNull(),
  parentId: uuid("parent_id").notNull().references(() => parent.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  createdAt: created(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("parent_signin_token_one_live_uq").on(t.parentId, t.purpose).where(sql`used_at IS NULL`),
  index("parent_signin_token_hash_ix").on(t.tokenHash),
]);

/**
 * A device remembered as having passed the second step of a sign-in, for a person (the sign-in release): the keyed
 * hash of the token its cookie holds, never the token; renewed by use (`last_used_at`, `expires_at`: since slice SI-3b
 * at a password sign-in on the device; renewal while its session is in use is slice SI-5's). It goes with the person.
 * The daily clean-up deletes one past its expiry. Made since slice SI-3b by a sign-in that proved a password and a
 * second step, or a set-up link (recordStrongSignin(), src/lib/parents/devices.ts); since slice SI-2
 * blocking, sign-ins switched off, the change-of-company clear, a password reset, a confirmed change of sign-in email
 * and closing a person's last open membership delete them (src/lib/parents/sessions.ts).
 */
export const parentDevice = pgTable("parent_device", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentId: uuid("parent_id").notNull().references(() => parent.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  createdAt: created(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex("parent_device_token_uq").on(t.tokenHash),
  index("parent_device_parent_ix").on(t.parentId),
]);

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
 * The token is stored hashed. A request belongs to the person, the link (`guardian_id`) and the family it was asked under
 * and the QuickBooks record it would change; it is confirmed only by that person, signed in to that family through that
 * link, while that is still their record. The family is the app's own record (`family_id`, the session's family when it
 * was asked; migration 0037 carried each request's QuickBooks family over to it and 0038 dropped `family_qbo_id`);
 * which QuickBooks record it writes (`record_qbo_id`) is still decided when it is asked. The link and family were added
 * after the table (0016, 0037): a row without them is never confirmed. The record's id names a customer of the
 * connected company: a change of company deletes every row, before the app's records it names.
 */
export const parentEmailChange = pgTable("parent_email_change", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentId: uuid("parent_id").notNull().references(() => parent.id, { onDelete: "cascade" }),
  guardianId: uuid("guardian_id").references(() => guardian.id, { onDelete: "cascade" }),
  familyId: uuid("family_id").references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
  recordQboId: text("record_qbo_id"),
  newEmail: text("new_email").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: created(),
}, (t) => [
  uniqueIndex("parent_email_change_token_uq").on(t.tokenHash),
  uniqueIndex("parent_email_change_one_live").on(t.parentId).where(sql`used_at IS NULL`),
  index("parent_email_change_family_ix").on(t.familyId),
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
 * failed. Never a source of truth. Keyed by the app's own family (`family_id`, a `restrict` foreign key; migrations
 * 0032 and 0033 of stage 2 of the app-owned families spec): a row is only ever written for a family that has a record.
 * What is inside stays QuickBooks': the invoices and the check each name the customer they are of, and those ids
 * belong to the company in `realm_id`. A company change deletes every row (before the app's records it names), and so
 * does a change of membership shape, which changes whose invoices are a family's.
 */
export const familyMoney = pgTable("family_money", {
  familyId: uuid("family_id").primaryKey().references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
  realmId: text("realm_id"),                                         // the QuickBooks company the figures were read from
  readAt: timestamp("read_at", { withTimezone: true }),              // when the read that gave the figures first asked QuickBooks
  invoices: jsonb("invoices").$type<StoredInvoice[]>(),              // open invoices, then those paid in the last 12 months
  totalCents: bigint("total_cents", { mode: "number" }),             // the sum of the open invoices
  balanceWithJobsCents: bigint("balance_with_jobs_cents", { mode: "number" }), // QuickBooks' own figure, a cross-check only; null when it would count customers the total leaves out
  currency: text("currency"),                                        // null when the open invoices are in more than one
  mismatchAuditedAt: timestamp("mismatch_audited_at", { withTimezone: true }), // the last time a differing cross-check was audited
  checkedAt: timestamp("checked_at", { withTimezone: true }),         // when the worker last compared each customer's balance with its invoices
  customerChecks: jsonb("customer_checks").$type<CustomerCheck[]>(), // what that comparison found, one entry per customer compared
  failedAt: timestamp("failed_at", { withTimezone: true }),
  failedCode: text("failed_code"),                                   // a short code, never a response body
  staleAt: timestamp("stale_at", { withTimezone: true }),             // a buy-out invoice was made or voided since `read_at`: the next page load reads QuickBooks (src/lib/buyouts/writes.ts)
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
 * Every id is a QuickBooks id of the company the queue row names, because each is what is sent or what the roster
 * cache is compared with (a move's families feed its follow-ups, a create's family is looked for after a refresh); a
 * create holds the customer type it was given. The app's records the item is filed under are the row's own columns.
 */
export type RosterWrite =
  | { op: "create"; role: RosterRole; name: string; typeQboId: string; familyQboId: string | null; email: string | null }
  | { op: "rename"; role: RosterRole; qboId: string; syncToken: string; name: string; was: string }
  | { op: "move"; role: "student"; qboId: string; syncToken: string; fromFamilyQboId: string; toFamilyQboId: string }
  /**
   * `other`: a customer under a family that is neither its student nor its parent (a deeper sub-customer, or one of a
   * type the shape doesn't name), made inactive only as part of making its family inactive, which is never queued.
   */
  | { op: "deactivate"; role: RosterRole | "other"; qboId: string; syncToken: string };
/**
 * A volunteer buy-out's write to QuickBooks (v1 spec §11.5, src/lib/buyouts/writes.ts), kept in `write_queue.request`
 * beside the roster writes: the invoice made for one buy-out, and its void. Every id is a QuickBooks id of the company
 * the queue row names, from the roster cache when the guardian chose (what is sent); the family that chose it is the
 * row's `family_id`, the buy-out's own. A row written before migration 0034 also carries the family's customer as
 * `familyQboId`, which was never sent and which nothing reads. `buyoutId` is the portal's own `buyout.id`, which
 * the invoice carries in its private note so the portal can find it again. `billEmail` is the sign-in address of the
 * guardian who chose the buy-out, taken from their session when they chose (decided by the owner on 2026-11-17:
 * QuickBooks gives a Pay link only to an invoice that carries an email address). Every try sends that address, never
 * one looked up again. A create queued before then has none, and is sent without one, as it was then.
 */
export type BuyoutWrite =
  | { op: "invoice_create"; buyoutId: string; customerQboId: string; itemQboId: string; units: number; unitCents: number; billEmail?: string }
  | { op: "invoice_void"; buyoutId: string; invoiceQboId: string; customerQboId: string; why: "switched_back" | "student_moved" };
/**
 * Everything the write queue holds: the staff roster writes and the buy-out invoice writes, as they are sent, in
 * QuickBooks ids. Who an item is for in the app is `write_queue.family_id` and `student_id`, never read from here.
 */
export type QueuedWrite = RosterWrite | BuyoutWrite;

/**
 * Staff roster writes and buy-out invoice writes that QuickBooks didn't take at the time and may take later (v1 spec §4,
 * §8.4): it was busy, it throttled, or it couldn't be reached or didn't answer. `sent` says whether QuickBooks may have
 * acted on the last try: such an item is never simply sent again (src/lib/roster/queue.ts looks in a fresh roster
 * first). What is sent, and the customer it changes (`target_qbo_id`, the key of "one change waiting on a record"),
 * stay QuickBooks'. Since stage 3 of the app-owned families spec (migrations 0034 and 0035) the item names the app's
 * own records it is filed under, each a `restrict` foreign key: `family_id`, the family it is under or about (a new
 * student's or parent's family, a changed student's or parent's, the family itself, a member's own in flat books, the
 * family a student moves from, the family that chose a buy-out), and `student_id`, the student a rename, move or
 * make-inactive is for. Each is null where there is no such record: a new family or member (made after QuickBooks
 * answers), a parent's own customer, an invoice's student. A done or given-up item is kept 30 days (the daily
 * clean-up); every item goes when a different company is connected, before the app's records.
 */
export const writeQueue = pgTable("write_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  realmId: text("realm_id").notNull(),               // the company it is for: never sent to another
  request: jsonb("request").$type<QueuedWrite>().notNull(),
  targetQboId: text("target_qbo_id"),                // the customer it changes; null for a create
  familyId: uuid("family_id").references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),     // the family it is filed under
  studentId: uuid("student_id").references(() => student.id, { onDelete: "restrict" }).$type<AppStudentId>(), // the student it is for
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
  index("write_queue_family_id_ix").on(t.familyId),
  index("write_queue_student_ix").on(t.studentId),
]);

/**
 * What one request of the check of the portal's own QuickBooks requests found (src/lib/quickbooks/sandbox-check/), kept in
 * `qbo_check_run.results`: the expectation's key, its outcome, a short code, and what was learned as short codes, counts
 * and host names only. Never a customer's name, an amount, an address or any other QuickBooks text.
 */
export type CheckOutcome = "as_expected" | "not_as_expected" | "learned" | "not_run";
export type CheckLearned = Record<string, string | number | boolean | string[]>;
export type CheckResult = { key: string; outcome: CheckOutcome; code: string | null; learned: CheckLearned };

/**
 * One run of the check of the portal's QuickBooks requests (src/lib/quickbooks/sandbox-check/): when, by whom, against
 * which company and environment, and what each request did. The writes run only against an Intuit sandbox company
 * (`writes`). `outcome` is null while it runs; a run found unfinished by a later one is `cut_off`; one asked to try the
 * writes that left any of them untried is `incomplete`, never `passed`. Kept: a few rows a
 * year, read by the check's page and the Health page.
 */
export const qboCheckRun = pgTable("qbo_check_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  realmId: text("realm_id").notNull(),               // the company checked: its id, never its name
  environment: text("environment", { enum: ["sandbox", "production"] }).notNull(),
  writes: boolean("writes").notNull(),                // whether the writes were allowed to run (sandbox only)
  tag: text("tag").notNull(),                        // what the check's own records are named after: "2026-11-17 a1b2"
  startedBy: uuid("started_by"),                      // staff_user.id
  startedByLabel: text("started_by_label"),
  outcome: text("outcome", { enum: ["passed", "not_as_expected", "incomplete", "stopped", "cut_off"] }),
  stopCode: text("stop_code"),                        // why a run stopped early: a short code
  results: jsonb("results").$type<CheckResult[]>().notNull().default(sql`'[]'::jsonb`),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [index("qbo_check_run_started_ix").on(t.startedAt)]);

/**
 * A record the check made in a sandbox company: the only records it ever writes to. Every write it sends names an id
 * listed here for its own run (or, to make it inactive, for an earlier run that was cut off). `closed_at` is set once
 * the customer is inactive or the invoice voided; a row left open is made inactive by the next run first. The ids
 * belong to the company in `realm_id`; a change of company deletes every row (clearRosterOfOtherCompanyLocked).
 * A row is written before its create is sent, with no `qbo_id`: a create whose answer was lost is then found again by
 * its name, which no other record can have (QuickBooks keeps names unique, and each run's names carry a random tag).
 */
export const qboCheckRecord = pgTable("qbo_check_record", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => qboCheckRun.id, { onDelete: "restrict" }),
  realmId: text("realm_id").notNull(),
  kind: text("kind", { enum: ["family", "student", "parent", "invoice"] }).notNull(),
  qboId: text("qbo_id"),                              // null until QuickBooks answers the create
  name: text("name").notNull(),                       // the check's own name for it; for an invoice, the marker in its private note
  closedAt: timestamp("closed_at", { withTimezone: true }),
  lastCode: text("last_code"),                        // the last short code when closing it failed
  createdAt: created(),
}, (t) => [
  uniqueIndex("qbo_check_record_uq").on(t.realmId, t.kind, t.qboId),
  index("qbo_check_record_run_ix").on(t.runId),
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
  itemQboId: text("item_qbo_id"),                      // payment: the QuickBooks product or service it is met by (src/lib/money/payment-rule.ts); volunteer: what a buy-out is billed with
  buyoutUnitCents: integer("buyout_unit_cents"),       // volunteer only: a buy-out's price per shift or hour still owed, in cents; null when no buy-out is offered (src/lib/buyouts/)
  position: integer("position").notNull(),
  form: jsonb("form").$type<FormSetting>(),              // the form kind only: the Documenso template and who must sign; null until staff attach one
  formReminders: jsonb("form_reminders").$type<FormReminders>(), // the form kind only: when reminders go (staff Forms page); null for none
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index("requirement_step_ix").on(t.stepId, t.position)]);

/**
 * The families or students a requirement with `covers = 'chosen'` is asked of: the app's own records, a family for a
 * per-family requirement and a student for a per-student one (exactly one of `family_id` and `student_id`; which one
 * follows the requirement's `applies_to`, as src/lib/seasons/ writes them). A record is never deleted while anything
 * names it, so one that has left the roster stays listed and is simply not shown.
 */
export const requirementCover = pgTable("requirement_cover", {
  requirementId: uuid("requirement_id").notNull().references(() => requirement.id, { onDelete: "cascade" }),
  familyId: uuid("family_id").references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
  studentId: uuid("student_id").references(() => student.id, { onDelete: "restrict" }).$type<AppStudentId>(),
  createdAt: created(),
}, (t) => [
  uniqueIndex("requirement_cover_family_uq").on(t.requirementId, t.familyId),
  uniqueIndex("requirement_cover_student_uq").on(t.requirementId, t.studentId),
  index("requirement_cover_family_ix").on(t.familyId),
  index("requirement_cover_student_ix").on(t.studentId),
  check("requirement_cover_one_subject", sql`num_nonnulls(${t.familyId}, ${t.studentId}) = 1`),
]);

/**
 * What is recorded for one family or one student against one requirement: that it is met, a waiver, or both. A row
 * exists only while it records something. It names the app's own family (`family_id`) for a per-family requirement
 * and the app's own student (`student_id`) for a per-student one, exactly one of the two. `met_at` is a checklist
 * item's tick; the other kinds are judged from their own records and leave it null. A waiver always has a reason. The row keeps the requirement from being deleted.
 */
export const requirementProgress = pgTable("requirement_progress", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: uuid("requirement_id").notNull().references(() => requirement.id, { onDelete: "restrict" }),
  familyId: uuid("family_id").references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
  studentId: uuid("student_id").references(() => student.id, { onDelete: "restrict" }).$type<AppStudentId>(),
  metAt: timestamp("met_at", { withTimezone: true }),
  metBy: uuid("met_by"),                                 // staff_user.id
  waivedAt: timestamp("waived_at", { withTimezone: true }),
  waivedBy: uuid("waived_by"),                           // staff_user.id
  waivedReason: text("waived_reason"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("requirement_progress_family_uq").on(t.requirementId, t.familyId),
  uniqueIndex("requirement_progress_student_uq").on(t.requirementId, t.studentId),
  index("requirement_progress_family_ix").on(t.familyId),
  index("requirement_progress_student_ix").on(t.studentId),
  check("requirement_progress_one_subject", sql`num_nonnulls(${t.familyId}, ${t.studentId}) = 1`),
  check("requirement_progress_records_something", sql`${t.metAt} is not null or ${t.waivedAt} is not null`),
  check("requirement_progress_waiver_reason", sql`(${t.waivedAt} is null) = (${t.waivedReason} is null)`),
]);

/**
 * The reminders before a required payment's or checklist item's due date (src/lib/seasons/due-reminders.ts), one row
 * per email: to one guardian of one family, about that family's requirements due on `due_on`, sent 14 or 3 days before
 * it (`kind`). Claimed before it is sent, so two wakes never send it twice; `outcome` is null while the send is under
 * way, and a failed one may be claimed again after a while. The family is the app's own record. Deleted after a year by
 * the daily clean-up.
 */
export const requirementReminder = pgTable("requirement_reminder", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["due_14", "due_3"] }).notNull(),
  familyId: uuid("family_id").notNull().references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
  parentId: uuid("parent_id").notNull(),
  dueOn: date("due_on", { mode: "string" }).notNull(),     // the club's date
  triedAt: timestamp("tried_at", { withTimezone: true }).notNull(),
  outcome: text("outcome", { enum: ["sent", "failed"] }),
  createdAt: created(),
}, (t) => [
  uniqueIndex("requirement_reminder_family_uq").on(t.kind, t.familyId, t.dueOn, t.parentId),
  index("requirement_reminder_family_ix").on(t.familyId),
  index("requirement_reminder_created_ix").on(t.createdAt),
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
 * One place on a shift, taken by a guardian for themselves or for one of their students (v1 spec §11.2). `family_id`
 * is the app's own family it was taken from, and `student_id` the app's own student who fills it (stage 2 of the
 * app-owned families spec; migrations 0026 and 0027): a place belongs to that family only while its student is still
 * active and in it (src/lib/volunteer/my-volunteer.ts), so one whose student moved is nobody's. `signed_up_by` is the
 * guardian who took it (parent.id), and `filler_name` the name of whoever fills it, as it was then. A cancelled
 * sign-up keeps its row and frees its place. One person holds one place on a shift at most.
 */
export const volunteerSignup = pgTable("volunteer_signup", {
  id: uuid("id").primaryKey().defaultRandom(),
  shiftId: uuid("shift_id").notNull().references(() => volunteerShift.id, { onDelete: "restrict" }),
  familyId: uuid("family_id").notNull().references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
  signedUpBy: uuid("signed_up_by").notNull(),          // parent.id
  fillerKind: text("filler_kind", { enum: ["guardian", "student"] }).notNull(),
  fillerParentId: uuid("filler_parent_id"),            // parent.id, when a guardian fills it
  studentId: uuid("student_id").references(() => student.id, { onDelete: "restrict" }).$type<AppStudentId>(), // when a student fills it
  fillerName: text("filler_name").notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledByDoor: text("cancelled_by_door", { enum: ["parent", "staff"] }),
  cancelledBy: uuid("cancelled_by"),                   // parent.id or staff_user.id
  createdAt: created(),
}, (t) => [
  index("volunteer_signup_shift_ix").on(t.shiftId),
  index("volunteer_signup_family_id_ix").on(t.familyId),
  index("volunteer_signup_student_id_ix").on(t.studentId),
  uniqueIndex("volunteer_signup_guardian_uq").on(t.shiftId, t.fillerParentId).where(sql`cancelled_at is null and filler_kind = 'guardian'`),
  uniqueIndex("volunteer_signup_student_id_uq").on(t.shiftId, t.studentId).where(sql`cancelled_at is null and filler_kind = 'student'`),
  check("volunteer_signup_filler_record", sql`(${t.fillerKind} = 'guardian' and ${t.fillerParentId} is not null and ${t.studentId} is null) or (${t.fillerKind} = 'student' and ${t.studentId} is not null and ${t.fillerParentId} is null)`),
]);

/**
 * Confirmed volunteer credit (v1 spec §11.4), one row per credit. A check-in (`checkin`, by the guardian with the
 * shift's code, or `staff_checkin`, added by staff for one that was missed) names the sign-up it came from, and so its
 * shift, family and filler; it credits the shift's length in minutes as it was then, and one shift. Volunteering done
 * outside the portal (`outside`) names the family, the student when it is one student's, the one requirement it counts
 * toward, and the amount in that requirement's unit (`minutes` for hours, `shifts` for shifts); its `note` is for staff
 * only. How credit fills requirements is src/lib/volunteer/allocation.ts. A removed credit keeps its row, with who and
 * why (the reason is for staff only), and counts for nothing. A sign-up holds one live credit at most. The family and
 * the student are the app's own records (migrations 0026 and 0027): credit stays with the family it was earned for.
 */
export const volunteerCredit = pgTable("volunteer_credit", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["checkin", "staff_checkin", "outside"] }).notNull(),
  signupId: uuid("signup_id").references(() => volunteerSignup.id, { onDelete: "restrict" }),
  familyId: uuid("family_id").notNull().references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
  // Outside credit for one student; a check-in's filler is its sign-up's.
  studentId: uuid("student_id").references(() => student.id, { onDelete: "restrict" }).$type<AppStudentId>(),
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
  index("volunteer_credit_family_id_ix").on(t.familyId),
  index("volunteer_credit_student_id_ix").on(t.studentId),
  uniqueIndex("volunteer_credit_signup_uq").on(t.signupId).where(sql`removed_at is null`),
  check("volunteer_credit_source_record", sql`(${t.kind} in ('checkin', 'staff_checkin') and ${t.signupId} is not null and ${t.requirementId} is null and ${t.studentId} is null) or (${t.kind} = 'outside' and ${t.signupId} is null and ${t.requirementId} is not null)`),
  check("volunteer_credit_amount", sql`${t.minutes} >= 0 and ${t.shifts} >= 0 and ${t.minutes} + ${t.shifts} > 0`),
]);

/**
 * The volunteer reminders the worker sends (v1 spec §11.3), one row per email, claimed before it is sent so two
 * wakes never send it twice: the day-before reminder of one sign-up (`key` is the sign-up and the shift's date), and a
 * due-date nudge to one guardian of one family (`key` is the app's family, the due date and the guardian; `kind` says
 * which nudge). `outcome` is null while the send is under way; a failed one may be claimed again after a while. The
 * family is the app's own record (migrations 0026 and 0027, which carried every claim over with its key rewritten).
 */
export const volunteerReminder = pgTable("volunteer_reminder", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["day_before", "due_14", "due_3"] }).notNull(),
  key: text("key").notNull(),
  familyId: uuid("family_id").notNull().references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
  triedAt: timestamp("tried_at", { withTimezone: true }).notNull(),
  outcome: text("outcome", { enum: ["sent", "failed"] }),
  createdAt: created(),
}, (t) => [uniqueIndex("volunteer_reminder_kind_key_uq").on(t.kind, t.key), index("volunteer_reminder_family_id_ix").on(t.familyId)]);

/**
 * A family's or one student's choice to pay instead of volunteering (v1 spec §11.5), and its QuickBooks invoice: the
 * only invoice the portal ever creates. `family_id` is the app's own family that chose it; a per-student requirement's
 * names the app's own student it is for (`student_id`), and a per-family one's none, its subject being the family
 * (stage 2 of the app-owned families spec; migrations 0030 and 0031). What it bills stays QuickBooks': `customer_qbo_id`
 * is who the invoice is billed to (the family customer, or the student's own), read from the roster cache for the
 * session's family, with the item, the invoice and the company it is in. The price is fixed when the guardian confirms:
 * credit earned later does not lower it. One live buy-out at most per requirement and family where it is the family's
 * (`buyout_family_live_uq`), and per requirement and student whichever family chose it (`buyout_student_live_uq`), so a
 * guardian can never make two invoices for one requirement. `flag` is set for the treasurer (the daily check, a move, a
 * paid invoice the portal would not void) and shown on the Reconciliation page. Never expires; a company change deletes
 * every row. The row keeps the requirement, the family and the student from being deleted.
 */
export const buyout = pgTable("buyout", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: uuid("requirement_id").notNull().references(() => requirement.id, { onDelete: "restrict" }),
  familyId: uuid("family_id").notNull().references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
  studentId: uuid("student_id").references(() => student.id, { onDelete: "restrict" }).$type<AppStudentId>(), // a per-student requirement's student; null for a per-family one
  customerQboId: text("customer_qbo_id").notNull(),
  itemQboId: text("item_qbo_id").notNull(),
  unitCents: integer("unit_cents").notNull(),
  units: integer("units").notNull(),
  amountCents: integer("amount_cents").notNull(),
  // Where it stands (src/lib/buyouts/rules.ts). All but voided and refused are live: one at most per requirement and subject.
  state: text("state", { enum: ["being_invoiced", "invoiced", "paid", "being_voided", "voided", "refused", "stuck"] }).notNull(),
  // Why a voided one ended: its invoice voided (switched back, student moved, or in QuickBooks), or closed by staff from
  // Reconciliation once no unpaid invoice of it stood, with nothing sent to QuickBooks (src/lib/buyouts/close.ts).
  endReason: text("end_reason", { enum: ["switched_back", "student_moved", "voided_in_quickbooks", "closed_by_staff"] }),
  invoiceQboId: text("invoice_qbo_id"),
  invoiceSyncToken: text("invoice_sync_token"),
  realmId: text("realm_id").notNull(),                 // the QuickBooks company the invoice is in
  chosenBy: uuid("chosen_by").notNull(),               // parent.id
  chosenByLabel: text("chosen_by_label"),
  lastCode: text("last_code"),                         // the last short code from QuickBooks, never its words
  flag: text("flag", { enum: ["missing", "other_customer", "student_moved", "paid_before_void", "void_refused", "given_up"] }), // for staff, on Reconciliation (src/lib/buyouts/staff.ts)
  flaggedAt: timestamp("flagged_at", { withTimezone: true }),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  // One live buy-out per requirement and subject: a per-family one's by its family, a per-student one's by its student
  // across every family (a student another family's live buy-out still holds is offered no choice).
  uniqueIndex("buyout_family_live_uq").on(t.requirementId, t.familyId).where(sql`state not in ('voided', 'refused') and student_id is null`),
  uniqueIndex("buyout_student_live_uq").on(t.requirementId, t.studentId).where(sql`state not in ('voided', 'refused') and student_id is not null`),
  index("buyout_family_id_ix").on(t.familyId),
  index("buyout_student_id_ix").on(t.studentId),
  index("buyout_state_ix").on(t.state),
  check("buyout_amount", sql`${t.unitCents} > 0 and ${t.units} > 0 and ${t.amountCents} = ${t.unitCents} * ${t.units}`),
]);
export type BuyoutState = (typeof buyout.$inferSelect)["state"];

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
 * declined. `family_id` is the app's own family whose request it is: every parent lookup starts from it. A per-student
 * form names the app's own student it is signed for (`student_id`); a per-family form names none, its subject being the
 * family (stage 2 of the app-owned families spec; migrations 0028 and 0029). A complete request moves with its student
 * to another family; any other is reset under the new family (src/lib/forms/moved.ts). `evidence_owed` is set when a
 * request becomes complete and cleared by whatever stores its sealed PDF and audit record. The row keeps the
 * requirement, the family and the student from being deleted.
 */
export const signatureRequest = pgTable("signature_request", {
  id: uuid("id").primaryKey().defaultRandom(),
  requirementId: uuid("requirement_id").notNull().references(() => requirement.id, { onDelete: "restrict" }),
  familyId: uuid("family_id").notNull().references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
  studentId: uuid("student_id").references(() => student.id, { onDelete: "restrict" }).$type<AppStudentId>(), // a per-student form's student; null for a per-family form
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
  // One request per form and subject: a per-family form's by its family, a per-student form's by its student.
  uniqueIndex("signature_request_family_uq").on(t.requirementId, t.familyId).where(sql`student_id is null`),
  uniqueIndex("signature_request_student_uq").on(t.requirementId, t.studentId).where(sql`student_id is not null`),
  uniqueIndex("signature_request_envelope_uq").on(t.envelopeId).where(sql`envelope_id is not null`),
  index("signature_request_family_id_ix").on(t.familyId),
  index("signature_request_student_id_ix").on(t.studentId),
  index("signature_request_state_ix").on(t.state, t.checkedAt),
]);

/**
 * A guardian's agreement to sign one form electronically (v1 spec §9.2): who, when, from which address, and which
 * version of the consent text they were shown (src/lib/forms/consent.ts). Without a row for the signed-in guardian no
 * document is made and no signing token is handed out. Kept with the request as part of its evidence (§9.4). The
 * request is the family's (signature_request.family_id), and a company change, were it to run, deletes these with it.
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
 * (the roster cache's company then), or null when the family had no link there, or the roster named no company: a
 * family the club keeps by hand signs forms like any other. When a different company is connected the row is kept,
 * `request_id` is cut (`earlier_company_at` is set), and from then on it is shown only in the staff archive: its
 * QuickBooks ids may name another family in the new company. `mismatch_at` is set when a later fetch gave a stored file
 * a different hash.
 *
 * `family_qbo_id`, `subject_qbo_id` and `subject_kind` are the record's own copies of whose form it was, in QuickBooks'
 * ids: the customers the family's and the subject's own links named when it was kept, each null when that record had
 * no link then (migration 0036; kept with a company only, so both are null when `realm_id` is). Never changed or
 * removed once stored (a link made later fills nothing in), and never used to find a family. The current company's evidence also
 * names the app's own family whose form it is now (`family_id`, which moves with a student, as the request does) and,
 * for a per-student form, the app's own student (`student_id`): that is how the portal finds a family's evidence
 * (stage 2 of the app-owned families spec; migration 0028 filled them). An earlier company's evidence names neither,
 * and never gains them (signed_form_evidence_app_records): it is matched to nobody.
 */
export const signedFormEvidence = pgTable("signed_form_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id"),                           // signature_request.id, with no foreign key; null once its company is an earlier one
  realmId: text("realm_id"),                               // the QuickBooks company the request's family belonged to; null with no link
  earlierCompanyAt: timestamp("earlier_company_at", { withTimezone: true }),
  requirementId: uuid("requirement_id"),                   // requirement.id, with no foreign key
  familyQboId: text("family_qbo_id"),                      // the record's copy, null with no link: never changed, never matched to a family
  subjectQboId: text("subject_qbo_id"),                    // the record's copy, null with no link: never changed, never matched to a family
  subjectKind: text("subject_kind", { enum: ["family", "student"] }).notNull(),
  familyId: uuid("family_id").references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),   // the current company's only
  studentId: uuid("student_id").references(() => student.id, { onDelete: "restrict" }).$type<AppStudentId>(), // a per-student form's, the current company's only
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
  index("signed_form_evidence_family_id_ix").on(t.familyId),
  index("signed_form_evidence_student_id_ix").on(t.studentId),
  index("signed_form_evidence_earlier_ix").on(t.earlierCompanyAt),
  // An earlier company's evidence names no app record; the current company's names its family, and its student exactly when it is a student's.
  check("signed_form_evidence_app_records", sql`(${t.earlierCompanyAt} is not null and ${t.familyId} is null and ${t.studentId} is null) or (${t.earlierCompanyAt} is null and ${t.familyId} is not null and (${t.studentId} is null) = (${t.subjectKind} = 'family'))`),
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
>(prefix: "staff_auth" | "parent_auth", extraUser: U = {} as U, extraSession: S = {} as S,
  sessionIndexes: (t: Record<string, PgColumn>) => PgTableExtraConfigValue[] = () => []) {
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
  }, (t) => sessionIndexes(t as unknown as Record<string, PgColumn>));
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

// A parent session's family (Better Auth's additional field `familyId`, src/lib/auth/parent-auth.ts): the app's own
// family record the session chose, null until it chooses one. The gate matches it to the person's own open guardian
// rows by their `family_id` on every request (src/lib/auth/resolve.ts); it is never a QuickBooks id. Migration 0037
// carried each session's QuickBooks family over to it (clearing one it couldn't), and 0038 dropped `family_qbo_id`. A
// change of company deletes every session before the app's records go (clearParentAccess()).
// `strong_at` (the sign-in release, slice SI-1): when this session last proved the password and the second step, null
// until a later slice stamps it. It is the portal's alone: it is not a Better Auth additional field, so the library
// never names it. Its drizzle adapter inserts and updates only the fields its own schema knows, leaving this column at
// its null, and returns only those fields (so /get-session never answers it, and a session the library makes again
// from an old one starts with none). Nullable for that reason; no backfill.
const parentAuth = authTables("parent_auth",
  { parentId: uuid("parent_id").notNull().unique().references(() => parent.id, { onDelete: "cascade" }) },
  { familyId: uuid("family_id").references(() => family.id, { onDelete: "restrict" }).$type<AppFamilyId>(),
    strongAt: timestamp("strong_at", { withTimezone: true }) },
  (t) => [index("parent_auth_session_family_ix").on(t.familyId!)]);
export const parentAuthUser = parentAuth.user;
export const parentAuthSession = parentAuth.session;
export const parentAuthAccount = parentAuth.account;
export const parentAuthVerification = parentAuth.verification;
