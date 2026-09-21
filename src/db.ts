// SQLite storage for longview. Creates the data dir and all tables on open,
// so a fresh boot always works. Zero npm deps — Bun's built-in sqlite.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Topic {
  id: number;
  name: string;
  query: string;
  schedule: string; // "daily" | "weekly" | "manual"
  status: string; // "ok" | "error"
  last_error: string | null;
  last_error_class: string | null; // "challenge" | "timeout" | "network" | "parse_empty" | "http_<code>"
  last_crawl_at: number | null;
  created_at: number;
}

export interface Finding {
  id: number;
  topic_id: number;
  title: string;
  url: string;
  snippet: string;
  found_at: number;
  is_new: number;
}

export interface ResearchRun {
  id: number;
  question: string;
  status: string; // "pending" | "working" | "done" | "error"
  report_md: string | null;
  error: string | null;
  created_at: number;
}

export interface ResearchSource {
  run_id: number;
  title: string;
  url: string;
  snippet: string;
}

export function defaultDataDir(): string {
  return join(process.cwd(), "data");
}

export function openDb(dataDir?: string): Database {
  const dir = dataDir ?? process.env.LONGVIEW_DATA ?? defaultDataDir();
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "longview.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      schedule TEXT NOT NULL DEFAULT 'daily',
      status TEXT NOT NULL DEFAULT 'ok',
      last_error TEXT,
      last_error_class TEXT,
      last_crawl_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      found_at INTEGER NOT NULL,
      is_new INTEGER NOT NULL DEFAULT 1,
      UNIQUE(topic_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_findings_topic ON findings(topic_id);
    CREATE TABLE IF NOT EXISTS research_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      report_md TEXT,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS research_sources (
      run_id INTEGER NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sources_run ON research_sources(run_id);
  `);
  // Migration for DBs created before last_error_class existed.
  const cols = db.query("PRAGMA table_info(topics)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "last_error_class")) {
    db.exec("ALTER TABLE topics ADD COLUMN last_error_class TEXT");
  }
  return db;
}

// ---- topics ----

export function listTopics(db: Database): Topic[] {
  return db.query("SELECT * FROM topics ORDER BY name").all() as Topic[];
}

export function getTopic(db: Database, id: number): Topic | null {
  return (
    (db.query("SELECT * FROM topics WHERE id = ?").get(id) as Topic) ?? null
  );
}

export function createTopic(
  db: Database,
  t: { name: string; query: string; schedule?: string }
): Topic {
  const now = Date.now();
  const row = db
    .query(
      "INSERT INTO topics (name, query, schedule, created_at) VALUES (?,?,?,?) RETURNING *"
    )
    .get(t.name, t.query, t.schedule ?? "daily", now) as Topic;
  return row;
}

export function updateTopic(
  db: Database,
  id: number,
  patch: { name?: string; query?: string; schedule?: string }
): Topic | null {
  const cur = getTopic(db, id);
  if (!cur) return null;
  const row = db
    .query(
      "UPDATE topics SET name=?, query=?, schedule=? WHERE id=? RETURNING *"
    )
    .get(
      patch.name ?? cur.name,
      patch.query ?? cur.query,
      patch.schedule ?? cur.schedule,
      id
    ) as Topic;
  return row;
}

export function deleteTopic(db: Database, id: number): boolean {
  db.query("DELETE FROM findings WHERE topic_id = ?").run(id);
  const r = db.query("DELETE FROM topics WHERE id = ?").run(id);
  return r.changes > 0;
}

export function setTopicStatus(
  db: Database,
  id: number,
  status: "ok" | "error",
  lastError: string | null,
  lastCrawlAt: number | null,
  lastErrorClass: string | null = null
): void {
  db.query(
    "UPDATE topics SET status=?, last_error=?, last_error_class=?, last_crawl_at=? WHERE id=?"
  ).run(status, lastError, lastErrorClass, lastCrawlAt, id);
}

export function topicNewCount(db: Database, topicId: number): number {
  const r = db
    .query("SELECT COUNT(*) AS n FROM findings WHERE topic_id=? AND is_new=1")
    .get(topicId) as { n: number };
  return r.n;
}

// ---- findings ----

/** Insert results; dedupe by (topic_id, url). Returns number of NEW rows. */
export function insertFindings(
  db: Database,
  topicId: number,
  results: { title: string; url: string; snippet: string }[]
): number {
  const now = Date.now();
  const stmt = db.query(
    "INSERT OR IGNORE INTO findings (topic_id, title, url, snippet, found_at, is_new) VALUES (?,?,?,?,?,1)"
  );
  let added = 0;
  for (const r of results) {
    const res = stmt.run(topicId, r.title, r.url, r.snippet, now);
    added += Number(res.changes);
  }
  return added;
}

export function listFindings(db: Database, topicId: number): Finding[] {
  return db
    .query("SELECT * FROM findings WHERE topic_id=? ORDER BY found_at DESC, id DESC")
    .all(topicId) as Finding[];
}

export function markFindingRead(db: Database, id: number): boolean {
  const r = db.query("UPDATE findings SET is_new=0 WHERE id=?").run(id);
  return r.changes > 0;
}

// ---- research runs ----

export function createResearchRun(db: Database, question: string): ResearchRun {
  return db
    .query(
      "INSERT INTO research_runs (question, status, created_at) VALUES (?, 'pending', ?) RETURNING *"
    )
    .get(question, Date.now()) as ResearchRun;
}

export function getResearchRun(db: Database, id: number): ResearchRun | null {
  return (
    (db.query("SELECT * FROM research_runs WHERE id=?").get(id) as ResearchRun) ??
    null
  );
}

export function listResearchRuns(db: Database): ResearchRun[] {
  return db
    .query(
      "SELECT id, question, status, created_at FROM research_runs ORDER BY id DESC LIMIT 50"
    )
    .all() as ResearchRun[];
}

export function setRunStatus(
  db: Database,
  id: number,
  status: string,
  reportMd: string | null = null,
  error: string | null = null
): void {
  db.query("UPDATE research_runs SET status=?, report_md=?, error=? WHERE id=?").run(
    status,
    reportMd,
    error,
    id
  );
}

export function insertResearchSources(
  db: Database,
  runId: number,
  sources: { title: string; url: string; snippet: string }[]
): void {
  const stmt = db.query(
    "INSERT INTO research_sources (run_id, title, url, snippet) VALUES (?,?,?,?)"
  );
  for (const s of sources) stmt.run(runId, s.title, s.url, s.snippet);
}

export function listResearchSources(db: Database, runId: number): ResearchSource[] {
  return db
    .query("SELECT run_id, title, url, snippet FROM research_sources WHERE run_id=? ORDER BY rowid")
    .all(runId) as ResearchSource[];
}
