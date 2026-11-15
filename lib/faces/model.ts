/**
 * ONNX models for the face pipeline (FACES.md §2), loaded once per server instance.
 *
 * - Detector: OpenCV Zoo YuNet `face_detection_yunet_2023mar.onnx` (MIT, ~230 KB)
 * - Embedder: OpenCV Zoo SFace `face_recognition_sface_2021dec.onnx` (Apache-2.0, 128-d)
 * Files live in lib/faces/models/ (fetch with `npm run faces:models`).
 *
 * Runtime: `onnxruntime-node` (native, fastest) if installed, else `onnxruntime-web` (WASM, no
 * native binaries, far smaller on Vercel). Both are imported at runtime with webpackIgnore, so the
 * app builds and runs without either; until one is installed, face jobs wait (ModelUnavailable).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const MODEL_ID = "yunet2023mar+sface2021dec";
export const MODEL_FILES = {
  detector: "face_detection_yunet_2023mar.onnx",
  embedder: "face_recognition_sface_2021dec.onnx",
} as const;
export const MODELS_DIR = path.join(process.cwd(), "lib", "faces", "models");

/** The models or runtime aren't installed: jobs stay queued instead of failing. */
export class ModelUnavailable extends Error { constructor(msg: string) { super(msg); this.name = "ModelUnavailable"; } }

// The slice of the onnxruntime API we use (same in -node and -web).
interface OrtTensor { data: unknown; dims: readonly number[] }
interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}
interface Ort {
  InferenceSession: { create(model: Uint8Array, opts?: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => OrtTensor;
  env: { logLevel?: string; wasm?: { numThreads?: number } };
}

async function importOrt(): Promise<{ ort: Ort; runtime: string }> {
  const tries = ["onnxruntime-node", "onnxruntime-web"];
  const errors: string[] = [];
  for (const name of tries) {
    try {
      const mod = (await import(/* webpackIgnore: true */ name)) as Ort & { default?: Ort };
      const ort = (mod.InferenceSession ? mod : mod.default) as Ort;
      if (ort?.InferenceSession) return { ort, runtime: name };
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message?.slice(0, 80)}`);
    }
  }
  throw new ModelUnavailable(`no ONNX runtime (npm i onnxruntime-web): ${errors.join("; ")}`);
}

interface Loaded { ort: Ort; runtime: string; det: OrtSession; emb: OrtSession }
let loading: Promise<Loaded> | null = null;

async function load(): Promise<Loaded> {
  const { ort, runtime } = await importOrt();
  // one thread: functions get ~1 vCPU, and WASM threads would need worker files traced too
  if (ort.env.wasm) ort.env.wasm.numThreads = 1;
  // the OpenCV Zoo exports keep their weights as graph inputs, which makes ORT print ~200
  // "Initializer … appears in graph inputs" warnings per cold start: harmless, but they bury the logs
  ort.env.logLevel = "error";
  const read = async (f: string) => {
    try { return new Uint8Array(await readFile(path.join(MODELS_DIR, f))); }
    catch { throw new ModelUnavailable(`missing model lib/faces/models/${f} (npm run faces:models)`); }
  };
  const opts = { executionProviders: [runtime === "onnxruntime-node" ? "cpu" : "wasm"], graphOptimizationLevel: "all", logSeverityLevel: 3 };
  const [det, emb] = await Promise.all([
    read(MODEL_FILES.detector).then((b) => ort.InferenceSession.create(b, opts)),
    read(MODEL_FILES.embedder).then((b) => ort.InferenceSession.create(b, opts)),
  ]);
  console.info("[faces] models loaded", { runtime, det: det.outputNames.length, emb: emb.outputNames });
  return { ort, runtime, det, emb };
}

function models(): Promise<Loaded> {
  // a failed load is retried on the next call (e.g. the models were added in a later deploy)
  loading ??= load().catch((e) => { loading = null; throw e; });
  return loading;
}

/** Runs YuNet on a 1×3×size×size BGR tensor; returns outputs in the session's order. */
export async function runDetector(input: Float32Array, size: number): Promise<{ names: readonly string[]; data: Float32Array[] }> {
  const m = await models();
  const out = await m.det.run({ [m.det.inputNames[0]]: new m.ort.Tensor("float32", input, [1, 3, size, size]) });
  return { names: m.det.outputNames, data: m.det.outputNames.map((n) => out[n].data as Float32Array) };
}

/** Runs SFace on a 1×3×112×112 RGB tensor; returns the raw 128-d feature. */
export async function runEmbedder(input: Float32Array): Promise<Float32Array> {
  const m = await models();
  const out = await m.emb.run({ [m.emb.inputNames[0]]: new m.ort.Tensor("float32", input, [1, 3, 112, 112]) });
  return Float32Array.from(out[m.emb.outputNames[0]].data as Float32Array);
}

/** For the admin page: can this instance run the models? */
export async function modelStatus(): Promise<{ ok: true; runtime: string } | { ok: false; error: string }> {
  try { return { ok: true, runtime: (await models()).runtime }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
