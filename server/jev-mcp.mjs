#!/usr/bin/env node
/**
 * Lead Club MCP server.
 *
 * Exposes TypeSafe AI's Jev decision model (System One API) to Claude as MCP tools,
 * plus a CSV exporter. Zero runtime dependencies: Node >= 20 (global fetch).
 *
 * Transports:
 *   node jev-mcp.mjs              stdio (what the Claude Code plugin uses)
 *   node jev-mcp.mjs --http 8787  Streamable HTTP on POST /mcp (for self-hosting)
 *
 * Configuration (env):
 *   JEV_API_KEY / TYPESAFE_API_KEY   TypeSafe API key (JEV_API_KEY wins). Required for Jev tools.
 *   JEV_BASE_URL                     API root, default https://api.typesafe.ai
 *   JEV_MODEL                        default model, default jev-latest
 *   JEV_MIN_CONFIDENCE               confidence threshold for "qualified", default 0.6
 *   JEV_CONCURRENCY                  parallel Jev requests in batch calls, default 4
 *   JEV_TIMEOUT_MS                   per-attempt timeout, default 20000
 */

import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdir, appendFile, writeFile, readFile, access } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";

export const VERSION = "0.1.0";
const SERVER_INFO = { name: "lead-club-jev", version: VERSION };
const PROTOCOL_VERSION = "2025-06-18";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Treat empty strings and un-substituted `${...}` placeholders as unset. */
const cleanEnv = (v) => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t || t.startsWith("${")) return undefined;
  return t;
};

export function loadConfig(env = process.env) {
  const num = (name, dflt) => {
    const raw = cleanEnv(env[name]);
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) ? n : dflt;
  };
  return {
    apiKey: cleanEnv(env.JEV_API_KEY) ?? cleanEnv(env.TYPESAFE_API_KEY),
    baseURL: (cleanEnv(env.JEV_BASE_URL) ?? cleanEnv(env.TYPESAFE_BASE_URL) ?? "https://api.typesafe.ai").replace(/\/+$/, ""),
    model: cleanEnv(env.JEV_MODEL) ?? cleanEnv(env.TYPESAFE_DEFAULT_MODEL) ?? "jev-latest",
    minConfidence: Math.min(1, Math.max(0, num("JEV_MIN_CONFIDENCE", 0.6))),
    concurrency: Math.max(1, Math.min(16, Math.trunc(num("JEV_CONCURRENCY", 4)))),
    timeoutMs: Math.max(1000, num("JEV_TIMEOUT_MS", 20000)),
  };
}

// ---------------------------------------------------------------------------
// TypeSafe (Jev) client — mirrors the official SDK's wire format and retry policy
// ---------------------------------------------------------------------------

