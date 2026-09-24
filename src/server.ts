// longview server — Bun + zero npm deps + built-in SQLite.
// Research-desk dashboard for watched DuckDuckGo topics + on-demand deep research.

import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  openDb,
  listTopics,
  getTopic,
  createTopic,
  updateTopic,
  deleteTopic,
  listFindings,
  markFindingRead,
  topicNewCount,
  setSetting,
  createResearchRun,
  getResearchRun,
  listResearchRuns,
  setRunStatus,
  insertResearchSources,
  listResearchSources,
  createAgentRun,
  getAgentRun,
  listAgentRuns,
  appendAgentStep,
  setAgentStatus,
  setAgentRunFolder,
  createFolder,
  getFolder,
  listFolders,
  countUnfiledRuns,
  updateFolder,
  deleteFolder,
  createJournal,
  getJournal,
  listJournals,
  updateJournal,
  deleteJournal,
  addJournalEntry,
  listJournalEntries,
  updateJournalEntryNote,
  deleteJournalEntry,
  reorderJournalEntries,
  journalExportMd,
  type Topic,
} from "./db";
import { crawlTopic, startScheduler } from "./scheduler";
import {
  initSearch,
  resolveBackend,
  diagnoseSearch,
} from "./search";
import { exaKeyConfigured } from "./backends/exa";
import { parallelKeyConfigured } from "./backends/parallel";
import { runResearchPipeline } from "./research";
import { runAgent } from "./agent";
import { clusterResults } from "./cluster";

const PORT = Number(process.env.PORT ?? 3011);
const PUBLIC = join(import.meta.dir, "..", "public");

const db: Database = openDb();
// Bind the DB for backend resolution (SEARCH_BACKEND env > persisted setting).
initSearch(db);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function topicShape(db: Database, t: Topic) {
  return {
    id: t.id,
    name: t.name,
    query: t.query,
    schedule: t.schedule,
    depth: t.depth ?? 3,
    status: t.status,
    last_error: t.last_error,
    last_error_class: t.last_error_class,
    last_crawl_at: t.last_crawl_at,
    created_at: t.created_at,
    new_count: topicNewCount(db, t.id),
  };
}

/** depth must be an integer 1-10 when supplied. */
function parseDepth(b: Record<string, unknown>): { depth?: number; error?: string } {
  if (b.depth === undefined || b.depth === null || b.depth === "") return {};
  const n = typeof b.depth === "number" ? b.depth : Number(b.depth);
  if (!Number.isInteger(n) || n < 1 || n > 10)
    return { error: "depth must be an integer from 1 to 10" };
  return { depth: n };
}

