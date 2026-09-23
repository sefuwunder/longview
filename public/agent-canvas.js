/* Longview agent canvas — visualizes a research agent run's output graph:
   question → lines of inquiry → sources → findings.
   Vanilla JS, zero deps. Layout is a pure function (testable); the view is a
   pannable/zoomable layered graph with SVG edges and clickable nodes. */
(function () {
  "use strict";

  var KIND_ORDER = ["question", "subq", "source", "finding"];
  var NODE_SIZE = {
    question: { w: 440, h: 88 },
    subq: { w: 270, h: 84 },
    source: { w: 230, h: 72 },
    finding: { w: 270, h: 100 },
  };
  var COL_GAP = 90, ROW_GAP = 18, PAD = 24;

  /**
   * Pure, deterministic layered layout.
   * graph: { nodes: [{ id, kind, label, ... }], edges: [{ from, to }] }
   * Returns { nodes: { "<id>": { x, y, w, h, kind } }, edges: [{ from, to, d }],
   *           width, height } where d is an SVG path for the edge.
   */
  function layoutAgentGraph(graph, opts) {
    var nodes = (graph && graph.nodes) || [];
    var edges = (graph && graph.edges) || [];
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });

    var layers = KIND_ORDER.map(function (kind) {
      return nodes.filter(function (n) { return n.kind === kind; });
    });
    // Drop empty layers but keep kind order for column placement.
    var cols = [];
    layers.forEach(function (layer, li) {
      if (layer.length === 0) return;
      var w = 0;
      layer.forEach(function (n) {
        var s = NODE_SIZE[n.kind] || NODE_SIZE.source;
        if (s.w > w) w = s.w;
      });
      cols.push({ kind: KIND_ORDER[li], nodes: layer, w: w });
    });

    var colH = cols.map(function (c) {
      var h = 0;
      c.nodes.forEach(function (n) {
        h += (NODE_SIZE[n.kind] || NODE_SIZE.source).h + ROW_GAP;
      });
      return h > 0 ? h - ROW_GAP : 0;
    });
    var H = colH.reduce(function (a, b) { return Math.max(a, b); }, 0);

    var out = { nodes: {}, edges: [], width: 0, height: 0 };
    var cx = PAD;
    cols.forEach(function (c, ci) {
      var cy = PAD + (H - colH[ci]) / 2;
      c.nodes.forEach(function (n) {
        var s = NODE_SIZE[n.kind] || NODE_SIZE.source;
        var x = Math.round(cx + (c.w - s.w) / 2);
        var y = Math.round(cy);
        out.nodes[n.id] = { x: x, y: y, w: s.w, h: s.h, kind: n.kind };
        cy += s.h + ROW_GAP;
      });
      cx += c.w + COL_GAP;
    });
    out.width = Math.round(cx - COL_GAP + PAD);
    out.height = Math.round(H + PAD * 2);

    edges.forEach(function (e) {
      var a = out.nodes[e.from], b = out.nodes[e.to];
      if (!a || !b) return;
      var x1 = a.x + a.w, y1 = a.y + a.h / 2;
      var x2 = b.x, y2 = b.y + b.h / 2;
      var mx = (x1 + x2) / 2;
      out.edges.push({
        from: e.from,
        to: e.to,
        label: e.label || "",
        d: "M" + x1 + "," + y1 + " C" + mx + "," + y1 + " " + mx + "," + y2 + " " + x2 + "," + y2,
      });
    });
    return out;
  }

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /**
   * Render the agent graph into `mount`. Returns { destroy }.
   * hooks: { onOpenSource(url) }.
   */
  function render(mount, graph, hooks) {
    hooks = hooks || {};
    if (mount._lvAgentDestroy) { mount._lvAgentDestroy(); }
    mount.innerHTML = "";

    var layout = layoutAgentGraph(graph);
    var nodeById = {};
    (graph.nodes || []).forEach(function (n) { nodeById[n.id] = n; });

    // Adjacency for neighborhood highlighting.
    var adj = {};
    function link(a, b) {
      (adj[a] = adj[a] || {})[b] = true;
      (adj[b] = adj[b] || {})[a] = true;
    }
    (graph.edges || []).forEach(function (e) { link(e.from, e.to); });

    var wrap = el("div", "ag-wrap");
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", "Research agent output graph");
    mount.appendChild(wrap);

    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "ag-edges");
    svg.setAttribute("width", layout.width);
    svg.setAttribute("height", layout.height);
    wrap.appendChild(svg);

    var edgeEls = [];
    layout.edges.forEach(function (e) {
      var p = document.createElementNS(NS, "path");
      p.setAttribute("d", e.d);
      p.setAttribute("class", "ag-edge");
      p.dataset.from = e.from;
      p.dataset.to = e.to;
      if (e.label) {
        var t = document.createElementNS(NS, "title");
        t.textContent = e.label;
        p.appendChild(t);
      }
      svg.appendChild(p);
      edgeEls.push(p);
    });

    var world = el("div", "ag-world");
    wrap.appendChild(world);

    var nodeEls = {};
    Object.keys(layout.nodes).forEach(function (id) {
      var n = nodeById[id];
      var L = layout.nodes[id];
      if (!n) return;
      var card = el("div", "ag-node ag-" + n.kind);
      card.dataset.id = id;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.style.left = L.x + "px";
      card.style.top = L.y + "px";
      card.style.width = L.w + "px";
      card.style.height = L.h + "px";
      var kindLabel = { question: "Question", subq: "Line of inquiry", source: "Source", finding: "Finding" }[n.kind] || n.kind;
      card.appendChild(el("div", "ag-kind", kindLabel));
      if (n.kind === "source" && n.url) {
        var a = el("a", "ag-title", n.label || n.url);
        a.href = n.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.tabIndex = -1;
        // Clicking the title opens the page; clicking elsewhere selects.
        a.addEventListener("click", function (ev) {
          ev.stopPropagation();
          if (hooks.onOpenSource) { ev.preventDefault(); hooks.onOpenSource(n.url); }
        });
        card.appendChild(a);
        if (n.detail) card.appendChild(el("div", "ag-detail", n.detail));
      } else {
        card.appendChild(el("div", "ag-title", n.label || id));
        if (n.detail) card.appendChild(el("div", "ag-detail", n.detail));
      }
      card.setAttribute("aria-label", kindLabel + ": " + (n.label || id));
      world.appendChild(card);
      nodeEls[id] = card;
    });

    // Legend.
    var legend = el("div", "ag-legend");
    ["question", "subq", "source", "finding"].forEach(function (k) {
      var item = el("span", "ag-legend-item");
      item.appendChild(el("span", "ag-swatch ag-" + k));
      item.appendChild(el("span", null, { question: "Question", subq: "Line of inquiry", source: "Source", finding: "Finding" }[k]));
      legend.appendChild(item);
    });
    mount.appendChild(legend);

    var view = { x: 24, y: 16, k: 1 };
    function applyT() {
      var t = "translate(" + view.x + "px," + view.y + "px) scale(" + view.k + ")";
      world.style.transform = t;
      svg.style.transform = t;
      svg.style.transformOrigin = "0 0";
    }
    applyT();

    /* ---------- selection: neighborhood highlight ---------- */
    var selected = null;
    function select(id) {
      selected = id;
      var keep = {};
      if (id) {
        keep[id] = true;
        Object.keys(adj[id] || {}).forEach(function (nb) { keep[nb] = true; });
      }
      Object.keys(nodeEls).forEach(function (nid) {
        nodeEls[nid].classList.toggle("dim", !!id && !keep[nid]);
        nodeEls[nid].classList.toggle("sel", nid === id);
        nodeEls[nid].setAttribute("aria-pressed", nid === id ? "true" : "false");
      });
      edgeEls.forEach(function (p) {
        var on = !id || (keep[p.dataset.from] && keep[p.dataset.to]);
        p.classList.toggle("dim", !on);
        p.classList.toggle("hl", !!id && on);
      });
    }

    world.addEventListener("click", function (e) {
      var card = e.target.closest ? e.target.closest(".ag-node") : null;
      if (!card || !world.contains(card)) return;
      var id = card.dataset.id;
      select(selected === id ? null : id);
    });
    wrap.addEventListener("click", function (e) {
      // Background click clears the selection.
      if (e.target === wrap || e.target === svg) select(null);
    });
    world.addEventListener("keydown", function (e) {
      var card = e.target.closest ? e.target.closest(".ag-node") : null;
      if (!card) return;
      var id = card.dataset.id;
      var n = nodeById[id];
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (n && n.kind === "source" && n.url) {
          if (hooks.onOpenSource) hooks.onOpenSource(n.url);
          else { try { window.open(n.url, "_blank", "noopener"); } catch (err) {} }
        } else {
          select(selected === id ? null : id);
        }
      } else if (e.key === "Escape") {
        select(null);
      }
    });

    /* ---------- pan / zoom ---------- */
    var panLast = null;
    wrap.addEventListener("pointerdown", function (e) {
      // Node interactions handle themselves; background drag pans.
      if (e.target.closest && e.target.closest(".ag-node")) return;
      panLast = { x: e.clientX, y: e.clientY };
      try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
    });
    wrap.addEventListener("pointermove", function (e) {
      if (!panLast) return;
      view.x += e.clientX - panLast.x;
      view.y += e.clientY - panLast.y;
      panLast = { x: e.clientX, y: e.clientY };
      applyT();
    });
    function endPan() { panLast = null; }
    wrap.addEventListener("pointerup", endPan);
    wrap.addEventListener("pointercancel", endPan);

    function clampK(k) { return Math.max(0.3, Math.min(2.5, k)); }
    wrap.addEventListener("wheel", function (e) {
      e.preventDefault();
      var rect = wrap.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var k2 = clampK(view.k * Math.exp(-e.deltaY * 0.0015));
      var wx = (mx - view.x) / view.k, wy = (my - view.y) / view.k;
      view.k = k2;
      view.x = mx - wx * k2;
      view.y = my - wy * k2;
      applyT();
    }, { passive: false });

    // Fit the graph on first render for narrow screens.
    function fit() {
      var w = wrap.clientWidth || 800;
      if (layout.width > w) {
        view.k = clampK((w - 48) / layout.width);
        applyT();
      }
    }
    fit();

    function destroy() {
      mount.innerHTML = "";
    }
    mount._lvAgentDestroy = destroy;
    return { destroy: destroy, select: select };
  }

  window.LVAgentCanvas = {
    layoutAgentGraph: layoutAgentGraph,
    render: render,
  };
})();
