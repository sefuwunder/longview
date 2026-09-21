// End-to-end API tests. Spawns the real server with a stub DDG endpoint
// and stub content pages, so no live network is ever touched.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE_PORT = 32171;
const DDG_PORT = 32172;
const APP_PORT = 32173;
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

const tidalResults = () => [
  { t: "Tidal energy basics", u: `http://127.0.0.1:${PAGE_PORT}/p1.html`, s: "How tidal stream turbines work." },
  { t: "Tidal power guide", u: `http://127.0.0.1:${PAGE_PORT}/p2.html`, s: "A guide to tidal power generation." },
];

const deepResults = () => [
  { t: "Tidal hub", u: `http://127.0.0.1:${PAGE_PORT}/hub.html`, s: "A hub of tidal links." },
];

/** Every path the stub page server was asked for (assert pruning). */
let pageHits: string[] = [];

const LINKED = (title: string, links: string, body: string) =>
  `<html><head><title>${title}</title></head><body>${links}<p>${body}</p></body></html>`;
const LK = (href: string, text: string) => `<a href="${href}">${text}</a>`;

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

async function waitRunDone(id: number, timeoutMs = 25000) {
  const start = Date.now();
  for (;;) {
    const r = await fetch(`${APP}/api/research/${id}`);
    const d = await r.json();
    if (d.run.status === "done" || d.run.status === "error") return d.run;
    if (Date.now() - start > timeoutMs) throw new Error("research run never finished");
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  const pages = Bun.serve({
    port: PAGE_PORT,
    fetch(req) {
      const p = new URL(req.url).pathname;
      pageHits.push(p);
      const ct = { headers: { "Content-Type": "text/html" } };
      if (p === "/p1.html")
        return new Response(
          ARTICLE(
            "Tidal energy basics",
            "Tidal stream turbines generate electricity from the kinetic energy of moving water. " +
              "Tidal power is predictable because tides follow the gravitational pull of the moon. " +
              "Engineers anchor the turbines to the seabed in narrow channels where currents run strong."
          ),
          ct
        );
      if (p === "/p2.html")
        return new Response(
          ARTICLE(
            "Tidal power guide",
            "Tidal barrages hold back water at high tide and release it through turbines at low tide. " +
              "Tidal power plants must withstand harsh marine conditions and corrosive salt water. " +
              "The largest tidal barrage in operation sits on the Rance estuary in France."
          ),
          ct
        );
      // Linked graph for the deep-crawl end-to-end test.
      if (p === "/hub.html")
        return new Response(
          LINKED(
            "Tidal hub",
            LK("/d1.html", "tidal turbine research") +
              LK("/d2.html", "tidal energy news") +
              LK("/offtopic.html", "best pizza recipes") +
              LK("/d1.html?utm_source=x", "tidal turbine research") +
              LK("/hub.html", "back to hub"),
            "A hub page collecting tidal energy links for testing the deep crawler."
          ),
          ct
        );
      if (p === "/d1.html")
        return new Response(
          LINKED(
            "Tidal d1",
            LK("/d3.html", "tidal power advances") + LK("/hub.html", "hub home"),
            "Deep page one about tidal turbine research and rotor design advances."
          ),
          ct
        );
      if (p === "/d2.html")
        return new Response(
          LINKED("Tidal d2", "", "Deep page two with tidal energy news and nothing else."),
          ct
        );
      if (p === "/d3.html")
        return new Response(
          LINKED(
            "Tidal d3",
            LK("/d4.html", "tidal stream data"),
            "Deep page three covering tidal power advances in recent deployments."
          ),
          ct
        );
      if (p === "/d4.html")
        return new Response(
          LINKED("Tidal d4", "", "Deep page four with tidal stream data tables."),
          ct
        );
      if (p === "/offtopic.html")
        return new Response(LINKED("Pizza", "", "Pizza recipes with cheese and dough."), ct);
      return new Response("nf", { status: 404 });
    },
  });
  const ddg = Bun.serve({
    port: DDG_PORT,
    async fetch(req) {
      if (req.method === "POST") {
        const q = await req.text();
        const results = q.includes("deep") ? deepResults() : tidalResults();
        return new Response(ddgHtml(results), { headers: { "Content-Type": "text/html" } });
      }
      return new Response("nf", { status: 404 });
    },
  });
  const dataDir = mkdtempSync(join(tmpdir(), "lv-api-"));
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
  for (const s of stops) s();
  appProc?.kill(9); // SIGTERM is ignored by the spawned server; SIGKILL it
});

