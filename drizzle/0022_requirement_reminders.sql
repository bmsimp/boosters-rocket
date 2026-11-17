CREATE TABLE "requirement_reminder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"family_qbo_id" text NOT NULL,
	"parent_id" uuid NOT NULL,
	"due_on" date NOT NULL,
	"tried_at" timestamp with time zone NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_reminder_uq" ON "requirement_reminder" USING btree ("kind","family_qbo_id","due_on","parent_id");--> statement-breakpoint
CREATE INDEX "requirement_reminder_created_ix" ON "requirement_reminder" USING btree ("created_at");