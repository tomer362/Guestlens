/** Small vector helpers shared by the pipeline, clustering and tests. */

export function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function dot(a: Float32Array, b: Float32Array, ao = 0, bo = 0, n = a.length - ao): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[ao + i] * b[bo + i];
  return s;
}

/** pgvector text literal: "[0.1,0.2,…]" */
export const toPgVector = (v: Float32Array) => `[${Array.from(v, (x) => x.toFixed(5)).join(",")}]`;

export function fromPgVector(s: string): Float32Array {
  const body = s.trim().replace(/^\[/, "").replace(/\]$/, "");
  return Float32Array.from(body.split(",").map(Number));
}
