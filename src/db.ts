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

export interface AgentRun {
  id: number;
  question: string;
  status: string; // "pending" | "working" | "done" | "error"
  steps_json: string | null; // AgentStep[]
  plan_json: string | null; // SubQuestion[]
  graph_json: string | null; // AgentGraph
  report_md: string | null;
  error: string | null;
  created_at: number;
  pages_read: number | null;
  sources: number | null;
  findings: number | null;
  followups: number | null;
  folder_id: number | null; // NULL = Unfiled
  parent_run_id: number | null; // NULL = root run; set for follow-up runs
}

export interface Folder {
  id: number;
  name: string;
  parent_id: number | null;
  created_at: number;
  run_count?: number;
}

export interface Journal {
  id: number;
  title: string;
  created_at: number;
  updated_at: number;
  entry_count?: number;
}

export type JournalEntryKind = "finding" | "source" | "note";

export interface JournalEntry {
  id: number;
  journal_id: number;
  run_id: number | null;
  kind: JournalEntryKind;
  ref_text: string;
  note: string;
  position: number;
  run_question?: string | null;
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
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      steps_json TEXT,
      plan_json TEXT,
      graph_json TEXT,
      report_md TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      pages_read INTEGER,
      sources INTEGER,
      findings INTEGER,
      followups INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_id INTEGER NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
      run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
      kind TEXT NOT NULL DEFAULT 'note',
      ref_text TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_journal_entries_journal ON journal_entries(journal_id);
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
  addCol("agent_runs", "folder_id INTEGER");
  addCol("agent_runs", "parent_run_id INTEGER");
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

// ---- settings ----
// Small key/value store for server-persisted preferences (e.g. the selected
// search backend). Env vars override settings at read time where documented.

export function getSetting(db: Database, key: string): string | null {
  const r = db
    .query("SELECT value FROM settings WHERE key=?")
    .get(key) as { value: string } | null;
  return r ? r.value : null;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)").run(
    key,
    value
  );
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

// ---- agent runs ----

export function createAgentRun(
  db: Database,
  question: string,
  opts: { folderId?: number | null; parentRunId?: number | null } = {}
): AgentRun {
  return db
    .query(
      "INSERT INTO agent_runs (question, status, created_at, folder_id, parent_run_id) VALUES (?, 'pending', ?, ?, ?) RETURNING *"
    )
    .get(question, Date.now(), opts.folderId ?? null, opts.parentRunId ?? null) as AgentRun;
}

export function getAgentRun(db: Database, id: number): AgentRun | null {
  return (
    (db.query("SELECT * FROM agent_runs WHERE id=?").get(id) as AgentRun) ??
    null
  );
}

export function listAgentRuns(db: Database): AgentRun[] {
  return db
    .query(
      "SELECT id, question, status, created_at, pages_read, sources, findings, followups, folder_id, parent_run_id FROM agent_runs ORDER BY id DESC LIMIT 50"
    )
    .all() as AgentRun[];
}

/** Move a run into a folder (or unfile it with null). Returns false for unknown run/folder. */
export function setAgentRunFolder(db: Database, id: number, folderId: number | null): boolean {
  if (!getAgentRun(db, id)) return false;
  if (folderId !== null && !getFolder(db, folderId)) return false;
  db.query("UPDATE agent_runs SET folder_id=? WHERE id=?").run(folderId, id);
  return true;
}

export interface AgentRunStats {
  pagesRead: number;
  sources: number;
  findings: number;
  followups: number;
}

/** Persist one emitted step by appending it to the run's steps_json. */
export function appendAgentStep(
  db: Database,
  id: number,
  step: { kind: string; label: string; detail?: string }
): void {
  const run = getAgentRun(db, id);
  if (!run) return;
  let steps: unknown[] = [];
  try {
    steps = run.steps_json ? (JSON.parse(run.steps_json) as unknown[]) : [];
  } catch {
    steps = [];
  }
  steps.push({ ...step, seq: steps.length, at: Date.now() });
  db.query("UPDATE agent_runs SET steps_json=? WHERE id=?").run(
    JSON.stringify(steps),
    id
  );
}