export class JevError extends Error {
  constructor(message, { status, body, requestId } = {}) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const describeError = (status, body) => {
  if (typeof body === "string" && body) return `${status} ${body.slice(0, 200)}`;
  if (body && typeof body === "object") {
    const { error, message, detail } = body;
    if (typeof error === "string") return `${status} ${error}`;
    if (error && typeof error.message === "string") return `${status} ${error.message}`;
    if (typeof message === "string") return `${status} ${message}`;
    if (typeof detail === "string") return `${status} ${detail}`;
    if (Array.isArray(detail)) {
      const parts = detail
        .filter((e) => e && typeof e.msg === "string")
        .map((e) => `${Array.isArray(e.loc) ? e.loc.filter((x) => x !== "body").join(".") + ": " : ""}${e.msg}`);
      if (parts.length) return `${status} ${parts.join("; ")}`;
    }
    return `${status} ${JSON.stringify(body).slice(0, 200)}`;
  }
  return `${status} status code (no body)`;
};

export class JevClient {
  constructor({ apiKey, baseURL, model, timeoutMs = 20000, maxRetries = 2, fetchImpl = globalThis.fetch }) {
    if (!apiKey) throw new JevError("No TypeSafe/Jev API key configured. Set it in the plugin config (jev_api_key) or export TYPESAFE_API_KEY.");
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    const url = `${this.baseURL}${path}`;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": `lead-club-mcp/${VERSION}`,
      "X-TypeSafe-SDK": `lead-club-mcp/${VERSION}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const payload = body === undefined ? undefined : JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      const retriesLeft = this.maxRetries - attempt;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res;
      try {
        res = await this.fetch(url, { method, headers, body: payload, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        if (retriesLeft <= 0) {
          const cause = err?.cause ? ` (${err.cause.code ?? ""} ${err.cause.message ?? ""})`.replace(/\s+\)/, ")") : "";
          const why = controller.signal.aborted ? `timed out after ${this.timeoutMs}ms` : `${err?.message ?? "connection error"}${cause}`;
          throw new JevError(`Jev request to ${url} failed: ${why}. Check network/proxy access to ${this.baseURL}.`);
        }
        await sleep(Math.min(500 * 2 ** attempt, 5000));
        continue;
      }
      clearTimeout(timer);
      const text = await res.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
      const requestId = res.headers.get("x-typesafe-request-id") ?? undefined;
      if (res.ok) return parsed;
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (retriesLeft <= 0 || !retryable) {
        throw new JevError(`Jev API error: ${describeError(res.status, parsed)}`, { status: res.status, body: parsed, requestId });
      }
      const ra = Number(res.headers.get("retry-after-ms") ?? (Number(res.headers.get("retry-after")) * 1000));
      await sleep(Number.isFinite(ra) && ra >= 0 && ra <= 60000 ? ra : Math.min(500 * 2 ** attempt, 5000));
    }
  }

  /** POST /v1/systemone — answer named questions about `state`. */
  systemOne({ state, questions, model }) {
    validateQuestions(questions);
    return this.request("POST", "/v1/systemone", { state, questions, model: model ?? this.model });
  }

  /** GET /v1/models — also a cheap way to verify the key. */
  async listModels() {
    const wire = await this.request("GET", "/v1/models");
    if (wire && Array.isArray(wire.models)) return wire.models;
    throw new JevError("Unexpected response shape from GET /v1/models; expected { models: [...] }.");
  }
}

export function validateQuestions(questions) {
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw new JevError("At least one question is required (an object keyed by question name).");
  }
  for (const [name, q] of Object.entries(questions)) {
    if (!q || typeof q !== "object") throw new JevError(`Question "${name}" must be an object.`);
    if (q.type === "noul") continue;
    if (q.type === "score") {
      if (!Array.isArray(q.criteria)) throw new JevError(`Score question "${name}": criteria must be an ordered array of level descriptions (index 0 = lowest).`);
      if (q.criteria.length < 2 || q.criteria.length > 10) throw new JevError(`Score question "${name}": between 2 and 10 levels are required.`);
      continue;
    }
    if (q.type === "choice") {
      if (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria)) throw new JevError(`Choice question "${name}": criteria must be a map of label -> description.`);
      if (Object.keys(q.criteria).length < 2) throw new JevError(`Choice question "${name}": at least two options are required.`);
      continue;
    }
    throw new JevError(`Question "${name}": type must be one of noul, score, choice.`);
  }
}

// ---------------------------------------------------------------------------
// Lead qualification — the questions we ask Jev about every lead
// ---------------------------------------------------------------------------

export const LEAD_FIELDS = [
  "name", "title", "company", "email", "phone", "linkedin", "website",
  "location", "industry", "company_size", "source_url", "evidence", "notes",
];

/** Keep lead objects small and predictable before sending them as Jev state. */
export function normalizeLead(lead, index) {
  if (!lead || typeof lead !== "object") throw new JevError(`leads[${index}] must be an object.`);
  const out = {};
  for (const k of LEAD_FIELDS) {
    const v = lead[k];
    if (v === undefined || v === null || v === "") continue;
    out[k] = typeof v === "string" ? v.trim().slice(0, 2000) : v;
  }
  for (const [k, v] of Object.entries(lead)) {
    if (!(k in out) && !LEAD_FIELDS.includes(k) && v !== undefined && v !== null && v !== "") out[k] = v;
  }
  if (!out.name && !out.company) throw new JevError(`leads[${index}] needs at least a name or a company.`);
  out.id = typeof lead.id === "string" && lead.id ? lead.id : `lead-${index + 1}`;
  return out;
}

export function buildLeadQuestions({ lead, extraQuestions }) {
  const hasContact = Boolean(lead.email || lead.linkedin || lead.phone || lead.website);
  const questions = {
    is_real: {
      type: "noul",
      instructions:
        "Based only on the evidence provided, is this a real, currently identifiable person or operating organization that matches the stated role and company? " +
        "Answer no for job postings, generic inboxes, placeholder or sample data, defunct companies, outdated roles, or leads where the evidence does not support the claimed identity.",
      criteria: {
        true: "The evidence (snippets, source URLs, profile data) supports that the person or company exists as described.",
        false: "The evidence is missing, contradictory, generic, fabricated-looking, or describes something other than a reachable person or company.",
      },
    },
    icp_fit: {
      type: "score",
      instructions:
        "How well does this lead match the ideal customer profile (ICP) in `icp`? Consider role/seniority, company type and size, industry, geography, and any explicit must-have or exclusion criteria.",
      criteria: [
        "0 – No match: wrong kind of person or company, or explicitly excluded by the ICP.",
        "1 – Weak: shares one surface attribute with the ICP but misses the core criteria.",
        "2 – Partial: matches some core criteria; a notable gap or unknown remains.",
        "3 – Strong: matches the core criteria with only minor gaps.",
        "4 – Ideal: matches every stated criterion with supporting evidence.",
      ],
    },
    verdict: {
      type: "choice",
      instructions:
        "Decide what should happen to this lead. Be strict: only `qualified` when the lead is real, on-ICP, and there is a usable way to reach them or their company.",
      criteria: {
        qualified: "Real, on-ICP, reachable. Worth adding to the outreach list now.",
        review: "Promising but something is missing or uncertain (unverified contact, unclear role, partial fit). A human should look before outreach.",
        reject: "Not real, off-ICP, excluded, unreachable, or the evidence is too weak to trust.",
      },
    },
  };
  if (hasContact) {
    questions.contact_plausible = {
      type: "noul",
      instructions:
        "Is the contact channel provided (email, LinkedIn URL, phone, or website) plausibly correct for this specific person or company, given the evidence? " +
        "Answer no for guessed or pattern-generated emails without supporting evidence, mismatched domains, or profiles that clearly belong to someone else.",
    };
  }
  if (extraQuestions && typeof extraQuestions === "object") {
    for (const [k, v] of Object.entries(extraQuestions)) {
      if (k in questions) throw new JevError(`Custom question "${k}" collides with a built-in question name.`);
      questions[k] = v;
    }
  }
  return questions;
}

/** Turn Jev's answers into a single local decision with a human-readable reason. */
export function decideLead(answers, { minConfidence }) {
  const isReal = answers.is_real?.noul ?? 0;
  const fit = answers.icp_fit?.score ?? 0;
  const fitConf = answers.icp_fit?.confidence ?? 0;
  const verdict = answers.verdict?.choice ?? "reject";
  const verdictConf = answers.verdict?.confidence ?? 0;
  const contact = answers.contact_plausible?.noul;

  const reasons = [];
  let decision = verdict;

  if (isReal < 0.5) { decision = "reject"; reasons.push(`is_real=${isReal.toFixed(2)} (<0.50)`); }
  if (verdict === "qualified" && verdictConf < minConfidence) { decision = "review"; reasons.push(`verdict confidence ${verdictConf.toFixed(2)} < ${minConfidence}`); }
  if (verdict === "qualified" && fit < 2) { decision = "review"; reasons.push(`icp_fit=${fit.toFixed(2)} (<2)`); }
  if (decision === "qualified" && contact !== undefined && contact < 0.5) { decision = "review"; reasons.push(`contact_plausible=${contact.toFixed(2)} (<0.50)`); }
  if (reasons.length === 0) reasons.push(`verdict=${verdict} (conf ${verdictConf.toFixed(2)}), icp_fit=${fit.toFixed(2)} (conf ${fitConf.toFixed(2)}), is_real=${isReal.toFixed(2)}`);

  return {
    decision,
    jev_verdict: verdict,
    jev_verdict_confidence: round(verdictConf),
    icp_fit: round(fit),
    icp_fit_confidence: round(fitConf),
    is_real: round(isReal),
    contact_plausible: contact === undefined ? null : round(contact),
    reason: reasons.join("; "),
  };
}

const round = (n) => (typeof n === "number" ? Math.round(n * 1000) / 1000 : n);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function qualifyLeads(client, { icp, leads, questions, model, minConfidence, concurrency }) {
  if (typeof icp !== "string" || !icp.trim()) throw new JevError("`icp` (ideal customer profile) must be a non-empty string.");
  if (!Array.isArray(leads) || leads.length === 0) throw new JevError("`leads` must be a non-empty array.");
  if (leads.length > 50) throw new JevError("Send at most 50 leads per call; split larger lists into batches.");
  const normalized = leads.map(normalizeLead);

  const results = await mapLimit(normalized, concurrency, async (lead) => {
    const q = buildLeadQuestions({ lead, extraQuestions: questions });
    try {
      const res = await client.systemOne({ state: { icp: icp.trim(), lead }, questions: q, model });
      const custom = {};
      for (const k of Object.keys(questions ?? {})) custom[k] = res.answers?.[k];
      return {
        id: lead.id,
        lead,
        ...decideLead(res.answers ?? {}, { minConfidence }),
        custom_answers: Object.keys(custom).length ? custom : undefined,
        model: res.model,
        usage: res.usage,
      };
    } catch (err) {
      return { id: lead.id, lead, decision: "error", reason: err.message, error: { status: err.status, requestId: err.requestId } };
    }
  });

  const summary = { total: results.length, qualified: 0, review: 0, reject: 0, error: 0 };
  for (const r of results) summary[r.decision] = (summary[r.decision] ?? 0) + 1;
  return { summary, results };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

export const DEFAULT_CSV_COLUMNS = [
  "name", "title", "company", "email", "phone", "linkedin", "website", "location", "industry", "company_size",
  "decision", "icp_fit", "is_real", "contact_plausible", "jev_verdict_confidence", "reason", "source_url", "evidence", "notes",
];

const csvCell = (v) => {
  if (v === undefined || v === null) return "";
  const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Flatten a qualification result (or a plain lead) into one CSV row object. */
export function flattenRow(item) {
  if (item && typeof item === "object" && item.lead && typeof item.lead === "object") {
    const { lead, ...rest } = item;
    return { ...lead, ...rest };
  }
  return item ?? {};
}

export function toCsv(rows, columns) {
  const flat = rows.map(flattenRow);
  let cols = columns;
  if (!cols || cols.length === 0) {
    const seen = new Set(DEFAULT_CSV_COLUMNS.filter((c) => flat.some((r) => r[c] !== undefined && r[c] !== null && r[c] !== "")));
    for (const r of flat) for (const k of Object.keys(r)) {
      if (!seen.has(k) && !["custom_answers", "usage", "model", "error", "id"].includes(k) && typeof r[k] !== "object") seen.add(k);
    }
    cols = [...seen];
  }
  const lines = [cols.map(csvCell).join(",")];
  for (const r of flat) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  return { header: lines[0] + "\n", body: lines.slice(1).map((l) => l + "\n").join(""), columns: cols };
}

export async function exportCsv({ path, rows, columns, append }, { cwd = process.cwd() } = {}) {
  if (typeof path !== "string" || !path.trim()) throw new JevError("`path` is required (prefer an absolute path).");
  if (!Array.isArray(rows) || rows.length === 0) throw new JevError("`rows` must be a non-empty array of leads or qualification results.");
  const target = isAbsolute(path) ? path : resolve(cwd, path);
  await mkdir(dirname(target), { recursive: true });
  const { header, body, columns: cols } = toCsv(rows, columns);
  let exists = false;
  try { await access(target); exists = true; } catch { /* new file */ }
  if (append && exists) {
    const head = (await readFile(target, "utf8")).split(/\r?\n/)[0];
    if (head !== header.trimEnd()) {
      throw new JevError(`Cannot append: existing header differs. Pass the same \`columns\` ([${head}]) or write to a new file.`);
    }
    await appendFile(target, body, "utf8");
  } else {
    await writeFile(target, header + body, "utf8");
  }
  return { path: target, rows: rows.length, columns: cols, appended: Boolean(append && exists) };
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

