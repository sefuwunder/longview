// Review HUD tests: coverflow target review for agent-run pages.
// DOM-stubbed render of the real public/app.js via fake-dom.
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeElement, makeWindow, makeDocument, dispatch } from "./fake-dom";

const appSrc = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");

// in-memory localStorage shim (bun's test env has none). Installed
// unconditionally: bun shares globalThis across test files and another
// suite's thinner shim (no clear()) may already be present.
{
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

function srcNode(i: number, over: any = {}) {
  return {
    id: "p" + i,
    kind: "source",
    label: "Page " + i + " title",
    url: "https://ex" + i + ".com/article",
    detail: "ex" + i + ".com",
    snippet: "Snippet for page " + i,
    depth: 0,
    kwAdded: [],
    evidence: 0,
    via: null,
    ...over,
  };
}

function makeRun() {
  return {
    question: "solid state batteries?",
    graph: {
      nodes: [
        { id: "q", kind: "question", label: "solid state batteries?", detail: "" },
        srcNode(0),
        srcNode(1, { depth: 2, kwAdded: ["photovoltaic", "inverter"], evidence: 3, via: "ex0.com" }),
        srcNode(2, { depth: 5, evidence: 1 }),
      ],
      edges: [],
    },
  };
}

function bootHud() {
  const win = makeWindow();
  const doc = makeDocument();
  const opened: string[] = [];
  (win as any).open = (u: string) => { opened.push(u); };
  new Function("window", "document", "fetch", "setTimeout", "clearTimeout", "confirm", appSrc)(
    win, doc, async () => ({ ok: true, json: async () => ({}) }), setTimeout, clearTimeout, () => true);
  return { win: win as any, doc, opened };
}

function lockedIndex(doc: any): number {
  const cards = doc.querySelectorAll(".tgt-card");
  for (let i = 0; i < cards.length; i++)
    if (cards[i].classList.contains("locked")) return i;
  return -1;
}

describe("review HUD", () => {
  test("open renders one card per source page with the first locked", () => {
    const { win, doc } = bootHud();
    (globalThis as any).localStorage.clear();
    win.LVReview.open(7, makeRun());
    expect(win.LVReview.isOpen()).toBe(true);
    const cards = doc.querySelectorAll(".tgt-card");
    expect(cards.length).toBe(3);
    expect(lockedIndex(doc)).toBe(0);
    // focused card carries depth badge + HUD readouts
    expect(cards[0].querySelector(".depth").textContent).toBe("SEED");
    expect(doc.getElementById("hud-tgt").querySelector("b")!.textContent).toBe("01");
    // deep page shows its depth and signal keywords
    expect(cards[1].querySelector(".depth").textContent).toBe("D2");
    expect(cards[1].querySelectorAll(".sig").length).toBe(2);
    // data strip shows tracked-from domain
    const dataCell = doc.querySelector('#hud-data .hud-cell .v b')!;
    expect(dataCell.textContent).toBe("SEED");
  });

  test("arrow keys move the lock; tape click jumps", () => {
    const { win, doc } = bootHud();
    win.LVReview.open(7, makeRun());
    dispatch(doc, "keydown", { key: "ArrowRight" });
    expect(lockedIndex(doc)).toBe(1);
    expect(doc.getElementById("hud-tgt").querySelector("b")!.textContent).toBe("02");
    dispatch(doc, "keydown", { key: "ArrowRight" });
    dispatch(doc, "keydown", { key: "ArrowRight" }); // clamps at the end
    expect(lockedIndex(doc)).toBe(2);
    dispatch(doc, "keydown", { key: "ArrowLeft" });
    expect(lockedIndex(doc)).toBe(1);
    // tape jump
    const tapes = doc.querySelectorAll(".tape-i");
    expect(tapes.length).toBe(3);
    dispatch(tapes[0], "click");
    expect(lockedIndex(doc)).toBe(0);
  });

  test("swipe left advances the lock; small drags snap back", () => {
    const { win, doc } = bootHud();
    win.LVReview.open(7, makeRun());
    const stage = doc.getElementById("hud-stage");
    dispatch(stage, "pointerdown", { clientX: 200, pointerId: 1 });
    dispatch(stage, "pointermove", { clientX: 100, pointerId: 1 });
    dispatch(stage, "pointerup", { clientX: 100, pointerId: 1 });
    expect(lockedIndex(doc)).toBe(1);
    // small drag: no movement
    dispatch(stage, "pointerdown", { clientX: 200, pointerId: 2 });
    dispatch(stage, "pointermove", { clientX: 185, pointerId: 2 });
    dispatch(stage, "pointerup", { clientX: 185, pointerId: 2 });
    expect(lockedIndex(doc)).toBe(1);
  });

  test("keep/drop verdicts toggle, update progress, and persist", () => {
    const { win, doc } = bootHud();
    (globalThis as any).localStorage.clear();
    win.LVReview.open(9, makeRun());
    const prog = () => doc.getElementById("hud-prog").innerHTML;
    expect(prog()).toContain("<b>0</b>");
    dispatch(doc.getElementById("hud-keep"), "click");
    expect(prog()).toContain("<b>1</b>");
    expect(doc.querySelector(".tgt-card.locked .verdict.keep")).toBeTruthy();
    // keyboard drop on the next card
    dispatch(doc, "keydown", { key: "ArrowRight" });
    dispatch(doc, "keydown", { key: "x" });
    expect(prog()).toContain("<b>2</b>");
    expect(doc.querySelector(".tgt-card.locked .verdict.drop")).toBeTruthy();
    // persisted across reopen
    win.LVReview.close();
    win.LVReview.open(9, makeRun());
    expect(doc.getElementById("hud-prog").innerHTML).toContain("<b>2</b>");
    // toggle off
    dispatch(doc.getElementById("hud-keep"), "click");
    expect(doc.getElementById("hud-prog").innerHTML).toContain("<b>1</b>");
  });

  test("filter TODO hides decided targets; KEPT shows only keeps", () => {
    const { win, doc } = bootHud();
    (globalThis as any).localStorage.clear();
    win.LVReview.open(11, makeRun());
    dispatch(doc.getElementById("hud-keep"), "click"); // keep card 0
    const btn = (f: string) =>
      doc.querySelector('#hud-filter button[data-f="' + f + '"]');
    dispatch(btn("todo"), "click");
    expect(doc.querySelectorAll(".tgt-card").length).toBe(2);
    dispatch(btn("keep"), "click");
    expect(doc.querySelectorAll(".tgt-card").length).toBe(1);
    expect(doc.querySelector(".tgt-card .verdict.keep")).toBeTruthy();
    dispatch(btn("all"), "click");
    expect(doc.querySelectorAll(".tgt-card").length).toBe(3);
  });

  test("Enter opens the locked page; Escape closes", () => {
    const { win, doc, opened } = bootHud();
    (globalThis as any).localStorage.clear();
    win.LVReview.open(12, makeRun());
    dispatch(doc, "keydown", { key: "Enter" });
    expect(opened).toEqual(["https://ex0.com/article"]);
    dispatch(doc, "keydown", { key: "Escape" });
    expect(win.LVReview.isOpen()).toBe(false);
    expect(doc.getElementById("review-hud").classList.contains("hidden")).toBe(true);
  });

  test("depth tape lights the focused page's depth", () => {
    const { win, doc } = bootHud();
    win.LVReview.open(13, makeRun());
    const alt = doc.getElementById("hud-alt");
    expect(alt.querySelectorAll(".alt-tick").length).toBe(6); // D5..SEED
    expect(alt.querySelector(".alt-tick.on .n").textContent).toBe("SEED");
    dispatch(doc, "keydown", { key: "ArrowRight" });
    dispatch(doc, "keydown", { key: "ArrowRight" });
    expect(doc.getElementById("hud-alt").querySelector(".alt-tick.on .n").textContent).toBe("D5");
  });

  test("run with no sources shows the empty state", () => {
    const { win, doc } = bootHud();
    win.LVReview.open(14, { question: "q", graph: { nodes: [], edges: [] } });
    expect(doc.querySelector(".hud-empty")).toBeTruthy();
    expect(doc.querySelectorAll(".tgt-card").length).toBe(0);
  });
});
