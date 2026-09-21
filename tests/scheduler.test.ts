import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  openDb,
  createTopic,
  getTopic,
  listTopics,
  updateTopic,
  deleteTopic,
  insertFindings,
  listFindings,
  markFindingRead,
  topicNewCount,
  setTopicStatus,
} from "../src/db";
import { topicIsDue, crawlTopic, sweep } from "../src/scheduler";
import type { CrawlResult } from "../src/ddg";
import type { DeepCrawlResult } from "../src/deepcrawl";

/** Deep-crawl stub that discovers nothing (deterministic, no network). */
const noDeep = async (): Promise<DeepCrawlResult> => ({
  pages: [],
  pagesCrawled: 0,
  maxDepthReached: 0,
  capped: false,
  capReason: null,
});

const okCrawl =
  (rows: { title: string; url: string; snippet: string }[]) =>
  async (): Promise<CrawlResult> => ({
    ok: true,
    results: rows,
    endpoint: "test",
    httpStatus: 200,
    errorClass: null,
    error: null,
    ms: 1,
  });

const failCrawl =
  (errorClass: CrawlResult["errorClass"], error: string) =>
  async (): Promise<CrawlResult> => ({
    ok: false,
    results: [],
    endpoint: "test",
    httpStatus: null,
    errorClass,
    error,
    ms: 1,
  });

let db: Database;
beforeEach(() => {
  db = openDb(mkdtempSync(join(tmpdir(), "lv-sched-")));
});

const H = 3_600_000;
const D = 24 * H;

describe("topicIsDue", () => {
  test("manual never auto-crawls", () => {
    expect(topicIsDue({ schedule: "manual", last_crawl_at: null }, Date.now())).toBe(false);
    expect(topicIsDue({ schedule: "manual", last_crawl_at: Date.now() - 30 * D }, Date.now())).toBe(false);
  });
  test("never-crawled daily/weekly topics are due", () => {
    expect(topicIsDue({ schedule: "daily", last_crawl_at: null }, Date.now())).toBe(true);
    expect(topicIsDue({ schedule: "weekly", last_crawl_at: null }, Date.now())).toBe(true);
  });
  test("daily interval", () => {
    const now = Date.now();
    expect(topicIsDue({ schedule: "daily", last_crawl_at: now - 23 * H }, now)).toBe(false);
    expect(topicIsDue({ schedule: "daily", last_crawl_at: now - 25 * H }, now)).toBe(true);
  });
  test("weekly interval", () => {
    const now = Date.now();
    expect(topicIsDue({ schedule: "weekly", last_crawl_at: now - 3 * D }, now)).toBe(false);
    expect(topicIsDue({ schedule: "weekly", last_crawl_at: now - 8 * D }, now)).toBe(true);
  });
});

describe("findings dedupe", () => {
  test("unique(topic_id, url): re-insert adds nothing, new urls add", () => {
    const t = createTopic(db, { name: "T", query: "q" });
    const rows = [
      { title: "A", url: "https://x.test/a", snippet: "s" },
      { title: "B", url: "https://x.test/b", snippet: "s" },
    ];
    expect(insertFindings(db, t.id, rows)).toBe(2);
    expect(insertFindings(db, t.id, rows)).toBe(0);
    expect(insertFindings(db, t.id, [...rows, { title: "C", url: "https://x.test/c", snippet: "s" }])).toBe(1);
    expect(listFindings(db, t.id).length).toBe(3);
  });
  test("mark read clears the new badge count", () => {
    const t = createTopic(db, { name: "T", query: "q" });
    insertFindings(db, t.id, [{ title: "A", url: "https://x.test/a", snippet: "" }]);
    expect(topicNewCount(db, t.id)).toBe(1);
    const f = listFindings(db, t.id)[0];
    expect(markFindingRead(db, f.id)).toBe(true);
    expect(topicNewCount(db, t.id)).toBe(0);
  });
  test("deleting a topic removes its findings", () => {
    const t = createTopic(db, { name: "T", query: "q" });
    insertFindings(db, t.id, [{ title: "A", url: "https://x.test/a", snippet: "" }]);
    expect(deleteTopic(db, t.id)).toBe(true);
    expect(getTopic(db, t.id)).toBeNull();
    expect(listFindings(db, t.id)).toEqual([]);
  });
  test("updateTopic patches fields", () => {
    const t = createTopic(db, { name: "T", query: "q" });
    const u = updateTopic(db, t.id, { schedule: "weekly", query: "q2" });
    expect(u!.schedule).toBe("weekly");
    expect(u!.query).toBe("q2");
    expect(u!.name).toBe("T");
    expect(updateTopic(db, 9999, { name: "x" })).toBeNull();
  });
});

describe("crawlTopic", () => {
  test("stores findings and marks ok", async () => {
    const t = createTopic(db, { name: "T", query: "q" });
    const r = await crawlTopic(
      db,
      t.id,
      okCrawl([{ title: "A", url: "https://x.test/a", snippet: "sa" }]),
      noDeep
    );
    expect(r).toEqual({ added: 1, total: 1, discovered: 0 });
    const cur = getTopic(db, t.id)!;
    expect(cur.status).toBe("ok");
    expect(cur.last_crawl_at).not.toBeNull();
    const f = listFindings(db, t.id);
    expect(f.length).toBe(1);
    expect(f[0].depth).toBe(0);
    expect(f[0].via_url).toBeNull();
  });
  test("a failed crawl marks the topic error and keeps old last_crawl_at", async () => {
    const t = createTopic(db, { name: "T", query: "q" });
    setTopicStatus(db, t.id, "ok", null, 12345);
    await expect(
      crawlTopic(db, t.id, async () => {
        throw new Error("DDG down");
      })
    ).rejects.toThrow("crawl failed");
    const cur = getTopic(db, t.id)!;
    expect(cur.status).toBe("error");
    expect(cur.last_error).toContain("DDG down");
    expect(cur.last_crawl_at).toBe(12345);
  });
  test("a classified crawl failure persists last_error + last_error_class", async () => {
    const t = createTopic(db, { name: "T", query: "q" });
    await expect(
      crawlTopic(
        db,
        t.id,
        failCrawl(
          "challenge",
          "DuckDuckGo served a bot challenge (HTTP 202) — try again later or from another network"
        )
      )
    ).rejects.toThrow("crawl failed");
    const cur = getTopic(db, t.id)!;
    expect(cur.status).toBe("error");
    expect(cur.last_error_class).toBe("challenge");
    expect(cur.last_error).toContain("bot challenge");
  });
});

