// Unit tests for the research agent: planner, evidence scoring, coverage
// reflection, finding synthesis, graph building, and the full loop with
// stubbed search/fetch. No live network.
import { describe, test, expect } from "bun:test";
import {
  aspectsOf,
  planQuestion,
  scoreEvidence,
  reflectCoverage,
  groupFindings,
  buildAgentGraph,
  runAgent,
} from "../src/agent";
import type { SearchOutcome } from "../src/search";

const Q = "how do solar panels work";

const PAGES = [
  {
    url: "https://ex.com/solar-basics",
    title: "Solar basics",
    text:
      "Solar panels convert sunlight directly into electricity through photovoltaic cells. " +
      "A typical residential solar panel contains sixty individual photovoltaic cells wired together. " +
      "Panels are mounted on rooftops to capture maximum sunlight throughout the day.",
  },
  {
    url: "https://ex.com/pv-effect",
    title: "The photovoltaic effect",
    text:
      "The working principle of a solar panel relies on the photovoltaic effect in silicon. " +
      "When sunlight strikes the panel surface, electrons are knocked loose from silicon atoms. " +
      "This electron flow creates direct current electricity for homes and businesses.",
  },
];

function stubCrawl(urls: string[]): (q: string) => Promise<SearchOutcome> {
  return async (q: string) => ({
    ok: true,
    results: urls.map((u, i) => ({
      title: `Result ${i} for ${q.slice(0, 12)}`,
      url: u,
      snippet: "snippet",
    })),
    backend: "ddg",
    endpoint: "stub",
    httpStatus: 200,
    errorClass: null,
    error: null,
    ms: 1,
  });
}

