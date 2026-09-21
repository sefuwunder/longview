// UI tests for the cluster canvas. A minimal fake DOM lets us eval the real
// public/canvas.js (and public/app.js for the toggle) with zero deps.
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clusterResults } from "../src/cluster";

/* ---------------- fake DOM ---------------- */

const VOID = new Set(["input", "br", "hr", "img"]);

class FakeEvent {
  type: string;
  target: any = null;
  currentTarget: any = null;
  defaultPrevented = false;
  propagationStopped = false;
  [k: string]: any;
  constructor(type: string, props: Record<string, any> = {}) {
    this.type = type;
    Object.assign(this, props);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

function matchSimple(el: FakeElement, sel: string): boolean {
  // supports: .a.b, tag, #id, [data-x="y"], tag.class, .class[attr="v"]
  const m = sel.match(/^(?:([a-zA-Z][a-zA-Z0-9]*)?((?:\.[a-zA-Z0-9_-]+)*))?(?:#([a-zA-Z0-9_-]+))?(?:\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\])?$/);
  if (!m) return false;
  const [, tag, classes, id, attr, attrVal] = m;
  if (tag && el.tagName !== tag.toLowerCase()) return false;
  if (id && el.getAttribute("id") !== id) return false;
  for (const c of (classes || "").split(".").filter(Boolean))
    if (!el.classList.contains(c)) return false;
  if (attr) {
    const v = el.getAttribute(attr === "class" ? "class" : attr) ?? el.getAttribute("data-" + attr);
    if (v == null) return false;
    if (attrVal !== undefined && v !== attrVal) return false;
  }
  return true;
}

function matchSel(el: FakeElement, sel: string): boolean {
  // Rightmost compound selector must match the subject itself; earlier
  // parts match ancestors (descendant combinator).
  const parts = sel.trim().split(/\s+/);
  let cur: FakeElement | null = el;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (i === parts.length - 1) {
      if (!cur || !matchSimple(cur, parts[i])) return false;
      cur = cur.parent;
    } else {
      while (cur && !matchSimple(cur, parts[i])) cur = cur.parent;
      if (!cur) return false;
      cur = cur.parent;
    }
  }
  return true;
}

class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners: Record<string, { fn: Function; capture: boolean }[]> = {};
  classSet = new Set<string>();
  textContent = "";
  value = "";
  disabled = false;
  tabIndex = 0;
  draggable = false;
  options: FakeElement[] = [];
  clientWidth = 0;
  _qsCache: Record<string, FakeElement> = {};
  _rawHtml = "";

  classList = {
    add: (...c: string[]) => c.forEach((x) => this.classSet.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classSet.delete(x)),
    toggle: (c: string, force?: boolean) => {
      const on = force === undefined ? !this.classSet.has(c) : force;
      on ? this.classSet.add(c) : this.classSet.delete(c);
      return on;
    },
    contains: (c: string) => this.classSet.has(c),
  };

  constructor(tag = "div") { this.tagName = tag.toLowerCase(); }

  get className() { return [...this.classSet].join(" "); }
  set className(v: string) {
    this.classSet = new Set(v.split(/\s+/).filter(Boolean));
    this.attributes["class"] = v;
  }
  get innerHTML() { return this._rawHtml; }
  set innerHTML(html: string) {
    this._rawHtml = html;
    this.children = [];
    parseHtml(this, html);
  }
  get firstChild() { return this.children[0] || null; }

  setAttribute(k: string, v: string) {
    this.attributes[k] = v;
    if (k === "class") this.classSet = new Set(v.split(/\s+/).filter(Boolean));
    if (k.startsWith("data-")) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = v;
    }
  }
  getAttribute(k: string) { return this.attributes[k] ?? null; }

  appendChild(c: FakeElement) { c.parent = this; this.children.push(c); return c; }
  insertBefore(c: FakeElement, ref: FakeElement | null) {
    c.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }

  addEventListener(t: string, fn: Function, opts?: any) {
    (this.listeners[t] = this.listeners[t] || []).push({
      fn, capture: !!(opts && (opts.capture || opts === true)),
    });
  }
  removeEventListener(t: string, fn: Function) {
    this.listeners[t] = (this.listeners[t] || []).filter((l) => l.fn !== fn);
  }
  setPointerCapture(_id: number) {}

  closest(sel: string): FakeElement | null {
    let cur: FakeElement | null = this;
    while (cur) { if (matchSel(cur, sel)) return cur; cur = cur.parent; }
    return null;
  }
  contains(other: FakeElement | null): boolean {
    let cur = other;
    while (cur) { if (cur === this) return true; cur = cur.parent; }
    return false;
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] || this._qsCache[sel] || null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const c of el.children) {
        if (matchSel(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: 600, right: this.clientWidth, bottom: 600 };
  }
  click() { dispatch(this, "click"); }
}

function parseAttrs(el: FakeElement, s: string) {
  const re = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
  let m;
  while ((m = re.exec(s))) el.setAttribute(m[1], m[2] ?? "");
}

function parseHtml(parent: FakeElement, html: string) {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>/g;
  const stack: FakeElement[] = [parent];
  let m;
  while ((m = tagRe.exec(html))) {
    const [full, tag, attrs, selfClose] = m;
    if (full[1] === "/") { if (stack.length > 1) stack.pop(); continue; }
    const el = new FakeElement(tag);
    parseAttrs(el, attrs);
    stack[stack.length - 1].appendChild(el);
    if (!VOID.has(el.tagName) && !selfClose) stack.push(el);
  }
}

function dispatch(target: FakeElement, type: string, props: Record<string, any> = {}) {
  const evt = new FakeEvent(type, props);
  evt.target = target;
  const path: FakeElement[] = [];
  let cur: FakeElement | null = target;
  while (cur) { path.unshift(cur); cur = cur.parent; }
  evt.eventPhase = 1;
  for (const el of path.slice(0, -1)) {
    if (evt.propagationStopped) break;
    evt.currentTarget = el;
    for (const l of el.listeners[type] || []) if (l.capture) l.fn(evt);
  }
  if (!evt.propagationStopped) {
    evt.eventPhase = 2;
    evt.currentTarget = target;
    const ls = target.listeners[type] || [];
    for (const l of ls.filter((l) => l.capture)) l.fn(evt);
    for (const l of ls.filter((l) => !l.capture)) { if (evt.propagationStopped) break; l.fn(evt); }
  }
  if (!evt.propagationStopped) {
    evt.eventPhase = 3;
    for (const el of path.slice(0, -1).reverse()) {
      if (evt.propagationStopped) break;
      evt.currentTarget = el;
      for (const l of el.listeners[type] || []) if (!l.capture) l.fn(evt);
    }
  }
  return evt;
}

function makeWindow() {
  const storage = new Map<string, string>();
  const win: any = {
    localStorage: {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    },
    opened: [] as string[],
    open: (url: string) => { win.opened.push(url); return null; },
    listeners: {} as Record<string, Function[]>,
    addEventListener: (t: string, fn: Function) => { (win.listeners[t] = win.listeners[t] || []).push(fn); },
    removeEventListener: (t: string, fn: Function) => {
      win.listeners[t] = (win.listeners[t] || []).filter((f) => f !== fn);
    },
    LVCanvas: undefined,
    _storage: storage,
  };
  return win;
}

function makeDocument() {
  const byId = new Map<string, FakeElement>();
  const body = new FakeElement("body");
  const doc: any = {
    body,
    _byId: byId,
    createElement: (t: string) => new FakeElement(t),
    getElementById: (id: string) => {
      if (!byId.has(id)) {
        const el = new FakeElement("div");
        el.setAttribute("id", id);
        byId.set(id, el);
        body.appendChild(el);
      }
      return byId.get(id)!;
    },
    querySelector: (sel: string) => {
      const parts = sel.trim().split(/\s+/);
      if (parts[0].startsWith("#")) {
        const root = doc.getElementById(parts[0].slice(1));
        if (parts.length === 1) return root;
        return root.querySelector(parts.slice(1).join(" ")) || stubChild(root, parts.slice(1).join(" "));
      }
      return body.querySelector(sel);
    },
    querySelectorAll: (sel: string) => body.querySelectorAll(sel),
  };
  return doc;
}

function stubChild(parent: FakeElement, sel: string): FakeElement {
  if (!parent._qsCache[sel]) {
    const el = new FakeElement("div");
    const m = sel.match(/\.([a-zA-Z0-9_-]+)/);
    if (m) el.classList.add(m[1]);
    parent._qsCache[sel] = el;
    parent.appendChild(el);
  }
  return parent._qsCache[sel];
}

/* ---------------- fixtures ---------------- */

const findingsFixture = () => [
  { id: 101, topic_id: 1, title: "Tidal energy basics", url: "http://x/t1", snippet: "How tidal stream turbines generate ocean power.", found_at: 1, is_new: 1, depth: 0, via_url: null },
  { id: 102, topic_id: 1, title: "Tidal power guide", url: "http://x/t2", snippet: "Guide to tidal power generation and wave farms.", found_at: 2, is_new: 1, depth: 0, via_url: null },
  { id: 103, topic_id: 1, title: "Tidal lagoon plans", url: "http://x/t3", snippet: "Proposed tidal lagoon barrages for renewable electricity.", found_at: 3, is_new: 0, depth: 1, via_url: "http://x/t1" },
  { id: 104, topic_id: 1, title: "Best sourdough recipe", url: "http://x/s1", snippet: "Bake crusty sourdough bread with a live starter.", found_at: 4, is_new: 1, depth: 0, via_url: null },
  { id: 105, topic_id: 1, title: "Sourdough starter tips", url: "http://x/s2", snippet: "Keep your bread starter alive and bubbly.", found_at: 5, is_new: 1, depth: 0, via_url: null },
  { id: 106, topic_id: 1, title: "Sourdough baking schedule", url: "http://x/s3", snippet: "Timeline for mixing, folding and baking sourdough loaves.", found_at: 6, is_new: 1, depth: 0, via_url: null },
];

const clustersFixture = () =>
  clusterResults(findingsFixture().map((f) => ({ id: f.id, title: f.title, snippet: f.snippet, url: f.url })))
    .map((c) => ({
      label: c.label,
      results: c.ids.map((id) => {
        const f = findingsFixture().find((x) => x.id === id)!;
        return { id: f.id, url: f.url, title: f.title, snippet: f.snippet, read: f.is_new === 0, depth: f.depth };
      }),
    }));

function mountCanvas(win: any, doc: any) {
  const mount = doc.getElementById("canvas");
  mount.clientWidth = 1200;
  return mount;
}

/* ---------------- layoutClusters (pure) ---------------- */

describe("LVCanvas.layoutClusters", () => {
  let LV: any;
  beforeAll(() => {
    const win = makeWindow();
    const doc = makeDocument();
    new Function("window", "document", readFileSync(join(import.meta.dir, "../public/canvas.js"), "utf8"))(win, doc);
    LV = win.LVCanvas;
  });

  test("deterministic across calls", () => {
    const c = clustersFixture();
    const a = JSON.stringify(LV.layoutClusters(c, { width: 1200, seed: 7 }));
    const b = JSON.stringify(LV.layoutClusters(c, { width: 1200, seed: 7 }));
    expect(a).toBe(b);
  });

  test("wide: zones lay out left-to-right, notes inside their zone", () => {
    const layout = LV.layoutClusters(clustersFixture(), { width: 1200, seed: 7 });
    expect(layout.zones.length).toBe(2);
    expect(layout.zones[1].x).toBeGreaterThan(layout.zones[0].x);
    for (const z of layout.zones) {
      expect(z.w).toBeGreaterThanOrEqual(300);
    }
    const notes = Object.values(layout.notes) as { x: number; y: number }[];
    expect(notes.length).toBe(6);
    for (const [i, z] of layout.zones.entries()) {
      void i;
      const inZone = notes.filter((p) => p.x >= z.x && p.x + 300 <= z.x + z.w + 1 && p.y >= z.y && p.y <= z.y + z.h);
      expect(inZone.length).toBe(z.count);
    }
  });

  test("narrow (390px): zones stack vertically", () => {
    const layout = LV.layoutClusters(clustersFixture(), { width: 390, seed: 7 });
    expect(layout.zones.length).toBe(2);
    expect(layout.zones[0].x).toBe(layout.zones[1].x);
    expect(layout.zones[1].y).toBeGreaterThan(layout.zones[0].y);
    expect(layout.width).toBeLessThanOrEqual(390);
  });
});

/* ---------------- render() ---------------- */

describe("LVCanvas.render", () => {
  let win: any, doc: any, LV: any, mount: FakeElement;

  beforeAll(() => {
    win = makeWindow();
    doc = makeDocument();
    new Function("window", "document", readFileSync(join(import.meta.dir, "../public/canvas.js"), "utf8"))(win, doc);
    LV = win.LVCanvas;
    mount = mountCanvas(win, doc);
  });

  test("renders zones and notes with labels, dots for unread", () => {
    const marked: number[] = [];
    const h = LV.render(mount, 9, clustersFixture(), { onMarkRead: (id: number) => marked.push(id) });
    void h;
    const zones = mount.querySelectorAll(".czone");
    expect(zones.length).toBe(2);
    const labels = zones.map((z) => z.querySelector(".czone-label")!.textContent.toLowerCase()).join("|");
    expect(labels).toContain("tidal");
    expect(labels).toContain("sourdough");
    const notes = mount.querySelectorAll(".note");
    expect(notes.length).toBe(6);
    // finding 103 is read in the fixture
    const read = notes.find((n) => n.dataset.id === "103")!;
    expect(read.classList.contains("read")).toBe(true);
    expect(read.querySelector(".note-dot")).toBe(null);
    const unread = notes.find((n) => n.dataset.id === "101")!;
    expect(unread.classList.contains("read")).toBe(false);
    expect(unread.querySelector(".note-dot")).not.toBe(null);
    expect(marked).toEqual([]);
  });

  test("clicking a note's link opens it and marks it read", () => {
    const marked: number[] = [];
    LV.render(mount, 11, clustersFixture(), { onMarkRead: (id: number) => marked.push(id) });
    const note = mount.querySelectorAll(".note").find((n) => n.dataset.id === "101")!;
    const a = note.querySelector(".note-title a")!;
    dispatch(a, "click");
    expect(win.opened).toContain("http://x/t1");
    expect(marked).toEqual([101]);
    expect(note.classList.contains("read")).toBe(true);
  });

  test("dragging a note persists its position; re-render restores it", () => {
    LV.render(mount, 12, clustersFixture(), {});
    const note = mount.querySelectorAll(".note").find((n) => n.dataset.id === "104")!;
    dispatch(note, "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
    dispatch(mount, "pointermove", { pointerId: 1, clientX: 100, clientY: 100 });
    dispatch(mount, "pointermove", { pointerId: 1, clientX: 250, clientY: 300 });
    dispatch(mount, "pointerup", { pointerId: 1, clientX: 250, clientY: 300 });
    const saved = JSON.parse(win.localStorage.getItem("longview:canvas:12") || "{}");
    expect(saved["104"]).toBeDefined();
    expect(saved["104"][0]).toBeGreaterThan(100);
    // Re-render: custom position wins over the auto-layout.
    LV.render(mount, 12, clustersFixture(), {});
    const note2 = mount.querySelectorAll(".note").find((n) => n.dataset.id === "104")!;
    expect(note2.style.left).toBe(saved["104"][0] + "px");
    expect(note2.style.top).toBe(saved["104"][1] + "px");
    // A plain click (no drag) must NOT move the note.
    const before = { ...saved };
    const note3 = mount.querySelectorAll(".note").find((n) => n.dataset.id === "105")!;
    dispatch(note3, "pointerdown", { pointerId: 2, clientX: 50, clientY: 50 });
    dispatch(mount, "pointerup", { pointerId: 2, clientX: 52, clientY: 51 });
    const after = JSON.parse(win.localStorage.getItem("longview:canvas:12") || "{}");
    expect(after).toEqual(before);
  });

  test("keyboard: Enter opens, arrows nudge and persist", () => {
    const marked: number[] = [];
    LV.render(mount, 13, clustersFixture(), { onMarkRead: (id: number) => marked.push(id) });
    const note = mount.querySelectorAll(".note").find((n) => n.dataset.id === "106")!;
    const x0 = parseFloat(note.style.left);
    dispatch(note, "keydown", { key: "Enter" });
    expect(win.opened).toContain("http://x/s3");
    expect(marked).toEqual([106]);
    dispatch(note, "keydown", { key: "ArrowRight" });
    expect(parseFloat(note.style.left)).toBe(x0 + 12);
    const saved = JSON.parse(win.localStorage.getItem("longview:canvas:13") || "{}");
    expect(saved["106"][0]).toBe(Math.round(x0 + 12));
  });

  test("wheel zooms around the cursor", () => {
    const h = LV.render(mount, 14, clustersFixture(), {});
    void h;
    const world = mount.querySelector(".cworld")!;
    const t0 = world.style.transform;
    dispatch(mount, "wheel", { clientX: 200, clientY: 150, deltaY: -100 });
    expect(world.style.transform).not.toBe(t0);
    expect(world.style.transform).toContain("scale(");
    h.destroy();
    expect(mount.children.length).toBe(0);
  });
});

/* ---------------- app.js toggle integration ---------------- */

describe("app.js List | Canvas toggle", () => {
  let win: any, doc: any;
  const readCalls: number[] = [];
  const fetched: string[] = [];

  const topic = { id: 1, name: "T", query: "q", schedule: "manual", status: "ok", last_error: null, last_error_class: null, last_crawl_at: null, depth: 3, created_at: 1 };

  async function fakeFetch(url: string, opts: any = {}) {
    fetched.push(`${opts.method || "GET"} ${url}`);
    const ok = (d: any) => ({ ok: true, status: 200, json: async () => d });
    if (url === "/api/topics") return ok({ topics: [{ ...topic, new_count: 2 }] });
    if (url === "/api/research") return ok({ runs: [] });
    if (url === "/api/topics/1") return ok({ topic });
    if (url === "/api/topics/1/findings") return ok({ findings: findingsFixture() });
    if (url === "/api/topics/1/clusters")
      return ok({ ok: true, clusters: clustersFixture() });
    const m = url.match(/^\/api\/findings\/(\d+)\/read$/);
    if (m && opts.method === "POST") { readCalls.push(Number(m[1])); return ok({ ok: true }); }
    throw new Error("unstubbed " + url);
  }

  async function waitFor(fn: () => boolean, ms = 5000) {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > ms) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    win = makeWindow();
    doc = makeDocument();
    const canvasSrc = readFileSync(join(import.meta.dir, "../public/canvas.js"), "utf8");
    const appSrc = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
    new Function("window", "document", "fetch", "setTimeout", "clearTimeout", "confirm", canvasSrc + "\n" + appSrc)(
      win, doc, fakeFetch, setTimeout, clearTimeout, () => true
    );
    // Mirror public/index.html's initial classes (the stub DOM has no markup).
    doc.getElementById("view-list").classList.add("seg-btn", "on");
    doc.getElementById("view-canvas").classList.add("seg-btn");
    doc.getElementById("canvas-wrap").classList.add("hidden");
    doc.getElementById("canvas-reset").classList.add("hidden");
    await waitFor(() => doc.querySelectorAll(".topic-card").length > 0);
    // Open the topic → findings list renders.
    doc.querySelectorAll(".topic-card")[0].click();
    await waitFor(() => doc.getElementById("findings").querySelectorAll(".finding").length === 6);
  });

  test("list is the default view", () => {
    expect(doc.getElementById("view-list").classList.contains("on")).toBe(true);
    expect(doc.getElementById("canvas-wrap").classList.contains("hidden")).toBe(true);
    expect(doc.getElementById("findings").classList.contains("hidden")).toBe(false);
  });

  test("Canvas toggle fetches clusters and renders notes", async () => {
    doc.getElementById("view-canvas").click();
    await waitFor(() => doc.getElementById("canvas").querySelectorAll(".note").length === 6);
    expect(fetched).toContain("GET /api/topics/1/clusters");
    expect(doc.getElementById("findings").classList.contains("hidden")).toBe(true);
    expect(doc.getElementById("canvas-wrap").classList.contains("hidden")).toBe(false);
    expect(doc.getElementById("canvas-reset").classList.contains("hidden")).toBe(false);
    const labels = doc.getElementById("canvas").querySelectorAll(".czone-label")
      .map((z: FakeElement) => z.textContent.toLowerCase()).join("|");
    expect(labels).toContain("tidal");
    expect(labels).toContain("sourdough");
  });

  test("opening a note from the canvas marks it read via the API", async () => {
    const note = doc.getElementById("canvas").querySelectorAll(".note")
      .find((n: FakeElement) => n.dataset.id === "101")!;
    const before = readCalls.length;
    note.querySelector(".note-title a")!.click();
    await waitFor(() => readCalls.length === before + 1);
    expect(readCalls).toContain(101);
    expect(note.classList.contains("read")).toBe(true);
  });

  test("List toggle restores the list view", async () => {
    doc.getElementById("view-list").click();
    await waitFor(() => !doc.getElementById("findings").classList.contains("hidden"));
    expect(doc.getElementById("canvas-wrap").classList.contains("hidden")).toBe(true);
    expect(doc.getElementById("canvas-reset").classList.contains("hidden")).toBe(true);
    expect(doc.getElementById("view-list").classList.contains("on")).toBe(true);
  });
});

