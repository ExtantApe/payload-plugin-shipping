# First public push audit

By the Plugins Lead, 2026-11-10, before the repo's first push (D5).

| Check | Result |
| --- | --- |
| `scripts/leak-check.sh`, with the private terms and in CI mode | passed (rerun at the reviewed commit) |
| Keys, tokens, secrets | none; none; tests use made-up keys (EZTK_made_up) and a made-up webhook secret, and the fake carrier |
| Email addresses in history | only the noreply author address |
| Build output, `node_modules`, `.env`, `.secrets/` | never committed |
| Leak check in CI | yes |
| LICENSE | MIT, "Copyright (c) 2026 Captive Origins" |
| Keywords | base words, `ecommerce` and `integrations`, no family tags |
