CREATE TABLE "job_run" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"detail" text,
	"started_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_connection" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"environment" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_ciphertext" text NOT NULL,
	"client_secret_key_id" text NOT NULL,
	"state_hash" text,
	"state_staff_user_id" uuid,
	"state_expires_at" timestamp with time zone,
	"realm_id" text,
	"company_name" text,
	"access_token_ciphertext" text,
	"access_token_key_id" text,
	"access_expires_at" timestamp with time zone,
	"refresh_token_ciphertext" text,
	"refresh_token_key_id" text,
	"refresh_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"connected_by" uuid,
	"last_token_refresh_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_customer" (
	"qbo_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"active" boolean NOT NULL,
	"parent_qbo_id" text,
	"type_qbo_id" text,
	"email" text,
	"phone" text,
	"sync_token" text NOT NULL,
	"qbo_updated_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_customer_type" (
	"qbo_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "job_run_job_ix" ON "job_run" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX "qbo_customer_parent_ix" ON "qbo_customer" USING btree ("parent_qbo_id");--> statement-breakpoint
CREATE INDEX "qbo_customer_type_ix" ON "qbo_customer" USING btree ("type_qbo_id");