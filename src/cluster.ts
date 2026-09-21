// Deterministic TF-IDF + k-means clustering of topic findings. Zero deps.
// Same input → same output, byte-identical, on every call: fixed PRNG seed,
// deterministic k-means++ init, fixed iteration cap, and total-order tie-breaks.

export interface ClusterItem {
  id: number;
  title: string;
  snippet: string;
  url: string;
}

export interface Cluster {
  label: string;
  ids: number[];
}

// Modest built-in English stopword list.
const STOPWORDS = new Set(
  (
    "a about above after again against all am an and any are as at be because been " +
    "before being below between both but by can did do does doing down during each few " +
    "for from further had has have having he her here hers herself him himself his how " +
    "i if in into is it its itself me more most my myself no nor not of off on once " +
    "only or other ought our ours ourselves out over own same she should so some such " +
    "than that the their theirs them themselves then there these they this those through " +
    "to too under until up very was we were what when where which while who whom why " +
    "with would you your yours yourself yourselves also per via may one two new " +
    "will just like get got using used use many much every within without across " +
    "among per cent etc vs"
  ).split(" ")
);

/** mulberry32 — tiny deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stem(tok: string): string {
  // Light stemming: strip a trailing "s" for words > 4 chars not ending in "ss".
  if (tok.length > 4 && tok.endsWith("s") && !tok.endsWith("ss")) return tok.slice(0, -1);
  return tok;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !STOPWORDS.has(t))
    .map(stem);
}

type Sparse = Map<number, number>; // termIdx -> weight

function cosineDistDocCentroid(
  doc: Sparse,
  docNorm: number,
  centroid: Float64Array,
  centNorm: number
): number {
  if (docNorm === 0 || centNorm === 0) return 1; // zero vector: maximally distant
  let dot = 0;
  for (const [idx, w] of doc) dot += w * centroid[idx];
  return 1 - dot / (docNorm * centNorm);
}

/**
 * Group items into labeled clusters. Pure and deterministic:
 * clusterResults(x) deep-equals clusterResults(x) on every call.
 */
export function clusterResults(items: ClusterItem[]): Cluster[] {
  const n = items.length;
  if (n === 0) return [];

  const docs = items.map((it) => tokenize(`${it.title || ""} ${it.snippet || ""}`));

  // Vocabulary + document frequencies.
  const vocab = new Map<string, number>();
  const df = new Map<string, number>();
  for (const toks of docs) {
    const seen = new Set<string>();
    for (const t of toks) {
      if (!vocab.has(t)) vocab.set(t, vocab.size);
      if (!seen.has(t)) {
        seen.add(t);
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }
  const V = vocab.size;
  if (V === 0) return [{ label: "Misc", ids: items.map((it) => it.id) }];

  // Smoothed IDF, then TF-IDF vectors.
  const idf = new Float64Array(V);
  for (const [term, idx] of vocab)
    idf[idx] = Math.log((n + 1) / ((df.get(term) ?? 0) + 1)) + 1;
  const vecs: Sparse[] = docs.map((toks) => {
    const tf = new Map<number, number>();
    for (const t of toks) {
      const idx = vocab.get(t)!;
      tf.set(idx, (tf.get(idx) ?? 0) + 1);
    }
    const m: Sparse = new Map();
    const len = toks.length || 1;
    for (const [idx, c] of tf) m.set(idx, (c / len) * idf[idx]);
    return m;
  });
  const norms = vecs.map(
    (v) => Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0))
  );

  const k = n < 4 ? 1 : Math.min(8, Math.max(2, Math.round(Math.sqrt(n / 2))));
  const rng = mulberry32(0xc10c7e55); // fixed seed → deterministic init

  const toDense = (v: Sparse): Float64Array => {
    const d = new Float64Array(V);
    for (const [idx, w] of v) d[idx] = w;
    return d;
  };

  // Deterministic k-means++ init.
  const centroids: Float64Array[] = [toDense(vecs[Math.floor(rng() * n)])];
  const minD2 = new Float64Array(n).fill(Infinity);
  const refreshMinD2 = () => {
    const c = centroids[centroids.length - 1];
    const cn = Math.sqrt(c.reduce((a, x) => a + x * x, 0));
    for (let i = 0; i < n; i++) {
      const d = cosineDistDocCentroid(vecs[i], norms[i], c, cn);
      if (d * d < minD2[i]) minD2[i] = d * d;
    }
  };
  refreshMinD2();
  while (centroids.length < k) {
    let total = 0;
    for (let i = 0; i < n; i++) total += minD2[i];
    let r = rng() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= minD2[i];
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push(toDense(vecs[pick]));
    refreshMinD2();
  }

  // Lloyd iterations, fixed cap; stop when assignments stabilize.
  const assign = new Array<number>(n).fill(-1);
  for (let iter = 0; iter < 50; iter++) {
    let changed = false;
    const centNorms = centroids.map((c) =>
      Math.sqrt(c.reduce((a, x) => a + x * x, 0))
    );
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = cosineDistDocCentroid(vecs[i], norms[i], centroids[c], centNorms[c]);
        if (d < bestD - 1e-12) {
          bestD = d;
          best = c; // strict < keeps the lowest index on ties → deterministic
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
    // Recompute centroids as cluster means.
    const sums = Array.from({ length: k }, () => new Float64Array(V));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      for (const [idx, w] of vecs[i]) sums[c][idx] += w;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue; // empty cluster keeps its old centroid
      for (let j = 0; j < V; j++) centroids[c][j] = sums[c][j] / counts[c];
    }
  }

  // Gather members, preserving input order.
  const members: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) members[assign[i]].push(i);

  // Global mean term weight — labels highlight what makes a cluster distinctive.
  const global = new Float64Array(V);
  for (const v of vecs) for (const [idx, w] of v) global[idx] += w;
  for (let j = 0; j < V; j++) global[j] /= n;

  const terms = [...vocab.keys()];
  function labelFor(mem: number[], fallbackNo: number): string {
    const c = new Float64Array(V);
    for (const di of mem) for (const [idx, w] of vecs[di]) c[idx] += w;
    const scored: Array<[string, number]> = [];
    for (let j = 0; j < V; j++) {
      const w = c[j] / mem.length;
      // Single-cluster runs: rank by raw weight (diff vs. global is ~0).
      const score = k === 1 ? w : w - global[j];
      if (score > 1e-9) scored.push([terms[j], score]);
    }
    scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const top = scored.slice(0, 3).map(([t]) => t);
    return top.length > 0 ? top.join(" · ") : `Cluster ${fallbackNo}`;
  }

  const out: Array<{ label: string; ids: number[]; ci: number }> = [];
  members.forEach((mem, ci) => {
    if (mem.length === 0) return;
    out.push({ label: "", ids: mem.map((di) => items[di].id), ci });
  });
  // Largest cluster first; label alphabetical as the deterministic tie-break.
  out.forEach((c) => {
    c.label = labelFor(members[c.ci], c.ci + 1);
  });
  out.sort((a, b) => b.ids.length - a.ids.length || (a.label < b.label ? -1 : 1));
  // Renumber generic fallbacks after sorting so "Cluster N" is stable.
  return out.map((c, i) => ({
    label: /^Cluster \d+$/.test(c.label) ? `Cluster ${i + 1}` : c.label,
    ids: c.ids,
  }));
}
