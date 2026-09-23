// Parallel search backend for longview. Official JSON API
// (POST api.parallel.ai/v1/search, Bearer auth).
//
// Parallel returns LLM-ready excerpts per result, which makes it good fuel
// for the research agent: fewer page fetches are needed to gather evidence.
// A key comes from platform.parallel.ai -> API keys. Set it as
// PARALLEL_API_KEY (env). Selected with SEARCH_BACKEND=parallel (or the
// Settings tab); DuckDuckGo scraping remains the default.

import type { SearchOutcome, SearchResult } from "../search";

export interface ParallelOptions {
  maxResults?: number;
  timeoutMs?: number;
  /** Test hook: point at a stub server instead of api.parallel.ai. */
  apiBase?: string;
  /** Test hook: explicit key instead of the env var. */
  apiKey?: string;
}

const DEFAULT_TIMEOUT_MS = 20000;

export function parallelApiBase(): string {
  return process.env.PARALLEL_API_BASE ?? "https://api.parallel.ai/v1/search";
}

export function parallelKeyConfigured(key?: string): boolean {
  return !!(key ?? process.env.PARALLEL_API_KEY);
}

function fail(
  errorClass: "auth" | "quota" | "timeout" | "network" | `http_${number}`,
  error: string,
  httpStatus: number | null,
  ms: number
): SearchOutcome {
  return {
    ok: false,
    results: [],
    backend: "parallel",
    endpoint: "parallel-api",
    httpStatus,
    errorClass,
    error,
    ms,
  };
}

function mapResult(r: unknown, maxSnippet: number): SearchResult | null {
  const rec = r as Record<string, unknown> | null;
  if (!rec) return null;
  const url = typeof rec.url === "string" ? rec.url : "";
  if (!/^https?:\/\//i.test(url)) return null;
  const title =
    typeof rec.title === "string" && rec.title.trim() ? rec.title.trim() : url;
  const parts: string[] = [];
  if (Array.isArray(rec.excerpts))
    for (const x of rec.excerpts) if (typeof x === "string" && x.trim()) parts.push(x.trim());
  let snippet = parts.join(" … ");
  if (!snippet && typeof rec.snippet === "string") snippet = rec.snippet;
  if (rec.published_date)
    snippet += ` (published ${String(rec.published_date).slice(0, 10)})`;
  return { title, url, snippet: snippet.slice(0, maxSnippet) };
}

/**
 * Search Parallel. Returns a classified outcome instead of throwing,
 * matching the DDG/Exa backends' contract so callers treat all three
 * identically.
 */
export async function searchParallel(
  query: string,
  opts: ParallelOptions = {}
): Promise<SearchOutcome> {
  const key = opts.apiKey ?? process.env.PARALLEL_API_KEY;
  if (!key) {
    return fail(
      "auth",
      "PARALLEL_API_KEY not configured — get a key at platform.parallel.ai",
      null,
      0
    );
  }
  const maxResults = Math.min(Math.max(opts.maxResults ?? 10, 1), 20);
  const base = opts.apiBase ?? parallelApiBase();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  const t0 = Date.now();
  try {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        objective: `Find authoritative web results about: ${query}`,
        search_queries: [query],
        mode: "basic",
        max_chars_total: 8000,
        // max_results is ONLY valid nested here — a top-level copy is
        // rejected by the API with 422 (extra fields forbidden).
        advanced_settings: { max_results: maxResults },
      }),
      signal: controller.signal,
    });
    const ms = Date.now() - t0;
    if (res.status === 401 || res.status === 403)
      return fail("auth", "invalid Parallel API key — check PARALLEL_API_KEY", res.status, ms);
    if (res.status === 402 || res.status === 429)
      return fail(
        "quota",
        "Parallel quota exhausted or rate-limited — try again later",
        res.status,
        ms
      );
    if (res.status === 422)
      // Deterministic: the request we built doesn't match the API schema.
      // "Try again later" would be wrong advice — this needs a code fix.
      return fail(
        "http_422",
        "Parallel rejected the search request as invalid (HTTP 422) — the request longview built didn't match the API schema; check for an app update",
        res.status,
        ms
      );
    if (!res.ok)
      return fail(
        `http_${res.status}`,
        `Parallel returned HTTP ${res.status} — try again later`,
        res.status,
        ms
      );
    const data: unknown = await res.json().catch(() => null);
    const arr =
      data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)
        ? (data as { results: unknown[] }).results
        : [];
    const results: SearchResult[] = [];
    for (const item of arr) {
      if (results.length >= maxResults) break;
      const r = mapResult(item, 600);
      if (r && !results.some((x) => x.url === r.url)) results.push(r);
    }
    return {
      ok: true,
      results,
      backend: "parallel",
      endpoint: "parallel-api",
      httpStatus: res.status,
      errorClass: null,
      error: null,
      ms,
    };
  } catch {
    const aborted = controller.signal.aborted;
    return fail(
      aborted ? "timeout" : "network",
      aborted
        ? "Parallel request timed out — check your connection"
        : "Could not reach Parallel — check your connection",
      null,
      Date.now() - t0
    );
  } finally {
    clearTimeout(timer);
  }
}
