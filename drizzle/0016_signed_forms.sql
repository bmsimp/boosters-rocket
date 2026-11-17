CREATE TABLE "form_reminder_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"parent_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_reminder_round" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_withdrawal" (
	"envelope_id" text PRIMARY KEY NOT NULL,
	"any_signed" boolean NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signed_form_copy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"parent_id" uuid NOT NULL,
	"outcome" text DEFAULT 'sending' NOT NULL,
	"how" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "signed_form_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid,
	"realm_id" text,
	"earlier_company_at" timestamp with time zone,
	"requirement_id" uuid,
	"family_qbo_id" text NOT NULL,
	"subject_qbo_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"form_title" text NOT NULL,
	"family_name" text,
	"subject_name" text,
	"season_name" text,
	"envelope_id" text NOT NULL,
	"template_id" text,
	"template_updated_at" timestamp with time zone,
	"signers" jsonb NOT NULL,
	"consents" jsonb NOT NULL,
	"originals" jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"copies_done_at" timestamp with time zone,
	"mismatch_at" timestamp with time zone,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signed_form_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"item_id" text,
	"bytes" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requirement" ADD COLUMN "form_reminders" jsonb;--> statement-breakpoint
ALTER TABLE "signature_request" ADD COLUMN "evidence_tries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "signature_request" ADD COLUMN "evidence_error" text;--> statement-breakpoint
ALTER TABLE "signature_request" ADD COLUMN "evidence_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signed_form_copy" ADD CONSTRAINT "signed_form_copy_evidence_id_signed_form_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."signed_form_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_form_file" ADD CONSTRAINT "signed_form_file_evidence_id_signed_form_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."signed_form_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_reminder_claim_uq" ON "form_reminder_claim" USING btree ("requirement_id","parent_id","on_date");--> statement-breakpoint
CREATE INDEX "form_reminder_claim_created_ix" ON "form_reminder_claim" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "form_reminder_round_uq" ON "form_reminder_round" USING btree ("requirement_id","on_date");--> statement-breakpoint
CREATE INDEX "form_reminder_round_created_ix" ON "form_reminder_round" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signed_form_copy_uq" ON "signed_form_copy" USING btree ("evidence_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signed_form_evidence_request_uq" ON "signed_form_evidence" USING btree ("request_id") WHERE request_id is not null;--> statement-breakpoint
CREATE INDEX "signed_form_evidence_family_ix" ON "signed_form_evidence" USING btree ("family_qbo_id");--> statement-breakpoint
CREATE INDEX "signed_form_evidence_earlier_ix" ON "signed_form_evidence" USING btree ("earlier_company_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signed_form_file_uq" ON "signed_form_file" USING btree ("evidence_id","kind","position");