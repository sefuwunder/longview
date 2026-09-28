// The Longview research agent. Fully deterministic — NO LLM.
//
// An agent run is a visible plan → act → reflect loop:
//
//   1. PLAN     decompose the question into lines of inquiry (sub-questions)
//   2. SEARCH   run each line's query variants through the active backend
//   3. READ     fetch the top pages per line and extract evidence sentences
//   4. CRAWL    deep-crawl from the read pages (up to 8 layers), growing the
//               keyword set from newly found associated keywords as it goes
//   5. REFLECT  check keyword coverage; weak spots trigger follow-up searches
//   6. SYNTHESIZE group evidence into findings and build the agent graph
//
// Every phase emits a step, so the UI can narrate the run live instead of
// showing a bare "working…" spinner. The run's output is the agent graph:
// question → lines of inquiry → sources → findings, which the canvas
// visualizes.

import { search, type SearchOutcome } from "./search";
import {
  deepCrawl,
  type DeepCrawlOptions,
  type DeepCrawlResult,
  type DeepSeed,
} from "./deepcrawl";
import {
  keywords,
  stem,
  queryVariants,
  extractiveSummary,
  buildReport,
  fetchPageText,
  splitSentences,
} from "./research";

export type AgentStepKind =
  | "plan"
  | "search"
  | "read"
  | "crawl"
  | "reflect"
  | "followup"
  | "synthesize"
  | "done"
  | "error";

export interface AgentStep {
  seq: number;
  kind: AgentStepKind;
  label: string;
  detail?: string;
  at: number;
}

export interface SubQuestion {
  id: string;
  label: string;
  queries: string[];
}

export interface Evidence {
  sentence: string;
  score: number;
  url: string;
  title: string;
  kws: string[];
}

export interface Finding {
  id: string;
  label: string;
  sentences: { text: string; url: string; title: string }[];
  sourceUrls: string[];
}

export interface AgentGraphNode {
  id: string;
  kind: "question" | "subq" | "source" | "finding";
  label: string;
  url?: string;
  detail?: string;
  /** Source nodes: crawl depth (0 = seed page). */
  depth?: number;
  /** Source nodes: associated keywords this page contributed while crawling. */
  kwAdded?: string[];
  /** Source nodes: evidence sentences drawn from this page. */
  evidence?: number;
  /** Source nodes: domain of the parent page it was discovered on (null for seeds). */
  via?: string | null;
  /** Source nodes: short text snippet from the search result / page. */
  snippet?: string;
}

export interface AgentGraphEdge {
  from: string;
  to: string;
  label: string;
}

export interface AgentGraph {
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
}

export interface AgentStats {
  subquestions: number;
  pagesRead: number;
  sources: number;
  findings: number;
  followups: number;
  /** Deep-crawl pages fetched (seeds + discovered). */
  crawledPages: number;
  /** Deepest link layer the crawl reached (0 when skipped). */
  crawlDepth: number;
  /** Associated keywords the crawl discovered and added to its gating set. */
  newKeywords: string[];
}

/** Content-word runs (2+ consecutive significant words) become aspect drills. */
export function aspectsOf(question: string): string[] {
  const toks = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
  const STOPWORDS = new Set(
    "what,which,who,whom,how,when,where,why,are,the,and,for,with,from,that,this,these,those,have,has,had,been,were,was,will,would,should,could,does,than,then,into,about,over,under,between,through,during,each,other,some,such,only,very,can,may,might,must,also,per,via,one,two,new".split(
      ","
    )
  );
  const runs: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length >= 2) runs.push(cur.join(" "));
    cur = [];
  };
  for (const t of toks) {
    if (!STOPWORDS.has(t)) cur.push(stem(t));
    else flush();
  }
  flush();
  const seen = new Set<string>();
  const q = question.toLowerCase().replace(/\s+/g, " ").trim();
  return runs
    .filter((r) => r !== q && !seen.has(r) && (seen.add(r), true))
    .slice(0, 3);
}

/**
 * Decompose a question into lines of inquiry. Pure and deterministic.
 * Always includes the question itself first, then up to 3 aspect drills.
 */
