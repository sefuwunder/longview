// Unit tests for the deterministic finding clusterer.
import { describe, test, expect } from "bun:test";
import { clusterResults, tokenize, mulberry32 } from "../src/cluster";

const item = (id: number, title: string, snippet: string, url = `http://x/${id}`) => ({
  id,
  title,
  snippet,
  url,
});

/** Two obvious topics: tidal energy vs sourdough baking. */
const twoTopicCorpus = () => [
  item(1, "Tidal energy basics", "How tidal stream turbines generate power from ocean currents."),
  item(2, "Tidal power guide", "A guide to tidal power generation and wave energy farms."),
  item(3, "Tidal lagoon plans", "Proposed tidal lagoon barrages for renewable electricity."),
  item(4, "Best sourdough recipe", "Bake crusty sourdough bread with a live starter culture."),
  item(5, "Sourdough starter tips", "Keep your bread starter alive, bubbly and ready to bake."),
  item(6, "Sourdough baking schedule", "A timeline for mixing, folding and baking sourdough loaves."),
];

describe("tokenize", () => {
  test("lowercases, strips diacritics/punctuation, drops stopwords/numbers/short tokens", () => {
    const toks = tokenize("Café Résumé! The 123 quick-brown FOXES are running.");
    expect(toks).toEqual(["cafe", "resume", "quick", "brown", "foxe", "running"]);
  });

  test("light stemming strips trailing s (not ss)", () => {
    expect(tokenize("turbines class")).toEqual(["turbine", "class"]);
  });
});

describe("mulberry32", () => {
  test("same seed → same sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("clusterResults", () => {
  test("empty input → []", () => {
    expect(clusterResults([])).toEqual([]);
  });

  test("singleton → one cluster", () => {
    const out = clusterResults([item(7, "Lone finding", "nothing else here")]);
    expect(out).toHaveLength(1);
    expect(out[0].ids).toEqual([7]);
  });

  test("n < 4 → single cluster", () => {
    const out = clusterResults([
      item(1, "Tidal energy", "ocean power"),
      item(2, "Sourdough bread", "baking loaves"),
      item(3, "Rocket launches", "space news"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].ids.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  test("deterministic: same input twice → byte-identical output", () => {
    const a = JSON.stringify(clusterResults(twoTopicCorpus()));
    const b = JSON.stringify(clusterResults(twoTopicCorpus()));
    expect(a).toBe(b);
  });

  test("two obvious topics separate correctly", () => {
    const out = clusterResults(twoTopicCorpus());
    expect(out).toHaveLength(2);
    const sets = out.map((c) => [...c.ids].sort((x, y) => x - y));
    expect(sets).toContainEqual([1, 2, 3]);
    expect(sets).toContainEqual([4, 5, 6]);
  });

  test("labels contain the distinctive terms", () => {
    const out = clusterResults(twoTopicCorpus());
    const labels = out.map((c) => c.label.toLowerCase()).join(" | ");
    expect(labels).toContain("tidal");
    expect(labels).toContain("sourdough");
  });

  test("identical texts don't crash and still cluster", () => {
    const items = [1, 2, 3, 4, 5].map((i) =>
      item(i, "Same title here", "Same snippet text repeated.")
    );
    const out = clusterResults(items);
    const total = out.reduce((a, c) => a + c.ids.length, 0);
    expect(total).toBe(5);
    expect(out.length).toBeGreaterThan(0);
  });

  test("empty/missing texts don't crash", () => {
    const items = [
      item(1, "", ""),
      item(2, "!!!", "123"),
      item(3, "Real title", "real content words"),
      item(4, "Another", "more content"),
    ];
    const out = clusterResults(items);
    expect(out.reduce((a, c) => a + c.ids.length, 0)).toBe(4);
  });

  test("k scales with corpus size and is capped at 8", () => {
    const topics = ["tidal", "sourdough", "rockets", "chess", "bees", "trains", "llamas", "comets", "kayaks", "igloos"];
    const items = topics.flatMap((t, ti) =>
      [0, 1, 2, 3].map((j) =>
        item(ti * 10 + j, `${t} headline ${j}`, `All about ${t}: details, news and analysis ${j}.`)
      )
    );
    const out = clusterResults(items);
    expect(out.length).toBeLessThanOrEqual(8);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.reduce((a, c) => a + c.ids.length, 0)).toBe(items.length);
  });

  test("three topics separate and every id appears exactly once", () => {
    const items = [
      ...[0, 1, 2, 3].map((j) => item(10 + j, `Tidal power ${j}`, `ocean tidal turbines energy waves ${j}`)),
      ...[0, 1, 2, 3].map((j) => item(20 + j, `Sourdough ${j}`, `bread starter baking flour loaves ${j}`)),
      ...[0, 1, 2, 3].map((j) => item(30 + j, `Chess openings ${j}`, `chess gambit knights endgame strategy ${j}`)),
    ];
    const out = clusterResults(items);
    const all = out.flatMap((c) => c.ids).sort((a, b) => a - b);
    expect(all).toEqual(items.map((i) => i.id).sort((a, b) => a - b));
    // Each synthetic topic should dominate one cluster.
    for (const base of [10, 20, 30]) {
      const best = Math.max(
        ...out.map((c) => c.ids.filter((id) => id >= base && id < base + 10).length)
      );
      expect(best).toBeGreaterThanOrEqual(3);
    }
  });
});
