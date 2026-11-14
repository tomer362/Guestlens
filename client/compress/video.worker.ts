/// <reference lib="webworker" />
import { prepareVideo, VideoError } from "./video-core";

export type WorkerIn = { file: Blob; forceOriginal?: boolean };
export type WorkerOut =
  | { type: "progress"; p: number }
  | { type: "info"; s: string }
  | { type: "report"; s: string }
  | { type: "done"; result: Awaited<ReturnType<typeof prepareVideo>> }
  | { type: "error"; code?: string; message: string };

const post = (m: WorkerOut) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  try {
    const result = await prepareVideo(e.data.file, {
      forceOriginal: e.data.forceOriginal,
      progress: (p) => post({ type: "progress", p }),
      info: (s) => post({ type: "info", s }),
      report: (s) => post({ type: "report", s }),
    });
    post({ type: "done", result });
  } catch (err) {
    post({ type: "error", code: err instanceof VideoError ? err.code : undefined, message: String((err as Error)?.message ?? err) });
  }
};
