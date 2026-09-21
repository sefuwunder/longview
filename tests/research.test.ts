import { describe, test, expect } from "bun:test";
import {
  keywords,
  queryVariants,
  htmlToText,
  splitSentences,
  extractiveSummary,
  buildReport,
  runResearchPipeline,
} from "../src/research";

describe("queryVariants", () => {
  test("deterministic, strips ?, dedupes, caps at 5", () => {
    const v = queryVariants("How do solid-state batteries work?");
    expect(v.length).toBeLessThanOrEqual(5);
    expect(v[0]).toBe("How do solid-state batteries work");
    expect(new Set(v).size).toBe(v.length);
    expect(queryVariants("How do solid-state batteries work?")).toEqual(v);
  });
  test("short questions still yield variants", () => {
    expect(queryVariants("bun").length).toBeGreaterThan(0);
  });
});

describe("htmlToText", () => {
  test("strips scripts/styles/tags and collapses whitespace", () => {
    const t = htmlToText(
      "<html><head><style>.x{color:red}</style><script>alert(1)</script></head><body><h1>Hi</h1><p>a  b</p></body></html>"
    );
    expect(t).toBe("Hi a b");
  });
});

describe("splitSentences", () => {
  test("splits and filters too-short sentences", () => {
    const s = splitSentences(
      "Ok. This is a reasonably long sentence about batteries and charging cycles."
    );
    expect(s.length).toBe(1);
    expect(s[0]).toContain("batteries");
  });
});

describe("extractiveSummary", () => {
  const pages = [
    {
      url: "https://x.test/a",
      title: "A",
      snippet: "",
      text:
        "Solid-state batteries replace the liquid electrolyte with a solid ceramic layer. " +
        "Fast charging cycles stress the ceramic separator inside solid-state battery packs. " +
        "The harbor looked beautiful at dawn and the gulls were circling overhead.",
    },
  ];
  test("picks keyword-overlapping sentences, keeps document order", () => {
    const s = extractiveSummary(pages, "solid-state battery charging cycles", 2);
    expect(s.length).toBe(2);
    expect(s[0]).toContain("electrolyte");
    expect(s[1]).toContain("separator");
  });
  test("empty keyword set returns nothing", () => {
    expect(extractiveSummary(pages, "the and of", 5)).toEqual([]);
  });
  test("dedupes near-identical sentences", () => {
    const dup = [
      { ...pages[0], text: pages[0].text + " " + pages[0].text },
    ];
    const s = extractiveSummary(dup, "solid-state batteries electrolyte charging", 5);
    const heads = new Set(s.map((x) => x.slice(0, 60).toLowerCase()));
    expect(heads.size).toBe(s.length);
  });
});

describe("buildReport", () => {
  test("markdown has the honest disclaimer + sections", () => {
    const r = buildReport("Q?", ["- s"], [{ title: "T", url: "https://x" }]);
    expect(r).toContain("# Q?");
    expect(r).toContain("## Key points");
    expect(r).toContain("## Sources");
    expect(r).toContain("Extractive summary");
    expect(r).toContain("No AI generation");
    expect(r).toContain("[T](https://x)");
  });
});

describe("runResearchPipeline", () => {
  const rows = [
    { title: "Page one", url: "https://x.test/1", snippet: "snip one" },
    { title: "Page two", url: "https://x.test/2", snippet: "snip two" },
  ];
  const crawl = async () => ({
    ok: true as const,
    results: rows,
    endpoint: "test",
    httpStatus: 200 as const,
    errorClass: null,
    error: null,
    ms: 1,
  });
  const fetchPage = async (url: string) =>
    url.endsWith("/1")
      ? "Rivers flow downhill and eventually reach the sea after long journeys across the continent. " +
        "River deltas form where the water slows down and drops its sediment load near the coast. " +
        "Famous deltas include the Nile, the Mississippi, and the Mekong river systems of the world."
      : "Tides are caused by the moon pulling on the oceans of the earth twice each day. " +
        "River deltas form where the water slows down and drops its sediment load near the coast. " +
        "Coastal wetlands around deltas support rich ecosystems and important fisheries worldwide.";
  // Link-free HTML so the real deepCrawl path runs deterministically in-process.
  const fetchHtml = async () =>
    "<html><head><title>T</title></head><body><p>plain paragraph, no links here</p></body></html>";

  test("full pipeline with stubs", async () => {
    const { report, sources, stats } = await runResearchPipeline("how do river deltas form?", {
      crawl,
      fetchPage,
      fetchHtml,
      maxQueries: 1,
    });
    expect(sources.length).toBe(2);
    expect(report).toContain("## Key points");
    expect(report).toContain("## Sources");
    expect(report).toContain("deltas form");
    expect(report).toContain("Deep crawl:");
    expect(stats.pagesCrawled).toBe(2);
    expect(stats.discovered).toBe(0);
    expect(stats.capped).toBe(false);
  });

  test("one failing query does not kill the run", async () => {
    let n = 0;
    const flaky = async () => {
      n++;
      if (n === 1)
        return {
          ok: false as const,
          results: [] as typeof rows,
          endpoint: "test",
          httpStatus: 202 as const,
          errorClass: "challenge" as const,
          error: "bot challenge",
          ms: 1,
        };
      return crawl();
    };
    const { sources } = await runResearchPipeline("how do river deltas form?", {
      crawl: flaky,
      fetchPage,
      fetchHtml,
      maxQueries: 2,
    });
    expect(sources.length).toBe(2);
  });

  test("all queries failing throws", async () => {
    await expect(
      runResearchPipeline("q", {
        crawl: async () => ({
          ok: false as const,
          results: [] as typeof rows,
          endpoint: "test",
          httpStatus: null,
          errorClass: "network" as const,
          error: "down",
          ms: 1,
        }),
        fetchPage,
      })
    ).rejects.toThrow("all search queries failed");
  });

  test("no fetchable pages throws", async () => {
    await expect(
      runResearchPipeline("q", {
        crawl,
        fetchHtml,
        fetchPage: async () => {
          throw new Error("404");
        },
      })
    ).rejects.toThrow("no pages could be fetched");
  });

  test("discovered pages join the source pool + stats", async () => {
    const deep = async () => ({
      pages: [
        {
          title: "Delta deep dive",
          url: "https://x.test/deep",
          snippet: "deep snip",
          depth: 1,
          viaUrl: "https://x.test/1",
          text:
            "River deltas form where the water slows down and drops its sediment load near the coast, " +
            "creating rich wetlands. Deltas like the Mississippi shift course over centuries of deposition. " +
            "Engineers study delta formation to predict how river deltas evolve under changing climates.",
        },
      ],
      pagesCrawled: 3,
      maxDepthReached: 1,
      capped: false,
      capReason: null as null,
    });
    const { report, sources, stats } = await runResearchPipeline(
      "how do river deltas form?",
      { crawl, fetchPage, deep, maxQueries: 1 }
    );
    expect(stats.discovered).toBe(1);
    expect(stats.pagesCrawled).toBe(3);
    expect(stats.maxDepthReached).toBe(1);
    expect(sources.some((s) => s.url === "https://x.test/deep")).toBe(true);
    expect(report).toContain("1 new source discovered beyond the search results");
  });

  test("a throwing deep crawl still summarizes the seeds", async () => {
    const deep = async (): Promise<never> => {
      throw new Error("deep down");
    };
    const { sources, stats } = await runResearchPipeline("how do river deltas form?", {
      crawl,
      fetchPage,
      deep,
      maxQueries: 1,
    });
    expect(sources.length).toBe(2);
    expect(stats.discovered).toBe(0);
  });
});
