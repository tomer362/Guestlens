import type { UploadTicket } from "@/lib/storage/provider";

/** Abort an upload that makes no progress for this long (iOS can stall a request forever). */
const STALL_MS = 45_000;

/** One function per provider; the queue only ever calls this. */
export async function uploadWithTicket(ticket: UploadTicket, body: Blob, onProgress?: (f: number) => void): Promise<string> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(new Error("stalled")), STALL_MS); };
  const progress = (f: number) => { arm(); onProgress?.(f); };
  arm();
  try {
    switch (ticket.provider) {
      case "vercel-blob": {
        const { upload } = await import("@vercel/blob/client");
        const r = await upload(ticket.pathname, body, {
          access: "public",
          handleUploadUrl: ticket.handleUploadUrl,
          clientPayload: ticket.clientPayload,
          contentType: ticket.contentType,
          multipart: ticket.multipart,
          abortSignal: ctrl.signal,
          onUploadProgress: (e) => progress(e.percentage / 100),
        });
        return r.url;
      }
      case "presigned-put": {
        const r = await fetch(ticket.url, { method: "PUT", headers: ticket.headers, body, signal: ctrl.signal });
        if (!r.ok) throw new Error(`put_${r.status}`);
        return ticket.publicUrl;
      }
    }
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error("stalled");
    throw e;
  } finally {
    clearTimeout(timer!);
  }
}