function serveStatic(path: string): Response | null {
  const file = join(PUBLIC, path);
  if (!existsSync(file)) return null;
  const ext = file.split(".").pop() ?? "";
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    svg: "image/svg+xml",
    ico: "image/x-icon",
  };
  return new Response(readFileSync(file), {
    headers: { "Content-Type": types[ext] ?? "application/octet-stream" },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;

    // ---- static ----
    if (method === "GET" && (p === "/" || p === "/index.html"))
      return serveStatic("index.html")!;
    if (method === "GET" && (p === "/styles.css" || p === "/app.js" || p === "/canvas.js" || p === "/agent-canvas.js"))
      return serveStatic(p.slice(1))!;

    // ---- topics ----
    if (p === "/api/topics" && method === "GET")
      return json({ ok: true, topics: listTopics(db).map((t) => topicShape(db, t)) });

    if (p === "/api/topics" && method === "POST") {
      const b = await body(req);
      const name = String(b.name ?? "").trim();
      const query = String(b.query ?? "").trim();
      const schedule = String(b.schedule ?? "daily");
      if (!name || !query)
        return json({ ok: false, error: "name and query are required" }, 400);
      if (!["daily", "weekly", "manual"].includes(schedule))
        return json({ ok: false, error: "schedule must be daily, weekly or manual" }, 400);
      const { depth, error: depthError } = parseDepth(b);
      if (depthError) return json({ ok: false, error: depthError }, 400);
      const t = createTopic(db, { name, query, schedule, depth });
      return json({ ok: true, topic: topicShape(db, t) }, 201);
    }

    let m = p.match(/^\/api\/topics\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === "GET") {
        const t = getTopic(db, id);
        return t ? json({ ok: true, topic: topicShape(db, t) }) : json({ ok: false, error: "not found" }, 404);
      }
      if (method === "PATCH") {
        const b = await body(req);
        const patch: { name?: string; query?: string; schedule?: string; depth?: number } = {};
        if (b.name !== undefined) patch.name = String(b.name).trim();
        if (b.query !== undefined) patch.query = String(b.query).trim();
        if (b.schedule !== undefined) {
          if (!["daily", "weekly", "manual"].includes(String(b.schedule)))
            return json({ ok: false, error: "schedule must be daily, weekly or manual" }, 400);
          patch.schedule = String(b.schedule);
        }
        if (b.depth !== undefined) {
          const { depth, error: depthError } = parseDepth(b);
          if (depthError) return json({ ok: false, error: depthError }, 400);
          if (depth !== undefined) patch.depth = depth;
        }
        const t = updateTopic(db, id, patch);
        return t ? json({ ok: true, topic: topicShape(db, t) }) : json({ ok: false, error: "not found" }, 404);
      }
      if (method === "DELETE") {
        const ok = deleteTopic(db, id);
        return ok ? json({ ok: true }) : json({ ok: false, error: "not found" }, 404);
      }
    }

    m = p.match(/^\/api\/topics\/(\d+)\/crawl$/);
    if (m && method === "POST") {
      const id = Number(m[1]);
      if (!getTopic(db, id)) return json({ ok: false, error: "not found" }, 404);
      try {
        const r = await crawlTopic(db, id);
        const t = getTopic(db, id)!;
        return json({ ok: true, added: r.added, total: r.total, discovered: r.discovered, topic: topicShape(db, t) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const t = getTopic(db, id);
        return json(
          { ok: false, error: msg, error_class: t?.last_error_class ?? null },
          502
        );
      }
    }

    // ---- crawl diagnostics ----
    // Probes the ACTIVE search backend so a user can see exactly what works
    // from their network. Same localhost trust model as the rest of the app.
    if (p === "/api/diag/crawl" && method === "GET") {
      const q = String(url.searchParams.get("q") ?? "").trim();
      if (!q) return json({ ok: false, error: "q query param is required" }, 400);
      const d = await diagnoseSearch(db, q);
      return json({ ok: true, ...d });
    }

    // ---- settings ----
    // Which search backend is active (ddg | exa | parallel) and whether the
    // Exa / Parallel keys are configured. Keys themselves are never returned.
    if (p === "/api/settings" && method === "GET") {
      const { name, source } = resolveBackend(db);
      return json({
        ok: true,
        settings: {
          backend: name,
          backend_source: source,
          exa_key_configured: exaKeyConfigured(),
          parallel_key_configured: parallelKeyConfigured(),
        },
      });
    }

    if (p === "/api/settings" && method === "PATCH") {
      const b = await body(req);
      if (b.backend !== undefined) {
        const v = String(b.backend).trim().toLowerCase();
        if (v !== "ddg" && v !== "exa" && v !== "parallel")
          return json({ ok: false, error: "backend must be 'ddg', 'exa' or 'parallel'" }, 400);
        setSetting(db, "backend", v);
      }
      const { name, source } = resolveBackend(db);
      return json({
        ok: true,
        settings: {
          backend: name,
          backend_source: source,
          exa_key_configured: exaKeyConfigured(),
          parallel_key_configured: parallelKeyConfigured(),
        },
      });
    }

    m = p.match(/^\/api\/topics\/(\d+)\/findings$/);
    if (m && method === "GET") {
      const id = Number(m[1]);
      if (!getTopic(db, id)) return json({ ok: false, error: "not found" }, 404);
      return json({ ok: true, findings: listFindings(db, id) });
    }

    m = p.match(/^\/api\/findings\/(\d+)\/read$/);
    if (m && method === "POST") {
      const ok = markFindingRead(db, Number(m[1]));
      return ok ? json({ ok: true }) : json({ ok: false, error: "not found" }, 404);
    }

    // Clustered findings for the canvas view. Computed on demand from the
    // same findings store the list view uses — no persistence needed, the
    // classifier is deterministic so repeated calls return identical output.
    m = p.match(/^\/api\/topics\/(\d+)\/clusters$/);
    if (m && method === "GET") {
      const id = Number(m[1]);
      if (!getTopic(db, id)) return json({ ok: false, error: "not found" }, 404);
      const findings = listFindings(db, id);
      const byId = new Map(findings.map((f) => [f.id, f]));
      const clusters = clusterResults(
        findings.map((f) => ({ id: f.id, title: f.title, snippet: f.snippet, url: f.url }))
      );
      return json({
        ok: true,
        clusters: clusters.map((c) => ({
          label: c.label,
          results: c.ids.map((rid) => {
            const f = byId.get(rid)!;
            return {
              id: f.id,
              url: f.url,
              title: f.title,
              snippet: f.snippet,
              read: f.is_new === 0,
              depth: f.depth,
            };
          }),
        })),
      });
    }

    // ---- deep research ----
    if (p === "/api/research" && method === "GET")
      return json({ ok: true, runs: listResearchRuns(db) });

    if (p === "/api/research" && method === "POST") {
      const b = await body(req);
      const question = String(b.question ?? "").trim();
      if (!question) return json({ ok: false, error: "question is required" }, 400);
      const run = createResearchRun(db, question);
      // async: client polls
      void (async () => {
        setRunStatus(db, run.id, "working");
        try {
          const { report, sources, stats } = await runResearchPipeline(question);
          insertResearchSources(db, run.id, sources);
          setRunStatus(db, run.id, "done", report, null, {
            pagesCrawled: stats.pagesCrawled,
            maxDepth: stats.maxDepthReached,
            capped: stats.capped,
            discovered: stats.discovered,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setRunStatus(db, run.id, "error", null, msg);
        }
      })();
      return json({ ok: true, run_id: run.id }, 202);
    }

    m = p.match(/^\/api\/research\/(\d+)$/);
    if (m && method === "GET") {
      const run = getResearchRun(db, Number(m[1]));
      if (!run) return json({ ok: false, error: "not found" }, 404);
      return json({
        ok: true,
        run: {
          id: run.id,
          question: run.question,
          status: run.status,
          report_md: run.report_md,
          error: run.error,
          created_at: run.created_at,
          pages_crawled: run.pages_crawled,
          max_depth_reached: run.max_depth,
          capped: (run.capped ?? 0) === 1,
          discovered: run.discovered ?? 0,
          sources: listResearchSources(db, run.id),
        },
      });
    }

    m = p.match(/^\/api\/research\/(\d+)\/export\.md$/);
    if (m && method === "GET") {
      const run = getResearchRun(db, Number(m[1]));
      if (!run) return json({ ok: false, error: "not found" }, 404);
      if (run.status !== "done" || !run.report_md)
        return json({ ok: false, error: "report not ready" }, 409);
      return new Response(run.report_md, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="longview-${run.id}.md"`,
        },
      });
    }

    // ---- research agent ----
    // The agent plans a question into lines of inquiry, searches, reads,
    // reflects on coverage, and synthesizes findings + a graph of its work.
    // Steps are appended to the run row as they happen; clients poll.
    if (p === "/api/agent" && method === "GET")
      return json({ ok: true, runs: listAgentRuns(db) });

    if (p === "/api/agent" && method === "POST") {
      const b = await body(req);
      const question = String(b.question ?? "").trim();
      if (!question) return json({ ok: false, error: "question is required" }, 400);
      // Optional filing: a folder for the new run, and a parent run for
      // chat-driven follow-ups. Both are validated; unknown ids → 400.
      let folderId: number | null = null;
      if (b.folder_id !== undefined && b.folder_id !== null) {
        const n = Number(b.folder_id);
        if (!Number.isInteger(n) || !getFolder(db, n))
          return json({ ok: false, error: "unknown folder_id" }, 400);
        folderId = n;
      }
      let parentRunId: number | null = null;
      if (b.parent_run_id !== undefined && b.parent_run_id !== null) {
        const n = Number(b.parent_run_id);
        if (!Number.isInteger(n) || !getAgentRun(db, n))
          return json({ ok: false, error: "unknown parent_run_id" }, 400);
        parentRunId = n;
      }
      const run = createAgentRun(db, question, { folderId, parentRunId });
      // async: client polls; each agent step is persisted as it fires.
      void (async () => {
        setAgentStatus(db, run.id, "working");
        try {
          const result = await runAgent(question, {
            onStep: (s) => appendAgentStep(db, run.id, s),
          });
          setAgentStatus(db, run.id, "done", {
            plan: result.plan,
            graph: result.graph,
            reportMd: result.report,
            stats: result.stats,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          appendAgentStep(db, run.id, { kind: "error", label: msg });
          setAgentStatus(db, run.id, "error", { error: msg });
        }
      })();
      return json({ ok: true, run_id: run.id }, 202);
    }

    m = p.match(/^\/api\/agent\/(\d+)$/);
    if (m && method === "GET") {
      const run = getAgentRun(db, Number(m[1]));
      if (!run) return json({ ok: false, error: "not found" }, 404);
      let steps: unknown[] = [];
      let plan: unknown = null;
      let graph: unknown = null;
      try {
        steps = run.steps_json ? JSON.parse(run.steps_json) : [];
        plan = run.plan_json ? JSON.parse(run.plan_json) : null;
        graph = run.graph_json ? JSON.parse(run.graph_json) : null;
      } catch {
        // corrupted JSON — serve what we can
      }
      return json({
        ok: true,
        run: {
          id: run.id,
          question: run.question,
          status: run.status,
          steps,
          plan,
          graph,
          report_md: run.report_md,
          error: run.error,
          created_at: run.created_at,
          pages_read: run.pages_read,
          sources: run.sources,
          findings: run.findings,
          followups: run.followups,
          folder_id: run.folder_id ?? null,
          parent_run_id: run.parent_run_id ?? null,
        },
      });
    }

    // Move a run between folders. Unknown folder → 400; unknown run → 404.
    if (m && method === "PATCH") {
      const b = await body(req);
      if (b.folder_id === undefined)
        return json({ ok: false, error: "folder_id is required (null to unfile)" }, 400);
      let folderId: number | null = null;
      if (b.folder_id !== null) {
        const n = Number(b.folder_id);
        if (!Number.isInteger(n) || !getFolder(db, n))
          return json({ ok: false, error: "unknown folder_id" }, 400);
        folderId = n;
      }
      const ok = setAgentRunFolder(db, Number(m[1]), folderId);
      return ok
        ? json({ ok: true, run_id: Number(m[1]), folder_id: folderId })
        : json({ ok: false, error: "not found" }, 404);
    }

    m = p.match(/^\/api\/agent\/(\d+)\/export\.md$/);
    if (m && method === "GET") {
      const run = getAgentRun(db, Number(m[1]));
      if (!run) return json({ ok: false, error: "not found" }, 404);
      if (run.status !== "done" || !run.report_md)
        return json({ ok: false, error: "report not ready" }, 409);
      return new Response(run.report_md, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="longview-agent-${run.id}.md"`,
        },
      });
    }

    // ---- folders ----
    // Organize agent runs into a nestable tree. Deleting a folder unfiles
    // its runs (folder_id NULL) and re-parents its children — runs are
    // never deleted by folder operations.
    if (p === "/api/folders" && method === "GET") {
      return json({
        ok: true,
        folders: listFolders(db).map((f) => ({
          id: f.id,
          name: f.name,
          parent_id: f.parent_id,
          created_at: f.created_at,
          run_count: f.run_count ?? 0,
        })),
        unfiled_count: countUnfiledRuns(db),
      });
    }

    if (p === "/api/folders" && method === "POST") {
      const b = await body(req);
      const name = String(b.name ?? "").trim();
      if (!name) return json({ ok: false, error: "name is required" }, 400);
      let parentId: number | null = null;
      if (b.parent_id !== undefined && b.parent_id !== null) {
        const n = Number(b.parent_id);
        if (!Number.isInteger(n))
          return json({ ok: false, error: "unknown parent_id" }, 400);
        parentId = n;
      }
      try {
        const f = createFolder(db, name, parentId);
        return json({ ok: true, folder: { id: f.id, name: f.name, parent_id: f.parent_id, created_at: f.created_at, run_count: 0 } }, 201);
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : "invalid folder" }, 400);
      }
    }

    m = p.match(/^\/api\/folders\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === "PATCH") {
        const b = await body(req);
        const patch: { name?: string; parent_id?: number | null } = {};
        if (b.name !== undefined) patch.name = String(b.name);
        if (b.parent_id !== undefined) {
          if (b.parent_id === null) patch.parent_id = null;
          else {
            const n = Number(b.parent_id);
            if (!Number.isInteger(n))
              return json({ ok: false, error: "unknown parent_id" }, 400);
            patch.parent_id = n;
          }
        }
        try {
          const f = updateFolder(db, id, patch);
          return f
            ? json({ ok: true, folder: { id: f.id, name: f.name, parent_id: f.parent_id, created_at: f.created_at } })
            : json({ ok: false, error: "not found" }, 404);
        } catch (e) {
          return json({ ok: false, error: e instanceof Error ? e.message : "invalid folder" }, 400);
        }
      }
      if (method === "DELETE") {
        const ok = deleteFolder(db, id);
        return ok ? json({ ok: true }) : json({ ok: false, error: "not found" }, 404);
      }
    }

    // ---- journals ----
    // Compile data points (findings, sources, freeform notes) from agent
    // runs into editable, reorderable journals with markdown export.
    if (p === "/api/journals" && method === "GET") {
      return json({
        ok: true,
        journals: listJournals(db).map((j) => ({
          id: j.id,
          title: j.title,
          created_at: j.created_at,
          updated_at: j.updated_at,
          entry_count: j.entry_count ?? 0,
        })),
      });
    }

    if (p === "/api/journals" && method === "POST") {
      const b = await body(req);
      const title = String(b.title ?? "").trim();
      if (!title) return json({ ok: false, error: "title is required" }, 400);
      const j = createJournal(db, title);
      return json({ ok: true, journal: { id: j.id, title: j.title, created_at: j.created_at, updated_at: j.updated_at, entry_count: 0 } }, 201);
    }

    const journalShape = (id: number) => {
      const j = getJournal(db, id);
      if (!j) return null;
      return {
        id: j.id,
        title: j.title,
        created_at: j.created_at,
        updated_at: j.updated_at,
        entries: listJournalEntries(db, id).map((e) => ({
          id: e.id,
          run_id: e.run_id,
          run_question: e.run_question ?? null,
          kind: e.kind,
          ref_text: e.ref_text,
          note: e.note,
          position: e.position,
        })),
      };
    };

    m = p.match(/^\/api\/journals\/(\d+)\/export\.md$/);
    if (m && method === "GET") {
      const md = journalExportMd(db, Number(m[1]));
      if (md === null) return json({ ok: false, error: "not found" }, 404);
      return new Response(md, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="longview-journal-${m[1]}.md"`,
        },
      });
    }

    m = p.match(/^\/api\/journals\/(\d+)\/entries\/reorder$/);
    if (m && method === "POST") {
      const b = await body(req);
      const ids = b.entry_ids;
      if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(Number(n))))
        return json({ ok: false, error: "entry_ids must be an array of entry ids" }, 400);
      const j = getJournal(db, Number(m[1]));
      if (!j) return json({ ok: false, error: "not found" }, 404);
      const ok = reorderJournalEntries(db, j.id, ids.map(Number));
      return ok ? json({ ok: true, journal: journalShape(j.id) }) : json({ ok: false, error: "entry_ids must match the journal's entries exactly" }, 400);
    }

    m = p.match(/^\/api\/journals\/(\d+)\/entries\/(\d+)$/);
    if (m) {
      const jid = Number(m[1]);
      const eid = Number(m[2]);
      if (method === "PATCH") {
        const b = await body(req);
        const e = updateJournalEntryNote(db, jid, eid, String(b.note ?? ""));
        return e ? json({ ok: true, journal: journalShape(jid) }) : json({ ok: false, error: "not found" }, 404);
      }
      if (method === "DELETE") {
        if (!getJournal(db, jid)) return json({ ok: false, error: "not found" }, 404);
        const ok = deleteJournalEntry(db, jid, eid);
        return ok ? json({ ok: true, journal: journalShape(jid) }) : json({ ok: false, error: "not found" }, 404);
      }
    }

    m = p.match(/^\/api\/journals\/(\d+)\/entries$/);
    if (m && method === "POST") {
      const jid = Number(m[1]);
      const b = await body(req);
      try {
        addJournalEntry(db, jid, {
          runId: b.run_id === undefined || b.run_id === null ? null : Number(b.run_id),
          kind: b.kind as "finding" | "source" | "note",
          refText: String(b.ref_text ?? ""),
          note: String(b.note ?? ""),
        });
        return json({ ok: true, journal: journalShape(jid) }, 201);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "invalid entry";
        const status = msg === "journal not found" || msg === "run not found" ? 404 : 400;
        return json({ ok: false, error: msg }, status);
      }
    }

    m = p.match(/^\/api\/journals\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === "GET") {
        const j = journalShape(id);
        return j ? json({ ok: true, journal: j }) : json({ ok: false, error: "not found" }, 404);
      }
      if (method === "PATCH") {
        const b = await body(req);
        try {
          const j = updateJournal(db, id, String(b.title ?? ""));
          return j ? json({ ok: true, journal: journalShape(j.id) }) : json({ ok: false, error: "not found" }, 404);
        } catch (e) {
          return json({ ok: false, error: e instanceof Error ? e.message : "invalid title" }, 400);
        }
      }
      if (method === "DELETE") {
        const ok = deleteJournal(db, id);
        return ok ? json({ ok: true }) : json({ ok: false, error: "not found" }, 404);
      }
    }

    return json({ ok: false, error: "not found" }, 404);
  },
});

const stopScheduler = startScheduler(db);

/**
 * Graceful shutdown. Registering SIGINT/SIGTERM listeners replaces the
 * runtime's default terminate behavior, so we must exit explicitly —
 * stopping the scheduler alone leaves the HTTP server keeping the event
 * loop alive (Ctrl-C appeared to do nothing). A second signal forces an
 * immediate exit in case shutdown hangs (e.g. a crawl in flight).
 */
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    console.log(`[longview] ${signal} again — forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`[longview] ${signal} received — shutting down`);
  stopScheduler();
  server.stop();
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`[longview] listening on http://127.0.0.1:${server.port}`);
