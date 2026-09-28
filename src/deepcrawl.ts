// Keyword-guided deep crawl for longview.
//
// Breadth-first link following from seed URLs (the DuckDuckGo results),
// gated by keyword overlap between the search query and each candidate
// link's anchor text + URL tokens. A link is only followed when at least one
// query keyword appears in its anchor or path — that gating is what keeps a
// 10-layer crawl from wandering off across the whole web.
//
// Guards: maxDepth (10 default), maxPages (150), wall-clock cap (10 min),
// visited-set dedupe with URL normalization, per-domain >=2s politeness,
// non-HTML skip, 2MB body cap. All dependency-free.

import { keywords, stem, htmlToText, STOPWORDS } from "./research";

export interface DeepSeed {
  title: string;
  url: string;
  snippet: string;
}

export interface DeepPage {
  title: string;
  url: string;
  snippet: string;
  /** 0 = seed (a DDG result page); >0 = discovered by following links. */
  depth: number;
  /** Normalized URL of the parent page this was found on (null for seeds). */
  viaUrl: string | null;
  /** Plain text extracted from the page (for the extractive summarizer). */
  text: string;
}

export interface DeepCrawlResult {
  pages: DeepPage[];
  /** Pages actually fetched (seeds + discovered). */
  pagesCrawled: number;
  maxDepthReached: number;
  capped: boolean;
  capReason: "page_cap" | "time_cap" | null;
  /** Associated keywords discovered in crawled pages and added to the
   *  gating set (empty unless expandKeywords was on). */
  newKeywords: string[];
}

export interface DeepCrawlOptions {
  /** 0 = seed page itself. Default 10. */
  maxDepth?: number;
  /** Hard stop on fetched pages. Default 150. */
  maxPages?: number;
  /** Hard stop on wall-clock ms. Default 10 minutes. */
  maxMs?: number;
  /** Max links followed per page (top-scoring). Default 5. */
  topK?: number;
  /** Min distinct keyword hits for a link to be followed. Default 1. */
  minScore?: number;
  /** Fetch timeout per page. Default 10s. */
  timeoutMs?: number;
  /** Max response body bytes. Default 2MB. */
  maxBytes?: number;
  /** Skip politeness delays (tests). Defaults to DEEP_NO_DELAY=1. */
  noDelay?: boolean;
  /** Overrideable page fetcher (tests). */
  fetchHtml?: (url: string) => Promise<string>;
  /**
   * Grow the gating keyword set from the crawl itself: after each page is
   * fetched, its most frequent new content-word stems join the set, so
   * deeper layers follow freshly discovered associated terminology instead
   * of only the original query's keywords. Default false.
   */
  expandKeywords?: boolean;
  /** Cap on keywords added via expansion. Default 24. */
  maxNewKeywords?: number;
  /** Max new keywords contributed per page. Default 3. */
  keywordsPerPage?: number;
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalize for dedupe: lowercase host, drop fragment, trailing slash, tracking params. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const params = new URLSearchParams();
  u.searchParams.forEach((v, k) => {
    if (!/^(utm_|gclid|gbraid|wbraid|fbclid|mc_cid|mc_eid|igshid|yclid|msclkid)/i.test(k))
      params.append(k, v);
  });
  params.sort();
  const qs = params.toString();
  return `${u.protocol}//${u.host.toLowerCase()}${path}${qs ? "?" + qs : ""}`;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

export interface RawLink {
  url: string;
  anchor: string;
}

/** Extract http(s) links with anchor text; resolves relative hrefs. */
export function extractLinks(html: string, base: string): RawLink[] {
  const out: RawLink[] = [];
  const seen = new Set<string>();
  const re =
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!href || /^[a-z]+:/i.test(href) && !/^https?:/i.test(href)) continue;
    let abs: string;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(abs)) continue;
    const anchor = decodeEntities(stripTags(m[4])).trim().replace(/\s+/g, " ");
    const key = abs + "\u0000" + anchor;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: abs, anchor });
  }
  return out;
}

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (w.length > 2) out.add(stem(w));
  }
  return out;
}

function urlTokens(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + " " + u.search;
  } catch {
    return "";
  }
}

/**
 * Keyword relevance of a candidate link: distinct query-keyword stems found
 * in the anchor text or URL path tokens. Higher = more relevant.
 */
export function linkScore(
  anchor: string,
  url: string,
  kw: Set<string>
): number {
  if (kw.size === 0) return 0;
  const toks = tokenize(anchor + " " + urlTokens(url));
  let hits = 0;
  for (const t of toks) if (kw.has(t)) hits++;
  return hits;
}

/**
 * Newly found associated keywords in a page's text: the most frequent
 * content-word stems that are NOT already in the gating set. A candidate
 * must appear at least 3 times (so one stray mention can't steer the
 * crawl) and the winners are frequency-ranked, ties broken alphabetically.
 * Deterministic.
 */