const LEAD_SCHEMA = {
  type: "object",
  description: "One lead. Include every field you actually found; never invent values. Put the raw snippets that support the lead in `evidence`.",
  properties: {
    id: { type: "string", description: "Optional stable id; defaults to lead-N." },
    name: { type: "string" },
    title: { type: "string", description: "Job title / role." },
    company: { type: "string" },
    email: { type: "string", description: "Only if found on a page. If inferred from a pattern, say so in notes." },
    phone: { type: "string" },
    linkedin: { type: "string", description: "LinkedIn profile or company URL." },
    website: { type: "string" },
    location: { type: "string" },
    industry: { type: "string" },
    company_size: { type: "string" },
    source_url: { type: "string", description: "Page(s) where the lead was found; separate several with spaces." },
    evidence: { type: "string", description: "Quoted snippets from the sources that support name, role, company and contact." },
    notes: { type: "string" },
  },
  additionalProperties: true,
};

const QUESTIONS_SCHEMA = {
  type: "object",
  description:
    "Jev questions keyed by name. Each is {type:'noul', instructions?, criteria?:{true?,false?}} | {type:'score', instructions, criteria:[level0, level1, ...]} (2-10 levels, index 0 = lowest) | {type:'choice', instructions, criteria:{label: description|null}}.",
  additionalProperties: { type: "object" },
};

