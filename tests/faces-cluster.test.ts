import { describe, expect, it } from "vitest";
import { chineseWhispers, decideIncremental, knnGraph, regroup, NEW_PREFIX, type ClusterConfig, type RFace, matchRescan } from "@/lib/faces/cluster";
import { fromPgVector, l2normalize, toPgVector } from "@/lib/faces/vec";

const cfg: ClusterConfig = { assignSim: 0.4, minFaces: 3, seedQuality: 0.45, neighbours: 10, anchorScore: 0.9 };

/** Deterministic gaussian-ish noise. */
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
}
/** `people` identities × `per` faces each: unit vectors around random centres (sim within ≈0.6–0.8, across ≈0). */
function synth(people: number, per: number, noise = 0.06, seed = 7) {
  const r = rng(seed);
  const centres = Array.from({ length: people }, () => l2normalize(Float32Array.from({ length: 128 }, r)));
  const faces: { vec: Float32Array; who: number }[] = [];
  for (let p = 0; p < people; p++) for (let i = 0; i < per; i++) {
    faces.push({ who: p, vec: l2normalize(Float32Array.from(centres[p], (x) => x + r() * noise * 6)) });
  }
  return faces;
}

describe("decideIncremental", () => {
  const f = { id: "x", quality: 0.8, score: 0.95 };
  it("joins the person most close neighbours belong to", () => {
    const d = decideIncremental(f, [
      { id: "a", sim: 0.7, personId: "P", quality: 0.9, score: 0.95 }, { id: "b", sim: 0.6, personId: "P", quality: 0.9, score: 0.95 },
      { id: "c", sim: 0.65, personId: "Q", quality: 0.9, score: 0.95 }, { id: "d", sim: 0.2, personId: "Q", quality: 0.9, score: 0.95 },
    ], cfg);
    expect(d).toEqual({ kind: "assign", personId: "P" });
  });
  it("ignores neighbours below the similarity threshold", () => {
    expect(decideIncremental(f, [{ id: "a", sim: 0.3, personId: "P", quality: 0.9, score: 0.95 }], cfg)).toEqual({ kind: "none" });
  });
  it("starts a person once enough good unassigned faces agree", () => {
    const d = decideIncremental(f, [
      { id: "a", sim: 0.7, personId: null, quality: 0.9, score: 0.95 }, { id: "b", sim: 0.6, personId: null, quality: 0.5, score: 0.95 },
      { id: "c", sim: 0.6, personId: null, quality: 0.1, score: 0.95 },
    ], cfg);
    expect(d).toEqual({ kind: "create", faceIds: ["x", "a", "b", "c"] });
  });
  it("blurry faces never start a person", () => {
    const n = [{ id: "a", sim: 0.7, personId: null, quality: 0.1, score: 0.95 }, { id: "b", sim: 0.7, personId: null, quality: 0.1, score: 0.95 }];
    expect(decideIncremental(f, n, cfg)).toEqual({ kind: "none" });
    expect(decideIncremental({ id: "x", quality: 0.1, score: 0.95 }, [...n, { id: "c", sim: 0.7, personId: null, quality: 0.9, score: 0.95 }], cfg)).toEqual({ kind: "none" });
  });
});

describe("people seen once (minFaces 1)", () => {
  const one: ClusterConfig = { ...cfg, minFaces: 1 };
  it("a clear, confident face starts a person on its own", () => {
    expect(decideIncremental({ id: "x", quality: 0.7, score: 0.95 }, [], one)).toEqual({ kind: "create", faceIds: ["x"] });
  });
  it("a borderline detection does not (a ceiling light, a grille)", () => {
    expect(decideIncremental({ id: "x", quality: 0.7, score: 0.82 }, [], one)).toEqual({ kind: "none" });
    expect(decideIncremental({ id: "x", quality: 0.3, score: 0.97 }, [], one)).toEqual({ kind: "none" }); // blurry
  });
  it("a borderline face can still start a person with a confident lookalike", () => {
    const d = decideIncremental({ id: "x", quality: 0.5, score: 0.82 }, [{ id: "a", sim: 0.6, personId: null, quality: 0.8, score: 0.95 }], one);
    expect(d).toEqual({ kind: "create", faceIds: ["x", "a"] });
  });
  it("two borderline lookalikes don't", () => {
    const d = decideIncremental({ id: "x", quality: 0.7, score: 0.84 }, [{ id: "a", sim: 0.6, personId: null, quality: 0.7, score: 0.83 }], one);
    expect(d).toEqual({ kind: "none" });
  });
});

