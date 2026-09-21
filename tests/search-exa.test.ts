// Exa backend + search-backend selection tests. A stub HTTP server plays the
// role of api.exa.ai, so no live network is ever touched.
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchExa, exaKeyConfigured } from "../src/backends/exa";
import {
  search,
  initSearch,
  resolveBackend,
  diagnoseSearch,
} from "../src/search";
import { openDb, setSetting, createTopic } from "../src/db";
import { crawlTopic } from "../src/scheduler";

const EXA_PORT = 32311;
const EXA_BASE = `http://127.0.0.1:${EXA_PORT}/search`;

let mode: "good" | "401" | "429" | "500" | "hang" = "good";
let requestCount = 0;
let lastMethod: string | null = null;
let lastApiKey: string | null = null;
let lastBody: unknown = null;

const GOOD_JSON = {
  results: [
    { title: "Alpha page", url: "https://example.com/alpha", text: "Alpha snippet text." },
    // missing title → url fallback; highlights → snippet fallback
    { url: "https://example.com/beta", highlights: ["Beta highlight snippet."] },
    // missing everything useful → empty snippet, still a result
    { title: "Gamma", url: "https://example.com/gamma" },
    // non-http url → dropped
    { title: "Junk", url: "ftp://example.com/junk" },
    // duplicate url → dropped
    { title: "Alpha dup", url: "https://example.com/alpha", text: "dup" },
  ],
};

let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: EXA_PORT,
    async fetch(req) {
      requestCount++;
      lastMethod = req.method;
      lastApiKey = req.headers.get("x-api-key");
      try {
        lastBody = await req.json();
      } catch {
        lastBody = null;
      }
      switch (mode) {
        case "401":
          return new Response("unauthorized", { status: 401 });
        case "429":
          return new Response("rate limited", { status: 429 });
        case "500":
          return new Response("boom", { status: 500 });
        case "hang":
          return new Promise<Response>(() => {}); // never responds
        default:
          return Response.json(GOOD_JSON);
      }
    },
  });
});

// The /hang stub never resolves; stop hard so the hook doesn't time out.
afterAll(() => {
  server?.stop(true);
});

// ---- env hygiene: bun shares process.env across test files ----
const ENV_KEYS = ["SEARCH_BACKEND", "EXA_API_KEY", "EXA_API_BASE", "DDG_BASE_URL", "DDG_NO_DELAY"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.EXA_API_BASE = EXA_BASE;
  process.env.EXA_API_KEY = "test-key-123";
  requestCount = 0;
  lastMethod = null;
  lastApiKey = null;
  lastBody = null;
  mode = "good";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  initSearch(null);
});

