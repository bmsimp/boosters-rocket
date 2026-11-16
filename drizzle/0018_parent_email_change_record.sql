ALTER TABLE "parent_email_change" ADD COLUMN "guardian_id" uuid;--> statement-breakpoint
ALTER TABLE "parent_email_change" ADD COLUMN "family_qbo_id" text;--> statement-breakpoint
ALTER TABLE "parent_email_change" ADD COLUMN "record_qbo_id" text;--> statement-breakpoint
ALTER TABLE "parent_email_change" ADD CONSTRAINT "parent_email_change_guardian_id_guardian_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."guardian"("id") ON DELETE cascade ON UPDATE no action;