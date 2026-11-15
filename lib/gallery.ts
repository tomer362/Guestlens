import { schema } from "@/lib/db/client";

/** One album tile, as sent to the client (album, admin moderation and person pages). */
export type GalleryItem = {
  id: string; kind: "photo" | "video"; url: string; thumbUrl: string;
  w: number | null; h: number | null; d: number | null; by: string | null; at: string; hidden?: boolean;
  /** inline blur placeholder */ p?: string;
};

const m = schema.media;
/** Only the columns a tile uses. */
export const galleryCols = {
  id: m.id, kind: m.kind, url: m.url, thumbUrl: m.thumbUrl, width: m.width, height: m.height,
  durationS: m.durationS, guestName: m.guestName, readyAt: m.readyAt, status: m.status, lqip: m.lqip,
};

type Row = {
  id: string; kind: "photo" | "video"; url: string | null; thumbUrl: string | null; width: number | null; height: number | null;
  durationS: number | null; guestName: string | null; readyAt: Date | null; status: string; lqip: string | null;
};

export function toGalleryItem(r: Row, admin = false): GalleryItem {
  return {
    id: r.id, kind: r.kind, url: r.url!, thumbUrl: r.thumbUrl!, w: r.width, h: r.height, d: r.durationS,
    by: r.guestName, at: r.readyAt!.toISOString(), ...(r.lqip ? { p: r.lqip } : {}), ...(admin ? { hidden: r.status === "hidden" } : {}),
  };
}

/** Keyset cursor for "older than this item". */
export const cursorOf = (r: Row) => `${r.readyAt!.toISOString()}_${r.id}`;
