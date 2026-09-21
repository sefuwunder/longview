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
import { crawlDDG, type CrawlResult } from "./ddg";

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

export type CrawlFn = (query: string) => Promise<CrawlResult>;

/** Crawl one topic, store new findings, update status. Returns added count. */
export async function crawlTopic(
  db: Database,
  topicId: number,
  crawl: CrawlFn = crawlDDG
): Promise<{ added: number; total: number }> {
  const topic = getTopic(db, topicId);
  if (!topic) throw new Error("topic not found");
  let result: CrawlResult;
  try {
    result = await crawl(topic.query);
  } catch (e) {
    // A crawl function that throws is treated as an unclassified network error.
    const msg = e instanceof Error ? e.message : String(e);
    result = {
      ok: false,
      results: [],
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
  const added = insertFindings(
    db,
    topicId,
    result.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }))
  );
  setTopicStatus(db, topicId, "ok", null, Date.now(), null);
  return { added, total: result.results.length };
}

/** One scheduler pass: crawl every due topic. Never throws. */
export async function sweep(
  db: Database,
  crawl: CrawlFn = crawlDDG
): Promise<{ crawled: number; added: number; errors: number }> {
  const now = Date.now();
  const due = listTopics(db).filter((t) => topicIsDue(t, now));
  let crawled = 0,
    added = 0,
    errors = 0;
  for (const t of due) {
    try {
      const r = await crawlTopic(db, t.id, crawl);
      crawled++;
      added += r.added;
    } catch {
      errors++;
    }
  }
  return { crawled, added, errors };
}

/** Start the 60s interval sweep. Returns a stop function. */
export function startScheduler(db: Database, crawl: CrawlFn = crawlDDG): () => void {
  const timer = setInterval(() => {
    sweep(db, crawl).catch((e) => console.error("[longview] sweep error", e));
  }, SWEEP_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
