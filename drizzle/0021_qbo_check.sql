CREATE TABLE "qbo_check_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"realm_id" text NOT NULL,
	"kind" text NOT NULL,
	"qbo_id" text,
	"name" text NOT NULL,
	"closed_at" timestamp with time zone,
	"last_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qbo_check_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"realm_id" text NOT NULL,
	"environment" text NOT NULL,
	"writes" boolean NOT NULL,
	"tag" text NOT NULL,
	"started_by" uuid,
	"started_by_label" text,
	"outcome" text,
	"stop_code" text,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "qbo_check_record" ADD CONSTRAINT "qbo_check_record_run_id_qbo_check_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."qbo_check_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qbo_check_record_uq" ON "qbo_check_record" USING btree ("realm_id","kind","qbo_id");--> statement-breakpoint
CREATE INDEX "qbo_check_record_run_ix" ON "qbo_check_record" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "qbo_check_run_started_ix" ON "qbo_check_run" USING btree ("started_at");