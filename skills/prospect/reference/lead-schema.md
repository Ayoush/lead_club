# Lead schema

One JSON object per candidate. Only `name` *or* `company` is strictly required, but Jev needs
`source_url` + `evidence` to say anything useful. Omit fields you did not find; never fill
them with guesses.

```json
{
  "id": "lead-7",
  "name": "Full Name",
  "title": "Head of Growth",
  "company": "Acme GmbH",
  "email": "only-if-printed-on-a-page@acme.de",
  "phone": "",
  "linkedin": "https://www.linkedin.com/in/...",
  "website": "https://acme.de",
  "location": "Berlin, Germany",
  "industry": "Fintech",
  "company_size": "11-50",
  "source_url": "https://acme.de/team https://example.com/berlin-fintech-2026",
  "evidence": "\"Full Name, Head of Growth at Acme\" (acme.de/team); \"Acme raised a €3M seed round\" (example.com)",
  "notes": "pattern guess: first.last@acme.de (seen for another employee)"
}
```

Extra keys are allowed and are forwarded to Jev as part of the lead state, so add anything
ICP-specific you discovered (`funding_stage`, `tech_stack`, `hiring`, ...).

## What `jev_qualify_leads` returns per lead

```json
{
  "id": "lead-7",
  "lead": { "...": "the normalized lead you sent" },
  "decision": "qualified | review | reject | error",
  "jev_verdict": "qualified",
  "jev_verdict_confidence": 0.81,
  "icp_fit": 3.4,
  "icp_fit_confidence": 0.72,
  "is_real": 0.93,
  "contact_plausible": 0.88,
  "reason": "verdict=qualified (conf 0.81), icp_fit=3.40 (conf 0.72), is_real=0.93",
  "custom_answers": { "hiring_now": { "type": "noul", "noul": 0.77 } },
  "model": "jev-1.13",
  "usage": { "input_tokens": 512, "output_tokens": 12 }
}
```

`decision` is computed locally from Jev's answers:

- `is_real < 0.5` → `reject`
- `verdict = qualified` but confidence `< min_confidence` (default 0.6) → `review`
- `verdict = qualified` but `icp_fit < 2` → `review`
- `qualified` with `contact_plausible < 0.5` → `review`
- otherwise Jev's verdict stands.
