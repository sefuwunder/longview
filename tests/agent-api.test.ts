// End-to-end agent API tests. Spawns the real server with a stub DDG
// endpoint and stub content pages, so no live network is ever touched.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE_PORT = 32181;
const DDG_PORT = 32182;
const APP_PORT = 32183;
const APP = `http://127.0.0.1:${APP_PORT}`;

const ARTICLE = (title: string, body: string) =>
  `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;

function ddgHtml(results: { t: string; u: string; s: string }[]): string {
  const res = (t: string, u: string, s: string) =>
    `<div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">` +
    `<h2 class="result__title"><a rel="nofollow" class="result__a" href="${u}">${t}</a></h2>` +
    `<div class="result__snippet">${s}</div></div></div>`;
  return (
    `<html><body><div id="links" class="results">` +
    results.map((r) => res(r.t, r.u, r.s)).join("") +
    `</div></body></html>`
  );
}

const results = () => [
  { t: "Tidal energy basics", u: `http://127.0.0.1:${PAGE_PORT}/t1.html`, s: "Tidal basics." },
  { t: "Tidal power guide", u: `http://127.0.0.1:${PAGE_PORT}/t2.html`, s: "Tidal guide." },
];

const T1 =
  "Tidal energy basics begin with the predictable rise and fall of ocean tides every single day. " +
  "Tidal stream turbines generate electricity from the kinetic energy of moving tidal water currents. " +
  "Engineers anchor tidal energy devices to the seabed in narrow channels where tidal currents run strong.";

const T2 =
  "The basic principle of tidal power plants is simple and has been understood for many decades now. " +
  "Tidal barrages hold back water at high tide and release it through turbines at low tide daily. " +
  "Modern tidal energy research focuses on reducing the cost of tidal stream turbine installations.";

let appProc: Bun.Subprocess | null = null;
let stops: (() => void)[] = [];

async function waitFor(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error("server never came up: " + url);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitAgentDone(id: number, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    const r = await fetch(`${APP}/api/agent/${id}`);
    const d = await r.json();
    if (d.run.status === "done" || d.run.status === "error") return d.run;
    if (Date.now() - start > timeoutMs) throw new Error("agent run never finished");
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  const pages = Bun.serve({
    port: PAGE_PORT,
    fetch(req) {
      const p = new URL(req.url).pathname;
      const ct = { headers: { "Content-Type": "text/html" } };
      if (p === "/t1.html") return new Response(ARTICLE("Tidal energy basics", T1), ct);
      if (p === "/t2.html") return new Response(ARTICLE("Tidal power guide", T2), ct);
      return new Response("nf", { status: 404 });
    },
  });
  const ddg = Bun.serve({
    port: DDG_PORT,
    async fetch(req) {
      if (req.method === "POST") {
        await req.text();
        return new Response(ddgHtml(results()), {
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("nf", { status: 404 });
    },
  });
  const dataDir = mkdtempSync(join(tmpdir(), "lv-agent-api-"));
  const app = Bun.spawn(["bun", join(import.meta.dir, "../src/server.ts")], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      LONGVIEW_DATA: dataDir,
      DDG_BASE_URL: `http://127.0.0.1:${DDG_PORT}/`,
      DDG_NO_DELAY: "1",
      DEEP_NO_DELAY: "1",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  appProc = app;
  stops = [() => pages.stop(), () => ddg.stop()];
  await waitFor(`${APP}/api/topics`);
});

afterAll(() => {
  if (appProc) appProc.kill();
  for (const s of stops) s();
});

describe("agent API", () => {
  test("POST /api/agent starts a run; poll shows live steps, then done with graph + report", async () => {
    const pr = await fetch(`${APP}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "tidal energy basics" }),
    });
    expect(pr.status).toBe(202);
    const { run_id } = await pr.json();
    expect(typeof run_id).toBe("number");

    // a mid-run poll shows steps accumulating before completion
    const mid = await (await fetch(`${APP}/api/agent/${run_id}`)).json();
    expect(["pending", "working", "done"]).toContain(mid.run.status);
    expect(Array.isArray(mid.run.steps)).toBe(true);

    const run = await waitAgentDone(run_id);
    expect(run.status).toBe("done");
    expect(run.error).toBeNull();

    const kinds = run.steps.map((s: { kind: string }) => s.kind);
    expect(kinds[0]).toBe("plan");
    for (const k of ["search", "read", "reflect", "synthesize", "done"])
      expect(kinds).toContain(k);

    // the agent graph: question → subqs → sources → findings
    const gkinds = run.graph.nodes.map((n: { kind: string }) => n.kind);
    expect(gkinds).toContain("question");
    expect(gkinds).toContain("subq");
    expect(gkinds).toContain("source");
    expect(gkinds).toContain("finding");
    expect(run.graph.edges.length).toBeGreaterThan(0);

    expect(run.pages_read).toBeGreaterThan(0);
    expect(run.sources).toBeGreaterThan(0);
    expect(run.findings).toBeGreaterThan(0);
    expect(run.report_md).toContain("# tidal energy basics");

    // markdown export
    const er = await fetch(`${APP}/api/agent/${run_id}/export.md`);
    expect(er.status).toBe(200);
    expect(er.headers.get("content-type")).toContain("text/markdown");
    const md = await er.text();
    expect(md).toContain("# tidal energy basics");
  });

  test("history lists agent runs", async () => {
    const d = await (await fetch(`${APP}/api/agent`)).json();
    expect(d.ok).toBe(true);
    expect(d.runs.length).toBeGreaterThan(0);
    expect(d.runs[0].question).toBe("tidal energy basics");
  });

  test("validation and 404s", async () => {
    const bad = await fetch(`${APP}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "   " }),
    });
    expect(bad.status).toBe(400);
    const nf = await fetch(`${APP}/api/agent/999999`);
    expect(nf.status).toBe(404);
    const ne = await fetch(`${APP}/api/agent/999999/export.md`);
    expect(ne.status).toBe(404);
  });

  test("settings expose the parallel backend and key status", async () => {
    const d = await (await fetch(`${APP}/api/settings`)).json();
    expect(d.ok).toBe(true);
    expect(typeof d.settings.parallel_key_configured).toBe("boolean");
    const p = await (
      await fetch(`${APP}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "parallel" }),
      })
    ).json();
    expect(p.ok).toBe(true);
    expect(p.settings.backend).toBe("parallel");
    const bad = await fetch(`${APP}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "nope" }),
    });
    expect(bad.status).toBe(400);
    // restore ddg so later suites see the default
    await fetch(`${APP}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "ddg" }),
    });
  });

  test("static asset /agent-canvas.js is served", async () => {
    const r = await fetch(`${APP}/agent-canvas.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    const js = await r.text();
    expect(js).toContain("LVAgentCanvas");
  });
});
