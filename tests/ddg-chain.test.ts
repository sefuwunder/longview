// Fallback-chain + error-classification tests. A stub server plays the role
// of each DuckDuckGo endpoint (challenge page, hang, empty page, 500, good
// results), so no live network is ever touched.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  crawlEndpoints,
  crawlDDG,
  diagnoseDDG,
  buildChain,
  parseDDGHtml,
  parseDDGLite,
  humanError,
  type EndpointDef,
} from "../src/ddg";

const PORT = 32211;
const BASE = `http://127.0.0.1:${PORT}`;

const FIX = (n: string) =>
  readFileSync(join(import.meta.dir, "fixtures", n), "utf8");

const CHALLENGE_HTML =
  '<html><head><title>challenge</title></head><body><div class="anomaly-modal">a<br>not<br>a<br>bot</div></body></html>';

const GOOD_HTML = (marker: string) =>
  `<html><body><div id="links" class="results">` +
  `<div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">` +
  `<h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/a?m=${marker}">Result A ${marker}</a></h2>` +
  `<div class="result__snippet">Snippet A.</div></div></div>` +
  `<div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">` +
  `<h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/b?m=${marker}">Result B ${marker}</a></h2>` +
  `<div class="result__snippet">Snippet B.</div></div></div>` +
  `</div></body></html>`;

let lastGetQuery: string | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    fetch(req) {
      const u = new URL(req.url);
      const text = (s: string, status = 200) =>
        new Response(s, {
          status,
          headers: { "Content-Type": "text/html" },
        });
      switch (u.pathname) {
        case "/challenge":
          return text(CHALLENGE_HTML, 202);
        case "/empty":
          return text("<html><body>some junk page with no results</body></html>");
        case "/err500":
          return new Response("boom", { status: 500 });
        case "/hang":
          return new Promise<Response>(() => {}); // never responds
        case "/good":
          if (req.method === "GET") lastGetQuery = u.searchParams.get("q");
          return text(GOOD_HTML(u.pathname));
        default:
          return new Response("nf", { status: 404 });
      }
    },
  });
});

afterAll(() => {
  // closeActiveConnections: the /hang route never responds, so plain stop()
  // would wait out the in-flight request.
  server?.stop(true);
});

const ep = (
  name: string,
  path: string,
  method: "GET" | "POST" = "POST"
): EndpointDef => ({
  name,
  method,
  base: `${BASE}${path}`,
  parser: parseDDGHtml,
});

describe("endpoint fallback chain", () => {
  test("challenge page classifies and falls through to the next endpoint", async () => {
    const r = await crawlEndpoints(
      "bun",
      [ep("first", "/challenge"), ep("second", "/good", "GET")],
      { noDelay: true }
    );
    expect(r.ok).toBe(true);
    expect(r.endpoint).toBe("second");
    expect(r.httpStatus).toBe(200);
    expect(r.results.length).toBe(2);
    expect(r.errorClass).toBeNull();
  });

  test("202 + anomaly-modal alone → challenge", async () => {
    const r = await crawlEndpoints("bun", [ep("only", "/challenge")], {
      noDelay: true,
    });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("challenge");
    expect(r.httpStatus).toBe(202);
    expect(r.endpoint).toBe("only");
    expect(r.error).toContain("bot challenge");
  });

  test("hanging endpoint → timeout", async () => {
    const r = await crawlEndpoints("bun", [ep("only", "/hang")], {
      noDelay: true,
      timeoutMs: 300,
    });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("timeout");
    expect(r.httpStatus).toBeNull();
    expect(r.error).toContain("timed out");
  });

  test("200 with no parseable results → parse_empty", async () => {
    const r = await crawlEndpoints("bun", [ep("only", "/empty")], {
      noDelay: true,
    });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("parse_empty");
    expect(r.httpStatus).toBe(200);
  });

  test("non-202 error status → http_<code>", async () => {
    const r = await crawlEndpoints("bun", [ep("only", "/err500")], {
      noDelay: true,
    });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("http_500");
    expect(r.error).toContain("HTTP 500");
  });

  test("GET endpoints carry the query as ?q=", async () => {
    lastGetQuery = null;
    const r = await crawlEndpoints("bun runtime", [ep("g", "/good", "GET")], {
      noDelay: true,
    });
    expect(r.ok).toBe(true);
    expect(lastGetQuery).toBe("bun runtime");
  });

  test("all endpoints failing returns the last failure", async () => {
    const r = await crawlEndpoints(
      "bun",
      [ep("one", "/err500"), ep("two", "/hang")],
      { noDelay: true, timeoutMs: 300 }
    );
    expect(r.ok).toBe(false);
    expect(r.endpoint).toBe("two");
    expect(r.errorClass).toBe("timeout");
  });
});

