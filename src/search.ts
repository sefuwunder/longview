// Search backend abstraction for longview.
//
// Two backends sit behind one interface:
//   ddg — scrapes DuckDuckGo's public HTML endpoints (free, but DDG serves
//         bot challenges to some networks; see src/ddg.ts)
//   exa — Exa's official JSON API (free tier ~1,000 searches/month, no credit
//         card; needs EXA_API_KEY; see src/backends/exa.ts)
//
// Selection order: SEARCH_BACKEND env var > persisted `backend` setting >
// "ddg". An invalid SEARCH_BACKEND logs a warning and falls back to "ddg".

import type { Database } from "bun:sqlite";
import { getSetting } from "./db";
import { crawlDDG, diagnoseDDG, type CrawlErrorClass } from "./ddg";
import { searchExa, exaKeyConfigured } from "./backends/exa";

export type BackendName = "ddg" | "exa";

/** DDG crawl classes plus the two API-specific classes the Exa backend adds. */
export type SearchErrorClass = CrawlErrorClass | "auth" | "quota";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOutcome {
  ok: boolean;
  results: SearchResult[];
  backend: BackendName;
  /** DDG endpoint name ("html-post" | "html-get" | "lite" | "custom") or "exa-api". */
  endpoint: string | null;
  httpStatus: number | null;
  errorClass: SearchErrorClass | null;
  /** Human-readable sentence describing the failure (null on success). */
  error: string | null;
  ms: number;
}

export type SearchFn = (query: string) => Promise<SearchOutcome>;

export interface BackendSelection {
  name: BackendName;
  /** Where the choice came from: env var, persisted setting, or the default. */
  source: "env" | "setting" | "default";
}

export function resolveBackend(db: Database | null): BackendSelection {
  const env = (process.env.SEARCH_BACKEND ?? "").trim().toLowerCase();
  if (env === "ddg" || env === "exa") return { name: env, source: "env" };
  if (env)
    console.warn(`[longview] unknown SEARCH_BACKEND="${env}", falling back to "ddg"`);
  if (db) {
    const s = getSetting(db, "backend");
    if (s === "ddg" || s === "exa") return { name: s, source: "setting" };
  }
  return { name: "ddg", source: "default" };
}

// The DB is bound once at boot (server.ts) so callers of search() don't have
// to thread it through. Tests rebind with initSearch().
let boundDb: Database | null = null;
export function initSearch(db: Database | null): void {
  boundDb = db;
}

/** Search with the active backend. Never throws for transport failures. */
export async function search(
  query: string,
  opts: { maxResults?: number } = {}
): Promise<SearchOutcome> {
  const { name } = resolveBackend(boundDb);
  if (name === "exa") return searchExa(query, opts);
  const r = await crawlDDG(query, opts);
  return {
    ok: r.ok,
    results: r.results,
    backend: "ddg",
    endpoint: r.endpoint,
    httpStatus: r.httpStatus,
    errorClass: r.errorClass,
    error: r.error,
    ms: r.ms,
  };
}

export interface SearchDiagEndpoint {
  endpoint: string;
  httpStatus: number | null;
  resultCount: number;
  errorClass: SearchErrorClass | null;
  ms: number;
}

export interface SearchDiag {
  backend: BackendName;
  query: string;
  /** Winner = first endpoint that returned results, or null. */
  winner: string | null;
  endpoints: SearchDiagEndpoint[];
  /** Exa only: whether EXA_API_KEY is set. Null for DDG. */
  keyConfigured: boolean | null;
}

/**
 * Probe the active backend once per endpoint and report status. For Exa this
 * costs one search call; for DDG it walks the existing fallback chain.
 */
export async function diagnoseSearch(
  db: Database,
  query: string
): Promise<SearchDiag> {
  const { name } = resolveBackend(db);
  if (name === "exa") {
    const r = await searchExa(query, { maxResults: 3 });
    return {
      backend: "exa",
      query,
      winner: r.ok ? "exa-api" : null,
      endpoints: [
        {
          endpoint: "exa-api",
          httpStatus: r.httpStatus,
          resultCount: r.results.length,
          errorClass: r.errorClass,
          ms: r.ms,
        },
      ],
      keyConfigured: exaKeyConfigured(),
    };
  }
  const d = await diagnoseDDG(query);
  return {
    backend: "ddg",
    query: d.query,
    winner: d.winner,
    endpoints: d.endpoints,
    keyConfigured: null,
  };
}
