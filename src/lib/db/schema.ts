import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, uuid, jsonb, uniqueIndex, index, inet, bigserial, integer } from "drizzle-orm/pg-core";
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
export type DisabledReason = "no_active_students" | "removed";

/** One record per parent, whatever families they're in (spec §2). Everything refers to the id, never to the email. */
export const parent = pgTable("parent", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(), // stored trimmed + lower-cased
  phone: text("phone"),
  blocked: boolean("blocked").notNull().default(false),
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
  disabledReason: text("disabled_reason", { enum: ["no_active_students", "removed"] }),
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

/** A parent's own email change waiting for the confirm link (spec §2 Email changes). The token is stored hashed. */
export const parentEmailChange = pgTable("parent_email_change", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentId: uuid("parent_id").notNull().references(() => parent.id, { onDelete: "cascade" }),
  newEmail: text("new_email").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: created(),
}, (t) => [
  uniqueIndex("parent_email_change_token_uq").on(t.tokenHash),
  uniqueIndex("parent_email_change_one_live").on(t.parentId).where(sql`used_at IS NULL`),
]);

export type QboEnvironment = "sandbox" | "production";

/**
 * The club's QuickBooks connection (spec §2, §3): the Intuit app's keys and, once connected, the company and its tokens.
 * One row at most (`id` is always "singleton"). The secret and both tokens are sealed (src/lib/crypto/secret-box.ts).
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
});

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

/** One row per run of a scheduled or hand-started job (spec §4). `outcome` is null while it runs. */
export const jobRun = pgTable("job_run", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  job: text("job").notNull(),                        // "quickbooks.token_refresh" | "roster.refresh"
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  outcome: text("outcome", { enum: ["ok", "failed"] }),
  detail: text("detail"),                            // counts, or a fixed sentence and a code
  startedBy: text("started_by").notNull(),           // "worker" or a staff_user.id
}, (t) => [index("job_run_job_ix").on(t.job, t.startedAt)]);

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

/** Append-only audit trail (spec §13). */
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
}, (t) => [index("audit_at_ix").on(t.at)]);

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