describe("knnGraph + chineseWhispers", () => {
  it("separates synthetic identities", () => {
    const faces = synth(6, 12);
    const adj = knnGraph(faces.map((f) => f.vec), 10, 0.4);
    const labels = chineseWhispers(adj, faces.map((_, i) => `f:${i}`), faces.map(() => false), faces.map(() => undefined));
    // purity: every label holds one identity, every identity one label
    const byLabel = new Map<string, Set<number>>();
    labels.forEach((l, i) => { (byLabel.get(l) ?? byLabel.set(l, new Set()).get(l)!).add(faces[i].who); });
    for (const s of byLabel.values()) expect(s.size).toBe(1);
    expect(byLabel.size).toBe(6);
  });
  it("never links two faces from the same photo", () => {
    const faces = synth(1, 4, 0.02);
    const adj = knnGraph(faces.map((f) => f.vec), 10, 0.4, ["m1", "m1", "m2", "m3"]);
    expect(adj[0].some((e) => e.j === 1)).toBe(false);
    expect(adj[0].some((e) => e.j === 2)).toBe(true);
  });
  it("never moves fixed nodes and respects rejections", () => {
    const faces = synth(1, 6);
    const adj = knnGraph(faces.map((f) => f.vec), 10, 0.4);
    const initial = ["P", "P", "P", "f:3", "f:4", "f:5"];
    const fixed = [true, false, false, false, false, true];
    initial[5] = "Q";
    const rejected = [undefined, undefined, undefined, new Set(["P"]), undefined, undefined];
    const l = chineseWhispers(adj, initial, fixed, rejected);
    expect(l[0]).toBe("P");
    expect(l[5]).toBe("Q");
    expect(l[3]).not.toBe("P");
  });
});

describe("regroup", () => {
  const make = (people: number, per: number) => synth(people, per).map((f, i): RFace & { who: number } => ({
    id: `face${i}`, vec: f.vec, quality: 0.8, score: 0.95, personId: null, locked: false, who: f.who,
  }));

  it("creates one new person per identity", () => {
    const faces = make(4, 8);
    const out = regroup(faces, new Map(), cfg);
    const targets = new Set(out.values());
    expect([...targets].every((t) => t?.startsWith(NEW_PREFIX))).toBe(true);
    expect(targets.size).toBe(4);
  });

  it("keeps existing person ids (stable across regroups)", () => {
    const faces = make(3, 8);
    faces.forEach((f) => { if (f.who === 0) f.personId = "alice"; });
    faces[1].personId = null; // a new face of alice
    const out = regroup(faces, new Map(), cfg);
    for (const f of faces.filter((f) => f.who === 0)) expect(out.get(f.id)).toBe("alice");
  });

  it("merges split clusters of the same identity into the bigger one", () => {
    const faces = make(1, 10);
    faces.forEach((f, i) => { f.personId = i < 7 ? "A" : "B"; });
    const out = regroup(faces, new Map(), cfg);
    expect(new Set(out.values())).toEqual(new Set(["A"]));
  });

  it("locked faces stay; a rejected face leaves its person", () => {
    const faces = make(1, 6);
    faces.forEach((f) => { f.personId = "A"; });
    faces[0].locked = true;
    const out = regroup(faces, new Map([["face3", new Set(["A"])]]), cfg);
    expect(out.get("face0")).toBe("A");
    expect(out.get("face3")).not.toBe("A");
  });

  it("a single face becomes a person only if it is an anchor (minFaces 1)", () => {
    const one: ClusterConfig = { ...cfg, minFaces: 1 };
    const [a, b] = make(2, 1);
    b.score = 0.82;
    const out = regroup([a, b], new Map(), one);
    expect(out.get(a.id)?.startsWith(NEW_PREFIX)).toBe(true);
    expect(out.get(b.id)).toBeNull();
  });

  it("drops an existing person left with one unconvincing face, unless a human confirmed it", () => {
    const one: ClusterConfig = { ...cfg, minFaces: 1 };
    const [a, b, c] = make(3, 1);
    a.personId = "ceiling"; a.score = 0.78; a.quality = 0.7;
    b.personId = "named"; b.score = 0.78; b.quality = 0.7; b.locked = true;
    c.personId = "clear"; // score 0.95, quality 0.8
    const out = regroup([a, b, c], new Map(), one);
    expect(out.get(a.id)).toBeNull();
    expect(out.get(b.id)).toBe("named");
    expect(out.get(c.id)).toBe("clear");
  });

  it("too few faces don't become a person", () => {
    const faces = make(1, 2);
    const out = regroup(faces, new Map(), cfg);
    expect([...out.values()]).toEqual([null, null]);
  });
});

describe("pgvector text", () => {
  it("round-trips", () => {
    const v = l2normalize(Float32Array.from({ length: 128 }, (_, i) => Math.sin(i)));
    const back = fromPgVector(toPgVector(v));
    for (let i = 0; i < 128; i++) expect(back[i]).toBeCloseTo(v[i], 4);
  });
});

describe("matchRescan", () => {
  it("pairs faces found again in the same place, one to one", () => {
    const old: [number, number, number, number][] = [[100, 100, 50, 50], [400, 100, 50, 50]];
    const found: [number, number, number, number][] = [[402, 98, 52, 51], [800, 800, 40, 40], [103, 101, 48, 50]];
    expect([...matchRescan(old, found)].sort()).toEqual([[0, 1], [2, 0]]);
  });
  it("never reuses an old face twice", () => {
    const m = matchRescan([[0, 0, 100, 100]], [[2, 2, 100, 100], [0, 0, 98, 98]]);
    expect(m.size).toBe(1);
    expect(m.get(1)).toBe(0); // the closer one wins
  });
});