export function setAgentStatus(
  db: Database,
  id: number,
  status: string,
  opts: {
    plan?: unknown;
    graph?: unknown;
    reportMd?: string | null;
    error?: string | null;
    stats?: AgentRunStats | null;
  } = {}
): void {
  db.query(
    "UPDATE agent_runs SET status=?, plan_json=COALESCE(?, plan_json), graph_json=COALESCE(?, graph_json), report_md=COALESCE(?, report_md), error=?, pages_read=?, sources=?, findings=?, followups=? WHERE id=?"
  ).run(
    status,
    opts.plan !== undefined ? JSON.stringify(opts.plan) : null,
    opts.graph !== undefined ? JSON.stringify(opts.graph) : null,
    opts.reportMd !== undefined ? opts.reportMd : null,
    opts.error ?? null,
    opts.stats?.pagesRead ?? null,
    opts.stats?.sources ?? null,
    opts.stats?.findings ?? null,
    opts.stats?.followups ?? 0,
    id
  );
}

// ---- folders ----

export function createFolder(db: Database, name: string, parentId: number | null = null): Folder {
  if (parentId !== null && !getFolder(db, parentId))
    throw new Error("parent folder not found");
  return db
    .query("INSERT INTO folders (name, parent_id, created_at) VALUES (?,?,?) RETURNING *")
    .get(name, parentId, Date.now()) as Folder;
}

export function getFolder(db: Database, id: number): Folder | null {
  return (db.query("SELECT * FROM folders WHERE id=?").get(id) as Folder) ?? null;
}

/** Flat list with per-folder run counts; the UI builds the tree from parent_id. */
export function listFolders(db: Database): Folder[] {
  return db
    .query(
      `SELECT f.*, (SELECT COUNT(*) FROM agent_runs r WHERE r.folder_id = f.id) AS run_count
       FROM folders f ORDER BY f.created_at, f.id`
    )
    .all() as Folder[];
}

export function countUnfiledRuns(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE folder_id IS NULL").get() as { n: number }).n;
}

/** True if `ancestorId` is an ancestor of (or equal to) `id`. Used to reject cycles. */
export function isFolderDescendant(db: Database, id: number, ancestorId: number): boolean {
  let cur: number | null = id;
  while (cur !== null) {
    if (cur === ancestorId) return true;
    const f = getFolder(db, cur);
    cur = f ? f.parent_id : null;
  }
  return false;
}

/** Rename and/or re-parent. Re-parenting to a descendant (or self) is rejected. */
export function updateFolder(
  db: Database,
  id: number,
  patch: { name?: string; parent_id?: number | null }
): Folder | null {
  const cur = getFolder(db, id);
  if (!cur) return null;
  let parentId = cur.parent_id;
  if (patch.parent_id !== undefined) {
    parentId = patch.parent_id;
    if (parentId !== null) {
      if (!getFolder(db, parentId)) throw new Error("parent folder not found");
      if (isFolderDescendant(db, parentId, id))
        throw new Error("cannot move a folder into itself or one of its descendants");
    }
  }
  const name = patch.name !== undefined ? patch.name.trim() : cur.name;
  if (!name) throw new Error("folder name is required");
  return db
    .query("UPDATE folders SET name=?, parent_id=? WHERE id=? RETURNING *")
    .get(name, parentId, id) as Folder;
}

/**
 * Delete a folder. Its runs are unfiled (folder_id NULL), never deleted;
 * child folders are re-parented to the deleted folder's parent.
 */
export function deleteFolder(db: Database, id: number): boolean {
  const cur = getFolder(db, id);
  if (!cur) return false;
  db.query("UPDATE folders SET parent_id=? WHERE parent_id=?").run(cur.parent_id, id);
  db.query("UPDATE agent_runs SET folder_id=NULL WHERE folder_id=?").run(id);
  db.query("DELETE FROM folders WHERE id=?").run(id);
  return true;
}

// ---- journals ----

const ENTRY_KINDS: JournalEntryKind[] = ["finding", "source", "note"];

export function createJournal(db: Database, title: string): Journal {
  const now = Date.now();
  return db
    .query("INSERT INTO journals (title, created_at, updated_at) VALUES (?,?,?) RETURNING *")
    .get(title, now, now) as Journal;
}

export function getJournal(db: Database, id: number): Journal | null {
  return (db.query("SELECT * FROM journals WHERE id=?").get(id) as Journal) ?? null;
}

export function listJournals(db: Database): Journal[] {
  return db
    .query(
      `SELECT j.*, (SELECT COUNT(*) FROM journal_entries e WHERE e.journal_id = j.id) AS entry_count
       FROM journals j ORDER BY j.updated_at DESC, j.id DESC`
    )
    .all() as Journal[];
}

export function updateJournal(db: Database, id: number, title: string): Journal | null {
  const cur = getJournal(db, id);
  if (!cur) return null;
  const t = title.trim();
  if (!t) throw new Error("journal title is required");
  return db
    .query("UPDATE journals SET title=?, updated_at=? WHERE id=? RETURNING *")
    .get(t, Date.now(), id) as Journal;
}

