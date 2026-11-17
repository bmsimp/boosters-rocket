CREATE TABLE "buyout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"family_qbo_id" text NOT NULL,
	"subject_qbo_id" text NOT NULL,
	"customer_qbo_id" text NOT NULL,
	"item_qbo_id" text NOT NULL,
	"unit_cents" integer NOT NULL,
	"units" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"state" text NOT NULL,
	"end_reason" text,
	"invoice_qbo_id" text,
	"invoice_sync_token" text,
	"realm_id" text NOT NULL,
	"chosen_by" uuid NOT NULL,
	"chosen_by_label" text,
	"last_code" text,
	"flag" text,
	"flagged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyout_amount" CHECK ("buyout"."unit_cents" > 0 and "buyout"."units" > 0 and "buyout"."amount_cents" = "buyout"."unit_cents" * "buyout"."units")
);
--> statement-breakpoint
ALTER TABLE "family_money" ADD COLUMN "stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requirement" ADD COLUMN "buyout_unit_cents" integer;--> statement-breakpoint
ALTER TABLE "buyout" ADD CONSTRAINT "buyout_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buyout_live_uq" ON "buyout" USING btree ("requirement_id","subject_qbo_id") WHERE state not in ('voided', 'refused');--> statement-breakpoint
CREATE INDEX "buyout_family_ix" ON "buyout" USING btree ("family_qbo_id");--> statement-breakpoint
CREATE INDEX "buyout_state_ix" ON "buyout" USING btree ("state");