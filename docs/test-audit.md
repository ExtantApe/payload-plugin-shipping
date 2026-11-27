# Test audit

Kept by this repo's maintainers: after each feature or fix, and at least every 14 days while it changes. Newest first.

## 2026-11-26: sweep after 0.1.0

Suite: 21 tests before, 37 after (`npm test`). The 16 new ones are in `test/safety.test.ts` and need no database: they use the plugin's own config, the fake carrier or a made-up `fetch`, and made-up addresses. Nothing reaches EasyPost. No source changed.

- **Promises.** From the README and `docs/decisions.md`:
  1. Addresses of three kinds, with problems in plain codes; a guessed or placeholder address is refused; PO Box and General Delivery take USPS only.
  2. Both addresses on a label come from the caller's records.
  3. Quotes pick Ground Advantage first, else the cheapest allowed rate.
  4. Returns go to the hub's record, USPS only.
  5. An unused label can be refunded, and the answer is the carrier's.
  6. The site's go-ahead runs before every outside call, and a refusal stops the call. With no hook, production is refused. `buyLabel` asks once per action.
  7. Errors carry a stable code and no name, address or key. Address checks return codes only.
  8. A purchase with an unclear outcome fails as `MAYBE_BOUGHT`.
  9. Parcel size, billable and dimensional weight, mailability.
  10. Tracking links and notice mapping.
  11. The webhook sits at the exact root path and fails closed: 503, 401, the age window, unknown, and 500 for a handler that throws or doesn't answer. Handlers can come from other plugins.
  12. No collections.
  13. The fake carrier comes only from `/testing`, and its rates and labels say `fake: true`.
  14. The plugin reads no environment: the site passes the key and the secret in.
  15. Start-up refuses a missing provider or a bad webhook path.
- **Covered.** By file and test (`shipping` is `test/shipping.test.ts`, `safety` is `test/safety.test.ts`):
  - 1: `shipping: addresses and parcels > finds each kind…`; `shipping: what the security read found > buys only USPS for a PO Box…`
  - 2: `shipping: buying postage > sends both addresses…`
  - 3: `shipping: buying postage > quotes Ground Advantage first…`; the cheapest rate by `…buys only USPS for a PO Box…` (its control)
  - 4: `shipping: buying postage > buys returns…`
  - 5: `shipping: buying postage > quotes Ground Advantage first…`; `safety: money > says so when the carrier rejects a refund`
  - 6: `shipping: buying postage > runs the site's hook…`, `…refuses production mode…`, `shipping: what the security read found > asks the site's hook once per action…`; `safety: the go-ahead fails closed` (all 3)
  - 7: `shipping: buying postage > says a timed-out purchase…`, `shipping: what the security read found > returns address problems as codes only…`; `safety: secrets > keeps the key out of every error…`, `…logs only the kind of error…`
  - 8: `shipping: what the security read found > never says "nothing was bought"…`; `safety: money > sends one purchase request per purchase…`, `…calls a redirected purchase, or a label with no shipment id, unclear`
  - 9, 10: `shipping: addresses and parcels` (the other 2)
  - 11: `shipping: the webhook` (all 6), `shipping: what the security read found > ignores replayed refunds…`; `safety: the webhook fails closed` (all 3)
  - 12: `safety: no collections > adds one endpoint…`
  - 13: `shipping: buying postage > quotes Ground Advantage first…` (`fake: true`); the `/testing` entry is `package.json`'s `exports`
  - 14: `safety: secrets > keeps the key and the webhook secret out of the provider object and the site's config`, `…sends the key only to EasyPost…`
  - 15: `shipping: start-up`
- **Gaps added.** 16 tests, each shown to fail under a one-line change to the source, which was then restored byte for byte (SHA-256 checked) and the tests passed again. 22 changes in all:
  - The go-ahead: a hook that refuses by rejecting a promise stops every function, with no outside call (the hook left unawaited). With no key, every function refuses before the hook or the carrier is asked (the check removed). Only a key starting with `EZTK` counts as a test key (`includes` for `startsWith`).
  - Money: one purchase request per purchase, and an unclear one isn't sent again (a retry added). A failed quote, or no allowed rate, buys nothing (any rate used when none is allowed). A redirected purchase and a label with no shipment id are unclear (each condition removed). 4.35 comes out as 435 cents, and the label shows the rate the carrier charged (`floor` for `round`; the quoted rate used). A rejected refund is reported as rejected (always `submitted`).
  - Secrets: the key and the webhook secret aren't on the provider object or in the site's config (the key added to the object). The key goes only to `api.easypost.com`, in the Authorization header, and a shipment id with slashes or a query stays one path segment (encoding removed, for buy and for refund). Errors don't repeat the key even when the failure does (the network error's text passed on; the carrier's message passed on). A failing handler logs only the error's name, and the 500 and 401 answers carry no detail (the message logged).
  - The webhook: a provider with no webhook, or one that isn't configured, gets 503 even when its check says yes (two changes to the check). `maxEventAgeDays` is honored, with an hour either side of the limit, and 5 minutes ahead passes where 11 doesn't (the limit fixed at 7; the window widened). A signed event with an unreadable date reaches no handler (the comparison rewritten).
  - No collections: the site's collections, globals and endpoints stay as they were, with one endpoint added (the site's endpoints dropped).
- **Gaps skipped.**
  - Who can see whose addresses and shipments, and signed-out requests: the plugin has no collections, stores nothing and serves no reads, so there is nothing of its own to refuse. Those rules belong to the plugin that records the label, and its tests. The one endpoint is the webhook, whose refusals are covered.
  - A second purchase of one shipment in a later call: the plugin keeps no record of labels, so that check belongs to the plugin that records them, and to EasyPost. Covered here is what the plugin does itself: one request per call, and no retry of an unclear one.
  - Half-written records after a carrier error: the plugin writes nothing.
  - A `parse` that throws: Payload turns it into a 500 and no handler runs. That is framework behavior.
  - A signed-in user posting to the webhook without a signature: the handler never reads the user, and the unsigned 401 already covers it.
  - Real EasyPost: it costs money and needs a key. The request shapes follow its documentation.
  - The handlers' own idempotency: each owner tests its own.
  - `quote` with no weight, and the remaining `mailability` notes: small, with no money or privacy at stake.

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
