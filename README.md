# Longview — research desk

A self-hosted, long-term online research tool. Two modes in one dashboard:

1. **Watched topics** — save topics (name + query + daily/weekly/manual schedule).
   An in-process scheduler sweeps every 60 seconds and re-crawls due topics.
   Each topic has a timeline of findings; new items carry a "new" badge until
   marked read. Findings dedupe by URL per topic.
2. **Deep research** — ask a question; Longview generates 3–5 query variants,
   crawls each, fetches the top pages' text (up to 8 pages, 10s timeout each),
   and compiles an **extractive** summary: top sentences by keyword overlap,
   quoted verbatim from the sources. **No LLM is involved** — the report is
   ranked quotes, not generated prose. The report renders with a Sources
   section and exports as Markdown.

Bun + zero npm dependencies + built-in SQLite. Default port **3011**
(`PORT` env override). Data lives in `./data/` (gitignored), created on boot.

## DuckDuckGo: the honest version

There is **no official DuckDuckGo search API**. Longview crawls the public
HTML endpoint (`https://html.duckduckgo.com/html/`) and parses result links
with zero-dependency regex extraction (`src/ddg.ts`).

Politeness policy (built in, not configurable down):
- ≥2 seconds between requests, plus jitter
- max ~20 results per query
- exponential backoff on failures (1s / 2s / 4s, 3 attempts)
- a failed crawl marks the topic `error` and never kills the scheduler

DuckDuckGo may serve bot-challenge pages to datacenter IPs; if a crawl
returns no results unexpectedly, that is the likely cause. The crawl path is
fully covered by fixture tests, so the parser is verified even where the
live endpoint is not reachable.

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
| POST /api/topics | `{name, query, schedule}` → 201 |
| GET /api/topics/:id | one topic |
| PATCH /api/topics/:id | `{name?, query?, schedule?}` |
| DELETE /api/topics/:id | deletes topic + findings |
| POST /api/topics/:id/crawl | manual trigger → `{added, total}`; 502 on crawl failure |
| GET /api/topics/:id/findings | newest first |
| POST /api/findings/:id/read | clears the "new" badge |
| GET /api/research | run history |
| POST /api/research | `{question}` → 202 `{run_id}`; runs async, poll below |
| GET /api/research/:id | `{status, report_md, sources, error}` |
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
