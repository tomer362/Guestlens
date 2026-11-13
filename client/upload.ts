import type { UploadTicket } from "@/lib/storage/provider";

/** One function per provider; the queue only ever calls this. */
export async function uploadWithTicket(ticket: UploadTicket, body: Blob, onProgress?: (f: number) => void): Promise<string> {
  switch (ticket.provider) {
    case "vercel-blob": {
      const { upload } = await import("@vercel/blob/client");
      const r = await upload(ticket.pathname, body, {
        access: "public",
        handleUploadUrl: ticket.handleUploadUrl,
        clientPayload: ticket.clientPayload,
        contentType: ticket.contentType,
        multipart: ticket.multipart,
        onUploadProgress: (e) => onProgress?.(e.percentage / 100),
      });
      return r.url;
    }
    case "presigned-put": {
      const r = await fetch(ticket.url, { method: "PUT", headers: ticket.headers, body });
      if (!r.ok) throw new Error(`put_${r.status}`);
      return ticket.publicUrl;
    }
  }
}
