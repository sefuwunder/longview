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
  type Topic,
} from "./db";
import { crawlTopic, startScheduler } from "./scheduler";
import {
  initSearch,
  resolveBackend,
  diagnoseSearch,
} from "./search";
import { exaKeyConfigured } from "./backends/exa";
import { runResearchPipeline } from "./research";
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
    if (method === "GET" && (p === "/styles.css" || p === "/app.js" || p === "/canvas.js"))
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
    // Which search backend is active (ddg | exa) and whether the Exa key is
    // configured. The key itself is never returned.
    if (p === "/api/settings" && method === "GET") {
      const { name, source } = resolveBackend(db);
      return json({
        ok: true,
        settings: {
          backend: name,
          backend_source: source,
          exa_key_configured: exaKeyConfigured(),
        },
      });
    }

    if (p === "/api/settings" && method === "PATCH") {
      const b = await body(req);
      if (b.backend !== undefined) {
        const v = String(b.backend).trim().toLowerCase();
        if (v !== "ddg" && v !== "exa")
          return json({ ok: false, error: "backend must be 'ddg' or 'exa'" }, 400);
        setSetting(db, "backend", v);
      }
      const { name, source } = resolveBackend(db);
      return json({
        ok: true,
        settings: {
          backend: name,
          backend_source: source,
          exa_key_configured: exaKeyConfigured(),
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
