# Longview — research desk

A self-hosted, long-term online research tool. Two modes in one dashboard:

1. **Watched topics** — save topics (name + query + daily/weekly/manual schedule).
   An in-process scheduler sweeps every 60 seconds and re-crawls due topics.
   Each topic has a timeline of findings; new items carry a "new" badge until
   marked read. Findings dedupe by URL per topic.
2. **Research agent** — ask a question; a deterministic agent loop plans the
   inquiry, searches each line with the active backend, reads the top pages,
   reflects on its own coverage and fires follow-up searches for weak spots,
   then assembles an **extractive** report: top sentences by keyword overlap,
   quoted verbatim from the sources. **No LLM is involved** — the report is
   ranked quotes, not generated prose. The agent's work is visualized on a
   **canvas**: question → lines of inquiry → sources → findings, with edges
   showing what surfaced and supports what. The report renders with a Sources
   section and exports as Markdown.

Bun + zero npm dependencies + built-in SQLite. Default port **3011**
(`PORT` env override). Data lives in `./data/` (gitignored), created on boot.

## Research agent

The agent is a small deterministic loop (`src/agent.ts`) — no model calls:

1. **Plan** — the question itself becomes the first line of inquiry, plus
   aspect drills derived from content-word runs in the question.
2. **Search** — each line of inquiry gets up to 3 query variants through the
   selected backend; results dedupe across lines and are attributed to the
   line that surfaced them.
3. **Read** — the top results per line are fetched and extracted.
4. **Reflect** — every question keyword needs at least 2 evidence hits;
   keywords below that are weak spots, each getting one targeted follow-up
   search (new URLs only).
5. **Synthesize** — evidence is grouped by shared keyword clusters into
   labeled findings, and a typed output graph is built:
   question → *line of inquiry* → lines of inquiry → *surfaced* → sources →
   *supports* → findings.

Live step events (`plan`, `search`, `read`, `reflect`, `followup`,
`synthesize`, `done`) stream to the UI as the run progresses, and every
run is persisted (`agent_runs`) with its steps, plan, graph, and report.

One dead query or one dead page never kills a run — per-item failures are
swallowed and reported; only a total search failure or zero readable pages
fails the run.

## DuckDuckGo: the honest version

There is **no official DuckDuckGo search API**. Longview crawls the public
HTML endpoints and parses result links with zero-dependency regex
extraction (`src/ddg.ts`).

Politeness policy (built in, not configurable down):
- ≥2 seconds between requests, plus jitter
- max ~20 results per query
- exponential backoff between endpoint attempts
- a failed crawl marks the topic `error` and never kills the scheduler

DuckDuckGo serves bot-challenge pages (`HTTP 202` + `anomaly-modal`) to
some IPs — this is the most common reason crawling "doesn't work" from a
given network. To cope, every crawl walks a **fallback chain**:

1. `POST https://html.duckduckgo.com/html/`
2. `GET https://html.duckduckgo.com/html/?q=<query>`
3. `GET https://lite.duckduckgo.com/lite/?q=<query>` (simpler table markup)

Each failure is **classified** and the reason is persisted on the topic
(`last_error` + `last_error_class`), so the UI can show *why* instead of a
bare "crawl error":

| class | meaning |
|---|---|
| `challenge` | DDG served a bot check — retry later or from a different IP |
| `timeout` | request timed out |
| `network` | DNS / refused / reset |
| `parse_empty` | HTTP 200 but zero results parsed — the page format may have changed |
| `http_<code>` | any other non-200 status |

The topic detail shows a failure banner with a per-class hint, and a
**Diagnose** button next to "Re-crawl now" probes each endpoint in the
chain and renders a per-endpoint table (HTTP status, result count, class,
time) so you can see exactly which endpoint works from your network.

`GET /api/diag/crawl?q=<query>` exposes the same probe as JSON:
`{ok, backend, query, endpoints: [{endpoint, httpStatus, resultCount, errorClass, ms}], winner}`.

The crawl path is fully covered by fixture tests, so the parsers are
verified even where the live endpoints are not reachable.

## Search backends

Longview has two search backends behind one interface (`src/search.ts`):

| backend | what it is | cost | catch |
|---|---|---|---|
| `ddg` (default) | scrapes DuckDuckGo's public HTML endpoints | free, no key | DDG bot-challenges some networks — then nothing works |
| `exa` | Exa's official JSON API (`POST api.exa.ai/search`) | free tier ~1,000 searches/month, renewable, **no credit card** | needs an API key |
| `parallel` | Parallel's official Search API (`POST api.parallel.ai/v1/search`) with `objective` + `search_queries` per call, mode `basic` | paid, LLM-ready excerpts | needs an API key |

