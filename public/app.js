/* Longview dashboard — vanilla JS. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };

  var noticeTimer = null;
  function notice(msg, isErr) {
    var n = $("notice");
    n.textContent = msg;
    n.classList.toggle("err", !!isErr);
    n.classList.remove("hidden");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { n.classList.add("hidden"); }, 4000);
  }

  async function api(path, opts) {
    var res = await fetch(path, Object.assign({
      headers: { "Content-Type": "application/json" },
    }, opts || {}));
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-json */ }
    if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
    return data;
  }

  /* ---------- tabs ---------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  tabs.forEach(function (t) {
    t.addEventListener("click", function () {
      tabs.forEach(function (x) { x.classList.remove("on"); x.setAttribute("aria-selected", "false"); });
      t.classList.add("on");
      t.setAttribute("aria-selected", "true");
      tabs.forEach(function (x) {
        $("tab-" + x.dataset.tab).classList.toggle("hidden", x !== t);
      });
      if (t.dataset.tab === "settings") loadSettings();
    });
  });

  /* ---------- topics ---------- */
  var currentTopic = null;

  function fmtTime(ms) {
    if (!ms) return "never";
    return new Date(ms).toLocaleString();
  }

  function scheduleLabel(s) {
    return s === "daily" ? "Daily" : s === "weekly" ? "Weekly" : "Manual";
  }

  /* Per-class hints shown under the persisted crawl-failure banner. */
  function errorHint(cls) {
    switch (cls) {
      case "challenge":
        return "DuckDuckGo is showing a bot check to this network. Crawling may work later or from a different IP.";
      case "timeout":
        return "The request timed out. Check your connection and try again.";
      case "network":
        return "Could not reach DuckDuckGo. Check your connection and try again.";
      case "parse_empty":
        return "DuckDuckGo answered but no results could be read — the page format may have changed.";
      default:
        if (cls && cls.indexOf("http_") === 0)
          return "DuckDuckGo returned an error (" + cls.slice(5) + "). Try again later.";
        return "Try again later, or run Diagnose below to see which endpoint works from this network.";
    }
  }

  async function loadTopics() {
    var data = await api("/api/topics");
    var list = $("topic-list");
    $("topic-empty").classList.toggle("hidden", data.topics.length > 0);
    list.innerHTML = data.topics.map(function (t) {
      var badges = '<span class="badge">' + esc(scheduleLabel(t.schedule)) + "</span>";
      if (t.new_count > 0) badges += ' <span class="badge new">' + t.new_count + " new</span>";
      if (t.status === "error") badges += ' <span class="badge err">crawl error</span>';
      return (
        '<div class="topic-card" data-id="' + t.id + '" role="button" tabindex="0">' +
        "<h3>" + esc(t.name) + "</h3>" +
        '<span class="query">' + esc(t.query) + "</span>" +
        '<div class="foot">' + badges +
        "<span>last crawl: " + esc(fmtTime(t.last_crawl_at)) + "</span></div>" +
        "</div>"
      );
    }).join("");
    Array.prototype.forEach.call(list.querySelectorAll(".topic-card"), function (el) {
      var open = function () { openTopic(Number(el.dataset.id)); };
      el.addEventListener("click", open);
      el.addEventListener("keydown", function (e) { if (e.key === "Enter") open(); });
    });
  }

  $("btn-add-topic").addEventListener("click", function () {
    $("topic-form").classList.remove("hidden");
    $("topic-name").focus();
  });
  $("topic-cancel").addEventListener("click", function () {
    $("topic-form").classList.add("hidden");
  });
  $("topic-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    try {
      await api("/api/topics", {
        method: "POST",
        body: JSON.stringify({
          name: $("topic-name").value,
          query: $("topic-query").value,
          schedule: $("topic-schedule").value,
          depth: Number($("topic-depth").value),
        }),
      });
      $("topic-form").reset();
      $("topic-form").classList.add("hidden");
      await loadTopics();
      notice("Topic added.");
    } catch (err) { notice(err.message, true); }
  });

  function viaDomain(u) {
    try { return new URL(u).hostname.replace(/^www\./, ""); }
    catch (e) { return null; }
  }

  /* Depth badge (L2) + "via <domain>" provenance for deep-crawl findings. */
  function provenance(f) {
    var bits = "";
    if (f.depth > 0) bits += '<span class="badge depth" title="Found ' + f.depth + ' link layer' + (f.depth === 1 ? "" : "s") + ' deep">L' + f.depth + "</span>";
    if (f.via_url) {
      var d = viaDomain(f.via_url);
      if (d) bits += '<span class="via">via ' + esc(d) + "</span>";
    }
    return bits;
  }

  function dayLabel(ms) {
    var d = new Date(ms);
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var day = new Date(ms); day.setHours(0, 0, 0, 0);
    var diff = Math.round((today - day) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }

  async function openTopic(id) {
    try {
      var data = await api("/api/topics/" + id);
      currentTopic = data.topic;
      $("topic-list").classList.add("hidden");
      $("topic-empty").classList.add("hidden");
      document.querySelector("#tab-topics .toolbar").classList.add("hidden");
      $("topic-form").classList.add("hidden");
      $("topic-detail").classList.remove("hidden");
      $("detail-name").textContent = currentTopic.name;
      $("detail-query").textContent = currentTopic.query;
      $("detail-sched").textContent = scheduleLabel(currentTopic.schedule);
      $("detail-last").textContent = "Last crawled: " + fmtTime(currentTopic.last_crawl_at);
      var dd = $("detail-depth");
      if (dd.options.length === 0) {
        for (var i = 1; i <= 10; i++) {
          var opt = document.createElement("option");
          opt.value = String(i);
          opt.textContent = i + (i === 1 ? " layer" : " layers");
          dd.appendChild(opt);
        }
      }
      dd.value = String(currentTopic.depth || 3);
      $("detail-depth-badge").textContent = "depth " + (currentTopic.depth || 3);
      var eb = $("detail-error");
      if (currentTopic.status === "error") {
        eb.classList.remove("hidden");
        eb.innerHTML =
          '<div class="err-banner"><strong>Crawl failed.</strong> ' +
          esc(currentTopic.last_error || "unknown error") +
          '<div class="hint">' + esc(errorHint(currentTopic.last_error_class)) + "</div></div>";
      } else {
        eb.classList.add("hidden");
        eb.innerHTML = "";
      }
      $("diag-out").classList.add("hidden");
      $("diag-out").innerHTML = "";
      await loadFindings(id);
    } catch (err) { notice(err.message, true); }
  }

  async function loadFindings(id) {
    var data = await api("/api/topics/" + id + "/findings");
    var box = $("findings");
    if (data.findings.length === 0) {
      box.innerHTML = '<div class="empty">No findings yet. Re-crawl to fetch the first batch from DuckDuckGo.</div>';
      return;
    }
    var html = "", lastDay = "";
    data.findings.forEach(function (f) {
      var day = dayLabel(f.found_at);
      if (day !== lastDay) { html += '<div class="day-head">' + esc(day) + "</div>"; lastDay = day; }
      html +=
        '<div class="finding' + (f.is_new ? "" : " read") + '" data-id="' + f.id + '">' +
        '<div class="f-title"><a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(f.title) + "</a></div>" +
        (f.snippet ? '<div class="f-snip">' + esc(f.snippet) + "</div>" : "") +
        '<div class="f-foot"><span>' + esc(new Date(f.found_at).toLocaleTimeString()) + "</span>" +
        provenance(f) +
        (f.is_new
          ? '<span class="badge new">new</span><button class="linklike" data-act="read">mark read</button>'
          : "<span>read</span>") +
        "</div></div>";
    });
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('[data-act="read"]'), function (btn) {
      btn.addEventListener("click", async function (e) {
        e.stopPropagation();
        var fid = btn.closest(".finding").dataset.id;
        try {
          await api("/api/findings/" + fid + "/read", { method: "POST" });
          await loadFindings(currentTopic.id);
          await loadTopics();
        } catch (err) { notice(err.message, true); }
      });
    });
    // Re-crawls and topic switches land here; keep the canvas in sync when active.
    if (typeof findingsView !== "undefined" && findingsView === "canvas") loadCanvas();
  }

  /* ---------- findings: List | Canvas ---------- */
  var findingsView = "list";
  var canvasHandle = null;

  async function loadCanvas() {
    if (!currentTopic) return;
    if (!window.LVCanvas) {
      $("canvas").innerHTML = '<div class="empty">Canvas view failed to load.</div>';
      return;
    }
    try {
      var data = await api("/api/topics/" + currentTopic.id + "/clusters");
      if (canvasHandle) { canvasHandle.destroy(); canvasHandle = null; }
      if (data.clusters.length === 0) {
        $("canvas").innerHTML = '<div class="empty">No findings yet. Re-crawl to fetch the first batch.</div>';
        return;
      }
      canvasHandle = window.LVCanvas.render($("canvas"), currentTopic.id, data.clusters, {
        onMarkRead: async function (id) {
          try {
            await api("/api/findings/" + id + "/read", { method: "POST" });
            await loadTopics();
          } catch (err) { notice(err.message, true); }
        },
      });
    } catch (err) { notice(err.message, true); }
  }

  function setFindingsView(v) {
    findingsView = v;
    var isCanvas = v === "canvas";
    $("view-list").classList.toggle("on", !isCanvas);
    $("view-canvas").classList.toggle("on", isCanvas);
    $("view-list").setAttribute("aria-selected", String(!isCanvas));
    $("view-canvas").setAttribute("aria-selected", String(isCanvas));
    $("findings").classList.toggle("hidden", isCanvas);
    $("canvas-wrap").classList.toggle("hidden", !isCanvas);
    $("canvas-reset").classList.toggle("hidden", !isCanvas);
    if (!currentTopic) return;
    if (isCanvas) loadCanvas();
    else loadFindings(currentTopic.id); // refresh read states after canvas marking
  }

  $("view-list").addEventListener("click", function () { setFindingsView("list"); });
  $("view-canvas").addEventListener("click", function () { setFindingsView("canvas"); });
  $("canvas-reset").addEventListener("click", function () {
    if (!currentTopic || !window.LVCanvas) return;
    window.LVCanvas.store.clear(currentTopic.id);
    loadCanvas();
    notice("Canvas layout reset.");
  });

  $("btn-back-topics").addEventListener("click", function () {
    currentTopic = null;
    $("topic-detail").classList.add("hidden");
    $("topic-list").classList.remove("hidden");
    document.querySelector("#tab-topics .toolbar").classList.remove("hidden");
    loadTopics();
  });

  $("btn-crawl").addEventListener("click", async function () {
    if (!currentTopic) return;
    var btn = $("btn-crawl");
    btn.disabled = true;
    btn.textContent = "Crawling…";
    try {
      var data = await api("/api/topics/" + currentTopic.id + "/crawl", { method: "POST" });
      notice("Crawl finished — " + data.added + " new of " + data.total + " pages" +
        (data.discovered ? " (" + data.discovered + " discovered by deep crawl)" : "") + ".");
      await openTopic(currentTopic.id);
      await loadTopics();
    } catch (err) { notice(err.message, true); }
    finally { btn.disabled = false; btn.textContent = "Re-crawl now"; }
  });

  $("btn-diag").addEventListener("click", async function () {
    if (!currentTopic) return;
    var btn = $("btn-diag");
    var out = $("diag-out");
    btn.disabled = true;
    btn.textContent = "Probing…";
    out.classList.remove("hidden");
    out.innerHTML = '<div class="meta dim">Probing…</div>';
    try {
      var d = await api("/api/diag/crawl?q=" + encodeURIComponent(currentTopic.query));
      out.innerHTML = '<div class="meta dim">Probing ' + esc(d.backend === "exa" ? "Exa" : "DuckDuckGo") + ' endpoints…</div>';
      var rows = d.endpoints.map(function (e) {
        var win = e.endpoint === d.winner;
        return "<tr" + (win ? ' class="winner"' : "") + ">" +
          "<td>" + esc(e.endpoint) + (win ? ' <span class="badge new">works</span>' : "") + "</td>" +
          "<td>" + (e.httpStatus == null ? "—" : esc(String(e.httpStatus))) + "</td>" +
          "<td>" + esc(String(e.resultCount)) + "</td>" +
          "<td>" + esc(e.errorClass || "ok") + "</td>" +
          "<td>" + esc(String(e.ms)) + " ms</td></tr>";
      }).join("");
      out.innerHTML =
        '<div class="diag-wrap"><table class="diag-table"><thead><tr>' +
        "<th>Endpoint</th><th>HTTP</th><th>Results</th><th>Class</th><th>Time</th>" +
        "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
        (d.winner
          ? ""
          : '<div class="meta dim" style="margin-top:0.4rem">None of the endpoints returned results from this network.</div>') +
        (d.backend === "exa" && !d.keyConfigured
          ? '<div class="err-line" style="margin-top:0.4rem">EXA_API_KEY is not set — the Exa backend cannot work until you configure a key (see the Settings tab).</div>'
          : "");
    } catch (err) {
      out.innerHTML = '<div class="err-line">' + esc(err.message) + "</div>";
    } finally {
      btn.disabled = false;
      btn.textContent = "Diagnose";
    }
  });

  /* Topic depth can be changed from the detail view; PATCHes the topic. */
  $("detail-depth").addEventListener("change", async function () {
    if (!currentTopic) return;
    var n = Number($("detail-depth").value);
    try {
      var data = await api("/api/topics/" + currentTopic.id, {
        method: "PATCH",
        body: JSON.stringify({ depth: n }),
      });
      currentTopic = data.topic;
      $("detail-depth-badge").textContent = "depth " + data.topic.depth;
      notice("Crawl depth set to " + data.topic.depth + ".");
    } catch (err) {
      notice(err.message, true);
      $("detail-depth").value = String(currentTopic.depth || 3);
    }
  });

  $("btn-delete-topic").addEventListener("click", async function () {
    if (!currentTopic) return;
    if (!confirm('Delete "' + currentTopic.name + '" and all its findings?')) return;
    try {
      await api("/api/topics/" + currentTopic.id, { method: "DELETE" });
      $("btn-back-topics").click();
      notice("Topic deleted.");
    } catch (err) { notice(err.message, true); }
  });

  /* ---------- research agent ---------- */
  var agentPollTimer = null;
  var agentGraphHandle = null;
  var agentView = "graph";

  var STEP_ICON = {
    plan: "🧭", search: "🔍", read: "📖", reflect: "🤔",
    followup: "🔁", synthesize: "🧩", done: "✅", error: "❌",
  };

  function renderSteps(steps) {
    var box = $("agent-steps");
    if (!steps || steps.length === 0) {
      box.innerHTML = '<div class="meta dim">Waiting for the agent to start…</div>';
      return;
    }
    box.innerHTML = steps.map(function (s) {
      return '<div class="step step-' + esc(s.kind) + '">' +
        '<span class="step-icon">' + (STEP_ICON[s.kind] || "•") + "</span>" +
        '<div class="step-body"><div class="step-label">' + esc(s.label) + "</div>" +
        (s.detail ? '<div class="step-detail">' + esc(s.detail) + "</div>" : "") +
        "</div></div>";
    }).join("");
    box.scrollTop = box.scrollHeight;
  }

  function setAgentView(v) {
    agentView = v;
    var isGraph = v === "graph";
    $("agent-view-graph").classList.toggle("on", isGraph);
    $("agent-view-report").classList.toggle("on", !isGraph);
    $("agent-view-graph").setAttribute("aria-selected", String(isGraph));
    $("agent-view-report").setAttribute("aria-selected", String(!isGraph));
    $("agent-graph-wrap").classList.toggle("hidden", !isGraph);
    $("agent-report-wrap").classList.toggle("hidden", isGraph);
  }

  $("agent-view-graph").addEventListener("click", function () { setAgentView("graph"); });
  $("agent-view-report").addEventListener("click", function () { setAgentView("report"); });

  /* ---------- research desk: center view switching ---------- */
  // The desk center shows one of: the folder-filtered run list (agent-home),
  // a run's detail (agent-wrap), or a journal (journal-wrap).
  function showDeskCenter(which) {
    $("agent-home").classList.toggle("hidden", which !== "home");
    $("agent-wrap").classList.toggle("hidden", which !== "run");
    $("journal-wrap").classList.toggle("hidden", which !== "journal");
  }

  /* ---------- research desk: folders ---------- */
  // folderFilter: "all" | "unfiled" | <folder id>
  var folderFilter = "all";
  var folderCache = []; // flat list from GET /api/folders
  var unfiledCount = 0;

  function folderName(id) {
    if (id === null || id === undefined) return "Unfiled";
    var f = null;
    for (var i = 0; i < folderCache.length; i++) {
      if (folderCache[i].id === id) { f = folderCache[i]; break; }
    }
    return f ? f.name : "Unfiled";
  }

  function folderLabel(filter) {
    if (filter === "all") return "All runs";
    if (filter === "unfiled") return "Unfiled";
    return folderName(filter);
  }

  async function loadFolders() {
    try {
      var data = await api("/api/folders");
      folderCache = data.folders;
      unfiledCount = data.unfiled_count;
      renderFolderTree();
    } catch (err) { notice(err.message, true); }
  }

  function folderChildren(pid) {
    return folderCache.filter(function (f) { return (f.parent_id || null) === (pid || null); });
  }

  function renderFolderTree() {
    var box = $("folder-tree");
    var html = "";
    function row(id, name, count, depth, kind) {
      var sel = folderFilter === id || (kind === "all" && folderFilter === "all") || (kind === "unfiled" && folderFilter === "unfiled");
      return '<div class="ftree-row' + (sel ? " sel" : "") + '" role="treeitem" data-kind="' + kind + '"' +
        (kind === "folder" ? ' data-id="' + id + '"' : "") +
        ' style="padding-left:' + (0.5 + depth * 1.1) + 'rem" tabindex="0">' +
        '<span class="ftree-name">' + esc(name) + "</span>" +
        ' <span class="badge">' + count + "</span>" +
        (kind === "folder" ? '<button class="linklike ftree-menu" data-id="' + id + '" title="Folder options">⋯</button>' : "") +
        "</div>";
    }
    var total = folderCache.reduce(function (a, f) { return a + (f.run_count || 0); }, 0) + unfiledCount;
    html += row("all", "All runs", total, 0, "all");
    html += row("unfiled", "Unfiled", unfiledCount, 0, "unfiled");
    (function walk(pid, depth) {
      folderChildren(pid).forEach(function (f) {
        html += row(f.id, f.name, f.run_count || 0, depth, "folder");
        walk(f.id, depth + 1);
      });
    })(null, 0);
    box.innerHTML = html || '<div class="meta dim">No folders yet.</div>';
    Array.prototype.forEach.call(box.querySelectorAll(".ftree-row"), function (el) {
      var pick = function (e) {
        if (e && e.target && e.target.classList && e.target.classList.contains("ftree-menu")) return;
        var kind = el.dataset.kind;
        folderFilter = kind === "folder" ? Number(el.dataset.id) : kind;
        currentJournal = null;
        renderFolderTree();
        showDeskCenter("home");
        loadAgentRuns();
      };
      el.addEventListener("click", pick);
      el.addEventListener("keydown", function (e) { if (e.key === "Enter") pick(e); });
    });
    Array.prototype.forEach.call(box.querySelectorAll(".ftree-menu"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        openFolderMenu(btn, Number(btn.dataset.id));
      });
    });
  }

  /* Small popover menu anchored near a button; closes on outside click. */
  function closePopover() {
    var p = document.querySelector(".popover");
    if (p && p.parentNode) p.parentNode.removeChild(p);
    document.removeEventListener("click", closePopover, true);
  }
  function openPopover(anchor, html) {
    closePopover();
    var p = document.createElement("div");
    p.className = "popover";
    p.innerHTML = html;
    document.body.appendChild(p);
    var r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { bottom: 0, left: 0 };
    p.style.top = (r.bottom + (window.scrollY || 0) + 4) + "px";
    p.style.left = (r.left + (window.scrollX || 0)) + "px";
    setTimeout(function () {
      document.addEventListener("click", closePopover, true);
    }, 0);
    return p;
  }

  function folderOptions(excludeId) {
    var opts = '<option value="">Top level</option>';
    folderCache.forEach(function (f) {
      if (f.id !== excludeId) opts += '<option value="' + f.id + '">' + esc(f.name) + "</option>";
    });
    return opts;
  }

  function openFolderMenu(btn, id) {
    var p = openPopover(btn,
      '<button data-act="rename">Rename</button>' +
      '<button data-act="sub">New subfolder</button>' +
      '<button data-act="move">Move to…</button>' +
      '<button data-act="del" class="danger">Delete</button>');
    p.addEventListener("click", function (e) {
      var act = e.target && e.target.dataset ? e.target.dataset.act : null;
      if (!act) return;
      closePopover();
      if (act === "rename") folderPrompt("Rename folder", folderName(id), function (name) {
        api("/api/folders/" + id, { method: "PATCH", body: JSON.stringify({ name: name }) })
          .then(loadFolders).catch(function (err) { notice(err.message, true); });
      });
      else if (act === "sub") folderPrompt("New subfolder", "", function (name) {
        api("/api/folders", { method: "POST", body: JSON.stringify({ name: name, parent_id: id }) })
          .then(function () { loadFolders(); notice("Subfolder created."); })
          .catch(function (err) { notice(err.message, true); });
      });
      else if (act === "move") {
        var q = openPopover(btn, '<select id="mv-parent">' + folderOptions(id) + "</select>" +
          '<button data-act="go">Move</button>');
        var sel = q.querySelector("#mv-parent");
        q.addEventListener("click", function (ev) {
          if (ev.target && ev.target.dataset && ev.target.dataset.act === "go") {
            var pid = sel.value === "" ? null : Number(sel.value);
            api("/api/folders/" + id, { method: "PATCH", body: JSON.stringify({ parent_id: pid }) })
              .then(loadFolders).catch(function (err) { notice(err.message, true); });
            closePopover();
          }
        });
      }
      else if (act === "del") {
        if (!confirm('Delete folder "' + folderName(id) + '"? Its runs become Unfiled; nothing is deleted.')) return;
        api("/api/folders/" + id, { method: "DELETE" })
          .then(function () {
            if (folderFilter === id) folderFilter = "all";
            loadFolders(); loadAgentRuns(); notice("Folder deleted — its runs are Unfiled.");
          })
          .catch(function (err) { notice(err.message, true); });
      }
    });
  }

  /* Inline prompt popover with a single text input. */
  function folderPrompt(title, initial, onOk) {
    var p = openPopover($("btn-add-folder"),
      '<div class="pp-title">' + esc(title) + "</div>" +
      '<input id="pp-input" maxlength="80" value="' + esc(initial) + '">' +
      '<div class="row"><button class="btn primary sm" data-act="ok">Save</button>' +
      '<button class="btn ghost sm" data-act="cancel">Cancel</button></div>');
    var input = p.querySelector("#pp-input");
    if (input && input.focus) input.focus();
    p.addEventListener("click", function (e) {
      var act = e.target && e.target.dataset ? e.target.dataset.act : null;
      if (act === "cancel") { closePopover(); return; }
      if (act === "ok") {
        var v = input.value.trim();
        if (!v) { notice("Name is required.", true); return; }
        closePopover();
        onOk(v);
      }
    });
  }

  $("btn-add-folder").addEventListener("click", function () {
    folderPrompt("New folder", "", function (name) {
      api("/api/folders", { method: "POST", body: JSON.stringify({ name: name }) })
        .then(function () { loadFolders(); notice("Folder created."); })
        .catch(function (err) { notice(err.message, true); });
    });
  });

  async function loadAgentRuns() {
    var data = await api("/api/agent");
    var runs = data.runs.filter(function (r) {
      if (folderFilter === "all") return true;
      if (folderFilter === "unfiled") return r.folder_id == null;
      return r.folder_id === folderFilter;
    });
    var list = $("agent-run-list");
    $("run-list-title").textContent =
      folderFilter === "all" ? "Past runs" : "Past runs — " + folderLabel(folderFilter);
    $("run-list-sub").textContent = runs.length + " run" + (runs.length === 1 ? "" : "s");
    list.innerHTML = runs.length === 0
      ? '<div class="empty" style="padding:1rem">No runs here yet. Ask a question above or in the chat.</div>'
      : runs.map(function (r) {
          var sub = r.status === "done" && r.findings != null
            ? " · " + r.findings + " findings from " + r.sources + " sources"
            : "";
          var badges = '<span class="badge">' + esc(folderName(r.folder_id)) + "</span>";
          if (r.parent_run_id) badges += ' <span class="badge follow">follow-up</span>';
          return '<div class="run-card" data-id="' + r.id + '" role="button" tabindex="0">' +
            '<div class="q">' + esc(r.question) + "</div>" +
            '<div class="foot"><span class="status-dot status-' + esc(r.status) + '"></span>' +
            "<span>" + esc(r.status) + sub + "</span>" + badges +
            "<span>" + esc(new Date(r.created_at).toLocaleString()) + "</span>" +
            '<button class="linklike run-move" data-id="' + r.id + '" title="Move to folder">move</button>' +
            "</div></div>";
        }).join("");
    Array.prototype.forEach.call(list.querySelectorAll(".run-card"), function (el) {
      var open = function (e) {
        if (e && e.target && e.target.classList && e.target.classList.contains("run-move")) return;
        showAgentRun(Number(el.dataset.id), true);
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", function (e) { if (e.key === "Enter") open(e); });
    });
    Array.prototype.forEach.call(list.querySelectorAll(".run-move"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        openMovePicker(btn, Number(btn.dataset.id));
      });
    });
  }

  function openMovePicker(anchor, runId) {
    var opts = '<button data-f="">Unfiled</button>' +
      folderCache.map(function (f) {
        return '<button data-f="' + f.id + '">' + esc(f.name) + "</button>";
      }).join("");
    var p = openPopover(anchor, '<div class="pp-title">Move run to…</div>' + opts);
    p.addEventListener("click", function (e) {
      var f = e.target && e.target.dataset ? e.target.dataset.f : undefined;
      if (f === undefined) return;
      closePopover();
      api("/api/agent/" + runId, {
        method: "PATCH",
        body: JSON.stringify({ folder_id: f === "" ? null : Number(f) }),
      }).then(function () {
        loadFolders(); loadAgentRuns(); notice("Run moved.");
      }).catch(function (err) { notice(err.message, true); });
    });
  }

  async function showAgentRun(id, poll) {
    clearTimeout(agentPollTimer);
    var wrap = $("agent-wrap");
    try {
      var data = await api("/api/agent/" + id);
      var run = data.run;
      currentJournal = null;
      showDeskCenter("run");
      chatRunId = id; // chat commands (follow up / summarize / export) target this run
      wrap.classList.remove("hidden");
      $("agent-title").textContent = run.status === "done" ? "" : run.question;
      var exp = $("agent-export");
      exp.href = "/api/agent/" + id + "/export.md";
      exp.style.display = run.status === "done" ? "" : "none";
      renderSteps(run.steps);
      if (run.status === "done") {
        var statBits = "Completed · " + run.findings + " findings from " +
          run.sources + " sources · " + run.pages_read + " pages read";
        if (run.followups) statBits += " · " + run.followups + " follow-up search" + (run.followups === 1 ? "" : "es");
        $("agent-status").textContent = statBits;
        $("agent-report-body").innerHTML = renderReport(run.report_md || "");
        // Sources come from the graph's source nodes (persisted with the run).
        var srcNodes = (run.graph && run.graph.nodes ? run.graph.nodes : []).filter(function (n) { return n.kind === "source"; });
        $("agent-report-sources").innerHTML =
          '<div class="sources"><h4>Sources</h4><ol>' +
          srcNodes.map(function (s) {
            return "<li><a href=\"" + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.label) + "</a>" +
              (s.detail ? '<span class="snip">' + esc(s.detail) + "</span>" : "") + "</li>";
          }).join("") + "</ol></div>";
        renderDataPoints(run);
        if (window.LVAgentCanvas && run.graph && run.graph.nodes && run.graph.nodes.length) {
          if (agentGraphHandle) { agentGraphHandle.destroy(); agentGraphHandle = null; }
          agentGraphHandle = window.LVAgentCanvas.render($("agent-canvas"), run.graph, {});
        } else {
          $("agent-canvas").innerHTML = '<div class="empty">Graph view failed to load.</div>';
        }
      } else if (run.status === "error") {
        $("agent-status").textContent = "Failed: " + (run.error || "unknown error");
        $("agent-report-body").innerHTML = "";
        $("agent-report-sources").innerHTML = "";
      } else {
        $("agent-status").textContent = "Agent working — follow the steps below…";
        if (poll) agentPollTimer = setTimeout(function () { showAgentRun(id, true); }, 2500);
      }
      await loadAgentRuns();
    } catch (err) { notice(err.message, true); }
  }

  $("agent-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var q = $("agent-q").value.trim();
    if (!q) return;
    try {
      var data = await api("/api/agent", {
        method: "POST",
        body: JSON.stringify({
          question: q,
          folder_id: typeof folderFilter === "number" ? folderFilter : null,
        }),
      });
      $("agent-q").value = "";
      notice("Agent started — watch it work below.");
      setAgentView("graph");
      showAgentRun(data.run_id, true);
    } catch (err) { notice(err.message, true); }
  });

  function mdInline(s) {
    return esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }
  function mdLink(s) {
    return s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, t, u) {
      return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(t) + "</a>";
    });
  }
  function renderReport(mdText) {
    var lines = mdText.split("\n");
    var html = "", inList = false;
    lines.forEach(function (ln) {
      var t = ln.trim();
      if (/^# /.test(t)) { if (inList) { html += "</ul>"; inList = false; } html += "<h1>" + mdInline(t.slice(2)) + "</h1>"; }
      else if (/^## /.test(t)) { if (inList) { html += "</ul>"; inList = false; } html += "<h2>" + mdInline(t.slice(3)) + "</h2>"; }
      else if (/^- /.test(t)) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += "<li>" + mdInline(mdLink(t.slice(2))) + "</li>";
      }
      else if (/^_.*_$/.test(t) && t.length > 2) { if (inList) { html += "</ul>"; inList = false; } html += "<p><em>" + mdInline(t.slice(1, -1)) + "</em></p>"; }
      else if (t === "") { if (inList) { html += "</ul>"; inList = false; } }
      else { if (inList) { html += "</ul>"; inList = false; } html += "<p>" + mdInline(mdLink(t)) + "</p>"; }
    });
    if (inList) html += "</ul>";
    return html;
  }

  /* ---------- research desk: data points → journal ---------- */
  // Each finding/source on a finished run can be filed into a journal.
  function renderDataPoints(run) {
    var box = $("agent-datapoints");
    var nodes = run.graph && run.graph.nodes ? run.graph.nodes : [];
    var findings = nodes.filter(function (n) { return n.kind === "finding"; });
    var sources = nodes.filter(function (n) { return n.kind === "source"; });
    if (!findings.length && !sources.length) { box.innerHTML = ""; return; }
    var html = '<h4>Data points</h4><p class="meta dim">File findings and sources into a journal to compile them across runs.</p>';
    if (findings.length) {
      html += '<div class="dp-group"><div class="dp-head">Findings</div>' +
        findings.map(function (f) {
          return '<div class="dp-row"><div class="dp-main"><strong>' + esc(f.label) + "</strong>" +
            (f.detail ? '<div class="meta dim">' + esc(f.detail) + "</div>" : "") + "</div>" +
            '<button class="btn ghost sm" data-kind="finding" data-ref="' + esc(f.label + (f.detail ? " — " + f.detail : "")) + '">＋ Journal</button></div>';
        }).join("") + "</div>";
    }
    if (sources.length) {
      html += '<div class="dp-group"><div class="dp-head">Sources</div>' +
        sources.map(function (s) {
          return '<div class="dp-row"><div class="dp-main"><a href="' + esc(s.url || "#") + '" target="_blank" rel="noopener">' + esc(s.label) + "</a>" +
            (s.detail ? '<div class="meta dim">' + esc(s.detail) + "</div>" : "") + "</div>" +
            '<button class="btn ghost sm" data-kind="source" data-ref="' + esc(s.label + " — " + (s.url || "")) + '">＋ Journal</button></div>';
        }).join("") + "</div>";
    }
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll("[data-kind]"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        openJournalPicker(btn, {
          run_id: run.id,
          kind: btn.dataset.kind,
          ref_text: btn.dataset.ref,
        });
      });
    });
  }

  function openJournalPicker(anchor, entry) {
    if (!journalCache.length) {
      notice("Create a journal first, then add data points to it.", true);
      return;
    }
    var p = openPopover(anchor,
      '<div class="pp-title">Add to journal</div>' +
      journalCache.map(function (j) {
        return '<button data-j="' + j.id + '">' + esc(j.title) + "</button>";
      }).join(""));
    p.addEventListener("click", function (e) {
      var jid = e.target && e.target.dataset ? e.target.dataset.j : undefined;
      if (jid === undefined) return;
      closePopover();
      api("/api/journals/" + jid + "/entries", {
        method: "POST",
        body: JSON.stringify({
          run_id: entry.run_id,
          kind: entry.kind,
          ref_text: entry.ref_text,
        }),
      }).then(function () {
        loadJournals();
        notice("Added to journal.");
      }).catch(function (err) { notice(err.message, true); });
    });
  }

  /* ---------- research desk: journals ---------- */
  var journalCache = [];
  var currentJournal = null; // full journal object when the journal view is open

  async function loadJournals() {
    try {
      var data = await api("/api/journals");
      journalCache = data.journals;
      var box = $("journal-list");
      box.innerHTML = journalCache.length === 0
        ? '<div class="meta dim">No journals yet.</div>'
        : journalCache.map(function (j) {
            return '<div class="jrow' + (currentJournal && currentJournal.id === j.id ? " sel" : "") + '" data-id="' + j.id + '" role="button" tabindex="0">' +
              '<span class="jrow-name">' + esc(j.title) + "</span>" +
              ' <span class="badge">' + j.entry_count + "</span></div>";
          }).join("");
      Array.prototype.forEach.call(box.querySelectorAll(".jrow"), function (el) {
        var open = function () { openJournal(Number(el.dataset.id)); };
        el.addEventListener("click", open);
        el.addEventListener("keydown", function (e) { if (e.key === "Enter") open(); });
      });
    } catch (err) { notice(err.message, true); }
  }

  $("btn-add-journal").addEventListener("click", function () {
    folderPrompt("New journal", "", function (title) {
      api("/api/journals", { method: "POST", body: JSON.stringify({ title: title }) })
        .then(function (d) {
          loadJournals();
          openJournal(d.journal.id);
          notice("Journal created.");
        })
        .catch(function (err) { notice(err.message, true); });
    });
  });

  async function openJournal(id) {
    try {
      var data = await api("/api/journals/" + id);
      currentJournal = data.journal;
      showDeskCenter("journal");
      renderJournal();
      loadJournals();
    } catch (err) { notice(err.message, true); }
  }

  function kindBadge(kind) {
    return '<span class="badge kind-' + kind + '">' + esc(kind) + "</span>";
  }

  function renderJournal() {
    var j = currentJournal;
    if (!j) return;
    $("journal-title").textContent = j.title;
    $("journal-meta").textContent = j.entries.length + " entr" + (j.entries.length === 1 ? "y" : "ies") +
      " · updated " + new Date(j.updated_at).toLocaleString();
    $("journal-export").href = "/api/journals/" + j.id + "/export.md";
    var box = $("journal-entries");
    box.innerHTML = j.entries.length === 0
      ? '<div class="empty" style="padding:1rem">No entries yet. Add findings or sources from any finished run, or write a note below.</div>'
      : j.entries.map(function (e, i) {
          var cite = e.run_id
            ? 'Run #' + e.run_id + (e.run_question ? ' — "' + esc(e.run_question) + '"' : "")
            : "No run";
          return '<div class="jentry" data-id="' + e.id + '">' +
            '<div class="row space"><div>' + kindBadge(e.kind) +
            ' <span class="meta dim">' + cite + "</span></div>" +
            '<div class="row jentry-acts">' +
            (i > 0 ? '<button class="linklike" data-act="up" title="Move up">↑</button>' : "") +
            (i < j.entries.length - 1 ? '<button class="linklike" data-act="down" title="Move down">↓</button>' : "") +
            '<button class="linklike danger-text" data-act="del" title="Remove entry">✕</button>' +
            "</div></div>" +
            '<div class="jentry-ref">' + esc(e.ref_text) + "</div>" +
            '<div class="jentry-note">' + (e.note ? esc(e.note) : "") +
            ' <button class="linklike" data-act="note">' + (e.note ? "edit note" : "+ note") + "</button></div>" +
            "</div>";
        }).join("");
    Array.prototype.forEach.call(box.querySelectorAll(".jentry"), function (el) {
      var eid = Number(el.dataset.id);
      el.addEventListener("click", function (e) {
        var act = e.target && e.target.dataset ? e.target.dataset.act : null;
        if (!act) return;
        e.stopPropagation();
        if (act === "up" || act === "down") {
          var ids = currentJournal.entries.map(function (x) { return x.id; });
          var i = ids.indexOf(eid);
          var k = act === "up" ? i - 1 : i + 1;
          var tmp = ids[i]; ids[i] = ids[k]; ids[k] = tmp;
          api("/api/journals/" + currentJournal.id + "/entries/reorder", {
            method: "POST",
            body: JSON.stringify({ entry_ids: ids }),
          }).then(function (d) { currentJournal = d.journal; renderJournal(); loadJournals(); })
            .catch(function (err) { notice(err.message, true); });
        } else if (act === "del") {
          api("/api/journals/" + currentJournal.id + "/entries/" + eid, { method: "DELETE" })
            .then(function (d) { currentJournal = d.journal; renderJournal(); loadJournals(); })
            .catch(function (err) { notice(err.message, true); });
        } else if (act === "note") {
          var cur = currentJournal.entries.filter(function (x) { return x.id === eid; })[0];
          folderPrompt("Note", cur ? cur.note : "", function (noteText) {
            api("/api/journals/" + currentJournal.id + "/entries/" + eid, {
              method: "PATCH",
              body: JSON.stringify({ note: noteText }),
            }).then(function (d) { currentJournal = d.journal; renderJournal(); loadJournals(); })
              .catch(function (err) { notice(err.message, true); });
          });
        }
      });
    });
  }

  $("journal-note-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!currentJournal) return;
    var v = $("journal-note-input").value.trim();
    if (!v) return;
    api("/api/journals/" + currentJournal.id + "/entries", {
      method: "POST",
      body: JSON.stringify({ kind: "note", ref_text: v }),
    }).then(function (d) {
      currentJournal = d.journal;
      $("journal-note-input").value = "";
      renderJournal(); loadJournals();
    }).catch(function (err) { notice(err.message, true); });
  });

  $("journal-rename").addEventListener("click", function () {
    if (!currentJournal) return;
    folderPrompt("Rename journal", currentJournal.title, function (title) {
      api("/api/journals/" + currentJournal.id, { method: "PATCH", body: JSON.stringify({ title: title }) })
        .then(function (d) { currentJournal = d.journal; renderJournal(); loadJournals(); })
        .catch(function (err) { notice(err.message, true); });
    });
  });

  $("journal-delete").addEventListener("click", function () {
    if (!currentJournal) return;
    if (!confirm('Delete journal "' + currentJournal.title + '" and all its entries?')) return;
    api("/api/journals/" + currentJournal.id, { method: "DELETE" })
      .then(function () {
        currentJournal = null;
        showDeskCenter("home");
        loadJournals();
        notice("Journal deleted.");
      })
      .catch(function (err) { notice(err.message, true); });
  });

  $("journal-back").addEventListener("click", function () {
    currentJournal = null;
    showDeskCenter("home");
    loadJournals();
  });

  /* ---------- research desk: agent chat ---------- */
  // Rule-based driver for the deterministic pipeline — NOT a freeform oracle.
  // Intents: research <q> · follow up · dig deeper into <finding> ·
  // summarize · export · help. Live step narration polls the run endpoint.
  var chatRunId = null;
  var chatPollTimer = null;
  var chatSeenSeq = 0;
  var CHAT_ICON = { plan: "🧭", search: "🔍", read: "📖", reflect: "🤔", followup: "🔁", synthesize: "🧩", done: "✅", error: "❌" };

  function chatMsg(role, html) {
    var box = $("chat-msgs");
    var d = document.createElement("div");
    d.className = "chat-msg " + role;
    d.innerHTML = html;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  function parseChatIntent(text) {
    var m = text.match(/^research\s+([\s\S]+)/i);
    if (m) return { intent: "research", arg: m[1].trim() };
    m = text.match(/^(?:follow[\s-]?up|dig deeper)(?:\s+into\s+([\s\S]+))?$/i);
    if (m) return { intent: "followup", arg: (m[1] || "").trim() };
    if (/^summarize\b/i.test(text)) return { intent: "summarize" };
    if (/^export\b/i.test(text)) return { intent: "export" };
    if (/^help\b/i.test(text)) return { intent: "help" };
    return { intent: "unknown" };
  }

  function chatHelp() {
    return "I drive the research pipeline. Try:<br>" +
      "• <strong>research &lt;question&gt;</strong> — start a run in the current folder<br>" +
      "• <strong>follow up</strong> / <strong>dig deeper into &lt;finding&gt;</strong> — a linked run on the current one<br>" +
      "• <strong>summarize</strong> — the current run's synthesis<br>" +
      "• <strong>export</strong> — download the current run as markdown";
  }

  function chatNeedRun() {
    chatMsg("bot", "Open a run first — click one in the list, or start one with <strong>research …</strong>.");
  }

  async function chatStartRun(question, parentId) {
    var folderId = typeof folderFilter === "number" ? folderFilter : null;
    if (parentId) {
      try {
        var cur = await api("/api/agent/" + parentId);
        folderId = cur.run.folder_id;
      } catch (e) { /* fall back to the current folder filter */ }
    }
    var data = await api("/api/agent", {
      method: "POST",
      body: JSON.stringify({ question: question, folder_id: folderId, parent_run_id: parentId || null }),
    });
    chatRunId = data.run_id;
    chatSeenSeq = 0;
    chatMsg("bot", (parentId ? "🔁 Follow-up started" : "🧭 Researching") + ": " + esc(question) +
      (folderId ? ' <span class="meta dim">in ' + esc(folderName(folderId)) + "</span>" : ""));
    chatPollRun(data.run_id);
  }

  async function chatPollRun(id) {
    clearTimeout(chatPollTimer);
    try {
      var data = await api("/api/agent/" + id);
      var run = data.run;
      (run.steps || []).forEach(function (s) {
        if (s.seq >= chatSeenSeq) {
          chatSeenSeq = s.seq + 1;
          chatMsg("bot",
            '<span class="step-icon">' + (CHAT_ICON[s.kind] || "•") + "</span> " + esc(s.label) +
            (s.detail ? '<div class="meta dim">' + esc(s.detail) + "</div>" : ""));
        }
      });
      if (run.status === "done") {
        chatMsg("bot", "✅ Done — " + run.findings + " findings from " + run.sources + " sources. Opening the canvas…");
        loadAgentRuns(); loadFolders();
        setAgentView("graph");
        showAgentRun(id, false);
      } else if (run.status === "error") {
        chatMsg("bot", "❌ The run failed: " + esc(run.error || "unknown error"));
        loadAgentRuns();
      } else {
        chatPollTimer = setTimeout(function () { chatPollRun(id); }, 2500);
      }
    } catch (err) {
      chatMsg("bot", "❌ " + esc(err.message));
    }
  }

  $("chat-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var input = $("chat-input");
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    chatMsg("user", esc(text));
    var it = parseChatIntent(text);
    try {
      if (it.intent === "research") {
        await chatStartRun(it.arg, null);
      } else if (it.intent === "followup") {
        if (!chatRunId) { chatNeedRun(); return; }
        var cur = await api("/api/agent/" + chatRunId);
        var q = it.arg
          ? 'Dig deeper into "' + it.arg + '" (follow-up on run #' + chatRunId + ")"
          : 'Follow-up on "' + cur.run.question + '"';
        await chatStartRun(q, chatRunId);
      } else if (it.intent === "summarize") {
        if (!chatRunId) { chatNeedRun(); return; }
        var r = await api("/api/agent/" + chatRunId);
        if (r.run.status === "done" && r.run.report_md) {
          var md = r.run.report_md;
          chatMsg("bot", "<strong>Synthesis</strong><br>" + esc(md.length > 800 ? md.slice(0, 800) + "…" : md));
        } else if (r.run.status === "error") {
          chatMsg("bot", "That run failed: " + esc(r.run.error || "unknown error"));
        } else {
          chatMsg("bot", "Still working — " + (r.run.steps ? r.run.steps.length : 0) + " steps so far.");
        }
      } else if (it.intent === "export") {
        if (!chatRunId) { chatNeedRun(); return; }
        var er = await api("/api/agent/" + chatRunId);
        if (er.run.status === "done") {
          chatMsg("bot", '<a href="/api/agent/' + chatRunId + '/export.md">Download run #' + chatRunId + " as markdown</a>");
        } else {
          chatMsg("bot", "The report isn't ready yet — the run is " + esc(er.run.status) + ".");
        }
      } else if (it.intent === "help") {
        chatMsg("bot", chatHelp());
      } else {
        chatMsg("bot", "I only drive the pipeline — I don't chat freely. " + chatHelp());
      }
    } catch (err) {
      chatMsg("bot", "❌ " + esc(err.message));
    }
  });

  /* Chat panel collapse; the state persists across visits. */
  function setChatOpen(open) {
    $("chat-body").classList.toggle("hidden", !open);
    $("chat-toggle").textContent = open ? "–" : "+";
    $("chat-toggle").setAttribute("aria-expanded", String(open));
    $("desk-chat").classList.toggle("collapsed", !open);
    try { localStorage.setItem("longview:chat:open", open ? "1" : "0"); } catch (e) { /* private mode */ }
  }
  $("chat-toggle").addEventListener("click", function () {
    setChatOpen($("chat-body").classList.contains("hidden"));
  });

  /* ---------- settings ---------- */
  var settingsLoaded = false;

  function backendLabel(b) {
    return b === "exa" ? "Exa" : b === "parallel" ? "Parallel" : "DuckDuckGo";
  }

  function keyBadge(ok) {
    return ok ? '<span class="badge new">configured</span>' : '<span class="badge err">not configured</span>';
  }

  async function loadSettings() {
    try {
      var data = await api("/api/settings");
      var s = data.settings;
      var radios = document.querySelectorAll('input[name="backend"]');
      radios.forEach(function (r) { r.checked = r.value === s.backend; });
      var effect = $("backend-in-effect");
      if (s.backend_source === "env") {
        effect.innerHTML = "In effect: <strong>" + esc(backendLabel(s.backend)) +
          "</strong> — the <span class=\"mono\">SEARCH_BACKEND</span> env var overrides the selector above.";
      } else {
        effect.innerHTML = "In effect: <strong>" + esc(backendLabel(s.backend)) + "</strong>" +
          (s.backend_source === "setting" ? " (saved)" : " (default)");
      }
      $("backend-quota").textContent =
        s.backend === "exa"
          ? "Each agent query counts as one Exa search. ~1,000 free searches/month ≈ 30+ per day."
          : s.backend === "parallel"
            ? "Each agent query counts as one Parallel search against your plan's quota."
            : "DuckDuckGo is scraped politely (≥2s between requests) and may serve bot challenges on some networks.";
      var key = $("exa-key-status");
      if (s.exa_key_configured) {
        key.innerHTML = keyBadge(true) + " Exa key is set on the server.";
      } else {
        key.innerHTML = keyBadge(false) + " — set <span class=\"mono\">EXA_API_KEY</span> and restart to use Exa.";
      }
      var pkey = $("parallel-key-status");
      if (s.parallel_key_configured) {
        pkey.innerHTML = keyBadge(true) + " Parallel key is set on the server.";
      } else {
        pkey.innerHTML = keyBadge(false) + " — set <span class=\"mono\">PARALLEL_API_KEY</span> and restart to use Parallel.";
      }
      settingsLoaded = true;
    } catch (err) { notice(err.message, true); }
  }

  document.querySelectorAll('input[name="backend"]').forEach(function (r) {
    r.addEventListener("change", async function () {
      try {
        await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ backend: r.value }),
        });
        notice("Search backend set to " + backendLabel(r.value) + ".");
        await loadSettings();
      } catch (err) {
        notice(err.message, true);
        await loadSettings();
      }
    });
  });

  /* ---------- boot ---------- */
  loadTopics().catch(function (e) { notice(e.message, true); });
  loadFolders().catch(function (e) { notice(e.message, true); });
  loadJournals().catch(function (e) { notice(e.message, true); });
  loadAgentRuns().catch(function (e) { notice(e.message, true); });
  try {
    if (localStorage.getItem("longview:chat:open") === "0") setChatOpen(false);
  } catch (e) { /* private mode */ }
  chatMsg("bot", "Research desk ready. " + chatHelp());
})();
