CREATE TABLE "requirement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"applies_to" text NOT NULL,
	"amount" integer,
	"amount_unit" text,
	"due_on" date,
	"covers" text DEFAULT 'everyone' NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirement_cover" (
	"requirement_id" uuid NOT NULL,
	"subject_qbo_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirement_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"subject_qbo_id" text NOT NULL,
	"met_at" timestamp with time zone,
	"met_by" uuid,
	"waived_at" timestamp with time zone,
	"waived_by" uuid,
	"waived_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_progress_records_something" CHECK ("requirement_progress"."met_at" is not null or "requirement_progress"."waived_at" is not null),
	CONSTRAINT "requirement_progress_waiver_reason" CHECK (("requirement_progress"."waived_at" is null) = ("requirement_progress"."waived_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "season" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "season_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_step_id_season_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."season_step"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_cover" ADD CONSTRAINT "requirement_cover_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_progress" ADD CONSTRAINT "requirement_progress_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_step" ADD CONSTRAINT "season_step_season_id_season_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."season"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requirement_step_ix" ON "requirement" USING btree ("step_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_cover_uq" ON "requirement_cover" USING btree ("requirement_id","subject_qbo_id");--> statement-breakpoint
CREATE INDEX "requirement_cover_subject_ix" ON "requirement_cover" USING btree ("subject_qbo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_progress_subject_uq" ON "requirement_progress" USING btree ("requirement_id","subject_qbo_id");--> statement-breakpoint
CREATE INDEX "requirement_progress_subject_ix" ON "requirement_progress" USING btree ("subject_qbo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "season_current_uq" ON "season" USING btree ("is_current") WHERE is_current;--> statement-breakpoint
CREATE INDEX "season_step_season_ix" ON "season_step" USING btree ("season_id","position");