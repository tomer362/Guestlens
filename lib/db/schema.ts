import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, boolean, timestamp, bigint, integer, real, date, index, uniqueIndex, check,
} from "drizzle-orm/pg-core";

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  pinHash: text("pin_hash"),
  adminKeyHash: text("admin_key_hash").notNull(),
  uploadOpen: boolean("upload_open").notNull().default(true),
  /** whether guests can see each other's uploads */
  galleryPublic: boolean("gallery_public").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const guests = pgTable("guests", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  displayName: text("display_name"), // optional
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("guests_event").on(t.eventId)]);

export const media = pgTable("media", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  guestId: uuid("guest_id").notNull().references(() => guests.id),
  guestName: text("guest_name"), // snapshot so the gallery needs no join
  kind: text("kind", { enum: ["photo", "video"] }).notNull(),
  sha256: text("sha256").notNull(),
  contentType: text("content_type").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
  thumbBytes: integer("thumb_bytes").notNull(),
  width: integer("width"),
  height: integer("height"),
  durationS: real("duration_s"),
  url: text("url"),
  thumbUrl: text("thumb_url"),
  status: text("status", { enum: ["reserved", "ready", "hidden", "failed"] }).notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readyAt: timestamp("ready_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("media_event_sha").on(t.eventId, t.sha256),
  index("media_gallery").on(t.eventId, t.status, t.readyAt.desc(), t.id.desc()),
  index("media_guest_recent").on(t.guestId, t.createdAt),
  index("media_reserved").on(t.status, t.createdAt).where(sql`status = 'reserved'`),
  check("media_kind", sql`${t.kind} in ('photo','video')`),
]);

/** Our own meter for monthly advanced Blob operations (puts). */
export const usageMonth = pgTable("usage_month", {
  month: date("month").primaryKey(),
  blobPuts: integer("blob_puts").notNull().default(0),
});

/** Blob storage is cumulative (not monthly): single-row counter, id is always 1. */
export const storageUsage = pgTable("storage_usage", {
  id: integer("id").primaryKey().default(1),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
});

export type MediaRow = typeof media.$inferSelect;
export type EventRow = typeof events.$inferSelect;
