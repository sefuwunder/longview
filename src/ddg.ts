// DuckDuckGo crawler for longview.
//
// There is no official DuckDuckGo search API, so this module drives the
// public HTML endpoints with a polite client: realistic UA, >=2s between
// requests with jitter, capped results, exponential backoff between
// endpoints. DuckDuckGo sometimes serves a bot challenge (HTTP 202 +
// "anomaly-modal") to datacenter / flagged IPs, so requests walk a fallback
// chain: html POST -> html GET -> lite GET. Each failure is classified so
// callers (and the UI) can explain *why* a crawl failed instead of just
// marking the topic `error`.
//
// All parsing is dependency-free regex extraction. The HTML endpoints wrap
// outbound links as /l/?uddg=<urlencoded real url>&rut=... ; lite uses the
// same uddg= redirect links in simpler table markup.

export interface DDGResult {
  title: string;
  url: string;
  snippet: string;
}

/** Machine-readable failure classes. `http_<code>` covers the rest. */
export type CrawlErrorClass =
  | "challenge" // HTTP 202 or anomaly-modal/captcha markup: DDG bot check
  | "timeout" // request aborted after timeoutMs
  | "network" // DNS, refused, reset, other fetch-level failures
  | "parse_empty" // HTTP 200 but zero results parsed: likely a markup change
  | `http_${number}`;

export interface CrawlResult {
  ok: boolean;
  results: DDGResult[];
  /** Name of the endpoint that produced this result (or the last tried). */
  endpoint: string | null;
  httpStatus: number | null;
  errorClass: CrawlErrorClass | null;
  /** Human-readable sentence describing the failure (null on success). */
  error: string | null;
  /** Milliseconds spent on the winning (or last) endpoint attempt. */
  ms: number;
}

export interface EndpointDef {
  name: string;
  method: "GET" | "POST";
  /** GET: base + "?q=" + enc(query). POST: base, query in the body. */
  base: string;
  parser: (html: string, maxResults: number) => DDGResult[];
}

export interface CrawlOptions {
  /** Skip the politeness delay (tests). */
  noDelay?: boolean;
  /** Milliseconds to wait for the HTTP response. */
  timeoutMs?: number;
  maxResults?: number;
}

export interface DiagRow {
  endpoint: string;
  httpStatus: number | null;
  resultCount: number;
  errorClass: CrawlErrorClass | null;
  ms: number;
}

export interface DiagResult {
  query: string;
  endpoints: DiagRow[];
  /** Name of the first endpoint that returned results, or null. */
  winner: string | null;
}

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
  // Redirect links: //duckduckgo.com/l/?uddg=<enc>&rut=...
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
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
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
    const sm = rest.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = sm
      ? decodeEntities(stripTags(sm[1])).trim().replace(/\s+/g, " ")
      : "";
    out.push({ title: title || url, url, snippet });
  }
  return out;
}

/**
 * Parse lite.duckduckgo.com markup. Lite uses a simple table layout; result
 * links still carry the uddg= redirect parameter, which is what we key on.
 * NOTE: this parser is built from lite's documented simple structure and is
 * deliberately tolerant of layout drift; verify against a live capture if
 * DDG changes it.
 */
export function parseDDGLite(html: string, maxResults = 20): DDGResult[] {
  const out: DDGResult[] = [];
  const anchorRe = /<a[^>]*href="([^"]*uddg=[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null && out.length < maxResults) {
    const url = unwrapDDGUrl(decodeEntities(m[1]));
    const title = decodeEntities(stripTags(m[2])).trim().replace(/\s+/g, " ");
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (out.some((r) => r.url === url)) continue;
    const rest = html.slice(anchorRe.lastIndex, anchorRe.lastIndex + 3000);
    const sm = rest.match(
      /class="result-?snippet"[^>]*>([\s\S]*?)<\/(?:td|div)>/i
    );
    const snippet = sm
      ? decodeEntities(stripTags(sm[1])).trim().replace(/\s+/g, " ")
      : "";
    out.push({ title: title || url, url, snippet });
  }
  return out;
}

/** The fallback chain. DDG_BASE_URL overrides it entirely (single endpoint). */
export function buildChain(): EndpointDef[] {
  const override = process.env.DDG_BASE_URL;
  if (override) {
    return [{ name: "custom", method: "POST", base: override, parser: parseDDGHtml }];
  }
  return [
    {
      name: "html-post",
      method: "POST",
      base: "https://html.duckduckgo.com/html/",
      parser: parseDDGHtml,
    },
    {
      name: "html-get",
      method: "GET",
      base: "https://html.duckduckgo.com/html/",
      parser: parseDDGHtml,
    },
    {
      name: "lite",
      method: "GET",
      base: "https://lite.duckduckgo.com/lite/",
      parser: parseDDGLite,
    },
  ];
}

interface RawFetch {
  httpStatus: number | null;
  html: string | null;
  ms: number;
  aborted: boolean;
  network: boolean;
}

