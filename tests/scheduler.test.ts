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
      okCrawl([{ title: "A", url: "https://x.test/a", snippet: "sa" }])
    );
    expect(r).toEqual({ added: 1, total: 1 });
    const cur = getTopic(db, t.id)!;
    expect(cur.status).toBe("ok");
    expect(cur.last_crawl_at).not.toBeNull();
    expect(listFindings(db, t.id).length).toBe(1);
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
    const r = await sweep(db, crawl);
    expect(r).toEqual({ crawled: 1, added: 1, errors: 1 });
    expect(listFindings(db, due1.id).length).toBe(1);
    expect(listFindings(db, due2.id).length).toBe(0);
    expect(getTopic(db, due2.id)!.status).toBe("error");
  });
  test("nothing due → nothing crawled", async () => {
    let calls = 0;
    const r = await sweep(db, async () => {
      calls++;
      return okCrawl([])();
    });
    expect(r.crawled).toBe(0);
    expect(calls).toBe(0);
  });
});

describe("listTopics", () => {
  test("ordered by name", () => {
    createTopic(db, { name: "Zed", query: "q" });
    createTopic(db, { name: "Abe", query: "q" });
    expect(listTopics(db).map((t) => t.name)).toEqual(["Abe", "Zed"]);
  });
});
