CREATE TYPE "public"."creator_audience" AS ENUM('mens', 'womens', 'any');--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "audience" "creator_audience" DEFAULT 'any' NOT NULL;