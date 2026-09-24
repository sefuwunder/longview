// Desk UI tests: folders, journals, agent chat.
// DOM-stubbed end-to-end render of the real public/app.js (+canvas.js, +agent-canvas.js).
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeElement, makeWindow, makeDocument, dispatch } from "./fake-dom";

const canvasSrc = readFileSync(join(import.meta.dir, "../public/canvas.js"), "utf8");
const agentCanvasSrc = readFileSync(join(import.meta.dir, "../public/agent-canvas.js"), "utf8");
const appSrc = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");

// bun's test env has no localStorage; app.js guards it, but the chat-collapse
// test asserts the persistence, so provide a faithful in-memory shim.
if (typeof (globalThis as any).localStorage === "undefined") {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

async function waitFor(fn: () => boolean, ms = 9000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/* ---------------- in-memory fake desk API ---------------- */

function doneRunDetail(run: any) {
  return {
    run: {
      ...run,
      status: "done",
      findings: 2,
      sources: 1,
      steps: [
        { seq: 0, kind: "plan", label: "Planning", detail: "2 lines of inquiry" },
        { seq: 1, kind: "search", label: "Searching", detail: "backend ddg" },
        { seq: 2, kind: "done", label: "Done", detail: null },
      ],
      report_md: "# Report\n\nSolid-state batteries use a solid electrolyte for higher density.\n",
      graph: {
        nodes: [
          { id: "q", kind: "question", label: run.question, detail: "" },
          { id: "f1", kind: "finding", label: "Solid electrolytes enable higher density", detail: "oxide ceramics" },
          { id: "s1", kind: "source", label: "Example Source", url: "https://example.com/ssb", detail: "overview" },
        ],
        edges: [
          { from: "q", to: "f1", label: "" },
          { from: "f1", to: "s1", label: "cites" },
        ],
      },
    },
  };
}

function makeServer() {
  const s: any = {
    folders: [
      { id: 1, name: "Energy", parent_id: null, run_count: 1 },
      { id: 2, name: "Batteries", parent_id: 1, run_count: 1 },
    ],
    runs: [
      { id: 1, question: "solid state batteries?", status: "done", findings: 2, sources: 1, created_at: "2026-09-24T10:00:00Z", folder_id: 2, parent_run_id: null },
      { id: 2, question: "tidal stream basics", status: "done", findings: 1, sources: 1, created_at: "2026-09-24T09:00:00Z", folder_id: null, parent_run_id: null },
    ],
    journals: [
      { id: 1, title: "Energy notes", entry_count: 0, created_at: "2026-09-24T08:00:00Z", updated_at: "2026-09-24T08:00:00Z", entries: [] as any[] },
    ],
    nextFolder: 3,
    nextRun: 3,
    nextJournal: 2,
    nextEntry: 1,
    pollCount: {} as Record<number, number>,
  };
  s.journalDetail = (j: any) => ({
    id: j.id,
    title: j.title,
    created_at: j.created_at,
    updated_at: j.updated_at,
    entries: j.entries.map((e: any) => ({
      ...e,
      run_question: e.run_id ? (s.runs.find((r: any) => r.id === e.run_id) || {}).question || null : null,
    })),
  });
  return s;
}

function makeApi(s: any) {
  const calls: string[] = [];
  const ok = (d: any) => ({ ok: true, status: 200, json: async () => d });
  async function fetch(url: string, opts: any = {}) {
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push(`${method} ${url}` + (body ? " " + JSON.stringify(body) : ""));
    if (url === "/api/topics") return ok({ topics: [] });

    if (url === "/api/folders" && method === "GET")
      return ok({ folders: s.folders, unfiled_count: s.runs.filter((r: any) => r.folder_id == null).length });
    if (url === "/api/folders" && method === "POST") {
      const f = { id: s.nextFolder++, name: body.name, parent_id: body.parent_id ?? null, run_count: 0 };
      s.folders.push(f);
      return ok({ folder: f });
    }
    let m = url.match(/^\/api\/folders\/(\d+)$/);
    if (m) {
      const f = s.folders.find((x: any) => x.id === Number(m[1]));
      if (method === "PATCH") { Object.assign(f, body); return ok({ folder: f }); }
      if (method === "DELETE") {
        s.folders = s.folders.filter((x: any) => x.id !== f.id);
        s.runs.forEach((r: any) => { if (r.folder_id === f.id) r.folder_id = null; });
        return ok({ ok: true });
      }
    }

    if (url === "/api/agent" && method === "GET") return ok({ runs: s.runs });
    if (url === "/api/agent" && method === "POST") {
      const r = {
        id: s.nextRun++, question: body.question, status: "running",
        findings: null, sources: null, created_at: new Date().toISOString(),
        folder_id: body.folder_id ?? null, parent_run_id: body.parent_run_id ?? null,
      };
      s.runs.unshift(r);
      return ok({ run_id: r.id });
    }
    m = url.match(/^\/api\/agent\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const r = s.runs.find((x: any) => x.id === id);
      if (!r) return ok({ error: "not found" });
      if (method === "PATCH") {
        if (body && "folder_id" in body) r.folder_id = body.folder_id;
        return ok({ ok: true, run: r });
      }
      if (r.status !== "done") {
        s.pollCount[id] = (s.pollCount[id] || 0) + 1;
        if (s.pollCount[id] >= 2) { r.status = "done"; return ok(doneRunDetail(r)); }
        return ok({ run: { ...r, steps: [{ seq: 0, kind: "plan", label: "Planning", detail: "breaking down the question" }] } });
      }
      return ok(doneRunDetail(r));
    }

    if (url === "/api/journals" && method === "GET")
      return ok({ journals: s.journals.map((j: any) => ({ ...j, entry_count: j.entries.length })) });
    if (url === "/api/journals" && method === "POST") {
      const j = { id: s.nextJournal++, title: body.title, created_at: "now", updated_at: "now", entries: [] };
      s.journals.push(j);
      return ok({ journal: s.journalDetail(j) });
    }
    m = url.match(/^\/api\/journals\/(\d+)\/entries\/reorder$/);
    if (m && method === "POST") {
      const j = s.journals.find((x: any) => x.id === Number(m[1]));
      const byId: any = {};
      j.entries.forEach((e: any) => { byId[e.id] = e; });
      j.entries = body.entry_ids.map((id: number, i: number) => ({ ...byId[id], position: i }));
      return ok({ journal: s.journalDetail(j) });
    }
    m = url.match(/^\/api\/journals\/(\d+)\/entries\/(\d+)$/);
    if (m) {
      const j = s.journals.find((x: any) => x.id === Number(m[1]));
      if (method === "PATCH") {
        const e = j.entries.find((x: any) => x.id === Number(m[2]));
        if (body.note !== undefined) e.note = body.note;
        return ok({ journal: s.journalDetail(j) });
      }
      if (method === "DELETE") {
        j.entries = j.entries.filter((x: any) => x.id !== Number(m[2]));
        return ok({ journal: s.journalDetail(j) });
      }
    }
    m = url.match(/^\/api\/journals\/(\d+)\/entries$/);
    if (m && method === "POST") {
      const j = s.journals.find((x: any) => x.id === Number(m[1]));
      const e = {
        id: s.nextEntry++, journal_id: j.id, run_id: body.run_id ?? null,
        kind: body.kind, ref_text: body.ref_text, note: "", position: j.entries.length,
      };
      j.entries.push(e);
      return ok({ ok: true, journal: s.journalDetail(j) });
    }
    m = url.match(/^\/api\/journals\/(\d+)$/);
    if (m) {
      const j = s.journals.find((x: any) => x.id === Number(m[1]));
      if (method === "GET") return ok({ journal: s.journalDetail(j) });
      if (method === "PATCH") { j.title = body.title; return ok({ journal: s.journalDetail(j) }); }
      if (method === "DELETE") { s.journals = s.journals.filter((x: any) => x.id !== j.id); return ok({ ok: true }); }
    }
    throw new Error("unstubbed " + method + " " + url);
  }
  return { calls, fetch };
}

function bootDesk() {
  const win = makeWindow();
  const doc = makeDocument();
  const server = makeServer();
  const api = makeApi(server);
  new Function("window", "document", "fetch", "setTimeout", "clearTimeout", "confirm",
    canvasSrc + "\n" + agentCanvasSrc + "\n" + appSrc)(
    win, doc, api.fetch, setTimeout, clearTimeout, () => true);
  // Mirror public/index.html's initial classes (the stub DOM has no markup).
  doc.getElementById("agent-wrap").classList.add("hidden");
  doc.getElementById("journal-wrap").classList.add("hidden");
  doc.getElementById("agent-report-wrap").classList.add("hidden");
  doc.getElementById("agent-view-graph").classList.add("on");
  return { win, doc, server, api };
}

function popover(doc: any) {
  const p = doc.body.querySelector(".popover");
  if (!p) throw new Error("no popover open");
  return p;
}

function chatText(doc: any) {
  // chatMsg appends message divs (innerHTML set per message); the container's
  // own innerHTML stays empty in the stub, so join the children.
  return doc.getElementById("chat-msgs").children.map((c: any) => c.innerHTML).join("\n");
}

function treeRows(doc: any): FakeElement[] {
  return doc.getElementById("folder-tree").querySelectorAll(".ftree-row");
}
function rowNamed(doc: any, name: string): FakeElement {
  const r = treeRows(doc).find((x: FakeElement) => {
    const nm = x.querySelector(".ftree-name");
    return nm && nm.textContent.includes(name);
  });
  if (!r) throw new Error("no folder row named " + name);
  return r;
}
function runCards(doc: any): FakeElement[] {
  return doc.getElementById("agent-run-list").querySelectorAll(".run-card");
}
function cardNamed(doc: any, name: string): FakeElement {
  const c = runCards(doc).find((x: FakeElement) => {
    const q = x.querySelector(".q");
    return q && q.textContent.includes(name);
  });
  if (!c) throw new Error("no run card named " + name);
  return c;
}

/* ---------------- folders ---------------- */

describe("desk: folders", () => {
  let desk: ReturnType<typeof bootDesk>;
  beforeAll(async () => {
    desk = bootDesk();
    await waitFor(() => desk.doc.getElementById("folder-tree").querySelectorAll(".ftree-row").length >= 4);
  });

  test("tree renders All runs, Unfiled, and nested folders with counts", () => {
    const html = desk.doc.getElementById("folder-tree").innerHTML;
    for (const name of ["All runs", "Unfiled", "Energy", "Batteries"]) expect(html).toContain(name);
    // total = Energy(1) + Batteries(1) + unfiled(1)
    const all = rowNamed(desk.doc, "All runs");
    expect(all.querySelector(".badge")!.textContent).toBe("3");
  });

  test("create folder posts to the API and re-renders the tree", async () => {
    desk.doc.getElementById("btn-add-folder").click();
    const p = popover(desk.doc);
    p.querySelector("#pp-input").value = "Fusion";
    p.querySelector('[data-act="ok"]').click();
    await waitFor(() => desk.server.folders.some((f: any) => f.name === "Fusion"));
    expect(desk.api.calls.some((c) => c === 'POST /api/folders {"name":"Fusion"}')).toBe(true);
    await waitFor(() => desk.doc.getElementById("folder-tree").querySelectorAll(".ftree-row").length >= 5);
    expect(desk.doc.getElementById("folder-tree").innerHTML).toContain("Fusion");
  });

  test("clicking a folder filters the run list", async () => {
    rowNamed(desk.doc, "Batteries").click();
    await waitFor(() => desk.doc.getElementById("run-list-title").textContent.includes("Batteries"));
    const cards = runCards(desk.doc);
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector(".q")!.textContent).toContain("solid state batteries?");
    // back to all runs for the tests below
    rowNamed(desk.doc, "All runs").click();
    await waitFor(() => runCards(desk.doc).length === 2);
  });

  test("run move picker PATCHes the folder", async () => {
    cardNamed(desk.doc, "tidal stream").querySelector(".run-move").click();
    const p = popover(desk.doc);
    p.querySelector('[data-f="1"]').click(); // Energy
    await waitFor(() => desk.server.runs.find((r: any) => r.id === 2).folder_id === 1);
    expect(desk.api.calls.some((c) => c === "PATCH /api/agent/2 {\"folder_id\":1}")).toBe(true);
  });

  test("deleting a folder re-files its runs, never deletes them", async () => {
    rowNamed(desk.doc, "Batteries").querySelector(".ftree-menu").click();
    popover(desk.doc).querySelector('[data-act="del"]').click(); // confirm() stubbed true
    await waitFor(() => desk.api.calls.some((c) => c === "DELETE /api/folders/2"));
    const run1 = desk.server.runs.find((r: any) => r.id === 1);
    expect(run1).toBeTruthy();
    expect(run1.folder_id).toBe(null);
    await waitFor(() => !desk.doc.getElementById("folder-tree").innerHTML.includes("Batteries"));
  });
});

/* ---------------- journals ---------------- */

describe("desk: journals", () => {
  let desk: ReturnType<typeof bootDesk>;
  beforeAll(async () => {
    desk = bootDesk();
    await waitFor(() => desk.doc.getElementById("folder-tree").querySelectorAll(".ftree-row").length >= 4);
    await waitFor(() => runCards(desk.doc).length >= 2);
    // open run 1 so its data points are available
    cardNamed(desk.doc, "solid state").click();
    await waitFor(() => desk.doc.getElementById("agent-datapoints").querySelectorAll("[data-kind]").length >= 2);
  });

  test("create journal opens the journal view", async () => {
    desk.doc.getElementById("btn-add-journal").click();
    const p = popover(desk.doc);
    p.querySelector("#pp-input").value = "Lab notes";
    p.querySelector('[data-act="ok"]').click();
    await waitFor(() => desk.server.journals.some((j: any) => j.title === "Lab notes"));
    await waitFor(() => !desk.doc.getElementById("journal-wrap").classList.contains("hidden"));
    expect(desk.doc.getElementById("journal-title").textContent).toBe("Lab notes");
  });

  test("adding a finding files it with a run citation", async () => {
    // back to the run (journal view took over the center)
    cardNamed(desk.doc, "solid state").click();
    await waitFor(() => desk.doc.getElementById("agent-datapoints").querySelectorAll("[data-kind]").length >= 2);
    const btn = desk.doc.getElementById("agent-datapoints").querySelectorAll("[data-kind]")
      .find((b: FakeElement) => b.dataset.kind === "finding")!;
    btn.click();
    const p = popover(desk.doc);
    p.querySelector('[data-j="1"]').click(); // Energy notes
    await waitFor(() => desk.server.journals[0].entries.length === 1);
    const e = desk.server.journals[0].entries[0];
    expect(e.kind).toBe("finding");
    expect(e.run_id).toBe(1);
    expect(e.ref_text).toContain("Solid electrolytes enable higher density");
  });

  test("journal view shows the entry with its citation", async () => {
    const jr = desk.doc.getElementById("journal-list").querySelectorAll(".jrow")
      .find((r: FakeElement) => {
        const nm = r.querySelector(".jrow-name");
        return nm && nm.textContent.includes("Energy notes");
      });
    if (!jr) throw new Error("no journal row");
    jr.click();
    await waitFor(() => desk.doc.getElementById("journal-title").textContent === "Energy notes");
    const html = desk.doc.getElementById("journal-entries").innerHTML;
    expect(html).toContain("Solid electrolytes enable higher density");
    expect(html).toContain("Run #1");
  });

  test("freeform note, reorder, remove", async () => {
    const jentries = () => desk.doc.getElementById("journal-entries").querySelectorAll(".jentry");
    // note
    desk.doc.getElementById("journal-note-input").value = "verify the oxide claim";
    dispatch(desk.doc.getElementById("journal-note-form"), "submit");
    await waitFor(() => jentries().length === 2);
    expect(desk.server.journals[0].entries[1].kind).toBe("note");

    // reorder: move the note (2nd) up
    jentries()[1].querySelector('[data-act="up"]').click();
    await waitFor(() => desk.api.calls.some((c) => c.startsWith("POST /api/journals/1/entries/reorder")));
    await waitFor(() => {
      const es = jentries();
      return es.length === 2 && es[0].querySelector(".badge")!.textContent === "note";
    });
    const j = desk.server.journals[0];
    expect(j.entries[0].kind).toBe("note");
    expect(j.entries[1].kind).toBe("finding");

    // remove the note (now first)
    jentries()[0].querySelector('[data-act="del"]').click();
    await waitFor(() => jentries().length === 1);
    expect(desk.server.journals[0].entries[0].kind).toBe("finding");
  });

  test("export link points at the markdown export", () => {
    expect(desk.doc.getElementById("journal-export").href).toBe("/api/journals/1/export.md");
  });
});
/* ---------------- chat ---------------- */

describe("desk: chat", () => {
  let desk: ReturnType<typeof bootDesk>;
  beforeAll(async () => {
    desk = bootDesk();
    await waitFor(() => desk.doc.getElementById("folder-tree").querySelectorAll(".ftree-row").length >= 4);
  });

  function say(text: string) {
    desk.doc.getElementById("chat-input").value = text;
    dispatch(desk.doc.getElementById("chat-form"), "submit");
  }

  test("boot posts the help message", () => {
    expect(chatText(desk.doc)).toContain("research");
    expect(chatText(desk.doc)).toContain("follow up");
  });

  test("follow up with no open run asks for one", async () => {
    say("follow up");
    await waitFor(() => chatText(desk.doc).includes("Open a run first"));
  });

  test("summarize with no open run asks for one", async () => {
    say("summarize");
    await waitFor(() => chatText(desk.doc).match(/Open a run first/g)!.length >= 2);
  });

  test("unknown input is honestly declined", async () => {
    say("what is the meaning of life?");
    await waitFor(() => chatText(desk.doc).includes("I only drive the pipeline"));
  });

  test("research starts a run, narrates steps, and opens the canvas on completion", async () => {
    say("research how do tokamaks work?");
    await waitFor(() => desk.api.calls.some((c) => c.includes('POST /api/agent {"question":"how do tokamaks work?"')));
    await waitFor(() => chatText(desk.doc).includes("Planning"));
    // the fake run completes on its second poll (~2.5s later)
    await waitFor(() => chatText(desk.doc).includes("✅ Done"), 15000);
    await waitFor(() => !desk.doc.getElementById("agent-wrap").classList.contains("hidden"), 15000);
    expect(desk.doc.getElementById("agent-status").textContent).toContain("Completed");
    // the real agent canvas rendered the output graph
    await waitFor(() => desk.doc.getElementById("agent-canvas").querySelectorAll(".ag-node").length > 0, 15000);
    // the finished run is filed under All runs
    expect(desk.doc.getElementById("agent-run-list").querySelector(".run-card .q")!.textContent)
      .toContain("how do tokamaks work?");
  });

  test("summarize returns the finished run's synthesis", async () => {
    say("summarize");
    await waitFor(() => chatText(desk.doc).includes("Solid-state batteries use a solid electrolyte"));
  });

  test("export links the markdown report", async () => {
    say("export");
    await waitFor(() => chatText(desk.doc).includes("/api/agent/3/export.md"));
  });

  test("collapsing the chat persists the preference", () => {
    desk.doc.getElementById("chat-toggle").click();
    expect(desk.doc.getElementById("chat-body").classList.contains("hidden")).toBe(true);
    expect(localStorage.getItem("longview:chat:open")).toBe("0");
    desk.doc.getElementById("chat-toggle").click();
    expect(localStorage.getItem("longview:chat:open")).toBe("1");
  });
});
