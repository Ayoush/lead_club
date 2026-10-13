import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadConfig, JevClient, validateQuestions, buildLeadQuestions, decideLead, qualifyLeads,
  toCsv, exportCsv, createToolHandlers, createDispatcher, startHttp,
} from "../server/jev-mcp.mjs";

const SERVER_PATH = fileURLToPath(new URL("../server/jev-mcp.mjs", import.meta.url));

/** Fake TypeSafe API: records requests and answers deterministically based on the lead. */
function fakeTypeSafe() {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

    if (req.headers.authorization !== "Bearer test-key") return json(401, { error: "invalid api key" });
    if (req.method === "GET" && req.url === "/v1/models") {
      return json(200, { models: [{ name: "jev-latest", description: "x", release_date: "2026-01-01" }] });
    }
    if (req.method === "POST" && req.url === "/v1/systemone") {
      const lead = body.state?.lead ?? {};
      const good = !/fake/i.test(lead.name ?? "");
      const answers = {};
      for (const [name, q] of Object.entries(body.questions)) {
        if (q.type === "noul") answers[name] = { type: "noul", noul: good ? 0.9 : 0.1 };
        else if (q.type === "score") answers[name] = { type: "score", score: good ? 3.4 : 0.6, confidence: 0.8, legend: {}, probabilities: {} };
        else answers[name] = { type: "choice", choice: good ? "qualified" : "reject", confidence: good ? 0.85 : 0.9, probabilities: {} };
      }
      return json(200, { model: body.model, answers, usage: { input_tokens: 10, output_tokens: 2 } });
    }
    json(404, { error: "nope" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ baseURL: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) });
  }));
}

test("loadConfig ignores blank and unsubstituted placeholders", () => {
  const cfg = loadConfig({ JEV_API_KEY: "${user_config.jev_api_key}", TYPESAFE_API_KEY: " shell-key ", JEV_MIN_CONFIDENCE: "", JEV_MODEL: "${user_config.jev_model}" });
  assert.equal(cfg.apiKey, "shell-key");
  assert.equal(cfg.model, "jev-latest");
  assert.equal(cfg.minConfidence, 0.6);
  assert.equal(cfg.baseURL, "https://api.typesafe.ai");
});

test("validateQuestions enforces the System One shapes", () => {
  assert.throws(() => validateQuestions({}), /At least one question/);
  assert.throws(() => validateQuestions({ s: { type: "score", criteria: { a: 1 } } }), /ordered array/);
  assert.throws(() => validateQuestions({ s: { type: "score", criteria: ["only one"] } }), /between 2 and 10/);
  assert.throws(() => validateQuestions({ c: { type: "choice", criteria: ["a", "b"] } }), /map of label/);
  assert.throws(() => validateQuestions({ x: { type: "wat" } }), /must be one of/);
  validateQuestions({ n: { type: "noul" }, s: { type: "score", instructions: "q", criteria: ["lo", "hi"] }, c: { type: "choice", instructions: "q", criteria: { a: null, b: "B" } } });
});

test("buildLeadQuestions adds contact check only when a channel exists and rejects collisions", () => {
  const q1 = buildLeadQuestions({ lead: { name: "A", company: "B" } });
  assert.deepEqual(Object.keys(q1), ["is_real", "icp_fit", "verdict"]);
  const q2 = buildLeadQuestions({ lead: { name: "A", company: "B", linkedin: "https://linkedin.com/in/a" }, extraQuestions: { hiring: { type: "noul" } } });
  assert.deepEqual(Object.keys(q2), ["is_real", "icp_fit", "verdict", "contact_plausible", "hiring"]);
  assert.throws(() => buildLeadQuestions({ lead: { name: "A" }, extraQuestions: { verdict: { type: "noul" } } }), /collides/);
  validateQuestions(q2);
});

