// DuckDuckGo crawler for longview.
//
// There is no official DuckDuckGo search API, so this module drives the
// public HTML endpoint (https://html.duckduckgo.com/html/) with a polite
// client: realistic UA, >=2s between requests with jitter, capped results,
// exponential backoff on failures. A failed crawl throws; callers decide how
// to record that (the scheduler marks the topic `error` and moves on).
//
// All parsing is dependency-free regex extraction. The HTML endpoint wraps
// outbound links as /l/?uddg=<urlencoded real url>&rut=... ; direct links
// are used as-is.

export interface DDGResult {
  title: string;
  url: string;
  snippet: string;
}

export interface CrawlOptions {
  /** Override the endpoint (tests point this at a stub server). */
  baseUrl?: string;
  maxResults?: number;
  /** Skip the politeness delay (tests). */
  noDelay?: boolean;
  /** Milliseconds to wait for the HTTP response. */
  timeoutMs?: number;
}

const DEFAULT_BASE = "https://html.duckduckgo.com/html/";
// Honored in tests/stubs to skip the politeness delay. Never set this in
// production: the >=2s gap is what keeps DDG from blocking us.
const NO_DELAY = process.env.DDG_NO_DELAY === "1";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let lastRequestAt = 0;

async function politeWait(noDelay?: boolean): Promise<void> {
  if (noDelay) return;
  const now = Date.now();
  const gap = 2000 + Math.random() * 700; // >=2s + jitter
  const wait = Math.max(0, lastRequestAt + gap - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

export function unwrapDDGUrl(href: string): string {
  // Protocol-relative redirect links: //duckduckgo.com/l/?uddg=<enc>&rut=...
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&mdash;/g, "\u2014")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

/** Parse result anchors + snippets out of the DDG HTML-endpoint markup. */
export function parseDDGHtml(html: string, maxResults = 20): DDGResult[] {
  const out: DDGResult[] = [];
  const anchorRe =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null && out.length < maxResults) {
    const rawHref = m[1];
    const url = unwrapDDGUrl(decodeEntities(rawHref));
    const title = decodeEntities(stripTags(m[2])).trim().replace(/\s+/g, " ");
    if (!url || !/^https?:\/\//i.test(url)) continue;
    // Snippet belongs to this result block; look ahead for the next one.
    const rest = html.slice(anchorRe.lastIndex, anchorRe.lastIndex + 4000);
    const sm = rest.match(
      /class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i
    );
    const snippet = sm
      ? decodeEntities(stripTags(sm[1])).trim().replace(/\s+/g, " ")
      : "";
    out.push({ title: title || url, url, snippet });
  }
  return out;
}

async function fetchOnce(
  query: string,
  o: Required<Omit<CrawlOptions, "noDelay">> & { noDelay?: boolean }
): Promise<DDGResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs);
  try {
    await politeWait(o.noDelay);
    const res = await fetch(o.baseUrl, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
      },
      body: "q=" + encodeURIComponent(query),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
    const html = await res.text();
    return parseDDGHtml(html, o.maxResults);
  } finally {
    clearTimeout(timer);
  }
}

/** Crawl DuckDuckGo for a query. Retries with exponential backoff. */
export async function crawlDDG(
  query: string,
  opts: CrawlOptions = {}
): Promise<DDGResult[]> {
  const o = {
    baseUrl: process.env.DDG_BASE_URL ?? DEFAULT_BASE,
    maxResults: 20,
    timeoutMs: 15000,
    noDelay: NO_DELAY,
    ...opts,
  };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchOnce(query, o);
    } catch (e) {
      lastErr = e;
      // 1s, 2s, 4s backoff; no point delaying in tests when disabled
      if (!o.noDelay) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`DDG crawl failed: ${String(lastErr)}`);
}
