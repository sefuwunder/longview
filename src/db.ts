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
  depth: number; // deep-crawl layers, 1-10
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
  depth: number; // 0 = DDG seed, >0 = discovered by deep crawl
  via_url: string | null; // parent page URL for deep-crawl discoveries
}

export interface ResearchRun {
  id: number;
  question: string;
  status: string; // "pending" | "working" | "done" | "error"
  report_md: string | null;
  error: string | null;
  created_at: number;
  pages_crawled: number | null;
  max_depth: number | null;
  capped: number | null;
  discovered: number | null;
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
  // Migrations for DBs created before these columns existed.
  const tableCols = (t: string) =>
    (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
      (c) => c.name
    );
  const addCol = (table: string, ddl: string) => {
    const name = ddl.trim().split(/\s+/)[0];
    if (!tableCols(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addCol("topics", "last_error_class TEXT");
  addCol("topics", "depth INTEGER NOT NULL DEFAULT 3");
  addCol("findings", "depth INTEGER NOT NULL DEFAULT 0");
  addCol("findings", "via_url TEXT");
  addCol("research_runs", "pages_crawled INTEGER");
  addCol("research_runs", "max_depth INTEGER");
  addCol("research_runs", "capped INTEGER NOT NULL DEFAULT 0");
  addCol("research_runs", "discovered INTEGER NOT NULL DEFAULT 0");
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
  t: { name: string; query: string; schedule?: string; depth?: number }
): Topic {
  const now = Date.now();
  const row = db
    .query(
      "INSERT INTO topics (name, query, schedule, depth, created_at) VALUES (?,?,?,?,?) RETURNING *"
    )
    .get(t.name, t.query, t.schedule ?? "daily", t.depth ?? 3, now) as Topic;
  return row;
}

export function updateTopic(
  db: Database,
  id: number,
  patch: { name?: string; query?: string; schedule?: string; depth?: number }
): Topic | null {
  const cur = getTopic(db, id);
  if (!cur) return null;
  const row = db
    .query(
      "UPDATE topics SET name=?, query=?, schedule=?, depth=? WHERE id=? RETURNING *"
    )
    .get(
      patch.name ?? cur.name,
      patch.query ?? cur.query,
      patch.schedule ?? cur.schedule,
      patch.depth ?? cur.depth,
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
  results: {
    title: string;
    url: string;
    snippet: string;
    depth?: number;
    viaUrl?: string | null;
  }[]
): number {
  const now = Date.now();
  const stmt = db.query(
    "INSERT OR IGNORE INTO findings (topic_id, title, url, snippet, found_at, is_new, depth, via_url) VALUES (?,?,?,?,?,1,?,?)"
  );
  let added = 0;
  for (const r of results) {
    const res = stmt.run(
      topicId,
      r.title,
      r.url,
      r.snippet,
      now,
      r.depth ?? 0,
      r.viaUrl ?? null
    );
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

export interface RunStats {
  pagesCrawled: number;
  maxDepth: number;
  capped: boolean;
  discovered: number;
}

export function setRunStatus(
  db: Database,
  id: number,
  status: string,
  reportMd: string | null = null,
  error: string | null = null,
  stats: RunStats | null = null
): void {
  db.query(
    "UPDATE research_runs SET status=?, report_md=?, error=?, pages_crawled=?, max_depth=?, capped=?, discovered=? WHERE id=?"
  ).run(
    status,
    reportMd,
    error,
    stats?.pagesCrawled ?? null,
    stats?.maxDepth ?? null,
    stats?.capped ? 1 : 0,
    stats?.discovered ?? 0,
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
