-- Stage 4's slice M3b: the history of ended links. Unlink from the books on the accounting links screen moves a family's
-- link, with its student records' and guardian rows' links, from accounting_link into this table, as each was, with when it
-- ended, by whom (staff_user.id, with no foreign key, as accounting_link.linked_by has none) and how; the audit page's record
-- filter reads it to bound each customer by when it was the record's. Additive: one table with its checks, foreign keys and
-- indexes, and no unique index (a customer may have been several records' in turn). It fills nothing and changes no row.
CREATE TABLE "accounting_link_ended" (
	"id" uuid PRIMARY KEY NOT NULL,
	"system" text NOT NULL,
	"realm_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"family_id" uuid,
	"student_id" uuid,
	"guardian_id" uuid,
	"origin" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"linked_by" uuid,
	"ended_at" timestamp with time zone NOT NULL,
	"ended_by" uuid,
	"ended_how" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_link_ended_one_record" CHECK (num_nonnulls("accounting_link_ended"."family_id", "accounting_link_ended"."student_id", "accounting_link_ended"."guardian_id") = 1),
	CONSTRAINT "accounting_link_ended_carried_over_by_nobody" CHECK ("accounting_link_ended"."origin" <> 'carried_over' or "accounting_link_ended"."linked_by" is null)
);
--> statement-breakpoint
ALTER TABLE "accounting_link_ended" ADD CONSTRAINT "accounting_link_ended_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_link_ended" ADD CONSTRAINT "accounting_link_ended_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_link_ended" ADD CONSTRAINT "accounting_link_ended_guardian_id_guardian_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."guardian"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_link_ended_family_ix" ON "accounting_link_ended" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "accounting_link_ended_student_ix" ON "accounting_link_ended" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "accounting_link_ended_guardian_ix" ON "accounting_link_ended" USING btree ("guardian_id");--> statement-breakpoint
CREATE INDEX "accounting_link_ended_customer_ix" ON "accounting_link_ended" USING btree ("system","realm_id","customer_id");