// API tests for the search-backend settings and Exa-backed crawling.
// The app is pointed at a stub Exa API, so no live network is ever touched.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXA_PORT = 32321;
const APP_PORT = 32322;
const APP = `http://127.0.0.1:${APP_PORT}`;

const EXA_JSON = {
  results: [
    { title: "Alpha page", url: "https://example.com/alpha", text: "Alpha snippet." },
    { title: "Beta page", url: "https://example.com/beta", text: "Beta snippet." },
  ],
};

let appProc: Bun.Subprocess | null = null;
let stopStub: (() => void) | null = null;

async function waitFor(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error("server never came up");
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  const stub = Bun.serve({
    port: EXA_PORT,
    fetch() {
      return Response.json(EXA_JSON);
    },
  });
  const dataDir = mkdtempSync(join(tmpdir(), "lv-set-"));
  const app = Bun.spawn(["bun", join(import.meta.dir, "../src/server.ts")], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      LONGVIEW_DATA: dataDir,
      EXA_API_BASE: `http://127.0.0.1:${EXA_PORT}/search`,
      EXA_API_KEY: "test-key-123",
      DDG_NO_DELAY: "1",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  appProc = app;
  stopStub = () => stub.stop();
  await waitFor(`${APP}/api/topics`);
});

afterAll(() => {
  stopStub?.();
  appProc?.kill(9); // SIGTERM is ignored by the spawned server; SIGKILL it
});

describe("settings API", () => {
  test("GET /api/settings defaults to ddg, reports key status (never the key)", async () => {
    const r = await fetch(`${APP}/api/settings`);
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.settings).toMatchObject({
      backend: "ddg",
      backend_source: "default",
      exa_key_configured: true,
    });
    expect(JSON.stringify(d)).not.toContain("test-key-123");
  });

  test("PATCH /api/settings switches the backend and persists it", async () => {
    const r = await fetch(`${APP}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "exa" }),
    });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.settings).toMatchObject({ backend: "exa", backend_source: "setting" });

    const g = await (await fetch(`${APP}/api/settings`)).json();
    expect(g.settings.backend).toBe("exa");
  });

  test("PATCH /api/settings rejects an unknown backend", async () => {
    const r = await fetch(`${APP}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "google" }),
    });
    expect(r.status).toBe(400);
  });

  test("GET /api/diag/crawl names the active (exa) backend", async () => {
    const r = await fetch(`${APP}/api/diag/crawl?q=alpha+test`);
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.ok).toBe(true);
    expect(d.backend).toBe("exa");
    expect(d.keyConfigured).toBe(true);
    expect(d.winner).toBe("exa-api");
    expect(d.endpoints).toHaveLength(1);
    expect(d.endpoints[0]).toMatchObject({
      endpoint: "exa-api",
      httpStatus: 200,
      resultCount: 2,
      errorClass: null,
    });
  });

  test("manual crawl uses the active backend and stores its results", async () => {
    const c = await fetch(`${APP}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Exa topic", query: "alpha test", schedule: "manual", depth: 1 }),
    });
    expect(c.status).toBe(201);
    const topicId = (await c.json()).topic.id;

    const r = await fetch(`${APP}/api/topics/${topicId}/crawl`, { method: "POST" });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.ok).toBe(true);
    expect(d.added).toBe(2);

    const f = await (await fetch(`${APP}/api/topics/${topicId}/findings`)).json();
    expect(f.findings.map((x: { url: string }) => x.url).sort()).toEqual([
      "https://example.com/alpha",
      "https://example.com/beta",
    ]);
  });
});
