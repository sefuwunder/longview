// Exa search backend for longview. Official JSON API (POST api.exa.ai/search).
//
// Exa offers a free tier (~1,000 searches/month, renewable, no credit card).
// A key comes from dashboard.exa.ai -> Keys. Set it as EXA_API_KEY (env).
// The backend is selected with SEARCH_BACKEND=exa (or the Settings tab);
// DuckDuckGo scraping remains the default.

import type { SearchOutcome, SearchResult } from "../search";

export interface ExaOptions {
  maxResults?: number;
  timeoutMs?: number;
  /** Test hook: point at a stub server instead of api.exa.ai. */
  apiBase?: string;
  /** Test hook: explicit key instead of the env var. */
  apiKey?: string;
}

const DEFAULT_TIMEOUT_MS = 15000;

export function exaApiBase(): string {
  return process.env.EXA_API_BASE ?? "https://api.exa.ai/search";
}

export function exaKeyConfigured(key?: string): boolean {
  return !!(key ?? process.env.EXA_API_KEY);
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
    backend: "exa",
    endpoint: "exa-api",
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
  let snippet = "";
  if (typeof rec.text === "string" && rec.text.trim())
    snippet = rec.text.trim();
  else if (Array.isArray(rec.highlights) && typeof rec.highlights[0] === "string")
    snippet = rec.highlights[0];
  return { title, url, snippet: snippet.slice(0, maxSnippet) };
}

/**
 * Search Exa. Returns a classified outcome instead of throwing, matching the
 * DDG backend's contract so callers treat both backends identically.
 */
export async function searchExa(
  query: string,
  opts: ExaOptions = {}
): Promise<SearchOutcome> {
  const key = opts.apiKey ?? process.env.EXA_API_KEY;
  if (!key) {
    return fail(
      "auth",
      "EXA_API_KEY not configured — get a free key at dashboard.exa.ai (no credit card)",
      null,
      0
    );
  }
  const numResults = Math.min(Math.max(opts.maxResults ?? 20, 1), 20);
  const base = opts.apiBase ?? exaApiBase();
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
        "x-api-key": key,
      },
      body: JSON.stringify({ query, numResults, type: "auto" }),
      signal: controller.signal,
    });
    const ms = Date.now() - t0;
    if (res.status === 401)
      return fail("auth", "invalid Exa API key — check EXA_API_KEY", 401, ms);
    if (res.status === 402 || res.status === 429)
      return fail(
        "quota",
        "Exa free quota exhausted or rate-limited — try again later",
        res.status,
        ms
      );
    if (!res.ok)
      return fail(
        `http_${res.status}`,
        `Exa returned HTTP ${res.status} — try again later`,
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
      if (results.length >= numResults) break;
      const r = mapResult(item, 500);
      if (r && !results.some((x) => x.url === r.url)) results.push(r);
    }
    return {
      ok: true,
      results,
      backend: "exa",
      endpoint: "exa-api",
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
        ? "Exa request timed out — check your connection"
        : "Could not reach Exa — check your connection",
      null,
      Date.now() - t0
    );
  } finally {
    clearTimeout(timer);
  }
}
