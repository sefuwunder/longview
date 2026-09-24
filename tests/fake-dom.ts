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
    this.textContent = "";
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
  get parentNode(): FakeElement | null { return this.parent; }
  removeChild(c: FakeElement) {
    this.children = this.children.filter((x) => x !== c);
    if (c.parent === this) c.parent = null;
    return c;
  }
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
  let last = 0;
  const pushText = (end: number) => {
    const t = html.slice(last, end);
    if (t) stack[stack.length - 1].textContent += decodeEnt(t);
  };
  while ((m = tagRe.exec(html))) {
    pushText(m.index);
    last = tagRe.lastIndex;
    const [full, tag, attrs, selfClose] = m;
    if (full[1] === "/") { if (stack.length > 1) stack.pop(); continue; }
    const el = new FakeElement(tag);
    parseAttrs(el, attrs);
    stack[stack.length - 1].appendChild(el);
    if (!VOID.has(el.tagName) && !selfClose) stack.push(el);
  }
  pushText(html.length);
}

function decodeEnt(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
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
    createElementNS: (_ns: string, t: string) => new FakeElement(t),
    listeners: {} as Record<string, Function[]>,
    addEventListener: (t: string, fn: Function) => { (doc.listeners[t] = doc.listeners[t] || []).push(fn); },
    removeEventListener: (t: string, fn: Function) => {
      doc.listeners[t] = (doc.listeners[t] || []).filter((f) => f !== fn);
    },
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

export { VOID, FakeEvent, FakeElement, dispatch, makeWindow, makeDocument, stubChild };