export function deleteJournal(db: Database, id: number): boolean {
  db.query("DELETE FROM journal_entries WHERE journal_id=?").run(id);
  return db.query("DELETE FROM journals WHERE id=?").run(id).changes > 0;
}

export function touchJournal(db: Database, id: number): void {
  db.query("UPDATE journals SET updated_at=? WHERE id=?").run(Date.now(), id);
}

export function addJournalEntry(
  db: Database,
  journalId: number,
  e: { runId?: number | null; kind: JournalEntryKind; refText: string; note?: string }
): JournalEntry {
  const j = getJournal(db, journalId);
  if (!j) throw new Error("journal not found");
  if (!ENTRY_KINDS.includes(e.kind)) throw new Error("kind must be finding, source or note");
  if (!e.refText.trim()) throw new Error("entry text is required");
  if (e.runId != null && !getAgentRun(db, e.runId)) throw new Error("run not found");
  const pos = (db.query("SELECT COALESCE(MAX(position), -1) AS m FROM journal_entries WHERE journal_id=?").get(journalId) as { m: number }).m + 1;
  const row = db
    .query(
      "INSERT INTO journal_entries (journal_id, run_id, kind, ref_text, note, position) VALUES (?,?,?,?,?,?) RETURNING *"
    )
    .get(journalId, e.runId ?? null, e.kind, e.refText.trim(), (e.note ?? "").trim(), pos) as JournalEntry;
  touchJournal(db, journalId);
  return row;
}

export function listJournalEntries(db: Database, journalId: number): JournalEntry[] {
  return db
    .query(
      `SELECT e.*, r.question AS run_question
       FROM journal_entries e LEFT JOIN agent_runs r ON r.id = e.run_id
       WHERE e.journal_id=? ORDER BY e.position, e.id`
    )
    .all(journalId) as JournalEntry[];
}

export function getJournalEntry(db: Database, journalId: number, entryId: number): JournalEntry | null {
  return (
    (db.query("SELECT * FROM journal_entries WHERE id=? AND journal_id=?").get(entryId, journalId) as JournalEntry) ?? null
  );
}

export function updateJournalEntryNote(
  db: Database,
  journalId: number,
  entryId: number,
  note: string
): JournalEntry | null {
  const cur = getJournalEntry(db, journalId, entryId);
  if (!cur) return null;
  const row = db
    .query("UPDATE journal_entries SET note=? WHERE id=? RETURNING *")
    .get(note.trim(), entryId) as JournalEntry;
  touchJournal(db, journalId);
  return row;
}

export function deleteJournalEntry(db: Database, journalId: number, entryId: number): boolean {
  const ok = db.query("DELETE FROM journal_entries WHERE id=? AND journal_id=?").run(entryId, journalId).changes > 0;
  if (ok) touchJournal(db, journalId);
  return ok;
}

/** Reorder entries; ids must be exactly the journal's current entry set. */
export function reorderJournalEntries(db: Database, journalId: number, ids: number[]): boolean {
  const cur = listJournalEntries(db, journalId).map((e) => e.id);
  if (cur.length !== ids.length || !ids.every((id) => cur.includes(id))) return false;
  if (new Set(ids).size !== ids.length) return false;
  const stmt = db.query("UPDATE journal_entries SET position=? WHERE id=? AND journal_id=?");
  ids.forEach((id, i) => stmt.run(i, id, journalId));
  touchJournal(db, journalId);
  return true;
}

function entryCitation(e: JournalEntry): string {
  if (e.run_id == null) return "no run";
  const q = e.run_question ? ` "${e.run_question}"` : "";
  return `run #${e.run_id}${q}`;
}

/** Compile a journal into markdown, each entry cited back to its run. */
export function journalExportMd(db: Database, journalId: number): string | null {
  const j = getJournal(db, journalId);
  if (!j) return null;
  const entries = listJournalEntries(db, journalId);
  const lines: string[] = [
    `# ${j.title}`,
    "",
    `_Compiled from Longview agent runs · exported ${new Date().toISOString().slice(0, 10)}_`,
    "",
  ];
  if (entries.length === 0) {
    lines.push("_No entries yet._", "");
  }
  for (const e of entries) {
    const head = e.kind === "note" ? "Note" : e.kind === "finding" ? "Finding" : "Source";
    lines.push(`## ${head} — ${entryCitation(e)}`, "");
    lines.push(e.ref_text, "");
    if (e.note) lines.push(`> ${e.note}`, "");
  }
  return lines.join("\n");
}