async function fetchEndpoint(
  ep: EndpointDef,
  query: string,
  timeoutMs: number
): Promise<RawFetch> {
  const url =
    ep.method === "GET" ? ep.base + "?q=" + encodeURIComponent(query) : ep.base;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: ep.method,
      headers: {
        "User-Agent": UA,
        Accept: "text/html",
        ...(ep.method === "POST"
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      ...(ep.method === "POST"
        ? { body: "q=" + encodeURIComponent(query) }
        : {}),
      signal: controller.signal,
    });
    const html = await res.text();
    return {
      httpStatus: res.status,
      html,
      ms: Date.now() - t0,
      aborted: false,
      network: false,
    };
  } catch (e) {
    const aborted =
      controller.signal.aborted ||
      (e instanceof DOMException && e.name === "AbortError");
    return {
      httpStatus: null,
      html: null,
      ms: Date.now() - t0,
      aborted,
      network: !aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeChallenge(html: string): boolean {
  return /anomaly-modal|captcha|challenge-platform|cf-challenge/i.test(html);
}

function classifyRaw(
  raw: RawFetch,
  ep: EndpointDef,
  maxResults: number
): { errorClass: CrawlErrorClass | null; results: DDGResult[] } {
  if (raw.network) return { errorClass: "network", results: [] };
  if (raw.aborted) return { errorClass: "timeout", results: [] };
  if (raw.httpStatus === 202 || looksLikeChallenge(raw.html ?? ""))
    return { errorClass: "challenge", results: [] };
  if (raw.httpStatus !== 200)
    return {
      errorClass: `http_${raw.httpStatus ?? 0}` as CrawlErrorClass,
      results: [],
    };
  const results = ep.parser(raw.html ?? "", maxResults);
  if (results.length === 0)
    return { errorClass: "parse_empty", results: [] };
  return { errorClass: null, results };
}

export function humanError(
  cls: CrawlErrorClass,
  httpStatus: number | null,
  timeoutMs: number
): string {
  switch (cls) {
    case "challenge":
      return `DuckDuckGo served a bot challenge${
        httpStatus ? ` (HTTP ${httpStatus})` : ""
      } — try again later or from another network`;
    case "timeout":
      return `DuckDuckGo request timed out after ${Math.round(
        timeoutMs / 1000
      )}s — check your connection`;
    case "network":
      return "Could not reach DuckDuckGo — check your connection";
    case "parse_empty":
      return "DuckDuckGo answered but no results could be read — the page format may have changed";
    default:
      return `DuckDuckGo returned HTTP ${httpStatus ?? "unknown"} — try again later`;
  }
}

/**
 * Crawl a query, walking the endpoint fallback chain. Returns a classified
 * result instead of throwing, so callers can persist and display the reason.
 */
export async function crawlEndpoints(
  query: string,
  endpoints: EndpointDef[],
  opts: CrawlOptions = {}
): Promise<CrawlResult> {
  const o = {
    maxResults: 20,
    timeoutMs: 15000,
    noDelay: NO_DELAY,
    ...opts,
  };
  let last: CrawlResult | null = null;
  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    await politeWait(o.noDelay);
    const raw = await fetchEndpoint(ep, query, o.timeoutMs);
    const { errorClass, results } = classifyRaw(raw, ep, o.maxResults);
    if (!errorClass) {
      return {
        ok: true,
        results,
        endpoint: ep.name,
        httpStatus: raw.httpStatus,
        errorClass: null,
        error: null,
        ms: raw.ms,
      };
    }
    last = {
      ok: false,
      results: [],
      endpoint: ep.name,
      httpStatus: raw.httpStatus,
      errorClass,
      error: humanError(errorClass, raw.httpStatus, o.timeoutMs),
      ms: raw.ms,
    };
    // Backoff between endpoints on top of the >=2s politeness gap (tests skip).
    if (!o.noDelay && i < endpoints.length - 1) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  return (
    last ?? {
      ok: false,
      results: [],
      endpoint: null,
      httpStatus: null,
      errorClass: "network",
      error: humanError("network", null, o.timeoutMs),
      ms: 0,
    }
  );
}

/** Crawl DuckDuckGo for a query using the default fallback chain. */
export async function crawlDDG(
  query: string,
  opts: CrawlOptions = {}
): Promise<CrawlResult> {
  return crawlEndpoints(query, buildChain(), opts);
}

/**
 * Probe every endpoint in the chain once (no politeness delay, no backoff)
 * and report per-endpoint status. Used by the /api/diag/crawl endpoint and
 * the UI "Diagnose" button so a user can see exactly which endpoint works
 * from their network.
 */
export async function diagnoseDDG(
  query: string,
  opts: CrawlOptions = {}
): Promise<DiagResult> {
  const endpoints = buildChain();
  const timeoutMs = opts.timeoutMs ?? 12000;
  const rows: DiagRow[] = [];
  for (const ep of endpoints) {
    const raw = await fetchEndpoint(ep, query, timeoutMs);
    const { errorClass, results } = classifyRaw(
      raw,
      ep,
      opts.maxResults ?? 5
    );
    rows.push({
      endpoint: ep.name,
      httpStatus: raw.httpStatus,
      resultCount: results.length,
      errorClass,
      ms: raw.ms,
    });
  }
  const winner = rows.find((r) => r.errorClass === null)?.endpoint ?? null;
  return { query, endpoints: rows, winner };
}
