// Tests for the Parallel search backend against a stub API server.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { searchParallel, parallelKeyConfigured } from "../src/backends/parallel";

const PORT = 32271;
const BASE = `http://127.0.0.1:${PORT}/v1/search`;

let server: ReturnType<typeof Bun.serve> | null = null;
let mode: "ok" | "auth" | "quota" | "empty" | "strict" | "always422" = "ok";
let lastBody: unknown = null;
let lastAuth = "";

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      lastAuth = req.headers.get("authorization") ?? "";
      lastBody = await req.json().catch(() => null);
      const ct = { headers: { "Content-Type": "application/json" } };
      if (mode === "auth") return new Response("{}", { status: 401, ...ct });
      if (mode === "quota") return new Response("{}", { status: 429, ...ct });
      if (mode === "always422")
        return new Response(JSON.stringify({ detail: "extra_forbidden" }), { status: 422, ...ct });
      if (mode === "strict") {
        // Mimics Parallel's real schema validation: max_results is only
        // valid nested under advanced_settings; a top-level copy → 422.
        const allowed = new Set(["objective", "search_queries", "mode", "max_chars_total", "client_model", "session_id", "advanced_settings"]);
        const extra = Object.keys((lastBody ?? {}) as object).filter((k) => !allowed.has(k));
        if (extra.length) return new Response(JSON.stringify({ detail: "extra_forbidden" }), { status: 422, ...ct });
      }
      if (mode === "empty")
        return new Response(JSON.stringify({ results: [] }), ct);
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Solar 101",
              url: "https://ex.com/solar",
              excerpts: ["Solar panels convert light.", "They last decades."],
              published_date: "2024-03-01T00:00:00Z",
            },
            { title: "Dupe", url: "https://ex.com/solar", excerpts: ["x"] },
            { title: "Bad URL", url: "notaurl", excerpts: ["x"] },
          ],
        }),
        ct
      );
    },
  });
});

afterAll(() => {
  server?.stop();
});

describe("searchParallel", () => {
  test("sends Bearer auth and maps excerpts", async () => {
    mode = "ok";
    const r = await searchParallel("solar panels", {
      apiBase: BASE,
      apiKey: "test-key",
    });
    expect(r.ok).toBe(true);
    expect(r.backend).toBe("parallel");
    expect(r.endpoint).toBe("parallel-api");
    expect(lastAuth).toBe("Bearer test-key");
    // dedupes by URL, drops non-URLs
    expect(r.results.length).toBe(1);
    expect(r.results[0].url).toBe("https://ex.com/solar");
    expect(r.results[0].snippet).toContain("Solar panels convert light.");
    expect(r.results[0].snippet).toContain("2024-03-01");
    // objective + search_queries contract
    const body = lastBody as Record<string, unknown>;
    expect(body.mode).toBe("basic");
    expect(body.search_queries).toEqual(["solar panels"]);
    expect(typeof body.objective).toBe("string");
    // max_results must be nested under advanced_settings — a top-level copy
    // is rejected by the real API with 422 (regression, 2026-09-23).
    expect(body.max_results).toBeUndefined();
    expect((body.advanced_settings as Record<string, unknown>)?.max_results).toBe(10);
  });

  test("strict-schema stub accepts the request (no 422)", async () => {
    mode = "strict";
    const r = await searchParallel("solar panels", {
      apiBase: BASE,
      apiKey: "k",
    });
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
    mode = "ok";
  });

  test("a 422 from the API surfaces the schema-mismatch diagnostic", async () => {
    mode = "always422";
    const r = await searchParallel("x", { apiBase: BASE, apiKey: "k" });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("http_422");
    expect(r.httpStatus).toBe(422);
    expect(r.error).toContain("rejected the search request as invalid");
    expect(r.error).not.toContain("try again later");
    mode = "ok";
  });

  test("missing key → auth failure without network", async () => {
    const r = await searchParallel("x", {
      apiBase: BASE,
      apiKey: "",
    });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("auth");
  });

  test("401 → auth class", async () => {
    mode = "auth";
    const r = await searchParallel("x", { apiBase: BASE, apiKey: "bad" });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("auth");
    expect(r.httpStatus).toBe(401);
  });

  test("429 → quota class", async () => {
    mode = "quota";
    const r = await searchParallel("x", { apiBase: BASE, apiKey: "k" });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("quota");
  });

  test("empty results still ok", async () => {
    mode = "empty";
    const r = await searchParallel("x", { apiBase: BASE, apiKey: "k" });
    expect(r.ok).toBe(true);
    expect(r.results).toEqual([]);
  });

  test("unreachable host → network class", async () => {
    const r = await searchParallel("x", {
      apiBase: "http://127.0.0.1:1/nope",
      apiKey: "k",
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.errorClass).toBe("network");
  });
});

describe("parallelKeyConfigured", () => {
  test("reads explicit key and env", () => {
    expect(parallelKeyConfigured("abc")).toBe(true);
    expect(parallelKeyConfigured("")).toBe(false);
    const prev = process.env.PARALLEL_API_KEY;
    process.env.PARALLEL_API_KEY = "env-key";
    expect(parallelKeyConfigured()).toBe(true);
    if (prev === undefined) delete process.env.PARALLEL_API_KEY;
    else process.env.PARALLEL_API_KEY = prev;
  });
});
