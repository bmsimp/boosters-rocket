CREATE TABLE "family_money" (
	"family_qbo_id" text PRIMARY KEY NOT NULL,
	"realm_id" text,
	"read_at" timestamp with time zone,
	"invoices" jsonb,
	"total_cents" bigint,
	"balance_with_jobs_cents" bigint,
	"currency" text,
	"mismatch_audited_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failed_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
