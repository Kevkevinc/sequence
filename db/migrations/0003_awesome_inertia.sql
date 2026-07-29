CREATE TYPE "public"."render_status" AS ENUM('rendering', 'done', 'failed');--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'rendering' BEFORE 'failed';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'done' BEFORE 'failed';--> statement-breakpoint
CREATE TABLE "renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edit_plan_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"storage_key" text,
	"duration_seconds" numeric,
	"status" "render_status" DEFAULT 'rendering' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_edit_plan_id_edit_plans_id_fk" FOREIGN KEY ("edit_plan_id") REFERENCES "public"."edit_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;