const TOOLS = [
  {
    name: "jev_check_setup",
    description: "Verify the Jev (TypeSafe AI) API key works and list the models available to the account. Call this first if any Jev tool fails with an auth error.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Check Jev setup", readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "jev_qualify_leads",
    description:
      "Ask Jev to decide, per lead, whether it is real (is_real), how well it fits the ideal customer profile (icp_fit 0-4), whether the contact channel is plausible, and a verdict (qualified / review / reject). " +
      "Returns a local `decision` after applying confidence thresholds plus Jev's raw probabilities. Send 1-50 leads per call with the evidence you gathered; Jev only sees what you pass in.",
    inputSchema: {
      type: "object",
      properties: {
        icp: { type: "string", description: "Ideal customer profile in plain language: who to find, must-haves, exclusions, geography, company size, etc." },
        leads: { type: "array", minItems: 1, maxItems: 50, items: LEAD_SCHEMA },
        questions: { ...QUESTIONS_SCHEMA, description: "Optional extra questions asked about every lead alongside the built-in ones (e.g. a noul 'Are they hiring engineers?')." },
        min_confidence: { type: "number", minimum: 0, maximum: 1, description: "Override the confidence threshold for `qualified` (default from config, 0.6)." },
        model: { type: "string", description: "Override the Jev model (default jev-latest)." },
      },
      required: ["icp", "leads"],
      additionalProperties: false,
    },
    annotations: { title: "Qualify leads with Jev", readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "jev_decide",
    description:
      "Low-level access to Jev's System One API: pass any `state` (text or JSON) and named questions (noul = yes/no probability, score = ordered rubric, choice = pick one). " +
      "Use for custom decisions such as ranking companies, classifying a page, or checking a single claim.",
    inputSchema: {
      type: "object",
      properties: {
        state: { description: "Text, JSON object or array to evaluate." },
        questions: QUESTIONS_SCHEMA,
        model: { type: "string" },
      },
      required: ["state", "questions"],
      additionalProperties: false,
    },
    annotations: { title: "Ask Jev a decision", readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "leads_export_csv",
    description:
      "Write leads (or jev_qualify_leads results) to a CSV file. Flattens `lead` + decision fields into columns. Use `append: true` to add batches to the same file. Prefer an absolute path such as <project>/leads/<slug>.csv.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Output file path (absolute preferred)." },
        rows: { type: "array", minItems: 1, items: { type: "object" }, description: "Qualification results or plain lead objects." },
        columns: { type: "array", items: { type: "string" }, description: "Optional explicit column order." },
        append: { type: "boolean", description: "Append to an existing file with the same header." },
      },
      required: ["path", "rows"],
      additionalProperties: false,
    },
    annotations: { title: "Export leads to CSV", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

export function createToolHandlers({ config, fetchImpl = globalThis.fetch, cwd = process.cwd() } = {}) {
  const cfg = config ?? loadConfig();
  const client = (overrideKey) => new JevClient({
    apiKey: overrideKey ?? cfg.apiKey, baseURL: cfg.baseURL, model: cfg.model, timeoutMs: cfg.timeoutMs, fetchImpl,
  });

  return {
    async jev_check_setup(_args, ctx) {
      const models = await client(ctx?.apiKey).listModels();
      return { ok: true, base_url: cfg.baseURL, default_model: cfg.model, min_confidence: cfg.minConfidence, models };
    },
    async jev_qualify_leads(args, ctx) {
      return qualifyLeads(client(ctx?.apiKey), {
        icp: args.icp, leads: args.leads, questions: args.questions, model: args.model,
        minConfidence: typeof args.min_confidence === "number" ? args.min_confidence : cfg.minConfidence,
        concurrency: cfg.concurrency,
      });
    },
    async jev_decide(args, ctx) {
      return client(ctx?.apiKey).systemOne({ state: args.state, questions: args.questions, model: args.model });
    },
    async leads_export_csv(args) {
      return exportCsv(args, { cwd });
    },
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP dispatch (transport-agnostic)
// ---------------------------------------------------------------------------

const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

export function createDispatcher(handlers) {
  return async function dispatch(msg, ctx = {}) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return rpcError(msg?.id, -32600, "Invalid Request");
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;
    try {
      switch (method) {
        case "initialize":
          return rpcResult(id, {
            protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions:
              "Lead Club: jev_qualify_leads decides which researched leads are real and on-ICP; leads_export_csv writes the final list. Run jev_check_setup if a key error appears.",
          });
        case "notifications/initialized":
        case "notifications/cancelled":
        case "notifications/roots/list_changed":
          return undefined;
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          return rpcResult(id, { tools: TOOLS });
        case "tools/call": {
          const name = params?.name;
          const handler = handlers[name];
          if (!handler || !TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
          try {
            const result = await handler(params?.arguments ?? {}, ctx);
            return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
          } catch (err) {
            return rpcResult(id, { content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }], isError: true });
          }
        }
        default:
          if (isNotification) return undefined;
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      return rpcError(id, -32603, err?.message ?? "Internal error");
    }
  };
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

export function startStdio(dispatch) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (obj) => { if (obj !== undefined) process.stdout.write(JSON.stringify(obj) + "\n"); };
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return write(rpcError(null, -32700, "Parse error")); }
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((m) => dispatch(m)))).filter((r) => r !== undefined);
      if (out.length) write(out);
    } else {
      write(await dispatch(msg));
    }
  });
  rl.on("close", () => process.exit(0));
}

