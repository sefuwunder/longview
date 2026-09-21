// API tests for crawl-failure persistence and the /api/diag/crawl endpoint.
// The app is pointed at a stub DDG that always serves a bot challenge.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DDG_PORT = 32221;
const APP_PORT = 32222;
const APP = `http://127.0.0.1:${APP_PORT}`;

const CHALLENGE_HTML =
  '<html><head><title>c</title></head><body><div class="anomaly-modal">nope</div></body></html>';

let appProc: Bun.Subprocess | null = null;
let stopStub: (() => void) | null = null;

async function waitFor(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error("server never came up");
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  const stub = Bun.serve({
    port: DDG_PORT,
    fetch() {
      return new Response(CHALLENGE_HTML, {
        status: 202,
        headers: { "Content-Type": "text/html" },
      });
    },
  });
  const dataDir = mkdtempSync(join(tmpdir(), "lv-diag-"));
  const app = Bun.spawn(["bun", join(import.meta.dir, "../src/server.ts")], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      LONGVIEW_DATA: dataDir,
      DDG_BASE_URL: `http://127.0.0.1:${DDG_PORT}/`,
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

describe("crawl failure persistence + diagnostics API", () => {
  let topicId = 0;

  test("create a topic", async () => {
    const r = await fetch(`${APP}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Challenged", query: "tidal energy", schedule: "manual" }),
    });
    expect(r.status).toBe(201);
    topicId = (await r.json()).topic.id;
  });

  test("failed crawl → 502 with error_class; reason persisted", async () => {
    const r = await fetch(`${APP}/api/topics/${topicId}/crawl`, {
      method: "POST",
    });
    expect(r.status).toBe(502);
    const d = await r.json();
    expect(d.ok).toBe(false);
    expect(d.error_class).toBe("challenge");
    expect(d.error).toContain("bot challenge");

    const t = await (await fetch(`${APP}/api/topics/${topicId}`)).json();
    expect(t.topic.status).toBe("error");
    expect(t.topic.last_error_class).toBe("challenge");
    expect(t.topic.last_error).toContain("bot challenge");
  });

  test("GET /api/diag/crawl probes endpoints and names the winner", async () => {
    const r = await fetch(`${APP}/api/diag/crawl?q=tidal+energy`);
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.ok).toBe(true);
    expect(d.query).toBe("tidal energy");
    expect(Array.isArray(d.endpoints)).toBe(true);
    expect(d.endpoints.length).toBe(1); // DDG_BASE_URL override → single endpoint
    expect(d.endpoints[0]).toMatchObject({
      endpoint: "custom",
      httpStatus: 202,
      resultCount: 0,
      errorClass: "challenge",
    });
    expect(typeof d.endpoints[0].ms).toBe("number");
    expect(d.winner).toBeNull();
  });

  test("diag requires q", async () => {
    const r = await fetch(`${APP}/api/diag/crawl`);
    expect(r.status).toBe(400);
  });
});