describe("searchExa", () => {
  test("maps results, tolerates missing fields, drops junk + dupes", async () => {
    const r = await searchExa("alpha test", { maxResults: 10 });
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("exa");
    expect(r.endpoint).toBe("exa-api");
    expect(r.httpStatus).toBe(200);
    expect(r.errorClass).toBeNull();
    expect(r.results).toHaveLength(3);
    expect(r.results[0]).toMatchObject({
      title: "Alpha page",
      url: "https://example.com/alpha",
      snippet: "Alpha snippet text.",
    });
    expect(r.results[1].title).toBe("https://example.com/beta"); // title fallback
    expect(r.results[1].snippet).toBe("Beta highlight snippet."); // highlights fallback
    expect(r.results[2].snippet).toBe(""); // nothing to fall back on
  });

  test("sends POST with x-api-key and the expected JSON body", async () => {
    await searchExa("some query", { maxResults: 5 });
    expect(lastMethod).toBe("POST");
    expect(lastApiKey).toBe("test-key-123");
    expect(lastBody).toMatchObject({ query: "some query", numResults: 5, type: "auto" });
  });

  test("caps numResults at 20", async () => {
    await searchExa("q", { maxResults: 500 });
    expect((lastBody as { numResults: number }).numResults).toBe(20);
  });

  test("401 → auth", async () => {
    mode = "401";
    const r = await searchExa("q");
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("auth");
    expect(r.error).toContain("invalid Exa API key");
  });

  test("429 → quota", async () => {
    mode = "429";
    const r = await searchExa("q");
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("quota");
    expect(r.error).toContain("quota");
  });

  test("500 → http_500", async () => {
    mode = "500";
    const r = await searchExa("q");
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("http_500");
  });

  test("hang → timeout", async () => {
    mode = "hang";
    const r = await searchExa("q", { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("timeout");
  });

  test("missing key → auth with no network request", async () => {
    delete process.env.EXA_API_KEY;
    const r = await searchExa("q");
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("auth");
    expect(r.error).toContain("EXA_API_KEY not configured");
    expect(requestCount).toBe(0);
  });
});

describe("exaKeyConfigured", () => {
  test("reflects the env var", () => {
    expect(exaKeyConfigured()).toBe(true);
    delete process.env.EXA_API_KEY;
    expect(exaKeyConfigured()).toBe(false);
  });
});

describe("resolveBackend", () => {
  test("env wins over the persisted setting", () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "lv-be-")));
    setSetting(db, "backend", "ddg");
    process.env.SEARCH_BACKEND = "exa";
    expect(resolveBackend(db)).toMatchObject({ name: "exa", source: "env" });
    db.close();
  });

  test("persisted setting is used when no env", () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "lv-be-")));
    setSetting(db, "backend", "exa");
    delete process.env.SEARCH_BACKEND;
    expect(resolveBackend(db)).toMatchObject({ name: "exa", source: "setting" });
    db.close();
  });

  test("invalid env falls back to ddg", () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "lv-be-")));
    process.env.SEARCH_BACKEND = "google";
    expect(resolveBackend(db).name).toBe("ddg");
    db.close();
  });

  test("default is ddg", () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "lv-be-")));
    delete process.env.SEARCH_BACKEND;
    expect(resolveBackend(db)).toMatchObject({ name: "ddg", source: "default" });
    db.close();
  });
});

describe("search() routing", () => {
  test("SEARCH_BACKEND=exa routes through Exa", async () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "lv-be-")));
    initSearch(db);
    process.env.SEARCH_BACKEND = "exa";
    const r = await search("alpha test");
    expect(r.backend).toBe("exa");
    expect(r.ok).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
    expect(requestCount).toBe(1);
    db.close();
  });

  test("exa failure classifies as auth when the key is missing", async () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "lv-be-")));
    initSearch(db);
    process.env.SEARCH_BACKEND = "exa";
    delete process.env.EXA_API_KEY;
    const r = await search("alpha test");
    expect(r.ok).toBe(false);
    expect(r.backend).toBe("exa");
    expect(r.errorClass).toBe("auth");
    db.close();
  });
});

describe("diagnoseSearch", () => {
  test("exa diag names the backend and reports key status", async () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "lv-be-")));
    setSetting(db, "backend", "exa");
    const d = await diagnoseSearch(db, "alpha test");
    expect(d.backend).toBe("exa");
    expect(d.winner).toBe("exa-api");
    expect(d.keyConfigured).toBe(true);
    expect(d.endpoints).toHaveLength(1);
    expect(d.endpoints[0]).toMatchObject({
      endpoint: "exa-api",
      httpStatus: 200,
      resultCount: 3,
      errorClass: null,
    });
    db.close();
  });

  test("exa diag without a key reports auth + keyConfigured false", async () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "lv-be-")));
    setSetting(db, "backend", "exa");
    delete process.env.EXA_API_KEY;
    const d = await diagnoseSearch(db, "alpha test");
    expect(d.backend).toBe("exa");
    expect(d.winner).toBeNull();
    expect(d.keyConfigured).toBe(false);
    expect(d.endpoints[0].errorClass).toBe("auth");
    db.close();
  });
});

describe("scheduler uses the active backend", () => {
  test("crawlTopic defaults to search() and records Exa seeds as findings", async () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "lv-be-")));
    initSearch(db);
    setSetting(db, "backend", "exa");
    const t = createTopic(db, { name: "t", query: "alpha test", schedule: "manual" });
    const noDeep = async () => ({
      pages: [],
      pagesCrawled: 0,
      maxDepthReached: 0,
      capped: false,
      capReason: null,
    });
    const r = await crawlTopic(db, t.id, undefined, noDeep as never);
    expect(r.added).toBe(3);
    expect(r.total).toBe(3);
    db.close();
  });
});
