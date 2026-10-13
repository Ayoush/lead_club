# Lead Club — vibe prospecting for Claude Code

Tell Claude who you want to reach. Claude researches the public web for matching people or
companies, **TypeSafe Jev** decides which leads are real and actually fit your profile, and you
get a clean CSV. No scraping tools to configure, no spreadsheet of junk to clean.

```
/lead-club:prospect heads of design at Series A SaaS companies in Amsterdam, 20 leads
```

## How it works

```
 you: ICP in plain words
      │
      ▼
 Claude (WebSearch / WebFetch, parallel researcher agents)
      │  candidates + quoted evidence + source URLs
      ▼
 Jev  (TypeSafe System One API, your key)
      │  is_real · icp_fit 0-4 · contact_plausible · verdict + confidence
      ▼
 leads/<date>-<slug>.csv  (qualified)   +  review list  +  chat summary
```

Jev is a *decision* model, not a chat model: it returns typed answers with calibrated
probabilities instead of prose. That makes it a good, cheap judge: Claude gathers evidence,
Jev rules on it, and the plugin converts the answers into `qualified / review / reject`.

## Install

Requires Claude Code and Node.js 20+ (the bundled MCP server has zero dependencies).

```
/plugin marketplace add Ayoush/lead_club
/plugin install lead-club@lead-club
```

Claude Code then prompts for your **TypeSafe (Jev) API key**. It is stored in your OS
credential store, never in a settings file. Get a key from the TypeSafe console
(<https://typesafe.ai> → API Keys).

Other ways to set it later:

```sh
claude plugin install lead-club@lead-club --config jev_api_key=<KEY>              # at install time
echo '{"jev_api_key":"<KEY>"}' | claude plugin configure lead-club@lead-club --values-stdin   # later
```

Check everything works:

```
/lead-club:setup
```

## Use

```
/lead-club:prospect <who you want to reach, where, how many, any must-haves or exclusions>
```

Examples:

- `/lead-club:prospect founders of seed-stage climate startups in Berlin, 25 leads, need LinkedIn`
- `/lead-club:prospect engineering managers at companies hiring React devs in Toronto, exclude agencies`
- `/lead-club:prospect indie Shopify app developers with >1000 installs, anywhere, want emails`

Claude will ask one short question if something essential is missing, then run the pipeline
and end with a table plus the CSV path. Output goes to `./leads/` in the current project
(git-ignored by default).

## What's in the box

| Path | Purpose |
| --- | --- |
| `skills/prospect/` | The `/lead-club:prospect` workflow: ICP → research → Jev → CSV. |
| `skills/setup/` | `/lead-club:setup` verifies the key and explains configuration. |
| `agents/lead-researcher.md` | Parallel web-research subagent used by the skill. |
| `server/jev-mcp.mjs` | MCP server exposing Jev + CSV export. Stdio for the plugin, optional HTTP mode for self-hosting. |
| `.claude-plugin/plugin.json` | Plugin manifest, including `userConfig` for the key. |
| `.claude-plugin/marketplace.json` | Lets this repo act as its own marketplace. |

### MCP tools

| Tool | What it does |
| --- | --- |
| `jev_check_setup` | Verifies the key via `GET /v1/models`. |
| `jev_qualify_leads` | For 1-50 leads: asks Jev `is_real` (noul), `icp_fit` (score 0-4), `contact_plausible` (noul), `verdict` (choice). Applies thresholds → `decision`. Accepts extra custom questions. |
| `jev_decide` | Raw access to `POST /v1/systemone` (`state` + `questions`). |
| `leads_export_csv` | Writes/appends a CSV from leads or qualification results. |

Plugin config (`/plugin` → Installed → lead-club → Configure options):

| Option | Default | Meaning |
| --- | --- | --- |
| `jev_api_key` | — | TypeSafe API key (required, secret). |
| `jev_model` | `jev-latest` | Model sent to the API. |
| `min_confidence` | `0.6` | Verdict confidence below this downgrades `qualified` → `review`. |

Server-side env vars (for self-hosting or running the server by hand): `JEV_API_KEY` /
`TYPESAFE_API_KEY`, `JEV_BASE_URL`, `JEV_MODEL`, `JEV_MIN_CONFIDENCE`, `JEV_CONCURRENCY`,
`JEV_TIMEOUT_MS`. Inside Claude Code the plugin options above are what count: the server is
not started until the required `jev_api_key` option is set.

## Development

```sh
npm test                     # unit + stdio + http tests against a fake TypeSafe API
claude plugin validate --strict .
claude plugin marketplace add .            # install from this checkout, exactly like a user would
claude plugin install lead-club@lead-club --config jev_api_key=<KEY>
claude -p "/lead-club:setup"               # smoke test
```

Run the server by hand:

```sh
TYPESAFE_API_KEY=... node server/jev-mcp.mjs            # stdio (what Claude Code uses)
TYPESAFE_API_KEY=... node server/jev-mcp.mjs --http 8787 # Streamable HTTP on POST /mcp
```

## Monetization and claude.ai connectors (read before selling this)

As of this writing, Anthropic's plugin marketplace and connector directory have **no built-in
paid listings, billing or revenue share**: a plugin is a git repo anyone can install, and the
directory lists free connectors. Claude Code does not enforce payment. So the realistic ways to
charge are:

1. **Bring-your-own-key (this repo as is).** Users pay TypeSafe for Jev usage directly; you
   give the plugin away. Zero infrastructure, zero revenue.
2. **Host the server and sell your own key.** Run `server/jev-mcp.mjs --http` (or a fork)
   behind HTTPS with your TypeSafe key on the server, issue *Lead Club* keys to paying users
   (Stripe + a tiny key table), and point the plugin at your URL:

   ```json
   "mcpServers": {
     "jev": {
       "type": "http",
       "url": "https://api.yourdomain.com/mcp",
       "headers": { "Authorization": "Bearer ${user_config.lead_club_key}" }
     }
   }
   ```

   The HTTP mode already accepts `Authorization: Bearer <key>`; swap the pass-through for a
   lookup in your key table and meter usage per key. This is also the only route to a
   **claude.ai / Claude Desktop custom connector**, which must be a remote HTTP MCP server
   (OAuth or a static header). The skill and agent would then be submitted as a plugin bundle
   that references the same URL.
3. **Submit to Anthropic's directory** (free listing, security scan, human review) for
   distribution, and monetize via option 2.

Check the Anthropic Software Directory terms before charging for anything listed there.

## Notes and limits

- Jev only sees what Claude passes in: a lead without `evidence` and `source_url` will be
  rejected, which is the intended behaviour.
- Emails are never invented. A pattern guess, if any, lives in `notes`.
- Research uses Claude's built-in WebSearch/WebFetch on public pages only.
- Not affiliated with TypeSafe AI. "Jev" and "TypeSafe" are their marks.