**Getting a free Exa key:** sign up at [dashboard.exa.ai](https://dashboard.exa.ai),
go to Keys, copy a key, then set it as the `EXA_API_KEY` environment
variable and restart. The Settings tab shows whether a key is configured —
the key itself is never displayed or sent to the browser.

**Getting a Parallel key:** sign up at
[platform.parallel.ai](https://platform.parallel.ai), create an API key,
then set it as the `PARALLEL_API_KEY` environment variable and restart.
The Settings tab shows whether a key is configured — the key itself is
never displayed or sent to the browser.

**Quota math:** each deep-research query variant is one Exa call (up to 5
per run), each topic crawl is one call. 1,000 free searches/month ≈ 30+
per day — comfortable for personal use. A 402/429 from Exa is classified
as `quota` and surfaced in the UI.

**Switching backends:** the Settings tab has a backend selector, persisted
server-side. `SEARCH_BACKEND=exa` (env) overrides the selector — the
Settings tab tells you which is in effect. An invalid `SEARCH_BACKEND`
logs a warning and falls back to `ddg`.

## Deep crawl — keyword-guided link following

Beyond the search results, Longview follows outbound links breadth-first
(`src/deepcrawl.ts`), up to 10 layers deep. Every candidate link is scored
by keyword overlap between the search query and its anchor text + URL
tokens; only links with at least one keyword hit are followed, top 5 per
page. That gating is what keeps a 10-layer crawl from wandering off across
the web.

- **Watched topics** have a `depth` setting (1–10, default 3), editable in
  the create form and the topic detail view. Findings store `depth`
  (0 = DDG seed) and `via_url` provenance; the UI shows an `L2` badge and
  "via \<domain\>". Dedupe by URL still applies — a known page is not
  re-added, but its links are still followed.
- **Deep research** always crawls to depth 10. Discovered pages join the
  source pool for the extractive summary; the report notes how many pages
  were read, how many layers were reached, and how many new sources the
  deep crawl found. The run detail JSON carries `pages_crawled`,
  `max_depth_reached`, `capped`, and `discovered`.

Safety caps (per run): 150 pages, 10 minutes wall-clock — whichever hits
first stops the crawl cleanly and reports `capped`. Per-domain politeness
(≥2s between requests), 10s fetch timeouts, 2MB body cap, non-HTML
skipped, cycle-proof URL normalization (fragment / trailing slash /
tracking params stripped).

Tuning env: `DEEP_NO_DELAY=1` skips politeness delays (tests only).

## Setup

```sh
# no npm install needed — zero dependencies
bun src/server.ts
# or
PORT=3011 LONGVIEW_DATA=./data bun src/server.ts
```

Open http://127.0.0.1:3011. `DDG_BASE_URL` overrides the search endpoint
(useful for tests/stubs).

## API

| Method | Path | Notes |
|---|---|---|
| GET /api/topics | list topics (with `new_count`) |
| POST /api/topics | `{name, query, schedule, depth?}` → 201 (`depth` 1–10, default 3) |
| GET /api/topics/:id | one topic |
| PATCH /api/topics/:id | `{name?, query?, schedule?, depth?}` |
| DELETE /api/topics/:id | deletes topic + findings |
| POST /api/topics/:id/crawl | manual trigger → `{added, total, discovered}`; 502 on crawl failure (with `error_class`) |
| GET /api/diag/crawl?q=… | probe each DDG endpoint → `{endpoints, winner}` |
| GET /api/topics/:id/findings | newest first |
| GET /api/topics/:id/clusters | findings grouped by the deterministic TF-IDF/k-means classifier (canvas view; computed on demand, no persistence) |
| POST /api/findings/:id/read | clears the "new" badge |
| GET /api/agent | run history |
| POST /api/agent | `{question}` → 202 `{run_id}`; runs async, poll below |
| GET /api/agent/:id | `{status, steps, plan, graph, report_md, error, pages_read, sources, findings, followups}` — live steps while working |
| GET /api/agent/:id/export.md | markdown download (409 until done) |
| GET /api/research | legacy deep-research history (kept for compatibility) |
| POST /api/research | `{question}` → 202 `{run_id}`; runs async, poll below |
| GET /api/research/:id | `{status, report_md, sources, error, pages_crawled, max_depth_reached, capped, discovered}` |
| GET /api/research/:id/export.md | markdown download (409 until done) |

## Tests

```sh
bun test
```

DDG parser tests run against recorded fixtures (`tests/fixtures/`); the
API suite spawns the real server with stub DDG + stub content servers, so
no live network is ever touched in tests.

## Limitations

- Extractive summaries quote sources; they do not synthesize, verify, or
  fact-check. Treat every report as a reading list with highlights.
- Watched topics dedupe by URL only — a page that updates in place will not
  reappear as new.
- The scheduler is in-process; if the server is down, no crawls happen.
