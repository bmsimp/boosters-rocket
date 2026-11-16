CREATE TABLE "signature_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"parent_id" uuid NOT NULL,
	"parent_name" text NOT NULL,
	"parent_email" text NOT NULL,
	"text_version" text NOT NULL,
	"agreed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" "inet",
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "signature_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"family_qbo_id" text NOT NULL,
	"subject_qbo_id" text NOT NULL,
	"state" text DEFAULT 'not_opened' NOT NULL,
	"envelope_id" text,
	"envelope_status" text,
	"template_id" text,
	"template_updated_at" timestamp with time zone,
	"signers_mode" text,
	"subject_name" text,
	"signers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preparing_at" timestamp with time zone,
	"document_created_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"all_signed_at" timestamp with time zone,
	"seal_asked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"evidence_owed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requirement" ADD COLUMN "form" jsonb;--> statement-breakpoint
ALTER TABLE "signature_consent" ADD CONSTRAINT "signature_consent_request_id_signature_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."signature_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_consent" ADD CONSTRAINT "signature_consent_parent_id_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_request" ADD CONSTRAINT "signature_request_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signature_consent_uq" ON "signature_consent" USING btree ("request_id","parent_id","text_version");--> statement-breakpoint
CREATE UNIQUE INDEX "signature_request_subject_uq" ON "signature_request" USING btree ("requirement_id","subject_qbo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signature_request_envelope_uq" ON "signature_request" USING btree ("envelope_id") WHERE envelope_id is not null;--> statement-breakpoint
CREATE INDEX "signature_request_family_ix" ON "signature_request" USING btree ("family_qbo_id");--> statement-breakpoint
CREATE INDEX "signature_request_state_ix" ON "signature_request" USING btree ("state","checked_at");