describe("DDG_BASE_URL override", () => {
  test("buildChain collapses to a single custom POST endpoint", () => {
    const old = process.env.DDG_BASE_URL;
    try {
      process.env.DDG_BASE_URL = `${BASE}/good`;
      const chain = buildChain();
      expect(chain.length).toBe(1);
      expect(chain[0].name).toBe("custom");
      expect(chain[0].method).toBe("POST");
      expect(chain[0].base).toBe(`${BASE}/good`);
    } finally {
      if (old === undefined) delete process.env.DDG_BASE_URL;
      else process.env.DDG_BASE_URL = old;
    }
  });

  test("default chain has the three real endpoints in order", () => {
    const old = process.env.DDG_BASE_URL;
    try {
      delete process.env.DDG_BASE_URL;
      const chain = buildChain();
      expect(chain.map((c) => c.name)).toEqual(["html-post", "html-get", "lite"]);
      expect(chain[2].method).toBe("GET");
      expect(chain[2].base).toContain("lite.duckduckgo.com");
    } finally {
      if (old !== undefined) process.env.DDG_BASE_URL = old;
    }
  });

  test("crawlDDG honors the override (POST to the stub)", async () => {
    const old = process.env.DDG_BASE_URL;
    try {
      process.env.DDG_BASE_URL = `${BASE}/good`;
      const r = await crawlDDG("bun", { noDelay: true });
      expect(r.ok).toBe(true);
      expect(r.endpoint).toBe("custom");
      expect(r.results.length).toBe(2);
    } finally {
      if (old === undefined) delete process.env.DDG_BASE_URL;
      else process.env.DDG_BASE_URL = old;
    }
  });
});

describe("diagnoseDDG", () => {
  test("shape and winner via DDG_BASE_URL override (hermetic)", async () => {
    const old = process.env.DDG_BASE_URL;
    try {
      process.env.DDG_BASE_URL = `${BASE}/good`;
      const d = await diagnoseDDG("bun", { timeoutMs: 2000 });
      expect(d.query).toBe("bun");
      expect(d.endpoints.length).toBe(1);
      expect(d.endpoints[0]).toMatchObject({
        endpoint: "custom",
        httpStatus: 200,
        resultCount: 2,
        errorClass: null,
      });
      expect(typeof d.endpoints[0].ms).toBe("number");
      expect(d.winner).toBe("custom");
    } finally {
      if (old === undefined) delete process.env.DDG_BASE_URL;
      else process.env.DDG_BASE_URL = old;
    }
  });

  test("all-failing probe → winner null", async () => {
    const old = process.env.DDG_BASE_URL;
    try {
      process.env.DDG_BASE_URL = `${BASE}/challenge`;
      const d = await diagnoseDDG("bun", { timeoutMs: 2000 });
      expect(d.winner).toBeNull();
      expect(d.endpoints[0].errorClass).toBe("challenge");
      expect(d.endpoints[0].httpStatus).toBe(202);
    } finally {
      if (old === undefined) delete process.env.DDG_BASE_URL;
      else process.env.DDG_BASE_URL = old;
    }
  });
});

describe("humanError", () => {
  test("sentences per class", () => {
    expect(humanError("challenge", 202, 15000)).toContain("bot challenge");
    expect(humanError("timeout", null, 15000)).toContain("timed out");
    expect(humanError("network", null, 15000)).toContain("Could not reach");
    expect(humanError("parse_empty", 200, 15000)).toContain(
      "no results could be read"
    );
    expect(humanError("http_500", 500, 15000)).toContain("HTTP 500");
  });
});

describe("parseDDGLite", () => {
  test("extracts results from the lite fixture", () => {
    const r = parseDDGLite(FIX("ddg-lite.html"));
    expect(r.length).toBe(2);
    expect(r[0].url).toBe("https://bun.sh/");
    expect(r[0].title).toContain("Bun");
    expect(r[0].title).not.toContain("<");
    expect(r[0].snippet).toContain("all-in-one JavaScript runtime");
    expect(r[1].url).toBe("https://en.wikipedia.org/wiki/Bun");
    expect(r[1].snippet).toContain("bread roll");
  });
  test("empty markup yields an empty list", () => {
    expect(parseDDGLite("<html><body>nothing here</body></html>")).toEqual([]);
  });
});
