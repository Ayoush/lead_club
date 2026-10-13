# Search playbook

Query patterns that reliably surface named people and companies. Combine 2–3 facets per query
(role + place + industry). Prefer pages that list many entities at once (directories, speaker
lists, portfolio pages, "team" pages) over one-off articles.

## People (by role)

- `"<title>" "<city>" site:linkedin.com/in` — LinkedIn profile stubs (public summary only).
- `"<title>" "<company type>" <city> -jobs -hiring` — avoid job ads.
- `<industry> conference <year> speakers <city>` — speaker lists carry name + title + company.
- `<industry> podcast guests "<title>"` — guests with bios.
- `"<title>" "<industry>" interview <year>` — press features name real, active people.
- `site:github.com "<tech>" "<city>"` and `site:dev.to` / `site:medium.com` for engineers.
- `"<company>" team` / `"<company>" leadership` / `"<company>" about us` — team pages.
- `<association> members directory <city>` — chambers, guilds, alumni networks.

## Companies (by profile)

- `<industry> startups <city> <year>` — roundups ("20 fintech startups in Berlin to watch").
- `site:crunchbase.com <industry> <city> seed` — company stubs with founders.
- `<accelerator> <year> cohort <industry>` — Y Combinator, Techstars, local programs.
- `"<industry>" "<size> employees" <country>` — size signals.
- `site:producthunt.com <category>` — product launches with maker names.
- `<industry> awards <year> finalists <region>` — curated lists of real companies.
- `"we are hiring" "<role>" <city> <industry>` — hiring signal plus hiring manager names.
- `<city> <industry> meetup organizers` — community leaders.

## Candidate-type targets (recruiting, interviews, research participants)

- `"<role>" "<company>" OR "<company 2>" site:linkedin.com/in <city>`
- `<topic> talk <year> site:youtube.com` → speaker names → company pages.
- `"<role>" portfolio <city>` for designers / `site:github.com <city> <language>` for devs.
- University / bootcamp alumni pages: `<program> alumni "<role>"`.

## Contact discovery (only what is public)

- `"<name>" "<company>" email` or `"<name>" "@<domain>"`.
- Company `/contact`, `/team`, `/press` pages; personal sites linked from GitHub or Twitter/X.
- Conference speaker pages often list email or socials.
- Email **patterns** (e.g. `first.last@domain`) may be inferred from one public example and
  recorded in `notes` as a guess, never in `email`.

## Hygiene

- Use `-jobs -careers -hiring` when you want people, not postings.
- Rotate the city/region spelling and the local-language name for non-English markets.
- Drop results older than ~3 years for role claims unless corroborated.
- One `WebFetch` per promising result; skip paywalled or login-only pages.
