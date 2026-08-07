CREATE TYPE "public"."inspiration_image_kind" AS ENUM('person', 'listing');--> statement-breakpoint
ALTER TABLE "job_inspiration_images" ADD COLUMN "kind" "inspiration_image_kind" DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_inspiration_images" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;