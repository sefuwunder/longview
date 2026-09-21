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
  createResearchRun,
  getResearchRun,
  listResearchRuns,
  setRunStatus,
  insertResearchSources,
  listResearchSources,
  type Topic,
} from "./db";
import { crawlTopic, startScheduler } from "./scheduler";
import { runResearchPipeline } from "./research";

const PORT = Number(process.env.PORT ?? 3011);
const PUBLIC = join(import.meta.dir, "..", "public");

const db: Database = openDb();

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
    status: t.status,
    last_error: t.last_error,
    last_crawl_at: t.last_crawl_at,
    created_at: t.created_at,
    new_count: topicNewCount(db, t.id),
  };
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
    if (method === "GET" && (p === "/styles.css" || p === "/app.js"))
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
      const t = createTopic(db, { name, query, schedule });
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
        const patch: { name?: string; query?: string; schedule?: string } = {};
        if (b.name !== undefined) patch.name = String(b.name).trim();
        if (b.query !== undefined) patch.query = String(b.query).trim();
        if (b.schedule !== undefined) {
          if (!["daily", "weekly", "manual"].includes(String(b.schedule)))
            return json({ ok: false, error: "schedule must be daily, weekly or manual" }, 400);
          patch.schedule = String(b.schedule);
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
        return json({ ok: true, added: r.added, total: r.total, topic: topicShape(db, t) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ ok: false, error: msg }, 502);
      }
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
          const { report, sources } = await runResearchPipeline(question);
          insertResearchSources(db, run.id, sources);
          setRunStatus(db, run.id, "done", report);
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
process.on("SIGINT", () => stopScheduler());
process.on("SIGTERM", () => stopScheduler());

console.log(`[longview] listening on http://127.0.0.1:${server.port}`);
