// API tests for GET /api/topics/:id/clusters. Spawns the real server and
// seeds findings by writing straight into its SQLite file (no live network).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const APP_PORT = 32181;
const APP = `http://127.0.0.1:${APP_PORT}`;

let appProc: Bun.Subprocess | null = null;
let dataDir = "";

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

async function post(path: string, body: unknown) {
  const r = await fetch(`${APP}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${JSON.stringify(d)}`);
  return d;
}

function seedFindings(topicId: number, rows: { title: string; url: string; snippet: string; is_new?: number }[]) {
  const db = new Database(join(dataDir, "longview.db"));
  const stmt = db.query(
    "INSERT INTO findings (topic_id, title, url, snippet, found_at, is_new, depth, via_url) VALUES (?,?,?,?,?,?,0,NULL)"
  );
  const now = Date.now();
  rows.forEach((r, i) =>
    stmt.run(topicId, r.title, r.url, r.snippet, now - i * 1000, r.is_new ?? 1)
  );
  db.close();
}

const corpus = () => [
  { title: "Tidal energy basics", url: "http://x/t1", snippet: "How tidal stream turbines generate ocean power." },
  { title: "Tidal power guide", url: "http://x/t2", snippet: "Guide to tidal power generation and wave farms." },
  { title: "Tidal lagoon plans", url: "http://x/t3", snippet: "Proposed tidal lagoon barrages for renewable electricity." },
  { title: "Tidal stream sites", url: "http://x/t4", snippet: "Best sites for tidal stream energy around the coast." },
  { title: "Best sourdough recipe", url: "http://x/s1", snippet: "Bake crusty sourdough bread with a live starter." },
  { title: "Sourdough starter tips", url: "http://x/s2", snippet: "Keep your bread starter alive and bubbly.", is_new: 0 },
  { title: "Sourdough baking schedule", url: "http://x/s3", snippet: "Timeline for mixing, folding and baking sourdough loaves." },
  { title: "Sourdough scoring", url: "http://x/s4", snippet: "How to score sourdough bread before baking." },
];

let topicId = 0;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "lv-clusters-"));
  appProc = Bun.spawn(["bun", join(import.meta.dir, "../src/server.ts")], {
    env: { ...process.env, PORT: String(APP_PORT), LONGVIEW_DATA: dataDir },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitFor(`${APP}/api/topics`);
  const t = await post("/api/topics", { name: "Energy", query: "tidal sourdough", schedule: "manual" });
  topicId = t.topic.id;
  seedFindings(topicId, corpus());
});

afterAll(() => {
  appProc?.kill(9);
});

describe("GET /api/topics/:id/clusters", () => {
  test("returns clusters matching the findings count, with labels", async () => {
    const r = await fetch(`${APP}/api/topics/${topicId}/clusters`);
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.ok).toBe(true);
    expect(Array.isArray(d.clusters)).toBe(true);
    const total = d.clusters.reduce((a: number, c: any) => a + c.results.length, 0);
    expect(total).toBe(corpus().length);
    for (const c of d.clusters) {
      expect(typeof c.label).toBe("string");
      expect(c.label.length).toBeGreaterThan(0);
      for (const res of c.results) {
        expect(res).toHaveProperty("id");
        expect(res).toHaveProperty("url");
        expect(res).toHaveProperty("title");
        expect(res).toHaveProperty("snippet");
        expect(typeof res.read).toBe("boolean");
        expect(typeof res.depth).toBe("number");
      }
    }
    const labels = d.clusters.map((c: any) => c.label.toLowerCase()).join(" | ");
    expect(labels).toContain("tidal");
    expect(labels).toContain("sourdough");
  });

  test("read flags mirror the findings store", async () => {
    const d = await (await fetch(`${APP}/api/topics/${topicId}/clusters`)).json();
    const all = d.clusters.flatMap((c: any) => c.results);
    const readOne = all.find((r: any) => r.url === "http://x/s2");
    const unreadOne = all.find((r: any) => r.url === "http://x/t1");
    expect(readOne.read).toBe(true);
    expect(unreadOne.read).toBe(false);
  });

  test("deterministic across calls", async () => {
    const a = await (await fetch(`${APP}/api/topics/${topicId}/clusters`)).text();
    const b = await (await fetch(`${APP}/api/topics/${topicId}/clusters`)).text();
    expect(a).toBe(b);
  });

  test("404 for unknown topic", async () => {
    const r = await fetch(`${APP}/api/topics/999999/clusters`);
    expect(r.status).toBe(404);
  });

  test("topic with no findings → empty clusters", async () => {
    const t = await post("/api/topics", { name: "Empty", query: "nothing", schedule: "manual" });
    const d = await (await fetch(`${APP}/api/topics/${t.topic.id}/clusters`)).json();
    expect(d.ok).toBe(true);
    expect(d.clusters).toEqual([]);
  });
});