test("decideLead applies the thresholds", () => {
  const base = { is_real: { noul: 0.9 }, icp_fit: { score: 3, confidence: 0.7 }, verdict: { choice: "qualified", confidence: 0.8 } };
  assert.equal(decideLead(base, { minConfidence: 0.6 }).decision, "qualified");
  assert.equal(decideLead({ ...base, is_real: { noul: 0.2 } }, { minConfidence: 0.6 }).decision, "reject");
  assert.equal(decideLead({ ...base, verdict: { choice: "qualified", confidence: 0.5 } }, { minConfidence: 0.6 }).decision, "review");
  assert.equal(decideLead({ ...base, icp_fit: { score: 1.2, confidence: 0.9 } }, { minConfidence: 0.6 }).decision, "review");
  assert.equal(decideLead({ ...base, contact_plausible: { noul: 0.3 } }, { minConfidence: 0.6 }).decision, "review");
  assert.equal(decideLead({ ...base, verdict: { choice: "reject", confidence: 0.9 } }, { minConfidence: 0.6 }).decision, "reject");
});

test("qualifyLeads talks to the API with the SDK wire format and summarizes", async () => {
  const api = await fakeTypeSafe();
  try {
    const client = new JevClient({ apiKey: "test-key", baseURL: api.baseURL, model: "jev-latest", timeoutMs: 5000 });
    const out = await qualifyLeads(client, {
      icp: "CTOs at fintech startups in Berlin",
      leads: [
        { name: "Real Person", title: "CTO", company: "Acme", linkedin: "https://linkedin.com/in/real", source_url: "https://acme.de/team", evidence: "\"Real Person, CTO\"" },
        { name: "Fake Person", company: "Nowhere" },
      ],
      questions: { hiring: { type: "noul", instructions: "Hiring?" } },
      minConfidence: 0.6, concurrency: 2,
    });
    assert.deepEqual(out.summary, { total: 2, qualified: 1, review: 0, reject: 1, error: 0 });
    assert.equal(out.results[0].decision, "qualified");
    assert.equal(out.results[0].custom_answers.hiring.noul, 0.9);
    assert.equal(out.results[1].decision, "reject");
    assert.equal(api.calls.length, 2);
    const call = api.calls.find((c) => c.body.state.lead.name === "Real Person");
    assert.equal(call.url, "/v1/systemone");
    assert.equal(call.auth, "Bearer test-key");
    assert.equal(call.body.model, "jev-latest");
    assert.equal(call.body.state.icp, "CTOs at fintech startups in Berlin");
    assert.ok(Array.isArray(call.body.questions.icp_fit.criteria));
    assert.equal(call.body.questions.verdict.type, "choice");
    assert.ok(call.body.questions.contact_plausible);
  } finally {
    await api.close();
  }
});

test("JevClient surfaces API errors with status and does not retry 401", async () => {
  const api = await fakeTypeSafe();
  try {
    const client = new JevClient({ apiKey: "wrong", baseURL: api.baseURL, model: "jev-latest", timeoutMs: 5000 });
    await assert.rejects(() => client.listModels(), (err) => err.status === 401 && /invalid api key/.test(err.message));
    assert.equal(api.calls.length, 1);
  } finally {
    await api.close();
  }
});

test("toCsv flattens results, quotes properly and picks sensible columns", () => {
  const { header, body, columns } = toCsv([
    { lead: { name: 'Ann "Q" Lee', company: "A, Inc", email: "ann@a.com" }, decision: "qualified", icp_fit: 3.2, reason: "ok" },
    { lead: { name: "Bob", company: "B", notes: "line1\nline2" }, decision: "review", icp_fit: 2, reason: "x" },
  ]);
  assert.deepEqual(columns, ["name", "company", "email", "decision", "icp_fit", "reason", "notes"]);
  assert.equal(header, "name,company,email,decision,icp_fit,reason,notes\n");
  assert.ok(body.includes('"Ann ""Q"" Lee","A, Inc",ann@a.com,qualified,3.2,ok,'));
  assert.ok(body.includes('"line1\nline2"'));
});

