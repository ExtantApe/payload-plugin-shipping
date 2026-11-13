# Test audit

Kept by this repo's maintainers: after each feature or fix, and at least every 14 days while it changes. Newest first.

## 2026-11-11: the webhook's signature check must say exactly `true`

Suite: 20 tests before, 21 after (`npx vitest run`, Payload 3.92, in-memory MongoDB, fake carrier). From an access sweep.

- **The change.** The webhook read `!hook.verify(raw, headers)` without awaiting, so a custom provider with an async `verify` returned a promise, which is truthy, and every body was accepted, unsigned ones included. Now the answer is awaited and only exactly `true` passes; a throw or rejection is a 401. EasyPost's own `verify` is sync and returns a boolean, and its tests are unchanged. `verify`'s type now allows `Promise<boolean>`.
- **Test.** "accepts a body only when verify answers exactly true, sync or async…": a custom provider answering a promise of `false`, `1`, `'yes'`, `{ valid: false }`, a promise of that, a throw and a rejection gets 401 every time and no handler runs; `true` and a promise of `true` are handled. The EasyPost tests (unsigned, wrong signature, a signature over other bytes) still pass.
- **Mutation checks.** 3 mutations, each a Python string replace restored byte for byte (SHA-256 checked). All 3 fail the new test: the old unawaited check put back; awaited but truthy; a throw rethrown.
- **Skipped.** `configured` and `parse` weren't in the sweep's findings; a `parse` that throws still answers 500.

## 2026-11-10: 0.1.0

| Promise | Test |
| --- | --- |
| Address problems for each kind; placeholders refused; PO Box and General Delivery to USPS only | `addresses and parcels > finds each kind…` |
| Parcel size, billable and dimensional weight, mailability | `addresses and parcels > works out the parcel…` |
| Tracking links and notice mapping | `addresses and parcels > links…` |
| Quote and buy (Ground Advantage first, `fake: true`), refund | `buying postage > quotes…` |
| Both addresses from the caller | `buying postage > sends both addresses…` |
| Returns from the hub's record, USPS only, placeholder refused | `buying postage > buys returns…` |
| The hook before every outside call; none made when it refuses | `buying postage > runs the site's hook…` |
| Production refused without a hook | `buying postage > refuses production…` |
| A timed-out buy says it may have gone through; no address in errors | `buying postage > says a timed-out purchase…` |
| The exact root path | `the webhook > lives at exactly…` |
| 503, 401 (unsigned, wrong, different bytes) | `the webhook > answers 503…` |
| A claimed event handled once when retried | `the webhook > passes a signed tracker…` |
| Unknown 200, too old ignored, a throwing handler 500, nothing in logs; handlers from other plugins | `the webhook > acknowledges…` |
| Refund events | `the webhook > passes refund events…` |
| Start-up refusals | `start-up` |

Gaps skipped: real EasyPost (it costs money and needs a key; recorded shapes follow its docs), and the handlers' own idempotency (each owner tests its own).