export function associatedKeywords(
  text: string,
  kw: Set<string>,
  limit: number
): string[] {
  const freq = new Map<string, number>();
  for (const w of text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    const s = stem(w);
    if (s.length < 3 || kw.has(s)) continue;
    freq.set(s, (freq.get(s) ?? 0) + 1);
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.max(0, limit))
    .map(([s]) => s);
}

/** Fetch a page's HTML, skipping non-HTML and capping the body. Throws on failure. */
export async function fetchHtmlDefault(
  url: string,
  timeoutMs: number,
  maxBytes: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    if (ct && !/html/i.test(ct)) throw new Error(`not HTML (${ct})`);
    if (!res.body) throw new Error("no body");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

function pageTitle(html: string, url: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const t = m ? decodeEntities(stripTags(m[1])).trim().replace(/\s+/g, " ") : "";
  return t || url;
}

/**
 * Breadth-first deep crawl. Seeds are depth 0. Only links scoring >= minScore
 * are followed, top topK per page. Never throws for page-level failures —
 * dead pages are skipped; the result reports what was found and whether a
 * safety cap stopped the run.
 */
export async function deepCrawl(
  seeds: DeepSeed[],
  query: string,
  opts: DeepCrawlOptions = {}
): Promise<DeepCrawlResult> {
  const o = {
    maxDepth: 10,
    maxPages: 150,
    maxMs: 10 * 60 * 1000,
    topK: 5,
    minScore: 1,
    timeoutMs: 10000,
    maxBytes: 2_000_000,
    noDelay: process.env.DEEP_NO_DELAY === "1",
    expandKeywords: false,
    maxNewKeywords: 24,
    keywordsPerPage: 3,
    ...opts,
  };
  const fetchHtml =
    o.fetchHtml ?? ((url: string) => fetchHtmlDefault(url, o.timeoutMs, o.maxBytes));
  const kw = new Set(keywords(query));
  const newKeywords: string[] = [];
  const visited = new Set<string>();
  const lastFetch = new Map<string, number>();
  const t0 = Date.now();

  interface Job {
    url: string;
    norm: string;
    depth: number;
    viaUrl: string | null;
    title: string;
    snippet: string;
  }
  const queue: Job[] = [];
  const enqueue = (
    url: string,
    depth: number,
    viaUrl: string | null,
    title: string,
    snippet: string
  ) => {
    const norm = normalizeUrl(url);
    if (!norm || visited.has(norm)) return;
    visited.add(norm);
    queue.push({ url: norm, norm, depth, viaUrl, title, snippet });
  };
  for (const s of seeds) enqueue(s.url, 0, null, s.title, s.snippet);

  const pages: DeepPage[] = [];
  let pagesCrawled = 0;
  let maxDepthReached = 0;
  let capped = false;
  let capReason: DeepCrawlResult["capReason"] = null;

  while (queue.length > 0) {
    if (pagesCrawled >= o.maxPages) {
      capped = true;
      capReason = "page_cap";
      break;
    }
    if (Date.now() - t0 > o.maxMs) {
      capped = true;
      capReason = "time_cap";
      break;
    }
    const job = queue.shift()!;
    // Per-domain politeness: >=2s between requests to the same host.
    if (!o.noDelay) {
      const host = new URL(job.norm).host;
      const gap = 2000 + Math.random() * 500;
      const wait = (lastFetch.get(host) ?? 0) + gap - Date.now();
      if (wait > 0) await sleep(wait);
      lastFetch.set(host, Date.now());
    }
    let html: string;
    try {
      html = await fetchHtml(job.url);
    } catch {
      continue; // one dead page never kills the crawl
    }
    pagesCrawled++;
    if (job.depth > maxDepthReached) maxDepthReached = job.depth;
    const text = htmlToText(html);
    pages.push({
      title: job.title || pageTitle(html, job.url),
      url: job.url,
      snippet: job.snippet || text.slice(0, 180),
      depth: job.depth,
      viaUrl: job.viaUrl,
      text,
    });
    // Grow the gating set from what the crawl itself discovers: newly found
    // associated keywords steer the link scoring of all deeper layers.
    if (o.expandKeywords) {
      for (const k of associatedKeywords(text, kw, o.keywordsPerPage)) {
        if (newKeywords.length >= o.maxNewKeywords) break;
        kw.add(k);
        newKeywords.push(k);
      }
    }
    if (job.depth >= o.maxDepth) continue;
    const scored: { link: RawLink; norm: string; score: number }[] = [];
    for (const link of extractLinks(html, job.url)) {
      const norm = normalizeUrl(link.url);
      if (!norm || visited.has(norm) || norm === job.norm) continue;
      const score = linkScore(link.anchor, link.url, kw);
      if (score >= o.minScore) scored.push({ link, norm, score });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const c of scored.slice(0, o.topK)) {
      enqueue(c.norm, job.depth + 1, job.norm, "", c.link.anchor.slice(0, 180));
    }
  }

  return { pages, pagesCrawled, maxDepthReached, capped, capReason, newKeywords };
}