/**
 * Minimal Streamable HTTP transport: stateless JSON responses on POST /mcp.
 * Auth: if the server has its own key, every caller uses it; otherwise the caller must send
 * `Authorization: Bearer <typesafe key>` (bring-your-own-key mode).
 */
export function startHttp(dispatch, { port, host = "127.0.0.1", path = "/mcp", requireKey }) {
  const server = createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz") return send(200, { ok: true, server: SERVER_INFO });
    if (url.pathname !== path) return send(404, { error: "not found" });
    if (req.method === "GET") return send(405, { error: "SSE streams are not supported; use POST" }, { Allow: "POST" });
    if (req.method === "DELETE") return send(200, { ok: true });
    if (req.method !== "POST") return send(405, { error: "method not allowed" }, { Allow: "POST" });

    let apiKey;
    const auth = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) apiKey = m[1].trim();
    if (requireKey && !apiKey) {
      return send(401, { error: "Missing Authorization: Bearer <TypeSafe API key>" }, { "WWW-Authenticate": "Bearer" });
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    let msg;
    try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { return send(400, rpcError(null, -32700, "Parse error")); }
    const ctx = { apiKey };
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((mm) => dispatch(mm, ctx)))).filter((r) => r !== undefined);
      return out.length ? send(200, out) : send(202);
    }
    const out = await dispatch(msg, ctx);
    return out === undefined ? send(202) : send(200, out);
  });
  server.listen(port, host, () => {
    process.stderr.write(`lead-club-jev listening on http://${host}:${port}${path}\n`);
  });
  return server;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const config = loadConfig();
  const dispatch = createDispatcher(createToolHandlers({ config }));
  const httpIdx = argv.indexOf("--http");
  if (httpIdx !== -1) {
    const port = Number(argv[httpIdx + 1] ?? process.env.PORT ?? 8787);
    const host = process.env.HOST ?? "127.0.0.1";
    startHttp(dispatch, { port, host, requireKey: !config.apiKey });
  } else {
    if (!config.apiKey) process.stderr.write("lead-club-jev: no Jev API key configured yet; Jev tools will fail until jev_api_key / TYPESAFE_API_KEY is set.\n");
    startStdio(dispatch);
  }
}
