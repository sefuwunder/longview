// Deep-research pipeline for longview. Fully deterministic — NO LLM.
// A question is expanded into a few query variants, each is crawled, the top
// pages are fetched, and an EXTRACTIVE summary is built by scoring sentences
// on keyword overlap with the question. The UI and README say this plainly.

import type { DDGResult, CrawlResult } from "./ddg";
import { crawlDDG } from "./ddg";
import {
  deepCrawl,
  normalizeUrl,
  type DeepCrawlResult,
  type DeepSeed,
} from "./deepcrawl";

const STOP = new Set(
  "a,an,the,and,or,but,of,to,in,on,for,with,at,by,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,our,your,their,what,which,who,whom,how,when,where,why,do,does,did,can,could,should,would,will,just,not,no,yes,if,then,than,so,such,into,over,after,before,between,about,up,out,more,most,other,some,any,all,only,very,than,too".split(
    ","
  )
);

/** Light stemmer so "charging"/"charge" and "batteries"/"battery" match. */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

export function keywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);
  return [...new Set(words)];
}

/** Deterministic query variants from a question (max 5). */
export function queryVariants(question: string): string[] {
  const q = question.trim().replace(/\?+\s*$/, "").replace(/\s+/g, " ");
  const vars: string[] = [];
  const push = (s: string) => {
    s = s.trim();
    if (s && !vars.includes(s)) vars.push(s);
  };
  push(q);
  const kw = keywords(q).slice(0, 6);
  if (kw.length >= 2) push(kw.join(" "));
  push(q + " explained");
  push(q + " overview");
  push(q + " guide");
  return vars.slice(0, 5);
}

/** Fetch a page and return cleaned visible text (capped). 10s timeout. */
export async function fetchPageText(
  url: string,
  timeoutMs = 10000
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    if (!/html/i.test(ct) && ct) throw new Error(`not HTML (${ct})`);
    const html = await res.text();
    return htmlToText(html);
  } finally {
    clearTimeout(timer);
  }
}

/** Zero-dep HTML → visible text. */
export function htmlToText(html: string): string {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return t.slice(0, 20000);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 400);
}

export interface ScoredPage {
  url: string;
  title: string;
  snippet: string;
  text: string;
}

/**
 * Extractive summary: score each sentence by keyword overlap with the
 * question, take the top N, return them in document order. No generation.
 */
