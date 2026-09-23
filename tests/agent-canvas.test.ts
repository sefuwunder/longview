// Tests for the agent canvas layout — the pure layered-graph function.
// The file is eval'd with a stubbed window; layout needs no DOM.
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let LV: {
  layoutAgentGraph: (g: unknown, opts?: unknown) => {
    nodes: Record<string, { x: number; y: number; w: number; h: number; kind: string }>;
    edges: { from: string; to: string; label: string; d: string }[];
    width: number;
    height: number;
  };
};

const GRAPH = {
  nodes: [
    { id: "q", kind: "question", label: "how do solar panels work" },
    { id: "q0", kind: "subq", label: "how do solar panels work" },
    { id: "q1", kind: "subq", label: "solar panel work" },
    { id: "p0", kind: "source", label: "Solar basics", url: "https://ex.com/a", detail: "ex.com" },
    { id: "p1", kind: "source", label: "PV effect", url: "https://ex.com/b", detail: "ex.com" },
    { id: "f0", kind: "finding", label: "solar · panel · photovoltaic", detail: "3 passages · 2 sources" },
  ],
  edges: [
    { from: "q", to: "q0", label: "line of inquiry" },
    { from: "q", to: "q1", label: "line of inquiry" },
    { from: "q0", to: "p0", label: "surfaced" },
    { from: "q0", to: "p1", label: "surfaced" },
    { from: "p0", to: "f0", label: "supports" },
    { from: "p1", to: "f0", label: "supports" },
  ],
};

beforeAll(() => {
  const src = readFileSync(join(import.meta.dir, "../public/agent-canvas.js"), "utf8");
  const sandbox: Record<string, unknown> = {};
  new Function("window", "document", src)(sandbox, {});
  LV = sandbox.LVAgentCanvas as typeof LV;
});

describe("layoutAgentGraph", () => {
  test("places kinds in left-to-right layers", () => {
    const L = LV.layoutAgentGraph(GRAPH);
    const x = (id: string) => L.nodes[id].x;
    expect(x("q")).toBeLessThan(x("q0"));
    expect(x("q0")).toBeLessThan(x("p0"));
    expect(x("q1")).toBeLessThan(x("p1"));
    expect(x("p0")).toBeLessThan(x("f0"));
    // same-kind nodes share a column
    expect(x("q0")).toBe(x("q1"));
    expect(x("p0")).toBe(x("p1"));
  });

  test("every node and edge is placed; edges reference real nodes", () => {
    const L = LV.layoutAgentGraph(GRAPH);
    expect(Object.keys(L.nodes).length).toBe(GRAPH.nodes.length);
    expect(L.edges.length).toBe(GRAPH.edges.length);
    for (const e of L.edges) {
      expect(L.nodes[e.from]).toBeDefined();
      expect(L.nodes[e.to]).toBeDefined();
      expect(e.d.startsWith("M")).toBe(true);
      expect(e.d).toContain("C");
    }
    expect(L.width).toBeGreaterThan(0);
    expect(L.height).toBeGreaterThan(0);
  });

  test("deterministic across calls", () => {
    expect(LV.layoutAgentGraph(GRAPH)).toEqual(LV.layoutAgentGraph(GRAPH));
  });

  test("drops edges to unknown nodes, tolerates empty graphs", () => {
    const L = LV.layoutAgentGraph({
      nodes: [{ id: "q", kind: "question", label: "x" }],
      edges: [{ from: "q", to: "ghost", label: "" }],
    });
    expect(L.edges.length).toBe(0);
    const E = LV.layoutAgentGraph({ nodes: [], edges: [] });
    expect(Object.keys(E.nodes).length).toBe(0);
    expect(E.edges.length).toBe(0);
  });

  test("nodes do not overlap within a column", () => {
    const L = LV.layoutAgentGraph(GRAPH);
    const col = (kind: string) =>
      Object.values(L.nodes)
        .filter((n) => n.kind === kind)
        .sort((a, b) => a.y - b.y);
    for (const kind of ["subq", "source", "finding"]) {
      const ns = col(kind);
      for (let i = 1; i < ns.length; i++)
        expect(ns[i].y).toBeGreaterThanOrEqual(ns[i - 1].y + ns[i - 1].h);
    }
  });
});
