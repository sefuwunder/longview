// In-process scheduler for longview: a sweep runs every 60s and re-crawls
// topics whose schedule is due. One failing crawl marks that topic `error`
// (with the classified reason persisted) and never stops the sweep.

import type { Database } from "bun:sqlite";
import {
  getTopic,
  insertFindings,
  listTopics,
  setTopicStatus,
  type Topic,
} from "./db";
import type { SearchResult } from "./search";
import { search, resolveBackend, type SearchOutcome } from "./search";
import {
  deepCrawl,
  normalizeUrl,
  type DeepCrawlOptions,
  type DeepCrawlResult,
  type DeepSeed,
} from "./deepcrawl";

export const SWEEP_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Pure due-check: manual never auto-crawls; daily/weekly by elapsed time. */
export function topicIsDue(
  t: Pick<Topic, "schedule" | "last_crawl_at">,
  nowMs: number
): boolean {
  if (t.schedule === "manual") return false;
  if (t.last_crawl_at == null) return true; // never crawled
  const interval = t.schedule === "weekly" ? WEEK_MS : DAY_MS;
  return nowMs - t.last_crawl_at >= interval;
}

export type CrawlFn = (query: string) => Promise<SearchOutcome>;
export type DeepCrawlFn = (
  seeds: DeepSeed[],
  query: string,
  maxDepth: number,
  opts?: DeepCrawlOptions
) => Promise<DeepCrawlResult>;

const defaultDeep: DeepCrawlFn = (seeds, query, maxDepth, opts) =>
  deepCrawl(seeds, query, { ...opts, maxDepth });

/** Default seed search: the active search backend (see src/search.ts). */
const defaultCrawl: CrawlFn = (q: string) => search(q);

export interface CrawlTopicDeps {
  crawl?: CrawlFn;
  deep?: DeepCrawlFn;
}

/**
 * Crawl one topic: DDG seeds first, then a keyword-guided deep crawl to the
 * topic's depth. New pages (seeds + discoveries) are stored as findings;
 * dedupe by URL still applies. Returns added count. Never throws for deep-
 * crawl failures — the DDG seeds are the guaranteed minimum.
 */
export async function crawlTopic(
  db: Database,
  topicId: number,
  crawl: CrawlFn = defaultCrawl,
  deep: DeepCrawlFn = defaultDeep
): Promise<{ added: number; total: number; discovered: number }> {
  const topic = getTopic(db, topicId);
  if (!topic) throw new Error("topic not found");
  let result: SearchOutcome;
  try {
    result = await crawl(topic.query);
  } catch (e) {
    // A crawl function that throws is treated as an unclassified network error.
    const msg = e instanceof Error ? e.message : String(e);
    result = {
      ok: false,
      results: [],
      backend: resolveBackend(db).name,
      endpoint: null,
      httpStatus: null,
      errorClass: "network",
      error: msg,
      ms: 0,
    };
  }
  if (!result.ok) {
    setTopicStatus(
      db,
      topicId,
      "error",
      result.error,
      topic.last_crawl_at,
      result.errorClass
    );
    throw new Error(`crawl failed: ${result.error}`);
  }
  const depth = topic.depth && topic.depth >= 1 && topic.depth <= 10 ? topic.depth : 3;
  // Seeds are always stored, even if the deep crawler can't fetch them.
  const seedRows = result.results.map((r) => ({
    title: r.title,
    url: normalizeUrl(r.url) ?? r.url,
    snippet: r.snippet,
    depth: 0,
    viaUrl: null as string | null,
  }));
  let discoveredRows: typeof seedRows = [];
  try {
    const dc = await deep(deepSeedList(result.results), topic.query, depth);
    discoveredRows = dc.pages
      .filter((p) => p.depth > 0)
      .map((p) => ({
        title: p.title,
        url: p.url,
        snippet: p.snippet,
        depth: p.depth,
        viaUrl: p.viaUrl,
      }));
  } catch {
    // deep crawl failure never fails the topic; seeds still get stored
  }
  const added = insertFindings(db, topicId, [...seedRows, ...discoveredRows]);
  setTopicStatus(db, topicId, "ok", null, Date.now(), null);
  return {
    added,
    total: seedRows.length + discoveredRows.length,
    discovered: discoveredRows.length,
  };
}

function deepSeedList(results: SearchResult[]): DeepSeed[] {
  return results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }));
}

/** One scheduler pass: crawl every due topic. Never throws. */
export async function sweep(
  db: Database,
  crawl: CrawlFn = defaultCrawl,
  deep: DeepCrawlFn = defaultDeep
): Promise<{ crawled: number; added: number; errors: number }> {
  const now = Date.now();
  const due = listTopics(db).filter((t) => topicIsDue(t, now));
  let crawled = 0,
    added = 0,
    errors = 0;
  for (const t of due) {
    try {
      const r = await crawlTopic(db, t.id, crawl, deep);
      crawled++;
      added += r.added;
    } catch {
      errors++;
    }
  }
  return { crawled, added, errors };
}

/** Start the 60s interval sweep. Returns a stop function. */
export function startScheduler(db: Database, crawl: CrawlFn = defaultCrawl): () => void {
  const timer = setInterval(() => {
    sweep(db, crawl).catch((e) => console.error("[longview] sweep error", e));
  }, SWEEP_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
