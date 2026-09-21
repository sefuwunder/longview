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
      $("tab-topics").classList.toggle("hidden", t.dataset.tab !== "topics");
      $("tab-research").classList.toggle("hidden", t.dataset.tab !== "research");
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
        }),
      });
      $("topic-form").reset();
      $("topic-form").classList.add("hidden");
      await loadTopics();
      notice("Topic added.");
    } catch (err) { notice(err.message, true); }
  });

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
      $("detail-error").textContent = currentTopic.status === "error"
        ? "Last crawl failed: " + (currentTopic.last_error || "unknown error")
        : "";
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
      notice("Crawl finished — " + data.added + " new of " + data.total + " results.");
      await openTopic(currentTopic.id);
      await loadTopics();
    } catch (err) { notice(err.message, true); }
    finally { btn.disabled = false; btn.textContent = "Re-crawl now"; }
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
        $("report-status").textContent = "Completed · " + run.sources.length + " sources";
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

  /* ---------- boot ---------- */
  loadTopics().catch(function (e) { notice(e.message, true); });
  loadRuns().catch(function (e) { notice(e.message, true); });
})();
