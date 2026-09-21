// Graceful-shutdown tests: boot the real server in a child process, send a
// signal, and assert it exits 0 promptly AND stops answering its port.
// A false pass from an already-dead process is ruled out by asserting the
// port was alive before the signal and dead after.

import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

async function waitFor(url: string, timeoutMs = 15000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > timeoutMs)
      throw new Error("timed out waiting for " + url);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function portAlive(port: number): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      signal: ctl.signal,
    });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const p = 31100 + Math.floor(Math.random() * 800);
    if (!(await portAlive(p))) return p;
  }
  throw new Error("no free port found");
}

type Child = ReturnType<typeof Bun.spawn>;
let procs: Child[] = [];
let dirs: string[] = [];

afterEach(() => {
  for (const p of procs) {
    try {
      p.kill(9); // SIGKILL any straggler the test didn't shut down
    } catch {
      /* already gone */
    }
  }
  procs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function waitExit(
  proc: Child,
  ms: number
): Promise<number | null> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), ms));
  return Promise.race([proc.exited, timeout]);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  test(
    `server exits 0 on ${sig} and stops answering the port`,
    async () => {
      const port = await freePort();
      const dataDir = mkdtempSync(join(tmpdir(), "lv-shutdown-"));
      dirs.push(dataDir);
      const proc = Bun.spawn(
        ["bun", join(import.meta.dir, "../src/server.ts")],
        {
          // Bun.spawn does not propagate runtime mutations of process.env;
          // pass an explicit copy.
          env: { ...process.env, PORT: String(port), LONGVIEW_DATA: dataDir },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      procs.push(proc);

      await waitFor(`http://127.0.0.1:${port}/api/settings`);
      expect(await portAlive(port)).toBe(true); // rules out an already-dead child

      const t0 = Date.now();
      proc.kill(sig);
      const code = await waitExit(proc, 5000);
      const elapsed = Date.now() - t0;
      console.log(`[shutdown] ${sig}: exited with ${code} in ${elapsed}ms`);

      expect(code).not.toBeNull(); // null = still alive after 5s
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(5000);
      // The server must actually be gone, not just report an exit code.
      expect(await portAlive(port)).toBe(false);
    },
    30000
  );
}
