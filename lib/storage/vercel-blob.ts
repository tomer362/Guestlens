import { del } from "@vercel/blob";
import { mediaPath, type StorageProvider } from "./provider";

export const vercelBlob: StorageProvider = {
  name: "vercel-blob",

  async createUpload({ eventId, mediaId, part, contentType }) {
    return {
      provider: "vercel-blob",
      pathname: mediaPath(eventId, mediaId, part, contentType),
      handleUploadUrl: "/api/blob/token",
      clientPayload: JSON.stringify({ mediaId, part }),
      contentType,
      // Single-part keeps each file at exactly one advanced op (Hobby: 2,000/month).
      multipart: false,
    };
  },

  ownsUrl(url, eventId, mediaId) {
    try {
      const u = new URL(url);
      return (
        u.protocol === "https:" &&
        u.hostname.endsWith(".public.blob.vercel-storage.com") &&
        u.pathname.startsWith(`/events/${eventId}/${mediaId}/`)
      );
    } catch {
      return false;
    }
  },

  async delete(urls) {
    if (urls.length) await del(urls); // deletes are not counted as advanced operations
  },
};