describe("planQuestion", () => {
  test("always leads with the question itself, then aspect drills", () => {
    const plan = planQuestion(Q);
    expect(plan.length).toBeGreaterThanOrEqual(1);
    expect(plan[0].id).toBe("q0");
    expect(plan[0].label).toBe("how do solar panels work");
    expect(plan[0].queries.length).toBeGreaterThan(0);
    // aspect drills exist for the content-word run "solar panel work"
    expect(plan.length).toBe(2);
    expect(plan[1].queries.length).toBeGreaterThan(0);
    const ids = plan.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("deterministic across calls", () => {
    expect(planQuestion(Q)).toEqual(planQuestion(Q));
  });

  test("short question with no aspects still plans one line", () => {
    const plan = planQuestion("fusion?");
    expect(plan.length).toBe(1);
    expect(plan[0].id).toBe("q0");
  });
});

describe("aspectsOf", () => {
  test("extracts content-word runs", () => {
    expect(aspectsOf(Q)).toEqual(["solar panel work"]);
  });
  test("drops stopwords and short questions", () => {
    expect(aspectsOf("what is it?")).toEqual([]);
  });
});

describe("scoreEvidence", () => {
  test("scores sentences by keyword overlap, keeps provenance", () => {
    const ev = scoreEvidence(PAGES, Q);
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev) {
      expect(e.sentence.length).toBeGreaterThanOrEqual(40);
      expect(e.url).toMatch(/^https:\/\/ex\.com\//);
      expect(e.kws.length).toBeGreaterThan(0);
    }
    // sorted by score descending
    for (let i = 1; i < ev.length; i++)
      expect(ev[i].score).toBeLessThanOrEqual(ev[i - 1].score + 1e-9);
  });

  test("empty on keyword-less questions", () => {
    expect(scoreEvidence(PAGES, "???")).toEqual([]);
  });
});

describe("reflectCoverage", () => {
  test("keywords with 2+ evidence hits are not weak", () => {
    const rich = [
      {
        url: "https://ex.com/a",
        title: "A",
        text:
          "Solar panels convert sunlight into electricity through photovoltaic cells every single day. " +
          "A typical residential solar panel contains sixty individual photovoltaic cells wired together in series. " +
          "Engineers who work on solar panel design keep improving the efficiency of every new panel generation.",
      },
    ];
    // solar + panel appear in 2+ sentences; work appears once → weak
    expect(reflectCoverage(Q, scoreEvidence(rich, Q))).toEqual(["work"]);
  });

  test("missing keyword is a weak spot", () => {
    const thin = [
      {
        url: "https://ex.com/a",
        title: "A",
        text: "Solar panels are quite common on rooftops these days. " +
          "Many solar panel installations happened last year across the region.",
      },
    ];
    // "work" never appears → weak
    expect(reflectCoverage(Q, scoreEvidence(thin, Q))).toEqual(["work"]);
  });
});

describe("groupFindings", () => {
  test("groups into labeled findings with source lists", () => {
    const ev = scoreEvidence(PAGES, Q);
    const fs = groupFindings(ev, 6);
    expect(fs.length).toBeGreaterThan(0);
    expect(fs.length).toBeLessThanOrEqual(6);
    for (const f of fs) {
      expect(f.id).toMatch(/^f\d+$/);
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.sentences.length).toBeGreaterThan(0);
      expect(f.sentences.length).toBeLessThanOrEqual(4);
      expect(f.sourceUrls.length).toBeGreaterThan(0);
    }
    // every evidence sentence is used at most once across findings
    const texts = fs.flatMap((f) => f.sentences.map((s) => s.text));
    expect(new Set(texts).size).toBe(texts.length);
  });

  test("deterministic", () => {
    const ev = scoreEvidence(PAGES, Q);
    expect(groupFindings(ev)).toEqual(groupFindings(ev));
  });
});

describe("buildAgentGraph", () => {
  test("wires question → subqs → sources → findings", () => {
    const plan = planQuestion(Q);
    const ev = scoreEvidence(PAGES, Q);
    const findings = groupFindings(ev);
    const sources = PAGES.map((p) => ({ title: p.title, url: p.url }));
    const foundVia = new Map(PAGES.map((p) => [p.url, "q0"] as [string, string]));
    const g = buildAgentGraph(Q, plan, sources, findings, foundVia);
    const kinds = g.nodes.map((n) => n.kind);
    expect(kinds).toContain("question");
    expect(kinds).toContain("subq");
    expect(kinds).toContain("source");
    expect(kinds).toContain("finding");
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    for (const e of g.edges) {
      expect(byId.has(e.from)).toBe(true);
      expect(byId.has(e.to)).toBe(true);
    }
    // every finding is supported by at least one source edge
    for (const f of findings) {
      const incoming = g.edges.filter((e) => e.to === f.id);
      expect(incoming.length).toBeGreaterThan(0);
    }
  });
});

describe("runAgent (stubbed)", () => {
  const urls = PAGES.map((p) => p.url);
  const fetchPage = async (url: string) =>
    PAGES.find((p) => p.url === url)?.text ?? "";

  test("full loop emits plan→search→read→reflect→synthesize→done", async () => {
    const kinds: string[] = [];
    const r = await runAgent(Q, {
      crawl: stubCrawl(urls),
      fetchPage,
      onStep: (s) => kinds.push(s.kind),
    });
    expect(kinds[0]).toBe("plan");
    expect(kinds).toContain("search");
    expect(kinds).toContain("read");
    expect(kinds).toContain("reflect");
    expect(kinds).toContain("synthesize");
    expect(kinds[kinds.length - 1]).toBe("done");
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.sources.length).toBe(urls.length);
    expect(r.graph.nodes.length).toBeGreaterThan(0);
    expect(r.report).toContain("# how do solar panels work");
    expect(r.stats.pagesRead).toBe(urls.length);
    // "work" appears in a single evidence sentence (< 2 hits) → the agent
    // correctly fires one follow-up; the stub returns no new URLs for it.
    expect(r.stats.followups).toBe(1);
    expect(kinds).toContain("followup");
    expect(r.steps.length).toBe(kinds.length);
  });

  test("weak coverage triggers follow-up searches", async () => {
    const thin: Record<string, string> = {
      "https://ex.com/thin":
        "Solar panels are quite common on rooftops these days across the whole country and beyond. " +
        "Many solar panel installations were completed last year in several different regions of the world. " +
        "Installers report that residential solar panel demand keeps growing steadily every single quarter.",
      "https://ex.com/work":
        "The working mechanism of a solar panel involves the photovoltaic effect in doped silicon layers. " +
        "Engineers who work on panel design focus on efficiency gains and long term durability of modules. " +
        "Field technicians work with panel arrays daily to keep every installation running at peak output.",
    };
    const crawl = async (q: string): Promise<SearchOutcome> => {
      const u = q.startsWith("work ") ? ["https://ex.com/work"] : ["https://ex.com/thin"];
      return {
        ok: true,
        results: u.map((url) => ({ title: url, url, snippet: "" })),
        backend: "ddg",
        endpoint: "stub",
        httpStatus: 200,
        errorClass: null,
        error: null,
        ms: 1,
      };
    };
    const kinds: string[] = [];
    const r = await runAgent(Q, {
      crawl,
      fetchPage: async (u) => thin[u] ?? "",
      onStep: (s) => kinds.push(s.kind),
    });
    expect(kinds).toContain("followup");
    expect(r.stats.followups).toBeGreaterThan(0);
    expect(r.stats.pagesRead).toBe(2);
  });

  test("total search failure throws", async () => {
    const dead = async (): Promise<SearchOutcome> => ({
      ok: false,
      results: [],
      backend: "ddg",
      endpoint: "stub",
      httpStatus: 500,
      errorClass: "http_500",
      error: "boom",
      ms: 1,
    });
    await expect(runAgent(Q, { crawl: dead, fetchPage })).rejects.toThrow(
      "all search queries failed"
    );
  });

  test("one dead query and one dead page never kill the run", async () => {
    let n = 0;
    const flaky = async (q: string): Promise<SearchOutcome> => {
      n++;
      if (n === 1)
        return {
          ok: false, results: [], backend: "ddg", endpoint: "stub",
          httpStatus: 500, errorClass: "http_500", error: "x", ms: 1,
        };
      return stubCrawl(urls)(q);
    };
    const flakyFetch = async (u: string) => {
      if (u === urls[0]) throw new Error("dead page");
      return fetchPage(u);
    };
    const r = await runAgent(Q, { crawl: flaky, fetchPage: flakyFetch });
    expect(r.stats.pagesRead).toBe(1);
    expect(r.findings.length).toBeGreaterThan(0);
  });
});
