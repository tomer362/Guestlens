CREATE TABLE IF NOT EXISTS "diag_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"guest_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"msg" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "diag_log_event" ON "diag_log" ("event_id","created_at" DESC);