export function extractiveSummary(
  pages: ScoredPage[],
  question: string,
  n = 8
): string[] {
  const kw = new Set(keywords(question));
  if (kw.size === 0) return [];
  const scored: { s: string; score: number; order: number }[] = [];
  let order = 0;
  for (const p of pages) {
    const words = new Set(
      p.text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    );
    for (const s of splitSentences(p.text)) {
      const toks = s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w))
        .map(stem);
      if (toks.length === 0) continue;
      let hits = 0;
      for (const t of toks) if (kw.has(t)) hits++;
      const score = hits / Math.sqrt(toks.length);
      if (hits >= 2) scored.push({ s, score, order: order++ });
      void words;
    }
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const top = scored.slice(0, n).sort((a, b) => a.order - b.order);
  // Dedupe near-identical sentences
  const seen = new Set<string>();
  return top
    .map((x) => x.s)
    .filter((s) => {
      const k = s.slice(0, 60).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** Assemble the markdown report. */
export function buildReport(
  question: string,
  sentences: string[],
  sources: { title: string; url: string }[],
  crawlNote?: string
): string {
  const lines: string[] = [`# ${question.trim()}`, ""];
  lines.push(
    "_Extractive summary — sentences pulled verbatim from the sources below, ranked by keyword overlap. No AI generation._",
    ""
  );
  if (crawlNote) lines.push(`_${crawlNote}_`, "");
  lines.push("## Key points", "");
  if (sentences.length === 0) {
    lines.push("_No usable sentences were extracted from the fetched pages._", "");
  } else {
    for (const s of sentences) lines.push(`- ${s}`);
    lines.push("");
  }
  lines.push("## Sources", "");
  sources.forEach((s, i) => {
    lines.push(`${i + 1}. [${s.title}](${s.url})`);
  });
  lines.push("");
  return lines.join("\n");
}

export interface ResearchDeps {
  crawl?: (q: string) => Promise<CrawlResult>;
  fetchPage?: (url: string) => Promise<string>;
  /** Raw HTML fetcher for the deep crawler (defaults to the real one). */
  fetchHtml?: (url: string) => Promise<string>;
  /** Deep-crawl override (tests). */
  deep?: (
    seeds: DeepSeed[],
    query: string,
    maxDepth: number
  ) => Promise<DeepCrawlResult>;
  maxPages?: number;
  maxQueries?: number;
  /** Deep-crawl layers for this run. Default 10. */
  maxDepth?: number;
}

export interface ResearchStats {
  pagesCrawled: number;
  maxDepthReached: number;
  capped: boolean;
  discovered: number;
}

/**
 * Run the full deep-research pipeline: DDG query variants, seed pages, then
 * a keyword-guided deep crawl (default 10 layers). Discovered pages join the
 * source pool for the extractive summary. Returns report markdown + sources
 * + crawl stats. Failures of individual crawls/pages are tolerated; a total
 * failure throws.
 */
export async function runResearchPipeline(
  question: string,
  deps: ResearchDeps = {}
): Promise<{
  report: string;
  sources: { title: string; url: string; snippet: string }[];
  stats: ResearchStats;
}> {
  const crawl = deps.crawl ?? ((q: string) => crawlDDG(q));
  const fetchPage = deps.fetchPage ?? fetchPageText;
  const maxPages = deps.maxPages ?? 8;
  const maxQueries = deps.maxQueries ?? 5;
  const maxDepth = deps.maxDepth ?? 10;
  const doDeep =
    deps.deep ??
    ((seeds: DeepSeed[], q: string, md: number) =>
      deepCrawl(seeds, q, { maxDepth: md, fetchHtml: deps.fetchHtml }));

  const variants = queryVariants(question).slice(0, maxQueries);
  const seen = new Map<string, DDGResult>();
  let crawlOk = 0;
  for (const v of variants) {
    try {
      const r = await crawl(v);
      if (r.ok && r.results.length > 0) {
        crawlOk++;
        for (const res of r.results) {
          if (!seen.has(res.url)) seen.set(res.url, res);
        }
      }
    } catch {
      // one dead query never kills the run
    }
  }
  if (crawlOk === 0) throw new Error("all search queries failed");

  const candidates = [...seen.values()].slice(0, maxPages);
  const pages: ScoredPage[] = [];
  for (const c of candidates) {
    try {
      const text = await fetchPage(c.url);
      if (text.length > 200) pages.push({ ...c, text });
    } catch {
      // one dead page never kills the run
    }
  }
  if (pages.length === 0) throw new Error("no pages could be fetched");

  // Keyword-guided deep crawl from the seed results; discoveries join the pool.
  let dc: DeepCrawlResult | null = null;
  try {
    dc = await doDeep(
      candidates.map((c) => ({ title: c.title, url: c.url, snippet: c.snippet })),
      question,
      maxDepth
    );
  } catch {
    // a dead deep crawl never kills the run; seeds still summarize
  }
  const discovered: ScoredPage[] = (dc?.pages ?? [])
    .filter((p) => p.depth > 0 && p.text.length > 200)
    .map((p) => ({ title: p.title, url: p.url, snippet: p.snippet, text: p.text }));
  const allPages = [...pages, ...discovered];

  const sentences = extractiveSummary(allPages, question, 8);
  const stats: ResearchStats = {
    pagesCrawled: dc?.pagesCrawled ?? 0,
    maxDepthReached: dc?.maxDepthReached ?? 0,
    capped: dc?.capped ?? false,
    discovered: discovered.length,
  };
  const crawlNote =
    `Deep crawl: ${stats.pagesCrawled} pages read across ${stats.maxDepthReached} ` +
    `layer${stats.maxDepthReached === 1 ? "" : "s"}` +
    (stats.discovered > 0
      ? `, ${stats.discovered} new source${stats.discovered === 1 ? "" : "s"} discovered beyond the search results`
      : ", no new sources beyond the search results") +
    (stats.capped ? " (stopped at the safety cap)" : "") +
    ".";
  // Dedupe sources by normalized URL: a discovered page may be the same
  // document as a seed under a trivially different URL.
  const srcMap = new Map<string, { title: string; url: string; snippet: string }>();
  for (const p of allPages) {
    const k = normalizeUrl(p.url) ?? p.url;
    if (!srcMap.has(k))
      srcMap.set(k, { title: p.title, url: p.url, snippet: p.snippet });
  }
  const sources = [...srcMap.values()];
  const report = buildReport(question, sentences, sources, crawlNote);
  return { report, sources, stats };
}
