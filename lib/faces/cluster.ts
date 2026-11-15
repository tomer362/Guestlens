/**
 * Face clustering (pure, unit-tested; lib/faces/store.ts does the database side).
 *
 * Two layers, as in FACES.md §3:
 * 1. `decideIncremental`: runs per new face against its nearest neighbours (from pgvector).
 *    Join the person most of the close neighbours belong to; otherwise, if this face and enough
 *    close unassigned faces are good enough, start a new person (a DBSCAN "core point", the
 *    approach Immich uses); otherwise wait.
 * 2. `regroup`: occasional full pass. kNN graph + Chinese Whispers (dlib's face clustering),
 *    seeded with current person IDs so people keep their identity, names and manual fixes.
 *    Locked faces (confirmed by a human) never move; rejected (face, person) pairs never join.
 */

export interface ClusterConfig { assignSim: number; minFaces: number; seedQuality: number; neighbours: number }

export interface Neighbour { id: string; sim: number; personId: string | null; quality: number }

export type Decision =
  | { kind: "assign"; personId: string }
  | { kind: "create"; faceIds: string[] }
  | { kind: "none" };

export function decideIncremental(face: { id: string; quality: number }, neighbours: Neighbour[], cfg: ClusterConfig): Decision {
  const near = neighbours.filter((n) => n.id !== face.id && n.sim >= cfg.assignSim);
  const votes = new Map<string, number>();
  for (const n of near) if (n.personId) votes.set(n.personId, (votes.get(n.personId) ?? 0) + n.sim);
  if (votes.size) {
    let best = "", bestW = -1;
    for (const [p, w] of votes) if (w > bestW || (w === bestW && p < best)) { best = p; bestW = w; }
    return { kind: "assign", personId: best };
  }
  const unassigned = near.filter((n) => !n.personId);
  const seeds = unassigned.filter((n) => n.quality >= cfg.seedQuality);
  if (face.quality >= cfg.seedQuality && seeds.length + 1 >= cfg.minFaces) {
    return { kind: "create", faceIds: [face.id, ...unassigned.map((n) => n.id)] };
  }
  return { kind: "none" };
}

export interface RFace { id: string; vec: Float32Array; quality: number; personId: string | null; locked: boolean; mediaId?: string }
export type Adjacency = { j: number; w: number }[][];

/**
 * Symmetric kNN graph, brute force over contiguous vectors: ~10k faces × 128-d is a few seconds
 * of CPU, run only on regroup. Faces with the same `group` (the same photo) are never linked:
 * two faces in one picture are two different people.
 */
export function knnGraph(vecs: Float32Array[], k: number, minSim: number, group?: (string | undefined)[]): Adjacency {
  const n = vecs.length;
  if (!n) return [];
  const d = vecs[0].length;
  const flat = new Float32Array(n * d);
  vecs.forEach((v, i) => flat.set(v, i * d));
  const topJ: Int32Array[] = Array.from({ length: n }, () => new Int32Array(k).fill(-1));
  const topW: Float32Array[] = Array.from({ length: n }, () => new Float32Array(k).fill(-Infinity));
  const push = (i: number, j: number, w: number) => {
    const J = topJ[i], W = topW[i];
    if (w <= W[k - 1]) return;
    let p = k - 1;
    while (p > 0 && W[p - 1] < w) { W[p] = W[p - 1]; J[p] = J[p - 1]; p--; }
    W[p] = w; J[p] = j;
  };
  for (let i = 0; i < n; i++) {
    const io = i * d;
    const gi = group?.[i];
    for (let j = i + 1; j < n; j++) {
      if (gi !== undefined && group![j] === gi) continue;
      // inlined dot product: this loop is ~50M pairs at 10k faces
      const jo = j * d;
      let w0 = 0, w1 = 0, w2 = 0, w3 = 0, t = 0;
      for (; t + 8 <= d; t += 8) {
        w0 += flat[io + t] * flat[jo + t] + flat[io + t + 4] * flat[jo + t + 4];
        w1 += flat[io + t + 1] * flat[jo + t + 1] + flat[io + t + 5] * flat[jo + t + 5];
        w2 += flat[io + t + 2] * flat[jo + t + 2] + flat[io + t + 6] * flat[jo + t + 6];
        w3 += flat[io + t + 3] * flat[jo + t + 3] + flat[io + t + 7] * flat[jo + t + 7];
      }
      for (; t < d; t++) w0 += flat[io + t] * flat[jo + t];
      const w = w0 + w1 + w2 + w3;
      if (w < minSim) continue;
      push(i, j, w); push(j, i, w);
    }
  }
  const adj: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      const j = topJ[i][p];
      if (j < 0) break;
      const w = topW[i][p];
      adj[i].set(j, w); adj[j].set(i, w);
    }
  }
  return adj.map((m) => [...m].map(([j, w]) => ({ j, w })));
}