describe("sweep", () => {
  test("crawls due topics only; one failure does not stop the rest", async () => {
    const due1 = createTopic(db, { name: "A", query: "qa" });
    const due2 = createTopic(db, { name: "B", query: "qb" });
    createTopic(db, { name: "C", query: "qc", schedule: "manual" });
    const crawl = async (q: string) => {
      if (q === "qb")
        return {
          ok: false as const,
          results: [] as never[],
          endpoint: "test",
          httpStatus: null,
          errorClass: "network" as const,
          error: "nope",
          ms: 1,
        };
      return okCrawl([{ title: "T-" + q, url: "https://x.test/" + q, snippet: "" }])();
    };
    const r = await sweep(db, crawl, noDeep);
    expect(r).toEqual({ crawled: 1, added: 1, errors: 1 });
    expect(listFindings(db, due1.id).length).toBe(1);
    expect(listFindings(db, due2.id).length).toBe(0);
    expect(getTopic(db, due2.id)!.status).toBe("error");
  });
  test("nothing due → nothing crawled", async () => {
    let calls = 0;
    const r = await sweep(
      db,
      async () => {
        calls++;
        return okCrawl([])();
      },
      noDeep
    );
    expect(r.crawled).toBe(0);
    expect(calls).toBe(0);
  });
});

describe("crawlTopic deep crawl", () => {
  const deepPages = (maxDepthSeen: { n: number }) => async (
    seeds: { title: string; url: string; snippet: string }[],
    query: string,
    maxDepth: number
  ): Promise<DeepCrawlResult> => {
    maxDepthSeen.n = maxDepth;
    void query;
    return {
      pages: seeds.map((s) => ({
        title: s.title,
        url: s.url,
        snippet: s.snippet,
        depth: 0,
        viaUrl: null,
        text: "seed text",
      })),
      pagesCrawled: seeds.length,
      maxDepthReached: 0,
      capped: false,
      capReason: null,
    };
  };

  test("topic depth is passed to the deep crawler", async () => {
    const t = createTopic(db, { name: "T", query: "q", depth: 7 });
    const seen = { n: 0 };
    await crawlTopic(
      db,
      t.id,
      okCrawl([{ title: "A", url: "https://x.test/a", snippet: "" }]),
      deepPages(seen)
    );
    expect(seen.n).toBe(7);
    expect(getTopic(db, t.id)!.depth).toBe(7);
  });

  test("discoveries stored with depth + via_url; dedupe keeps them stable", async () => {
    const t = createTopic(db, { name: "T", query: "q", depth: 2 });
    const deep = async (): Promise<DeepCrawlResult> => ({
      pages: [
        {
          title: "Deep one",
          url: "https://x.test/deep1",
          snippet: "d1",
          depth: 1,
          viaUrl: "https://x.test/seed",
          text: "x".repeat(300),
        },
        {
          title: "Deep two",
          url: "https://x.test/deep2",
          snippet: "d2",
          depth: 2,
          viaUrl: "https://x.test/deep1",
          text: "y".repeat(300),
        },
      ],
      pagesCrawled: 3,
      maxDepthReached: 2,
      capped: false,
      capReason: null,
    });
    const crawl = okCrawl([{ title: "Seed", url: "https://x.test/seed", snippet: "" }]);
    const r1 = await crawlTopic(db, t.id, crawl, deep);
    expect(r1).toEqual({ added: 3, total: 3, discovered: 2 });
    const byUrl = Object.fromEntries(
      listFindings(db, t.id).map((f) => [f.url, f])
    );
    expect(byUrl["https://x.test/deep1"].depth).toBe(1);
    expect(byUrl["https://x.test/deep1"].via_url).toBe("https://x.test/seed");
    expect(byUrl["https://x.test/deep2"].depth).toBe(2);
    expect(byUrl["https://x.test/deep2"].via_url).toBe("https://x.test/deep1");
    // re-crawl: dedupe adds nothing
    const r2 = await crawlTopic(db, t.id, crawl, deep);
    expect(r2.added).toBe(0);
    expect(listFindings(db, t.id).length).toBe(3);
  });

  test("a throwing deep crawl still stores the seeds", async () => {
    const t = createTopic(db, { name: "T", query: "q" });
    const boom = async (): Promise<DeepCrawlResult> => {
      throw new Error("deep down");
    };
    const r = await crawlTopic(
      db,
      t.id,
      okCrawl([{ title: "A", url: "https://x.test/a", snippet: "" }]),
      boom
    );
    expect(r.added).toBe(1);
    expect(getTopic(db, t.id)!.status).toBe("ok");
  });
});

describe("listTopics", () => {
  test("ordered by name", () => {
    createTopic(db, { name: "Zed", query: "q" });
    createTopic(db, { name: "Abe", query: "q" });
    expect(listTopics(db).map((t) => t.name)).toEqual(["Abe", "Zed"]);
  });
});
