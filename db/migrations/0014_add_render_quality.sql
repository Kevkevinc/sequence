CREATE TYPE "public"."render_quality" AS ENUM('1080p', '4k');--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "quality" "render_quality" DEFAULT '1080p' NOT NULL;