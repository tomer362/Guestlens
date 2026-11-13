import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getGuest } from "@/lib/auth";
import { LIMITS } from "@/lib/config";
import { markPart } from "@/lib/media";
import { mediaPath, type UploadPart } from "@/lib/storage/provider";
import { err, json } from "@/lib/http";

export async function POST(req: Request) {
  const body = (await req.json()) as HandleUploadBody;
  try {
    const res = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const g = await getGuest();
        if (!g) throw new Error("no_guest");
        const { mediaId, part } = JSON.parse(clientPayload ?? "{}") as { mediaId?: string; part?: UploadPart };
        if (!mediaId || (part !== "file" && part !== "thumb")) throw new Error("bad_payload");

        const [m] = await db().select().from(schema.media).where(and(
          eq(schema.media.id, mediaId), eq(schema.media.guestId, g.gid), eq(schema.media.status, "reserved"),
        )).limit(1);
        if (!m) throw new Error("no_reservation");

        const thumbTypes = LIMITS.thumb.types as readonly string[];
        const type = part === "file" ? m.contentType : thumbTypes.find((t) => pathname === mediaPath(m.eventId, m.id, "thumb", t));
        if (!type || pathname !== mediaPath(m.eventId, m.id, part, type)) throw new Error("bad_path");

        console.info("[blob/token] issue", { mediaId, part, type, max: part === "file" ? m.bytes : m.thumbBytes });
        return {
          allowedContentTypes: [type],
          // exactly what was reserved, so the budget can't be gamed
          maximumSizeInBytes: part === "file" ? m.bytes : m.thumbBytes,
          addRandomSuffix: true,
          cacheControlMaxAge: 60 * 60 * 24 * 365,
          tokenPayload: JSON.stringify({ mediaId, part }),
        };
      },
      // Backup path in case the client dies after upload, before /complete. (Not called on localhost.)
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const { mediaId, part } = JSON.parse(tokenPayload ?? "{}") as { mediaId: string; part: UploadPart };
        if (mediaId && part) await markPart(mediaId, part, blob.url);
      },
    });
    return json(res);
  } catch (e) {
    console.error("[blob/token] error", (e as Error).message);
    return err(400, (e as Error).message || "token_error");
  }
}