describe("topics API", () => {
  let topicId = 0;

  test("POST /api/topics validates input", async () => {
    const r = await fetch(`${APP}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(r.status).toBe(400);
    const bad = await fetch(`${APP}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", query: "y", schedule: "sometimes" }),
    });
    expect(bad.status).toBe(400);
  });

  test("create + list", async () => {
    const r = await fetch(`${APP}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Tides", query: "tidal energy", schedule: "daily" }),
    });
    expect(r.status).toBe(201);
    const d = await r.json();
    expect(d.ok).toBe(true);
    topicId = d.topic.id;
    expect(d.topic.new_count).toBe(0);
    const l = await (await fetch(`${APP}/api/topics`)).json();
    expect(l.topics.some((t: any) => t.id === topicId)).toBe(true);
  });

  test("manual crawl via stub DDG, then dedupe", async () => {
    const r1 = await (
      await fetch(`${APP}/api/topics/${topicId}/crawl`, { method: "POST" })
    ).json();
    expect(r1.ok).toBe(true);
    expect(r1.added).toBe(2);
    expect(r1.total).toBe(2);
    const r2 = await (
      await fetch(`${APP}/api/topics/${topicId}/crawl`, { method: "POST" })
    ).json();
    expect(r2.added).toBe(0);
  });

  test("findings + mark read", async () => {
    const f = await (await fetch(`${APP}/api/topics/${topicId}/findings`)).json();
    expect(f.findings.length).toBe(2);
    expect(f.findings[0].is_new).toBe(1);
    const rd = await (
      await fetch(`${APP}/api/findings/${f.findings[0].id}/read`, { method: "POST" })
    ).json();
    expect(rd.ok).toBe(true);
    const t = await (await fetch(`${APP}/api/topics`)).json();
    expect(t.topics.find((x: any) => x.id === topicId).new_count).toBe(1);
  });

  test("PATCH schedule", async () => {
    const r = await fetch(`${APP}/api/topics/${topicId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule: "manual" }),
    });
    const d = await r.json();
    expect(d.topic.schedule).toBe("manual");
  });

  test("404s", async () => {
    expect((await fetch(`${APP}/api/topics/99999`)).status).toBe(404);
    expect((await fetch(`${APP}/api/findings/99999/read`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${APP}/api/topics/99999/crawl`, { method: "POST" })).status).toBe(404);
  });

  test("delete cascades", async () => {
    expect((await (await fetch(`${APP}/api/topics/${topicId}`, { method: "DELETE" })).json()).ok).toBe(true);
    expect((await fetch(`${APP}/api/topics/${topicId}/findings`)).status).toBe(404);
  });
});

describe("topic depth", () => {
  const post = (body: unknown) =>
    fetch(`${APP}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("depth validation: rejects 0, 11, non-numbers", async () => {
    for (const depth of [0, 11, -1, "abc", 2.5]) {
      const r = await post({ name: "D", query: "dq", depth });
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error).toContain("depth");
    }
  });

  test("create defaults to depth 3; PATCH updates it", async () => {
    const d1 = await (await post({ name: "NoDepth", query: "ndq" })).json();
    expect(d1.topic.depth).toBe(3);
    const d2 = await (await post({ name: "HasDepth", query: "hdq", depth: 5 })).json();
    expect(d2.topic.depth).toBe(5);
    const p = await fetch(`${APP}/api/topics/${d2.topic.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ depth: 2 }),
    });
    expect((await p.json()).topic.depth).toBe(2);
    const bad = await fetch(`${APP}/api/topics/${d2.topic.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ depth: 99 }),
    });
    expect(bad.status).toBe(400);
  });

  test("deep crawl end-to-end: discoveries carry depth + via_url", async () => {
    pageHits = [];
    const d = await (
      await post({ name: "Deep", query: "deep tidal test", depth: 2, schedule: "manual" })
    ).json();
    const id = d.topic.id;
    const r = await (await fetch(`${APP}/api/topics/${id}/crawl`, { method: "POST" })).json();
    expect(r.ok).toBe(true);
    // hub (seed) + d1 + d2 at depth 1 + d3 at depth 2; d4 is depth 3 > maxDepth
    expect(r.added).toBe(4);
    expect(r.discovered).toBe(3);
    const f = await (await fetch(`${APP}/api/topics/${id}/findings`)).json();
    const byUrl: Record<string, any> = {};
    for (const x of f.findings) byUrl[x.url] = x;
    const H = `http://127.0.0.1:${PAGE_PORT}/hub.html`;
    const D1 = `http://127.0.0.1:${PAGE_PORT}/d1.html`;
    const D2 = `http://127.0.0.1:${PAGE_PORT}/d2.html`;
    const D3 = `http://127.0.0.1:${PAGE_PORT}/d3.html`;
    expect(byUrl[H].depth).toBe(0);
    expect(byUrl[H].via_url).toBeNull();
    expect(byUrl[D1].depth).toBe(1);
    expect(byUrl[D1].via_url).toBe(H);
    expect(byUrl[D2].depth).toBe(1);
    expect(byUrl[D2].via_url).toBe(H);
    expect(byUrl[D3].depth).toBe(2);
    expect(byUrl[D3].via_url).toBe(D1);
    // irrelevant link pruned, utm-dupe fetched once, d4 beyond depth 2
    expect(pageHits).not.toContain("/offtopic.html");
    expect(pageHits.filter((p: string) => p === "/d1.html").length).toBe(1);
    expect(pageHits).not.toContain("/d4.html");
  }, 30000);
});

describe("research API", () => {
  test("run → poll → done, with report + sources + export", async () => {
    const started = await fetch(`${APP}/api/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "How does tidal power work?" }),
    });
    expect(started.status).toBe(202);
    const { run_id } = await started.json();
    const run = await waitRunDone(run_id);
    expect(run.status).toBe("done");
    expect(run.report_md).toContain("# How does tidal power work?");
    expect(run.report_md).toContain("## Key points");
    expect(run.report_md).toContain("## Sources");
    expect(run.report_md).toContain("Extractive summary");
    expect(run.sources.length).toBe(2);
    expect(run.pages_crawled).toBe(2); // deep crawler re-read the 2 seed pages
    expect(run.max_depth_reached).toBe(0); // no links on the stub pages
    expect(run.capped).toBe(false);
    expect(run.discovered).toBe(0);
    expect(run.report_md).toContain("Deep crawl:");
    const exp = await fetch(`${APP}/api/research/${run_id}/export.md`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-type")).toContain("text/markdown");
    const text = await exp.text();
    expect(text).toContain("## Key points");
  }, 30000);

  test("missing question → 400; unknown run → 404", async () => {
    const r = await fetch(`${APP}/api/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect((await fetch(`${APP}/api/research/99999`)).status).toBe(404);
  });
});
