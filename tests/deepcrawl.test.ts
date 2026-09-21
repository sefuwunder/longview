// Deep-crawl tests against a hand-built stub site graph (no network):
// relevance pruning, depth limit, cycles, dedupe, top-K, safety caps.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  deepCrawl,
  normalizeUrl,
  extractLinks,
  linkScore,
} from "../src/deepcrawl";
import { keywords } from "../src/research";

const PORT = 32181;
const BASE = `http://127.0.0.1:${PORT}`;

const html = (title: string, links: string, extra = "") =>
  `<html><head><title>${title}</title></head><body>${links}<p>${extra}</p></body></html>`;
const a = (href: string, text: string) => `<a href="${href}">${text}</a>`;

// 7 relevant links (topK=5 cuts a6/a7), 1 irrelevant, 1 self-link.
const hubLinks =
  a("/a1", "tidal turbine research") +
  a("/a2", "tidal energy storage") +
  a("/a3", "tidal power news") +
  a("/a4", "tidal stream data") +
  a("/a5", "tidal lagoon plans") +
  a("/a6", "tidal barrage costs") +
  a("/a7", "tidal range technology") +
  a("/offtopic", "best pizza recipes") +
  a("/hub", "back to start");

let chainLinks = "";
const chain: Record<string, string> = {};
for (let i = 1; i <= 12; i++) {
  chain[`/c${i}`] = html(
    `Chain ${i}`,
    i < 12 ? a(`/c${i + 1}`, `tidal chain link number ${i + 1}`) : "",
    "chain filler text about tidal energy flows"
  );
}

const stub: Record<string, string> = {
  "/hub": html("Hub", hubLinks, "hub filler"),
  "/a1": html("A1", "", "tidal turbine research details here"),
  "/a2": html("A2", "", "tidal energy storage details here"),
  "/a3": html("A3", "", "tidal power news details here"),
  "/a4": html("A4", "", "tidal stream data details here"),
  "/a5": html("A5", "", "tidal lagoon plans details here"),
  "/a6": html("A6", "", "tidal barrage costs details here"),
  "/a7": html("A7", "", "tidal range technology details here"),
  "/offtopic": html("Pizza", "", "pizza recipes with cheese and dough"),
  "/loop1": html("Loop1", a("/loop2", "tidal loop page two"), "loop one filler"),
  "/loop2": html("Loop2", a("/loop1", "tidal loop page one"), "loop two filler"),
  "/dup": html(
    "Dup",
    a("/target", "tidal target") +
      a("/target/", "tidal target") +
      a("/target?utm_source=x&x=1", "tidal target") +
      a("/target?x=1", "tidal target"),
    "dupe filler"
  ),
  "/target": html("Target", "", "the tidal target page content"),
  ...chain,
};

let fetched: string[] = [];
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    fetch(req) {
      const u = new URL(req.url);
      fetched.push(u.pathname + u.search);
      const p = u.pathname;
      const body = stub[p];
      if (!body) return new Response("nf", { status: 404 });
      return new Response(body, { headers: { "Content-Type": "text/html" } });
    },
  });
});
afterAll(() => server?.stop(true));
beforeEach(() => {
  fetched = [];
});

const seed = (path: string, title = "Seed") => ({
  title,
  url: BASE + path,
  snippet: "seed snippet",
});
const KW = new Set(keywords("tidal energy"));

