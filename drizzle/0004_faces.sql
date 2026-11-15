-- People (face grouping). See FACES.md. Idempotent: two cold instances may race (lib/db/migrate.ts).
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "faces_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "people_version" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "faces_lock_until" timestamp with time zone DEFAULT 'epoch' NOT NULL;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "faces_rebuilt_at_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN IF NOT EXISTS "faces_opt_out" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "face_jobs" (
	"media_id" uuid PRIMARY KEY NOT NULL REFERENCES "media"("id") ON DELETE CASCADE,
	"event_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone DEFAULT 'epoch' NOT NULL,
	"error" text,
	"faces" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "face_jobs_status" CHECK ("status" in ('pending','done','failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "face_jobs_pending" ON "face_jobs" ("event_id","lease_until") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "face_jobs_pending_all" ON "face_jobs" ("created_at") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL REFERENCES "events"("id"),
	"name" text,
	"cover_face_id" uuid,
	"cover_pinned" boolean DEFAULT false NOT NULL,
	"face_count" integer DEFAULT 0 NOT NULL,
	"media_count" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "people_event" ON "people" ("event_id","media_count" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "faces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"media_id" uuid NOT NULL REFERENCES "media"("id") ON DELETE CASCADE,
	"person_id" uuid REFERENCES "people"("id") ON DELETE SET NULL,
	"model" text NOT NULL,
	"embedding" vector(128) NOT NULL,
	"box" real[] NOT NULL,
	"score" real NOT NULL,
	"quality" real NOT NULL,
	"crop" text NOT NULL,
	"clustered" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "faces_event_person" ON "faces" ("event_id","person_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "faces_media" ON "faces" ("media_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "faces_unclustered" ON "faces" ("event_id","created_at") WHERE NOT "clustered";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "face_rejections" (
	"face_id" uuid NOT NULL REFERENCES "faces"("id") ON DELETE CASCADE,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE CASCADE,
	PRIMARY KEY ("face_id","person_id")
);