test("exportCsv writes and appends with header check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "leadclub-"));
  const path = join(dir, "out", "leads.csv");
  const r1 = await exportCsv({ path, rows: [{ name: "A", company: "X" }] });
  assert.equal(r1.rows, 1);
  const r2 = await exportCsv({ path, rows: [{ name: "B", company: "Y" }], append: true });
  assert.equal(r2.appended, true);
  const text = await readFile(path, "utf8");
  assert.equal(text, "name,company\nA,X\nB,Y\n");
  await assert.rejects(() => exportCsv({ path, rows: [{ title: "T" }], append: true }), /header differs/);
  const r3 = await exportCsv({ path: "rel.csv", rows: [{ name: "C" }] }, { cwd: dir });
  assert.equal(r3.path, join(dir, "rel.csv"));
});

test("dispatcher implements initialize / tools/list / tools/call / ping", async () => {
  const api = await fakeTypeSafe();
  try {
    const config = { ...loadConfig({}), apiKey: "test-key", baseURL: api.baseURL };
    const dispatch = createDispatcher(createToolHandlers({ config }));
    const init = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(init.result.serverInfo.name, "lead-club-jev");
    assert.equal(await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
    const list = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(list.result.tools.map((t) => t.name), ["jev_check_setup", "jev_qualify_leads", "jev_decide", "leads_export_csv"]);
    for (const t of list.result.tools) assert.ok(t.name.length <= 64 && t.inputSchema && t.annotations);
    const ping = await dispatch({ jsonrpc: "2.0", id: 3, method: "ping" });
    assert.deepEqual(ping.result, {});
    const check = await dispatch({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "jev_check_setup", arguments: {} } });
    assert.equal(check.result.isError, false);
    assert.equal(check.result.structuredContent.models[0].name, "jev-latest");
    const bad = await dispatch({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "jev_qualify_leads", arguments: { icp: "x", leads: [] } } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /non-empty array/);
    const unknown = await dispatch({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } });
    assert.equal(unknown.error.code, -32602);
    const missing = await dispatch({ jsonrpc: "2.0", id: 7, method: "resources/list" });
    assert.equal(missing.error.code, -32601);
  } finally {
    await api.close();
  }
});

test("stdio transport end-to-end", async () => {
  const api = await fakeTypeSafe();
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, JEV_API_KEY: "test-key", JEV_BASE_URL: api.baseURL },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const lines = [];
    let buf = "";
    const waitFor = (n) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${n} lines; got ${lines.length}: ${lines.join("|")}`)), 8000);
      const check = () => { if (lines.length >= n) { clearTimeout(t); resolve(); } };
      child.stdout.on("data", (d) => { buf += d; const parts = buf.split("\n"); buf = parts.pop(); lines.push(...parts.filter(Boolean)); check(); });
      check();
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jev_decide", arguments: { state: "hello", questions: { ok: { type: "noul", instructions: "ok?" } } } } }) + "\n");
    await waitFor(2);
    const [init, call] = lines.map((l) => JSON.parse(l));
    assert.equal(init.id, 1);
    assert.equal(init.result.capabilities.tools.listChanged, false);
    assert.equal(call.id, 2);
    assert.equal(call.result.structuredContent.answers.ok.noul, 0.9);
  } finally {
    child.kill();
    await api.close();
  }
});

test("http transport: bring-your-own-key via Authorization header", async () => {
  const api = await fakeTypeSafe();
  const config = { ...loadConfig({}), apiKey: undefined, baseURL: api.baseURL };
  const http = startHttp(createDispatcher(createToolHandlers({ config })), { port: 0, requireKey: true });
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  try {
    const noAuth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(noAuth.status, 401);
    const ok = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jev_check_setup", arguments: {} } }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.result.structuredContent.ok, true);
    const notif = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-key" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.equal(notif.status, 202);
    const health = await fetch(`${base}/healthz`);
    assert.equal((await health.json()).ok, true);
  } finally {
    await new Promise((r) => http.close(r));
    await api.close();
  }
});
