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
  }

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

  /* ---------- deep research ---------- */
  var pollTimer = null;

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

  async function loadRuns() {
    var data = await api("/api/research");
    var list = $("run-list");
    list.innerHTML = data.runs.length === 0
      ? '<div class="empty" style="padding:1rem">No research runs yet.</div>'
      : data.runs.map(function (r) {
          return '<div class="run-card" data-id="' + r.id + '" role="button" tabindex="0">' +
            '<div class="q">' + esc(r.question) + "</div>" +
            '<div class="foot"><span class="status-dot status-' + esc(r.status) + '"></span>' +
            "<span>" + esc(r.status) + "</span><span>" + esc(new Date(r.created_at).toLocaleString()) + "</span></div>" +
            "</div>";
        }).join("");
    Array.prototype.forEach.call(list.querySelectorAll(".run-card"), function (el) {
      var open = function () { showRun(Number(el.dataset.id), true); };
      el.addEventListener("click", open);
      el.addEventListener("keydown", function (e) { if (e.key === "Enter") open(); });
    });
  }

  async function showRun(id, poll) {
    clearTimeout(pollTimer);
    var wrap = $("report-wrap");
    try {
      var data = await api("/api/research/" + id);
      var run = data.run;
      wrap.classList.remove("hidden");
      // The report markdown already opens with an H1 of the question, so the
      // card header only names it while the run is still working/failed.
      $("report-title").textContent = run.status === "done" ? "" : run.question;
      var exp = $("report-export");
      exp.href = "/api/research/" + id + "/export.md";
      exp.style.display = run.status === "done" ? "" : "none";
      if (run.status === "done") {
        var statBits = "Completed · " + run.sources.length + " sources";
        if (run.pages_crawled) {
          statBits += " · " + run.pages_crawled + " pages across " + run.max_depth_reached + " layer" +
            (run.max_depth_reached === 1 ? "" : "s");
          if (run.discovered) statBits += " · " + run.discovered + " discovered by deep crawl";
          if (run.capped) statBits += " (stopped at safety cap)";
        }
        $("report-status").textContent = statBits;
        $("report-body").innerHTML = renderReport(run.report_md || "");
        $("report-sources").innerHTML =
          '<div class="sources"><h4>Sources</h4><ol>' +
          run.sources.map(function (s) {
            return "<li><a href=\"" + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title) + "</a>" +
              (s.snippet ? '<span class="snip">' + esc(s.snippet) + "</span>" : "") + "</li>";
          }).join("") + "</ol></div>";
      } else if (run.status === "error") {
        $("report-status").textContent = "Failed: " + (run.error || "unknown error");
        $("report-body").innerHTML = "";
        $("report-sources").innerHTML = "";
      } else {
        $("report-status").textContent = "Working — crawling and reading sources…";
        $("report-body").innerHTML = "";
        $("report-sources").innerHTML = "";
        if (poll) pollTimer = setTimeout(function () { showRun(id, true); }, 3000);
      }
      await loadRuns();
    } catch (err) { notice(err.message, true); }
  }

  $("research-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var q = $("research-q").value.trim();
    if (!q) return;
    try {
      var data = await api("/api/research", {
        method: "POST",
        body: JSON.stringify({ question: q }),
      });
      $("research-q").value = "";
      notice("Research started.");
      showRun(data.run_id, true);
    } catch (err) { notice(err.message, true); }
  });

  /* ---------- settings ---------- */
  var settingsLoaded = false;

  function backendLabel(b) {
    return b === "exa" ? "Exa" : "DuckDuckGo";
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
        "Each deep-research query variant counts as one Exa search. ~1,000 free searches/month ≈ 30+ per day.";
      var key = $("exa-key-status");
      if (s.exa_key_configured) {
        key.innerHTML = '<span class="badge new">configured</span> Exa key is set on the server.';
      } else {
        key.innerHTML = '<span class="badge err">not configured</span> — set <span class="mono">EXA_API_KEY</span> and restart to use Exa.';
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
  loadRuns().catch(function (e) { notice(e.message, true); });
})();
