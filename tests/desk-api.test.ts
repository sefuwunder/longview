// API tests for the research-desk additions: folders, run filing, and
// journals. Spawns the real server with a stub DDG endpoint so no live
// network is touched.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE_PORT = 32281;
const DDG_PORT = 32282;
const APP_PORT = 32283;
const APP = `http://127.0.0.1:${APP_PORT}`;

const ARTICLE = (title: string, body: string) =>
  `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;

function ddgHtml(results: { t: string; u: string; s: string }[]): string {
  const res = (t: string, u: string, s: string) =>
    `<div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">` +
    `<h2 class="result__title"><a rel="nofollow" class="result__a" href="${u}">${t}</a></h2>` +
    `<div class="result__snippet">${s}</div></div></div>`;
  return `<html><body><div id="links" class="results">` + results.map((r) => res(r.t, r.u, r.s)).join("") + `</div></body></html>`;
}

const T1 =
  "Solar panel basics begin with the photovoltaic effect in silicon cells every single day. " +
  "Solar panels convert sunlight directly into electricity through photovoltaic cells in modules. " +
  "Engineers mount solar panel arrays on rooftops where sunlight exposure is strong and constant.";

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

const post = (path: string, b: unknown) =>
  fetch(`${APP}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const patch = (path: string, b: unknown) =>
  fetch(`${APP}${path}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const del = (path: string) => fetch(`${APP}${path}`, { method: "DELETE" });
const get = (path: string) => fetch(`${APP}${path}`);

beforeAll(async () => {
  const pages = Bun.serve({
    port: PAGE_PORT,
    fetch(req) {
      const p = new URL(req.url).pathname;
      const ct = { headers: { "Content-Type": "text/html" } };
      if (p === "/s1.html") return new Response(ARTICLE("Solar 101", T1), ct);
      return new Response("nf", { status: 404 });
    },
  });
  const ddg = Bun.serve({
    port: DDG_PORT,
    async fetch(req) {
      if (req.method === "POST") {
        await req.text();
        return new Response(
          ddgHtml([{ t: "Solar 101", u: `http://127.0.0.1:${PAGE_PORT}/s1.html`, s: "Solar basics." }]),
          { headers: { "Content-Type": "text/html" } }
        );
      }
      return new Response("nf", { status: 404 });
    },
  });
  const dataDir = mkdtempSync(join(tmpdir(), "lv-desk-api-"));
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

describe("folders", () => {
  test("CRUD with validation", async () => {
    let d = await (await get("/api/folders")).json();
    expect(d.ok).toBe(true);
    expect(d.folders).toEqual([]);
    expect(d.unfiled_count).toBe(0);

    // name required
    let r = await post("/api/folders", { name: "  " });
    expect(r.status).toBe(400);

    r = await post("/api/folders", { name: "Energy" });
    expect(r.status).toBe(201);
    const parent = (await r.json()).folder;
    expect(parent.parent_id).toBeNull();

    // nested folder
    r = await post("/api/folders", { name: "Solar", parent_id: parent.id });
    expect(r.status).toBe(201);
    const child = (await r.json()).folder;
    expect(child.parent_id).toBe(parent.id);

    // unknown parent → 400
    r = await post("/api/folders", { name: "X", parent_id: 999999 });
    expect(r.status).toBe(400);

    // rename
    r = await patch(`/api/folders/${child.id}`, { name: "PV Solar" });
    expect((await r.json()).folder.name).toBe("PV Solar");

    // cycle: parent into its own descendant → 400
    r = await patch(`/api/folders/${parent.id}`, { parent_id: child.id });
    expect(r.status).toBe(400);
    // cycle: folder into itself → 400
    r = await patch(`/api/folders/${parent.id}`, { parent_id: parent.id });
    expect(r.status).toBe(400);
    // unknown parent on move → 400
    r = await patch(`/api/folders/${parent.id}`, { parent_id: 999999 });
    expect(r.status).toBe(400);
    // unknown folder → 404
    expect((await patch("/api/folders/999999", { name: "x" })).status).toBe(404);
    expect((await del("/api/folders/999999")).status).toBe(404);

    // move child back to top level
    r = await patch(`/api/folders/${child.id}`, { parent_id: null });
    expect((await r.json()).folder.parent_id).toBeNull();

    d = await (await get("/api/folders")).json();
    expect(d.folders.length).toBe(2);
    expect(d.folders[0].name).toBe("Energy");
  });

  test("runs can be filed, moved, and unfiled; folder delete never deletes runs", async () => {
    const parent = (await (await post("/api/folders", { name: "Filed" })).json()).folder;
    const child = (await (await post("/api/folders", { name: "Nested", parent_id: parent.id })).json()).folder;

    // create a run directly into the child folder
    const pr = await post("/api/agent", { question: "solar panel basics", folder_id: child.id });
    expect(pr.status).toBe(202);
    const runId = (await pr.json()).run_id;

    let d = await (await get("/api/folders")).json();
    const childRow = d.folders.find((f: { id: number }) => f.id === child.id);
    expect(childRow.run_count).toBe(1);
    expect(d.unfiled_count).toBe(0);

    // run detail carries folder + parent ids
    const run = await (await get(`/api/agent/${runId}`)).json();
    expect(run.run.folder_id).toBe(child.id);
    expect(run.run.parent_run_id).toBeNull();

    // move run up to the parent folder
    let mr = await patch(`/api/agent/${runId}`, { folder_id: parent.id });
    expect(mr.status).toBe(200);
    expect((await mr.json()).folder_id).toBe(parent.id);

    // unknown folder on move → 400; missing body → 400; unknown run → 404
    expect((await patch(`/api/agent/${runId}`, { folder_id: 999999 })).status).toBe(400);
    expect((await patch(`/api/agent/${runId}`, {})).status).toBe(400);
    expect((await patch("/api/agent/999999", { folder_id: parent.id })).status).toBe(404);

    // deleting the child folder (now empty) re-parents nothing and unfiles nothing
    expect((await del(`/api/folders/${child.id}`)).status).toBe(200);

    // deleting the parent folder unfiles its run; the run still exists
    expect((await del(`/api/folders/${parent.id}`)).status).toBe(200);
    const after = await (await get(`/api/agent/${runId}`)).json();
    expect(after.run.folder_id).toBeNull();
    d = await (await get("/api/folders")).json();
    expect(d.unfiled_count).toBe(1);

    // nested delete re-parents the grandchild to the deleted folder's parent
    const a = (await (await post("/api/folders", { name: "A" })).json()).folder;
    const b = (await (await post("/api/folders", { name: "B", parent_id: a.id })).json()).folder;
    expect((await del(`/api/folders/${a.id}`)).status).toBe(200);
    d = await (await get("/api/folders")).json();
    const bRow = d.folders.find((f: { id: number }) => f.id === b.id);
    expect(bRow).toBeDefined();
    expect(bRow.parent_id).toBeNull();
  });

  test("linked follow-up runs carry parent_run_id", async () => {
    const pr = await post("/api/agent", { question: "solar panel basics" });
    const firstId = (await pr.json()).run_id;
    const fr = await post("/api/agent", {
      question: "dig deeper: photovoltaic efficiency",
      parent_run_id: firstId,
    });
    expect(fr.status).toBe(202);
    const secondId = (await fr.json()).run_id;
    const run = await (await get(`/api/agent/${secondId}`)).json();
    expect(run.run.parent_run_id).toBe(firstId);
    // unknown parent → 400
    expect((await post("/api/agent", { question: "x", parent_run_id: 999999 })).status).toBe(400);
    expect((await post("/api/agent", { question: "x", folder_id: 999999 })).status).toBe(400);
  });
});

describe("journals", () => {
  test("journal CRUD with validation", async () => {
    let d = await (await get("/api/journals")).json();
    expect(d.ok).toBe(true);
    expect(d.journals).toEqual([]);

    let r = await post("/api/journals", { title: "  " });
    expect(r.status).toBe(400);

    r = await post("/api/journals", { title: "Energy transition" });
    expect(r.status).toBe(201);
    const j = (await r.json()).journal;
    expect(j.title).toBe("Energy transition");

    d = await (await get("/api/journals")).json();
    expect(d.journals.length).toBe(1);
    expect(d.journals[0].entry_count).toBe(0);

    r = await patch(`/api/journals/${j.id}`, { title: "Grid storage" });
    expect((await r.json()).journal.title).toBe("Grid storage");

    expect((await patch(`/api/journals/${j.id}`, { title: " " })).status).toBe(400);
    expect((await patch("/api/journals/999999", { title: "x" })).status).toBe(404);
    expect((await get("/api/journals/999999")).status).toBe(404);

    expect((await del(`/api/journals/${j.id}`)).status).toBe(200);
    expect((await get("/api/journals")).json().then((x) => x.journals.length)).resolves.toBe(0);
    expect((await del("/api/journals/999999")).status).toBe(404);
  });

  test("entries: add finding/source/note, cite the run, edit note, delete", async () => {
    const jid = (await (await post("/api/journals", { title: "Test" })).json()).journal.id;
    const pr = await post("/api/agent", { question: "solar panel basics" });
    const runId = (await pr.json()).run_id;
    await waitAgentDone(runId);

    // invalid kind → 400; empty text → 400; unknown run → 404; unknown journal → 404
    expect((await post(`/api/journals/${jid}/entries`, { kind: "nope", ref_text: "x" })).status).toBe(400);
    expect((await post(`/api/journals/${jid}/entries`, { kind: "note", ref_text: "  " })).status).toBe(400);
    expect((await post(`/api/journals/${jid}/entries`, { kind: "note", ref_text: "x", run_id: 999999 })).status).toBe(404);
    expect((await post("/api/journals/999999/entries", { kind: "note", ref_text: "x" })).status).toBe(404);

    let r = await post(`/api/journals/${jid}/entries`, {
      run_id: runId,
      kind: "finding",
      ref_text: "solar · panel · photovoltaic",
      note: "worth following up",
    });
    expect(r.status).toBe(201);
    let journal = (await r.json()).journal;
    expect(journal.entries.length).toBe(1);
    const e1 = journal.entries[0];
    expect(e1.kind).toBe("finding");
    expect(e1.run_id).toBe(runId);
    expect(e1.run_question).toBe("solar panel basics");
    expect(e1.note).toBe("worth following up");
    expect(e1.position).toBe(0);

    r = await post(`/api/journals/${jid}/entries`, {
      run_id: runId,
      kind: "source",
      ref_text: "Solar 101 — http://127.0.0.1:32281/s1.html",
    });
    expect(r.status).toBe(201);
    journal = (await r.json()).journal;
    expect(journal.entries[1].position).toBe(1);

    // freeform note with no run
    r = await post(`/api/journals/${jid}/entries`, { kind: "note", ref_text: "check with the lab" });
    expect(r.status).toBe(201);
    journal = (await r.json()).journal;
    expect(journal.entries[2].run_id).toBeNull();

    // edit the note
    r = await patch(`/api/journals/${jid}/entries/${e1.id}`, { note: "updated note" });
    expect(r.status).toBe(200);
    journal = (await r.json()).journal;
    expect(journal.entries[0].note).toBe("updated note");

    // delete one entry
    r = await del(`/api/journals/${jid}/entries/${e1.id}`);
    expect(r.status).toBe(200);
    journal = (await r.json()).journal;
    expect(journal.entries.length).toBe(2);
    expect((await del(`/api/journals/${jid}/entries/999999`)).status).toBe(404);
  });

  test("entries reorder and markdown export", async () => {
    const jid = (await (await post("/api/journals", { title: "Reorder" })).json()).journal.id;
    const ids: number[] = [];
    for (const t of ["first", "second", "third"]) {
      const r = await post(`/api/journals/${jid}/entries`, { kind: "note", ref_text: t });
      ids.push(((await r.json()).journal.entries as { id: number }[]).pop()!.id);
    }
    // reverse the order
    const rev = [...ids].reverse();
    let r = await post(`/api/journals/${jid}/entries/reorder`, { entry_ids: rev });
    expect(r.status).toBe(200);
    let entries = ((await r.json()).journal.entries as { id: number; ref_text: string }[]);
    expect(entries.map((e) => e.ref_text)).toEqual(["third", "second", "first"]);

    // reorder must be exact: missing id → 400
    expect((await post(`/api/journals/${jid}/entries/reorder`, { entry_ids: rev.slice(1) })).status).toBe(400);
    // duplicates → 400
    expect((await post(`/api/journals/${jid}/entries/reorder`, { entry_ids: [rev[0], rev[0], rev[2]] })).status).toBe(400);
    // unknown journal → 404
    expect((await post("/api/journals/999999/entries/reorder", { entry_ids: [] })).status).toBe(404);

    // export markdown
    r = await get(`/api/journals/${jid}/export.md`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/markdown");
    const md = await r.text();
    expect(md).toContain("# Reorder");
    const iThird = md.indexOf("third");
    const iFirst = md.indexOf("first");
    expect(iThird).toBeGreaterThan(-1);
    expect(iFirst).toBeGreaterThan(iThird); // export follows the reordered positions
    expect(md).toContain("## Note — no run");
    expect((await get("/api/journals/999999/export.md")).status).toBe(404);
  });

  test("deleting a journal removes its entries", async () => {
    const jid = (await (await post("/api/journals", { title: "Temp" })).json()).journal.id;
    await post(`/api/journals/${jid}/entries`, { kind: "note", ref_text: "bye" });
    expect((await del(`/api/journals/${jid}`)).status).toBe(200);
    expect((await get(`/api/journals/${jid}`)).status).toBe(404);
  });
});
