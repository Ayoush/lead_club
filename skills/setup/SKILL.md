---
name: setup
description: Check that the Lead Club plugin is configured (TypeSafe Jev API key works, models reachable) and explain how to set or change the key. Use when the user asks to set up Lead Club, configure Jev, or when a Jev tool reports an auth error.
disable-model-invocation: true
allowed-tools: mcp__plugin_lead-club_jev__jev_check_setup
---

# Lead Club setup check

1. Call `jev_check_setup`.
2. If it succeeds, tell the user: the key works, which base URL and default model are in use,
   the confidence threshold, and the models the account can access. Then suggest
   `/lead-club:prospect <who you want to reach>`.
3. If it fails:
   - **401 / "No TypeSafe/Jev API key configured"** → explain the three ways to set the key:
     1. `/plugin` → Installed → **lead-club** → *Configure options* → paste the key (stored in
        the OS credential store, never in settings files).
     2. From a shell: `echo '{"jev_api_key":"<KEY>"}' | claude plugin configure lead-club --values-stdin`
        (`claude plugin configure lead-club` alone shows which options are set).
     3. `claude plugin install lead-club@lead-club --config jev_api_key=<KEY>` at install time.
     Note: Claude Code will not start the plugin's MCP server until the required option is
     set, so a shell `TYPESAFE_API_KEY` alone is not enough (it only applies when running
     `server/jev-mcp.mjs` by hand). Keys come from the TypeSafe console
     (https://typesafe.ai → API Keys). After changing the key, restart Claude Code.
   - **403** → the key is valid but the account lacks access to the model; suggest `jev_model`
     config and checking the TypeSafe dashboard.
   - **Connection error** → check network / corporate proxy; the server talks only to
     `https://api.typesafe.ai` unless `JEV_BASE_URL` is set.
4. Never print the key back, even partially.
