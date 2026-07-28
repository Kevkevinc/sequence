ALTER TYPE "public"."job_status" ADD VALUE 'tagging';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'planning';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'planned';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'failed';--> statement-breakpoint
CREATE TABLE "edit_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"variation_number" integer NOT NULL,
	"segments" jsonb NOT NULL,
	"hook_text" text NOT NULL,
	"sizing_overlay_text" text,
	"sizing_overlay_placement" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_clip_id" uuid NOT NULL,
	"start_seconds" numeric NOT NULL,
	"end_seconds" numeric NOT NULL,
	"content_tag" text,
	"quality_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "edit_plans" ADD CONSTRAINT "edit_plans_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_raw_clip_id_raw_clips_id_fk" FOREIGN KEY ("raw_clip_id") REFERENCES "public"."raw_clips"("id") ON DELETE no action ON UPDATE no action;