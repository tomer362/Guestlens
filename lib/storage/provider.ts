/**
 * Storage is behind this interface so the app can move from Vercel Blob to
 * another store (R2, S3, a private Blob store) by adding one file + an env flag.
 */
export type UploadPart = "file" | "thumb";

/** What the browser needs to upload one object directly (bytes never pass through our functions). */
export type UploadTicket =
  | { provider: "vercel-blob"; pathname: string; handleUploadUrl: string; clientPayload: string; contentType: string; multipart: boolean }
  | { provider: "presigned-put"; url: string; headers: Record<string, string>; publicUrl: string };

export interface StorageProvider {
  readonly name: string;
  createUpload(input: {
    eventId: string; mediaId: string; part: UploadPart; contentType: string; maxBytes: number;
  }): Promise<UploadTicket>;
  /** true if the URL the client reports really points at this media's folder in our store */
  ownsUrl(url: string, eventId: string, mediaId: string): boolean;
  delete(urls: string[]): Promise<void>;
}

export function extFor(contentType: string): string {
  switch (contentType) {
    case "image/webp": return "webp";
    case "image/jpeg": return "jpg";
    case "video/mp4": return "mp4";
    default: return "bin";
  }
}

export function mediaPath(eventId: string, mediaId: string, part: UploadPart, contentType: string) {
  return `events/${eventId}/${mediaId}/${part}.${extFor(contentType)}`;
}
