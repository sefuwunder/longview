// The Longview research agent. Fully deterministic — NO LLM.
//
// An agent run is a visible plan → act → reflect loop:
//
//   1. PLAN     decompose the question into lines of inquiry (sub-questions)
//   2. SEARCH   run each line's query variants through the active backend
//   3. READ     fetch the top pages per line and extract evidence sentences
//   4. REFLECT  check keyword coverage; weak spots trigger follow-up searches
//   5. SYNTHESIZE group evidence into findings and build the agent graph
//
// Every phase emits a step, so the UI can narrate the run live instead of
// showing a bare "working…" spinner. The run's output is the agent graph:
// question → lines of inquiry → sources → findings, which the canvas
// visualizes.

import { search, type SearchOutcome } from "./search";
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
  sources: { title: string; url: string }[],
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
  const pages: { url: string; title: string; snippet: string; text: string }[] = [];
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

  // ---- 4. REFLECT ----
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

  // ---- 5. SYNTHESIZE ----
  const findings = groupFindings(evidence);
  const sources = pages.map((p) => ({
    title: p.title,
    url: p.url,
    snippet: p.snippet,
  }));
  const graph = buildAgentGraph(question, plan, sources, findings, foundVia);
  const note =
    `Agent run: ${plan.length} lines of inquiry, ${pages.length} pages read, ` +
    `${sources.length} sources, ${findings.length} findings` +
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
  };
  emit(
    "synthesize",
    `Assembled ${findings.length} finding${findings.length === 1 ? "" : "s"} from ${sources.length} source${sources.length === 1 ? "" : "s"}`,
    findings.map((f) => f.label).join("  ·  ") || undefined
  );
  emit("done", "Research complete");

  return { report, plan, sources, findings, graph, stats, steps };
}
