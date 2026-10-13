---
name: prospect
description: Vibe prospecting. Finds leads (people or companies) on the public web that match an ideal customer profile the user describes, has TypeSafe Jev decide which ones are real and on-ICP, and exports the qualified list to CSV. Use when the user asks to find leads, build a prospect list, find people to contact, or source candidates/customers/partners.
argument-hint: "[who you want to reach, e.g. 'founders of seed-stage fintech startups in Berlin']"
disable-model-invocation: true
allowed-tools: WebSearch WebFetch Read Write Agent mcp__plugin_lead-club_jev__jev_check_setup mcp__plugin_lead-club_jev__jev_qualify_leads mcp__plugin_lead-club_jev__jev_decide mcp__plugin_lead-club_jev__leads_export_csv
---

# Prospect: find → qualify with Jev → export

You are running a lead-prospecting pipeline. The user tells you *who* they want; you do the
research with web search, Jev does the judging, and a CSV is the deliverable. Jev is not
a search engine and knows nothing you do not pass it: your job is to gather **evidence**,
Jev's job is to **decide**.

Arguments: `$ARGUMENTS` (may be empty).

## 0. Pre-flight (once per session)

If this is the first Jev call of the session, or any Jev tool returns an auth error, call
`jev_check_setup`. If it fails, stop and tell the user to set their TypeSafe key:
`/plugin` → Installed → lead-club → Configure options, or `export TYPESAFE_API_KEY=...`
and restart Claude Code. Do not continue without a working key.

## 1. Pin down the ICP

Build an **ICP statement** (ideal customer profile) from the request. It must cover:

- **Who**: role / seniority, or company type if the target is companies.
- **Where**: geography (or "anywhere").
- **Company filters**: industry, stage, size, tech, funding, hiring signals, etc.
- **Must-haves and exclusions**: anything the user said to avoid.
- **How many**: target count (default 20 qualified).
- **Contact fields wanted**: email / LinkedIn / website / phone (default: whatever is public).

If `$ARGUMENTS` already answers these, do not ask. If a *material* item is missing (no idea
who or where), ask one short question with up to three bullets. Otherwise state your
assumptions in one line and proceed.

Write the ICP statement as a single paragraph; you will send the exact same text to Jev
with every batch so decisions are consistent.

## 2. Research the web (gather evidence, never invent)

Read `reference/search-playbook.md` for query patterns per lead type. Then:

1. Draft 6–12 distinct search queries that attack the ICP from different angles (directories,
   "site:linkedin.com/in", conference speaker lists, press, GitHub, job boards, Crunchbase-style
   pages, local associations, review sites).
2. For breadth, fan out: launch 2–4 `lead-researcher` agents (`Agent` tool,
   `subagent_type: "lead-club:lead-researcher"`), each with a disjoint slice of the queries and the ICP
   statement. Each returns a JSON array of candidate leads. Run them in parallel.
   For small asks (≤10 leads) do the searches yourself.
3. For each promising hit, `WebFetch` the page and extract: name, title, company, website,
   LinkedIn URL, location, and *quoted snippets* proving role + company. Record `source_url`.
4. **Emails**: only record an email that appears on a page. If you can infer the company's
   email pattern from a public example, you may put the guess in `notes` as
   `pattern guess: first.last@domain` — never in `email`.
5. Stop collecting at roughly 2× the target count (Jev will reject a share), or when searches
   stop yielding new names. Deduplicate by name+company and by LinkedIn URL.

Candidate leads use the schema in `reference/lead-schema.md`. Every lead must carry
`source_url` and `evidence`; a lead without evidence will be (rightly) rejected by Jev.

## 3. Qualify with Jev

Call `jev_qualify_leads` with `icp` = the ICP statement and `leads` = candidates, in batches
of up to 25. Optionally add `questions` for ICP-specific checks the built-ins do not cover,
for example:

```json
{ "hiring_now": { "type": "noul", "instructions": "Does the evidence show this company is currently hiring?" } }
```

Each result carries `decision` ∈ `qualified | review | reject | error`, plus `icp_fit` (0–4),
`is_real`, `contact_plausible`, Jev confidences and a `reason`.

- `qualified` → goes in the final list.
- `review` → keep in a second section; if you have budget, do one more `WebFetch` to fill the
  gap Jev named in `reason` (usually missing contact or unclear role), then re-qualify that
  lead alone.
- `reject` → drop. Do not argue with Jev; find better leads instead.
- `error` → retry once; if it persists, report it.

If fewer than the target count are qualified, go back to step 2 with new query angles
(different directories, adjacent titles, neighbouring cities) until you hit the target or
have exhausted ~3 rounds. Say so if you fall short.

## 4. Export and report

1. Call `leads_export_csv` with an absolute path under the current project:
   `<cwd>/leads/<yyyy-mm-dd>-<short-slug>.csv`, `rows` = all `qualified` results
   (then `append: true` with the `review` results if the user wants them, or write them to
   `...-review.csv`). Use the default columns unless the user asked for specific ones.
2. In chat, show a compact table of the qualified leads (name, title, company, best contact,
   icp_fit) and the summary counts (qualified / review / reject). Link the CSV path.
3. If the user wants a Google Sheet, say the CSV imports directly (File → Import) and offer to
   push it through a Sheets connector if one is available in this session.

## Rules

- Never fabricate names, emails, phone numbers or URLs. Empty is better than wrong.
- Keep `evidence` as quoted text from the page, not your paraphrase.
- Respect the sites you fetch: public pages only, no logins, no scraping behind paywalls.
- Do not spend Jev calls on obviously off-target hits; a quick sanity filter is yours,
  the final judgment is Jev's.
- The user's ICP is confidential context for this session; do not echo it into files other
  than the CSV `notes` if they ask.
