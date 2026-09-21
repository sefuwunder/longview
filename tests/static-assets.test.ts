// Regression test: every script and stylesheet referenced by index.html must
// be served by the server's static allowlist. (The canvas view shipped with
// <script src="/canvas.js"> in the markup but no matching static route, so
// the script 404'd and the view showed "Canvas view failed to load.")
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_PORT = 32174;
const APP = `http://127.0.0.1:${APP_PORT}`;

let appProc: Bun.Subprocess | null = null;

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

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "longview-static-"));
  appProc = Bun.spawn(["bun", join(import.meta.dir, "../src/server.ts")], {
    env: { ...process.env, PORT: String(APP_PORT), LONGVIEW_DATA: dataDir },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitFor(APP + "/");
});

afterAll(() => {
  appProc?.kill();
});

describe("static assets", () => {
  test("every script and stylesheet in index.html is served with 200", async () => {
    const html = await (await fetch(APP + "/")).text();
    const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
    const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of [...scripts, ...styles]) {
      const r = await fetch(APP + src);
      expect(`${src} -> ${r.status}`).toBe(`${src} -> 200`);
      const ct = r.headers.get("content-type") ?? "";
      if (src.endsWith(".js")) expect(ct).toContain("javascript");
      if (src.endsWith(".css")) expect(ct).toContain("css");
      await r.arrayBuffer(); // drain
    }
  });

  test("canvas.js defines the LVCanvas entry point", async () => {
    const src = await (await fetch(APP + "/canvas.js")).text();
    expect(src).toContain("LVCanvas");
  });
});
