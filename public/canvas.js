/* Longview cluster canvas — "notes on a canvas" view for topic findings.
   Vanilla JS, zero deps. Layout is a pure function (testable); the view
   renders pannable/zoomable cluster zones with draggable note cards. */
(function () {
  "use strict";

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  var NOTE_W = 300, NOTE_H = 132, PAD = 16, ZONE_GAP = 30, HEAD_H = 46, NOTE_GAP = 12;

  /**
   * Pure, deterministic auto-layout.
   * clusters: [{ label, results: [{ id, ... }] }]
   * opts: { width: number (world units available), seed: number }
   * Narrow canvases stack zones vertically; wide ones lay out left-to-right.
   * Returns { zones: [{ label, count, x, y, w, h }], notes: { "<id>": { x, y } }, width, height }.
   */
  function layoutClusters(clusters, opts) {
    var width = (opts && opts.width) || 1200;
    var narrow = width < 620;
    var rng = mulberry32((opts && opts.seed != null ? opts.seed : 0xc1a05) >>> 0);
    var zoneW = narrow ? Math.max(280, width - 32) : NOTE_W + PAD * 2;
    var zones = [], notes = {};
    var cx = PAD, cy = PAD, maxH = 0;
    clusters.forEach(function (c) {
      var count = c.results.length;
      var zoneH = HEAD_H + count * (NOTE_H + NOTE_GAP) + PAD;
      var zx = narrow ? PAD : cx, zy = narrow ? cy : PAD;
      var zone = { label: c.label, count: count, x: zx, y: zy, w: zoneW, h: zoneH };
      zones.push(zone);
      c.results.forEach(function (r, i) {
        // Seeded scatter so the initial layout is stable across renders.
        var jx = (rng() - 0.5) * 12;
        var nx = zx + (zoneW - NOTE_W) / 2 + jx;
        if (nx < zx + 4) nx = zx + 4;
        if (nx + NOTE_W > zx + zoneW - 4) nx = zx + zoneW - NOTE_W - 4;
        notes[String(r.id)] = {
          x: Math.round(nx),
          y: Math.round(zy + HEAD_H + i * (NOTE_H + NOTE_GAP)),
        };
      });
      if (narrow) { cy += zoneH + ZONE_GAP; maxH = cy; }
      else { cx += zoneW + ZONE_GAP; if (zoneH > maxH) maxH = zoneH; }
    });
    return {
      zones: zones,
      notes: notes,
      width: Math.round(narrow ? width : cx),
      height: Math.round(narrow ? maxH : PAD * 2 + maxH),
    };
  }

  /* Custom note positions, persisted per topic. Values are canvas (world) coords. */
  var store = {
    key: function (topicId) { return "longview:canvas:" + topicId; },
    read: function (topicId) {
      try {
        var raw = window.localStorage.getItem(store.key(topicId));
        var o = raw ? JSON.parse(raw) : {};
        return o && typeof o === "object" ? o : {};
      } catch (e) { return {}; }
    },
    write: function (topicId, id, x, y) {
      try {
        var o = store.read(topicId);
        o[String(id)] = [Math.round(x), Math.round(y)];
        window.localStorage.setItem(store.key(topicId), JSON.stringify(o));
      } catch (e) { /* storage unavailable — layout just won't persist */ }
    },
    clear: function (topicId) {
      try { window.localStorage.removeItem(store.key(topicId)); } catch (e) {}
    },
  };

  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch (e) { return ""; }
  }

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  /**
   * Render the canvas into `mount`. Returns a handle { destroy, setRead }.
   * hooks: { onOpen(url, id), onMarkRead(id) }.
   */
  function render(mount, topicId, clusters, hooks) {
    hooks = hooks || {};
    // Clear any previous view (and its listeners).
    if (mount._lvDestroy) { mount._lvDestroy(); }
    mount.innerHTML = "";

    var world = el("div", "cworld");
    mount.appendChild(world);
    var view = { x: 24, y: 16, k: 1 };
    function applyT() {
      world.style.transform =
        "translate(" + view.x + "px," + view.y + "px) scale(" + view.k + ")";
    }

    var custom = store.read(topicId);
    var seedBase = hashStr("lv" + topicId);
    function doLayout() {
      var w = mount.clientWidth || 1200;
      var layout = layoutClusters(clusters, { width: w, seed: seedBase });
      // Overlay persisted custom positions on top of the auto-layout.
      Object.keys(custom).forEach(function (id) {
        if (layout.notes[id] && Array.isArray(custom[id])) {
          layout.notes[id] = { x: custom[id][0], y: custom[id][1] };
        }
      });
      return layout;
    }
    var layout = doLayout();

    var noteEls = {}; // "<id>" -> element

    layout.zones.forEach(function (z, zi) {
      var zone = el("div", "czone");
      zone.style.left = z.x + "px"; zone.style.top = z.y + "px";
      zone.style.width = z.w + "px"; zone.style.height = z.h + "px";
      var head = el("div", "czone-head");
      head.appendChild(el("span", "czone-label", z.label));
      head.appendChild(el("span", "czone-count", String(z.count)));
      zone.appendChild(head);
      world.appendChild(zone);
    });

    clusters.forEach(function (c) {
      c.results.forEach(function (r) {
        var p = layout.notes[String(r.id)];
        var note = el("div", "note" + (r.read ? " read" : ""));
        note.dataset.id = String(r.id);
        note.tabIndex = 0;
        note.setAttribute("role", "article");
        note.setAttribute("aria-label", r.title || "finding");
        note.style.left = p.x + "px"; note.style.top = p.y + "px";
        if (!r.read) note.appendChild(el("span", "note-dot"));
        var title = el("div", "note-title");
        var a = el("a", null, r.title || "(untitled)");
        a.href = r.url; a.target = "_blank"; a.rel = "noopener"; a.tabIndex = -1;
        title.appendChild(a);
        note.appendChild(title);
        var dom = domainOf(r.url);
        if (dom) note.appendChild(el("div", "note-domain", dom));
        if (r.snippet) note.appendChild(el("div", "note-snip", r.snippet));
        note.draggable = false;
        world.appendChild(note);
        noteEls[String(r.id)] = note;
      });
    });
    applyT();

    /* ---------- pan / zoom ---------- */
    var pointers = {}; // pointerId -> { x, y }
    var panLast = null, pinchD0 = 0, pinchK0 = 1, pinchMid0 = null;
    var drag = null; // active note drag
    var suppressClick = false;

    function clampK(k) { return Math.max(0.35, Math.min(2.5, k)); }

    mount.addEventListener("pointerdown", function (e) {
      var note = e.target.closest ? e.target.closest(".note") : null;
      if (note && mount.contains(note)) {
        var id = note.dataset.id;
        var p = layout.notes[id];
        drag = {
          id: id, el: note, ox: p.x, oy: p.y,
          sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: 0,
        };
      } else {
        panLast = { x: e.clientX, y: e.clientY };
      }
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (Object.keys(pointers).length === 2) {
        var ids = Object.keys(pointers);
        var p0 = pointers[ids[0]], p1 = pointers[ids[1]];
        pinchD0 = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
        pinchK0 = view.k;
        pinchMid0 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
        panLast = { x: pinchMid0.x, y: pinchMid0.y };
        drag = null;
      }
      try { mount.setPointerCapture(e.pointerId); } catch (err) {}
    });

    mount.addEventListener("pointermove", function (e) {
      if (!(e.pointerId in pointers)) return;
      var prev = pointers[e.pointerId];
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        // Pinch: zoom about the midpoint, pan with it.
        var p0 = pointers[ids[0]], p1 = pointers[ids[1]];
        var d = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
        var mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
        var rect = mount.getBoundingClientRect();
        var mx = mid.x - rect.left, my = mid.y - rect.top;
        var k2 = clampK(pinchK0 * (d / pinchD0));
        // Zoom about the midpoint, then pan with the fingers.
        var wx = (mx - view.x) / view.k, wy = (my - view.y) / view.k;
        view.k = k2;
        view.x = mx - wx * k2 + (mid.x - panLast.x);
        view.y = my - wy * k2 + (mid.y - panLast.y);
        panLast = { x: mid.x, y: mid.y };
        applyT();
        return;
      }
      if (drag) {
        drag.lx = e.clientX; drag.ly = e.clientY;
        drag.moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
        var nx = drag.ox + (e.clientX - drag.sx) / view.k;
        var ny = drag.oy + (e.clientY - drag.sy) / view.k;
        drag.el.style.left = nx + "px"; drag.el.style.top = ny + "px";
        drag.nx = nx; drag.ny = ny;
      } else if (panLast) {
        view.x += e.clientX - panLast.x;
        view.y += e.clientY - panLast.y;
        panLast = { x: e.clientX, y: e.clientY };
        applyT();
      }
    });

    function endPointer(e) {
      delete pointers[e.pointerId];
      if (drag && e.pointerId !== undefined) {
        if (drag.moved > 6) {
          // Real drag → persist the drop position, swallow the click.
          layout.notes[drag.id] = { x: drag.nx, y: drag.ny };
          store.write(topicId, drag.id, drag.nx, drag.ny);
          custom = store.read(topicId);
          suppressClick = true;
          setTimeout(function () { suppressClick = false; }, 0);
        }
        drag = null;
      }
      if (Object.keys(pointers).length === 0) panLast = null;
    }
    mount.addEventListener("pointerup", endPointer);
    mount.addEventListener("pointercancel", endPointer);

    // Clicking a note's title opens it (and marks it read); a drag swallows the click.
    world.addEventListener("click", function (e) {
      if (suppressClick) { e.preventDefault(); e.stopPropagation(); return; }
      var a = e.target.closest ? e.target.closest(".note a") : null;
      if (!a) return;
      var note = a.closest(".note");
      var id = Number(note.dataset.id);
      e.preventDefault();
      openFinding(a.href, id);
    }, true);

    mount.addEventListener("wheel", function (e) {
      e.preventDefault();
      var rect = mount.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var k2 = clampK(view.k * Math.exp(-e.deltaY * 0.0015));
      var wx = (mx - view.x) / view.k, wy = (my - view.y) / view.k;
      view.k = k2;
      view.x = mx - wx * k2;
      view.y = my - wy * k2;
      applyT();
    }, { passive: false });

    function openFinding(url, id) {
      try { window.open(url, "_blank", "noopener"); } catch (err) {}
      if (hooks.onMarkRead) hooks.onMarkRead(id);
      setRead(id, true);
    }

    function setRead(id, read) {
      var note = noteEls[String(id)];
      if (!note) return;
      note.classList.toggle("read", !!read);
      var dot = note.querySelector(".note-dot");
      if (read && dot) dot.remove();
      if (!read && !dot) note.insertBefore(el("span", "note-dot"), note.firstChild);
    }

    /* ---------- keyboard ---------- */
    world.addEventListener("keydown", function (e) {
      var note = e.target.closest ? e.target.closest(".note") : null;
      if (!note) return;
      var id = note.dataset.id;
      var p = layout.notes[id];
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        var a = note.querySelector(".note-title a");
        if (a) openFinding(a.href, Number(id));
      } else if (e.key.indexOf("Arrow") === 0) {
        e.preventDefault();
        var step = e.shiftKey ? 48 : 12;
        var nx = p.x, ny = p.y;
        if (e.key === "ArrowLeft") nx -= step;
        if (e.key === "ArrowRight") nx += step;
        if (e.key === "ArrowUp") ny -= step;
        if (e.key === "ArrowDown") ny += step;
        layout.notes[id] = { x: nx, y: ny };
        note.style.left = nx + "px"; note.style.top = ny + "px";
        store.write(topicId, id, nx, ny);
        custom = store.read(topicId);
      }
    });

    /* ---------- resize: re-run auto-layout when narrow/wide flips ---------- */
    var lastNarrow = (mount.clientWidth || 1200) < 620;
    var rsz = null;
    function onResize() {
      var narrow = (mount.clientWidth || 1200) < 620;
      if (narrow === lastNarrow) return;
      lastNarrow = narrow;
      var fresh = doLayout();
      // Keep custom positions; move auto-positioned notes to the new layout.
      Object.keys(layout.notes).forEach(function (id) {
        var isCustom = custom[id] && Array.isArray(custom[id]);
        if (!isCustom && noteEls[id]) {
          layout.notes[id] = fresh.notes[id];
          noteEls[id].style.left = fresh.notes[id].x + "px";
          noteEls[id].style.top = fresh.notes[id].y + "px";
        }
      });
      // Rebuild zone boxes.
      var zones = world.querySelectorAll(".czone");
      for (var i = zones.length - 1; i >= 0; i--) zones[i].remove();
      fresh.zones.forEach(function (z) {
        var zone = el("div", "czone");
        zone.style.left = z.x + "px"; zone.style.top = z.y + "px";
        zone.style.width = z.w + "px"; zone.style.height = z.h + "px";
        var head = el("div", "czone-head");
        head.appendChild(el("span", "czone-label", z.label));
        head.appendChild(el("span", "czone-count", String(z.count)));
        zone.appendChild(head);
        world.insertBefore(zone, world.firstChild);
      });
    }
    window.addEventListener("resize", function () {
      clearTimeout(rsz);
      rsz = setTimeout(onResize, 200);
    });

    function destroy() {
      window.removeEventListener("resize", onResize);
      mount.innerHTML = "";
    }
    mount._lvDestroy = destroy;

    return { destroy: destroy, setRead: setRead };
  }

  window.LVCanvas = {
    layoutClusters: layoutClusters,
    store: store,
    render: render,
    mulberry32: mulberry32,
  };
})();