/** Deterministic PRNG so a regroup of the same data gives the same answer. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Chinese Whispers label propagation. `initial[i]` is the starting label; `fixed[i]` nodes never
 * change; `rejected[i]` labels are never adopted by node i.
 */
export function chineseWhispers(adj: Adjacency, initial: string[], fixed: boolean[], rejected: (Set<string> | undefined)[], maxIter = 30, seed = 1): string[] {
  const n = adj.length;
  const label = [...initial];
  const order = Array.from({ length: n }, (_, i) => i);
  const rnd = mulberry32(seed);
  for (let it = 0; it < maxIter; it++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let changed = 0;
    for (const i of order) {
      if (fixed[i] || !adj[i].length) continue;
      const score = new Map<string, number>();
      for (const { j, w } of adj[i]) {
        const l = label[j];
        if (rejected[i]?.has(l)) continue;
        score.set(l, (score.get(l) ?? 0) + w);
      }
      if (!score.size) continue;
      let best = label[i], bestW = score.get(label[i]) ?? -1;
      for (const [l, w] of score) if (w > bestW || (w === bestW && l < best)) { best = l; bestW = w; }
      if (rejected[i]?.has(best)) continue;
      if (best !== label[i]) { label[i] = best; changed++; }
    }
    if (!changed) break;
  }
  return label;
}

export const NEW_PREFIX = "new:";

/**
 * Full regroup. Returns each face's target: an existing person id, `new:<k>` for a person to
 * create, or null (not enough evidence yet).
 */
export function regroup(faces: RFace[], rejections: Map<string, Set<string>>, cfg: ClusterConfig, seed = 1): Map<string, string | null> {
  const adj = knnGraph(faces.map((f) => f.vec), cfg.neighbours, cfg.assignSim, faces.map((f) => f.mediaId));
  const rej = faces.map((f) => rejections.get(f.id));
  // a face never starts in a person it was rejected from (it would otherwise just stay there)
  const initial = faces.map((f, i) => (f.personId && !rej[i]?.has(f.personId) ? f.personId : `f:${i}`));
  const fixed = faces.map((f, i) => f.locked && initial[i] === f.personId);
  const labels = chineseWhispers(adj, initial, fixed, rej, 30, seed);

  const groups = new Map<string, number[]>();
  labels.forEach((l, i) => { const g = groups.get(l); if (g) g.push(i); else groups.set(l, [i]); });

  const out = new Map<string, string | null>();
  let k = 0;
  for (const [l, members] of groups) {
    if (!l.startsWith("f:")) { for (const i of members) out.set(faces[i].id, l); continue; } // an existing person keeps its id
    const seeds = members.filter((i) => faces[i].quality >= cfg.seedQuality).length;
    // like the incremental rule: enough faces, and mostly good ones (blurry crowds don't become people)
    const target = members.length >= cfg.minFaces && seeds >= Math.max(1, cfg.minFaces - 1) ? `${NEW_PREFIX}${k++}` : null;
    for (const i of members) out.set(faces[i].id, target);
  }
  return out;
}

type Box = [number, number, number, number];
const boxIou = (a: Box, b: Box) => {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a[2] * a[3] + b[2] * b[3] - inter;
  return u > 0 ? inter / u : 0;
};

/**
 * Re-scanning a photo: pair each newly found face with the old face in the same place (greedy,
 * best overlap first, one-to-one), so the old row can be updated in place and keep its person,
 * lock, rejections and cover. Returns new index → old index.
 */
export function matchRescan(oldBoxes: Box[], newBoxes: Box[], minIou = 0.4): Map<number, number> {
  const pairs: { i: number; j: number; v: number }[] = [];
  newBoxes.forEach((nb, i) => oldBoxes.forEach((ob, j) => { const v = boxIou(nb, ob); if (v >= minIou) pairs.push({ i, j, v }); }));
  pairs.sort((a, b) => b.v - a.v);
  const out = new Map<number, number>(), used = new Set<number>();
  for (const { i, j } of pairs) if (!out.has(i) && !used.has(j)) { out.set(i, j); used.add(j); }
  return out;
}
