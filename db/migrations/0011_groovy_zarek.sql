CREATE TYPE "public"."job_kind" AS ENUM('cuts', 'talking');--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "kind" "job_kind" DEFAULT 'cuts' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "transcript" text;