describe("normalizeUrl", () => {
  test("lowercases host, strips fragment/trailing slash/tracking params", () => {
    expect(normalizeUrl("HTTP://Example.COM/Path/?utm_source=x&b=2#frag")).toBe(
      "http://example.com/Path?b=2"
    );
    expect(normalizeUrl("https://a.test/x/")).toBe("https://a.test/x");
    expect(normalizeUrl("https://a.test/")).toBe("https://a.test/");
    expect(normalizeUrl("https://a.test/x?gclid=1&fbclid=2")).toBe("https://a.test/x");
  });
  test("rejects non-http and invalid urls", () => {
    expect(normalizeUrl("mailto:a@b.test")).toBeNull();
    expect(normalizeUrl("javascript:void(0)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("extractLinks", () => {
  test("resolves relative hrefs, skips mailto/javascript", () => {
    const links = extractLinks(
      `<a href="/rel">R</a><a href="mailto:x@y">M</a><a href="javascript:void(0)">J</a><a href="https://e.test/abs">A</a>`,
      "https://b.test/dir/page"
    );
    expect(links.map((l) => l.url)).toEqual([
      "https://b.test/rel",
      "https://e.test/abs",
    ]);
    expect(links[0].anchor).toBe("R");
  });
});

describe("linkScore", () => {
  test("relevant anchor outranks irrelevant; empty keywords score 0", () => {
    const rel = linkScore("tidal turbine research", "https://x.test/tidal-guide", KW);
    const irr = linkScore("best pizza recipes", "https://x.test/pizza", KW);
    expect(rel).toBeGreaterThan(irr);
    expect(irr).toBe(0);
    expect(linkScore("tidal", "https://x.test/", new Set())).toBe(0);
  });
  test("url path tokens count", () => {
    expect(linkScore("", "https://x.test/tidal-energy-news", KW)).toBeGreaterThan(0);
  });
});

describe("deepCrawl", () => {
  test("follows relevant links, prunes irrelevant + self links, topK=5", async () => {
    const r = await deepCrawl([seed("/hub")], "tidal energy", {
      maxDepth: 1,
      noDelay: true,
    });
    expect(fetched).toContain("/hub");
    for (const p of ["/a1", "/a2", "/a3", "/a4", "/a5"]) expect(fetched).toContain(p);
    expect(fetched).not.toContain("/a6"); // cut by topK
    expect(fetched).not.toContain("/a7"); // cut by topK
    expect(fetched).not.toContain("/offtopic"); // no keyword overlap
    expect(r.pagesCrawled).toBe(6);
    expect(r.maxDepthReached).toBe(1);
    expect(r.capped).toBe(false);
    const a1 = r.pages.find((p) => p.url === BASE + "/a1")!;
    expect(a1.depth).toBe(1);
    expect(a1.viaUrl).toBe(BASE + "/hub");
    const hub = r.pages.find((p) => p.url === BASE + "/hub")!;
    expect(hub.depth).toBe(0);
    expect(hub.viaUrl).toBeNull();
  });

  test("stops at maxDepth on a 12-deep chain", async () => {
    const r = await deepCrawl([seed("/c1")], "tidal energy", {
      maxDepth: 10,
      noDelay: true,
    });
    expect(r.maxDepthReached).toBe(10);
    expect(fetched).toContain("/c11");
    expect(fetched).not.toContain("/c12");
    expect(r.pagesCrawled).toBe(11);
  });

  test("cycles terminate, each page fetched once", async () => {
    const r = await deepCrawl([seed("/loop1")], "tidal energy", {
      maxDepth: 10,
      noDelay: true,
    });
    expect(fetched.filter((p) => p === "/loop1").length).toBe(1);
    expect(fetched.filter((p) => p === "/loop2").length).toBe(1);
    expect(r.pagesCrawled).toBe(2);
  });

  test("visited-set dedupes trivially different urls", async () => {
    const r = await deepCrawl([seed("/dup")], "tidal energy", {
      maxDepth: 2,
      noDelay: true,
    });
    expect(fetched.filter((p) => p === "/target").length).toBe(1);
    expect(fetched).toContain("/target?x=1"); // x=1 is a real param, kept
    expect(r.pagesCrawled).toBe(3);
  });

  test("page cap stops the run and reports capped", async () => {
    const r = await deepCrawl([seed("/hub")], "tidal energy", {
      maxDepth: 10,
      maxPages: 3,
      noDelay: true,
    });
    expect(r.capped).toBe(true);
    expect(r.capReason).toBe("page_cap");
    expect(r.pagesCrawled).toBe(3);
  });

  test("time cap stops the run", async () => {
    const r = await deepCrawl([seed("/hub")], "tidal energy", {
      maxDepth: 10,
      maxMs: -1,
      noDelay: true,
    });
    expect(r.capped).toBe(true);
    expect(r.capReason).toBe("time_cap");
    expect(r.pagesCrawled).toBe(0);
  });

  test("dead pages are skipped, not fatal", async () => {
    const r = await deepCrawl(
      [seed("/hub"), { title: "Dead", url: BASE + "/nope", snippet: "" }],
      "tidal energy",
      { maxDepth: 0, noDelay: true }
    );
    expect(r.pagesCrawled).toBe(1);
    expect(r.capped).toBe(false);
  });

  test("minScore threshold is honored", async () => {
    // minScore 3: only a2 ("tidal energy storage" = 2 hits)... none qualify
    const r = await deepCrawl([seed("/hub")], "tidal energy", {
      maxDepth: 1,
      minScore: 3,
      noDelay: true,
    });
    expect(r.pagesCrawled).toBe(1); // hub only
  });
});
