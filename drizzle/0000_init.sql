CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"pin_hash" text,
	"admin_key_hash" text NOT NULL,
	"upload_open" boolean DEFAULT true NOT NULL,
	"gallery_public" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"guest_name" text,
	"kind" text NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"thumb_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"duration_s" real,
	"url" text,
	"thumb_url" text,
	"status" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "media_kind" CHECK ("media"."kind" in ('photo','video'))
);
--> statement-breakpoint
CREATE TABLE "storage_usage" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_month" (
	"month" date PRIMARY KEY NOT NULL,
	"blob_puts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guests_event" ON "guests" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_event_sha" ON "media" USING btree ("event_id","sha256");--> statement-breakpoint
CREATE INDEX "media_gallery" ON "media" USING btree ("event_id","status","ready_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_guest_recent" ON "media" USING btree ("guest_id","created_at");--> statement-breakpoint
CREATE INDEX "media_reserved" ON "media" USING btree ("status","created_at") WHERE status = 'reserved';