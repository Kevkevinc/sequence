CREATE TYPE "public"."creator_cohort" AS ENUM('beta', 'public');--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "cohort" "creator_cohort" DEFAULT 'beta' NOT NULL;