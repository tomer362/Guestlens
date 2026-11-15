import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, boolean, timestamp, bigint, integer, real, date, index, uniqueIndex, check, vector, primaryKey,
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
  /** bumped whenever the set of visible media changes; clients poll it to know when to refetch */
  mediaVersion: bigint("media_version", { mode: "number" }).notNull().default(0),
  /** People page (face grouping, FACES.md): off until the admin turns it on */
  facesEnabled: boolean("faces_enabled").notNull().default(false),
  /** bumped whenever people or their faces change; the People page polls it like media_version */
  peopleVersion: bigint("people_version", { mode: "number" }).notNull().default(0),
  /** single-flight lease for clustering this event's faces */
  facesLockUntil: timestamp("faces_lock_until", { withTimezone: true }).notNull().default(new Date(0)),
  /** face count at the last full regroup (decides when the next one is due) */
  facesRebuiltAtCount: integer("faces_rebuilt_at_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const guests = pgTable("guests", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  displayName: text("display_name"), // optional
  /** this guest's uploads are never scanned for faces */
  facesOptOut: boolean("faces_opt_out").notNull().default(false),
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
  /** tiny blurred preview as a data URL, sent inline with the gallery */
  lqip: text("lqip"),
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

/** One row per media item to scan for faces (a Postgres-backed job queue with leases). */
export const faceJobs = pgTable("face_jobs", {
  mediaId: uuid("media_id").primaryKey().references(() => media.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull(),
  status: text("status", { enum: ["pending", "done", "failed"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull().default(new Date(0)),
  error: text("error"),
  faces: integer("faces"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const people = pgTable("people", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => events.id),
  name: text("name"),
  coverFaceId: uuid("cover_face_id"),
  coverPinned: boolean("cover_pinned").notNull().default(false),
  faceCount: integer("face_count").notNull().default(0),
  mediaCount: integer("media_count").notNull().default(0),
  hidden: boolean("hidden").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("people_event").on(t.eventId, t.mediaCount.desc())]);

export const faces = pgTable("faces", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull(),
  mediaId: uuid("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
  personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
  /** which detector+embedder made this vector; vectors from different models are never compared */
  model: text("model").notNull(),
  embedding: vector("embedding", { dimensions: 128 }).notNull(),
  /** [x, y, w, h] in source-image pixels */
  box: real("box").array().notNull(),
  score: real("score").notNull(),
  quality: real("quality").notNull(),
  /** 96 px WebP data URL */
  crop: text("crop").notNull(),
  /** went through incremental assignment */
  clustered: boolean("clustered").notNull().default(false),
  /** person assignment confirmed by a human (merge/rename/hide); regrouping keeps it */
  locked: boolean("locked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("faces_event_person").on(t.eventId, t.personId),
  index("faces_media").on(t.mediaId),
  index("faces_unclustered").on(t.eventId, t.createdAt).where(sql`not clustered`),
]);

/** "Not this person": regrouping never puts this face back into that person. */
export const faceRejections = pgTable("face_rejections", {
  faceId: uuid("face_id").notNull().references(() => faces.id, { onDelete: "cascade" }),
  personId: uuid("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.faceId, t.personId] })]);

export type MediaRow = typeof media.$inferSelect;
export type EventRow = typeof events.$inferSelect;
