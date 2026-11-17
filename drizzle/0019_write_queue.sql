CREATE TABLE "write_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"realm_id" text NOT NULL,
	"request" jsonb NOT NULL,
	"target_qbo_id" text,
	"family_qbo_id" text,
	"state" text DEFAULT 'waiting' NOT NULL,
	"sent" boolean NOT NULL,
	"tries" integer DEFAULT 1 NOT NULL,
	"last_code" text,
	"last_tried_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_try_at" timestamp with time zone,
	"asked_by" uuid,
	"asked_by_label" text,
	"result_qbo_id" text,
	"note" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "write_queue_state_ix" ON "write_queue" USING btree ("state","next_try_at");--> statement-breakpoint
CREATE INDEX "write_queue_target_ix" ON "write_queue" USING btree ("target_qbo_id");--> statement-breakpoint
CREATE INDEX "write_queue_family_ix" ON "write_queue" USING btree ("family_qbo_id");