export function planQuestion(question: string): SubQuestion[] {
  const q = question.trim().replace(/\?+\s*$/, "").replace(/\s+/g, " ");
  const subs: SubQuestion[] = [
    { id: "q0", label: q, queries: queryVariants(q).slice(0, 4) },
  ];
  const kw = keywords(q);
  aspectsOf(question).forEach((a, i) => {
    const extra = kw.find((k) => !a.split(" ").includes(k));
    const queries = [a, `${a} explained`, `${a} overview`];
    if (extra) queries.splice(1, 0, `${a} ${extra}`);
    subs.push({
      id: `q${i + 1}`,
      label: a,
      queries: [...new Set(queries)].slice(0, 3),
    });
  });
  return subs.slice(0, 4);
}

/**
 * Score every candidate sentence against the question, keeping provenance
 * and keyword hits. Like extractiveSummary, but per-sentence records for
 * the reflect + synthesize phases.
 */
export function scoreEvidence(
  pages: { url: string; title: string; text: string }[],
  question: string
): Evidence[] {
  const kw = new Set(keywords(question));
  if (kw.size === 0) return [];
  const out: Evidence[] = [];
  for (const p of pages) {
    for (const s of splitSentences(p.text)) {
      const toks = s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .map(stem);
      const uniq = [...new Set(toks)];
      if (uniq.length === 0) continue;
      const hits = uniq.filter((t) => kw.has(t)).length;
      if (hits < 2) continue;
      out.push({
        sentence: s,
        score: hits / Math.sqrt(uniq.length),
        url: p.url,
        title: p.title,
        kws: uniq,
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Coverage check: question keywords with fewer than 2 evidence hits are
 * weak spots the agent should follow up on. Deterministic.
 */
export function reflectCoverage(
  question: string,
  evidence: Evidence[]
): string[] {
  const kw = keywords(question);
  const hits = new Map<string, number>();
  for (const k of kw) hits.set(k, 0);
  for (const e of evidence) {
    const set = new Set(e.kws);
    for (const k of kw) if (set.has(k)) hits.set(k, (hits.get(k) ?? 0) + 1);
  }
  return kw.filter((k) => (hits.get(k) ?? 0) < 2);
}

/**
 * Greedy grouping: the top-scoring unassigned sentence seeds a finding;
 * sentences sharing ≥2 keywords with the seed join it (max 4 per finding).
 * Label = the group's top 3 keywords. Deterministic.
 */
export function groupFindings(
  evidence: Evidence[],
  maxFindings = 6
): Finding[] {
  const sorted = [...evidence].sort((a, b) => b.score - a.score);
  const used = new Set<number>();
  const findings: Finding[] = [];
  for (let i = 0; i < sorted.length && findings.length < maxFindings; i++) {
    if (used.has(i)) continue;
    const seed = sorted[i];
    const seedSet = new Set(seed.kws);
    const group: Evidence[] = [seed];
    used.add(i);
    for (let j = i + 1; j < sorted.length && group.length < 4; j++) {
      if (used.has(j)) continue;
      let shared = 0;
      for (const k of sorted[j].kws) if (seedSet.has(k)) shared++;
      if (shared >= 2) {
        group.push(sorted[j]);
        used.add(j);
      }
    }
    const freq = new Map<string, number>();
    for (const g of group)
      for (const k of g.kws) freq.set(k, (freq.get(k) ?? 0) + 1);
    const label = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 3)
      .map(([k]) => k)
      .join(" · ");
    findings.push({
      id: `f${findings.length}`,
      label: label || "misc",
      sentences: group.map((g) => ({
        text: g.sentence,
        url: g.url,
        title: g.title,
      })),
      sourceUrls: [...new Set(group.map((g) => g.url))],
    });
  }
  return findings;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Build the agent's output graph: question → lines of inquiry → sources →
 * findings. `foundVia` maps source URL → sub-question id.
 */
export function buildAgentGraph(
  question: string,
  plan: SubQuestion[],
  sources: {
    title: string;
    url: string;
    snippet?: string;
    depth?: number;
    kwAdded?: string[];
    evidence?: number;
    via?: string | null;
  }[],
  findings: Finding[],
  foundVia: Map<string, string>
): AgentGraph {
  const nodes: AgentGraphNode[] = [
    { id: "q", kind: "question", label: question },
  ];
  const edges: AgentGraphEdge[] = [];
  for (const sq of plan) {
    nodes.push({ id: sq.id, kind: "subq", label: sq.label });
    edges.push({ from: "q", to: sq.id, label: "line of inquiry" });
  }
  sources.forEach((s, i) => {
    const id = `p${i}`;
    nodes.push({
      id,
      kind: "source",
      label: s.title,
      url: s.url,
      detail: domainOf(s.url),
      snippet: s.snippet ?? "",
      depth: s.depth ?? 0,
      kwAdded: s.kwAdded ?? [],
      evidence: s.evidence ?? 0,
      via: s.via ?? null,
    });
    const via = foundVia.get(s.url);
    if (via && plan.some((p) => p.id === via))
      edges.push({ from: via, to: id, label: "surfaced" });
  });
  const urlToPid = new Map<string, string>();
  sources.forEach((s, i) => {
    if (!urlToPid.has(s.url)) urlToPid.set(s.url, `p${i}`);
  });
  for (const f of findings) {
    nodes.push({
      id: f.id,
      kind: "finding",
      label: f.label,
      detail: `${f.sentences.length} passage${f.sentences.length === 1 ? "" : "s"} · ${f.sourceUrls.length} source${f.sourceUrls.length === 1 ? "" : "s"}`,
    });
    for (const u of f.sourceUrls) {
      const pid = urlToPid.get(u);
      if (pid) edges.push({ from: pid, to: f.id, label: "supports" });
    }
  }
  return { nodes, edges };
}

export interface AgentDeps {
  crawl?: (q: string) => Promise<SearchOutcome>;
  fetchPage?: (url: string) => Promise<string>;
  maxQueriesPerSubq?: number;
  maxPagesPerSubq?: number;
  maxFollowups?: number;
  /**
   * Deep-crawl override (tests). Receives the read pages as seeds, the
   * question, and the max link depth.
   */
  deepCrawl?: (
    seeds: DeepSeed[],
    query: string,
    maxDepth: number,
    opts?: DeepCrawlOptions
  ) => Promise<DeepCrawlResult>;
  /** Max link depth for the agent's deep crawl (0 skips the crawl). Default 8. */
  maxCrawlDepth?: number;
  /** Max pages the agent's deep crawl may fetch. Default 40. */
  maxCrawlPages?: number;
  onStep?: (step: Omit<AgentStep, "seq" | "at">) => void;
}

export interface AgentResult {
  report: string;
  plan: SubQuestion[];
  sources: { title: string; url: string; snippet: string }[];
  findings: Finding[];
  graph: AgentGraph;
  stats: AgentStats;
  steps: AgentStep[];
}

function short(s: string, n = 70): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Run the full agent loop. Individual search/page failures are tolerated;
 * a total failure (nothing found, nothing readable) throws.
 */
export async function runAgent(
  question: string,
  deps: AgentDeps = {}
): Promise<AgentResult> {
  const crawl = deps.crawl ?? search;
  const fetchPage = deps.fetchPage ?? fetchPageText;
  const maxQueriesPerSubq = deps.maxQueriesPerSubq ?? 3;
  const maxPagesPerSubq = deps.maxPagesPerSubq ?? 4;
  const maxFollowups = deps.maxFollowups ?? 2;
  const maxCrawlDepth = deps.maxCrawlDepth ?? 8;
  const maxCrawlPages = deps.maxCrawlPages ?? 40;
  const doDeep =
    deps.deepCrawl ??
    ((seeds: DeepSeed[], q: string, md: number, opts?: DeepCrawlOptions) =>
      deepCrawl(seeds, q, {
        expandKeywords: true,
        maxPages: maxCrawlPages,
        maxMs: 3 * 60 * 1000,
        ...opts,
        maxDepth: md,
      }));

  const steps: AgentStep[] = [];
  const emit = (kind: AgentStepKind, label: string, detail?: string) => {
    const s: AgentStep = {
      seq: steps.length,
      kind,
      label,
      detail,
      at: Date.now(),
    };
    steps.push(s);
    deps.onStep?.({ kind, label, detail });
  };

  // ---- 1. PLAN ----
  const plan = planQuestion(question);
  emit(
    "plan",
    `Planned ${plan.length} line${plan.length === 1 ? "" : "s"} of inquiry`,
    plan.map((p) => p.label).join("  ·  ")
  );

  // ---- 2. SEARCH ----
  const seen = new Map<string, { title: string; url: string; snippet: string }>();
  const foundVia = new Map<string, string>();
  let searchOk = 0;
  for (const sq of plan) {
    const queries = sq.queries.slice(0, maxQueriesPerSubq);
    let n = 0;
    for (const q of queries) {
      try {
        const r = await crawl(q);
        if (r.ok && r.results.length > 0) {
          searchOk++;
          for (const res of r.results) {
            if (!seen.has(res.url)) {
              seen.set(res.url, res);
              foundVia.set(res.url, sq.id);
              n++;
            }
          }
        }
      } catch {
        // one dead query never kills the run
      }
    }
    emit(
      "search",
      `Searched “${short(sq.label)}”`,
      `${queries.length} quer${queries.length === 1 ? "y" : "ies"} → ${n} new result${n === 1 ? "" : "s"}`
    );
  }
  if (searchOk === 0) {
    throw new Error("all search queries failed");
  }

  // ---- 3. READ ----
  const pages: {
    url: string;
    title: string;
    snippet: string;
    text: string;
    depth: number;
    kwAdded: string[];
  }[] = [];
  const readUrls = new Set<string>();
  const readPool = async (urls: string[], label: string) => {
    let read = 0;
    for (const u of urls) {
      if (readUrls.has(u)) continue;
      readUrls.add(u);
      try {
        const text = await fetchPage(u);
        const meta = seen.get(u);
        if (text.length > 200) {
          pages.push({
            url: u,
            title: meta?.title ?? u,
            snippet: meta?.snippet ?? "",
            text,
            depth: 0,
            kwAdded: [],
          });
          read++;
        }
      } catch {
        // one dead page never kills the run
      }
    }
    return read;
  };
  for (const sq of plan) {
    const urls = [...seen.keys()]
      .filter((u) => foundVia.get(u) === sq.id && !readUrls.has(u))
      .slice(0, maxPagesPerSubq);
    const read = await readPool(urls, sq.label);
    emit(
      "read",
      `Read ${read} page${read === 1 ? "" : "s"} for “${short(sq.label)}”`,
      read > 0 ? undefined : "no readable pages among the top results"
    );
  }
  if (pages.length === 0) {
    throw new Error("no pages could be fetched");
  }

  // ---- 4. CRAWL ----
  // Deep-crawl from the read pages, up to maxCrawlDepth link layers. The
  // crawl grows its own keyword set from newly found associated keywords,
  // so deeper layers follow terminology the run discovered, not just the
  // question's words. Discovered pages join the evidence pool below.
  let crawledPages = 0;
  let crawlDepth = 0;
  let newKeywords: string[] = [];
  const crawlVia = new Map<string, string | null>();
  if (maxCrawlDepth > 0) {
    const seeds: DeepSeed[] = pages.map((p) => ({
      title: p.title,
      url: p.url,
      snippet: p.snippet,
    }));
    let dc: DeepCrawlResult;
    try {
      dc = await doDeep(seeds, question, maxCrawlDepth);
    } catch {
      // a dead crawl never kills the run; the read pages still stand
      dc = {
        pages: [],
        pagesCrawled: 0,
        maxDepthReached: 0,
        capped: false,
        capReason: null,
        newKeywords: [],
      };
    }
    crawledPages = dc.pagesCrawled;
    crawlDepth = dc.maxDepthReached;
    newKeywords = dc.newKeywords;
    for (const p of dc.pages) crawlVia.set(p.url, p.viaUrl);
    // Attribute each discovered page to a line of inquiry by walking its
    // viaUrl chain back to the seed it grew from.
    const via = new Map(dc.pages.map((p) => [p.url, p.viaUrl]));
    const subqOf = (url: string): string => {
      let cur: string | null = url;
      const guard = new Set<string>();
      while (cur && !guard.has(cur)) {
        guard.add(cur);
        const sq = foundVia.get(cur);
        if (sq) return sq;
        cur = via.get(cur) ?? null;
      }
      return "q0";
    };
    let added = 0;
    for (const p of dc.pages) {
      if (p.depth === 0 || readUrls.has(p.url)) continue;
      readUrls.add(p.url);
      if (!seen.has(p.url)) {
        seen.set(p.url, { title: p.title, url: p.url, snippet: p.snippet });
      }
      foundVia.set(p.url, subqOf(p.url));
      pages.push({
        url: p.url,
        title: p.title,
        snippet: p.snippet,
        text: p.text,
        depth: p.depth,
        kwAdded: p.kwAdded,
      });
      added++;
    }
    emit(
      "crawl",
      `Deep crawl to depth ${crawlDepth}: ${crawledPages} page${crawledPages === 1 ? "" : "s"}, ${added} new`,
      newKeywords.length > 0
        ? `new associated keywords: ${newKeywords.slice(0, 8).join(", ")}${newKeywords.length > 8 ? "…" : ""}`
        : "no new associated keywords surfaced"
    );
  }

  // ---- 5. REFLECT ----
  let evidence = scoreEvidence(pages, question);
  const weak = reflectCoverage(question, evidence);
  let followups = 0;
  if (weak.length > 0 && maxFollowups > 0) {
    const aspect = plan.length > 1 ? plan[1].label : keywords(question)[0] ?? "";
    const fuQueries = weak
      .slice(0, maxFollowups)
      .map((k) => (aspect ? `${k} ${aspect}` : k));
    emit(
      "reflect",
      `Coverage check: ${weak.length} weak spot${weak.length === 1 ? "" : "s"} (${weak.slice(0, 4).join(", ")})`,
      `following up with ${fuQueries.length} targeted search${fuQueries.length === 1 ? "" : "es"}`
    );
    for (const fq of fuQueries) {
      let n = 0;
      try {
        const r = await crawl(fq);
        if (r.ok) {
          const urls: string[] = [];
          for (const res of r.results.slice(0, 3)) {
            if (!seen.has(res.url)) {
              seen.set(res.url, res);
              foundVia.set(res.url, "q0");
              urls.push(res.url);
              n++;
            }
          }
          const read = await readPool(urls, fq);
          emit("followup", `Follow-up: “${short(fq)}”`, `${n} new results, ${read} read`);
          followups++;
        }
      } catch {
        // a dead follow-up never kills the run
      }
    }
    evidence = scoreEvidence(pages, question);
  } else {
    emit(
      "reflect",
      "Coverage check passed",
      weak.length === 0
        ? "every key term has supporting evidence"
        : "follow-ups disabled for this run"
    );
  }

  // ---- 6. SYNTHESIZE ----
  const findings = groupFindings(evidence);
  const evCount = new Map<string, number>();
  for (const e of evidence) evCount.set(e.url, (evCount.get(e.url) ?? 0) + 1);
  const viaDomain = new Map<string, string | null>();
  for (const p of pages) if (!viaDomain.has(p.url)) viaDomain.set(p.url, null);
  for (const [url, parent] of crawlVia)
    viaDomain.set(url, parent ? domainOf(parent) : null);
  const sources = pages.map((p) => ({
    title: p.title,
    url: p.url,
    snippet: p.snippet,
    depth: p.depth,
    kwAdded: p.kwAdded,
    evidence: evCount.get(p.url) ?? 0,
    via: viaDomain.get(p.url) ?? null,
  }));
  const graph = buildAgentGraph(question, plan, sources, findings, foundVia);
  const note =
    `Agent run: ${plan.length} lines of inquiry, ${pages.length} pages read, ` +
    `${sources.length} sources, ${findings.length} findings` +
    (crawledPages > 0
      ? `, deep crawl to depth ${crawlDepth} (${crawledPages} pages` +
        (newKeywords.length > 0 ? `, ${newKeywords.length} new keywords` : "") +
        ")"
      : "") +
    (followups > 0 ? `, ${followups} follow-up search${followups === 1 ? "" : "es"} after the coverage check` : "") +
    ".";
  const report = buildReport(
    question,
    extractiveSummary(pages, question, 8),
    sources,
    note
  );
  const stats: AgentStats = {
    subquestions: plan.length,
    pagesRead: pages.length,
    sources: sources.length,
    findings: findings.length,
    followups,
    crawledPages,
    crawlDepth,
    newKeywords,
  };
  emit(
    "synthesize",
    `Assembled ${findings.length} finding${findings.length === 1 ? "" : "s"} from ${sources.length} source${sources.length === 1 ? "" : "s"}`,
    findings.map((f) => f.label).join("  ·  ") || undefined
  );
  emit("done", "Research complete");

  return { report, plan, sources, findings, graph, stats, steps };
}
