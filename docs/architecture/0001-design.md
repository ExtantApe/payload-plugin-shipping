# 0001: Shipping design record

Status: **accepted** (the platform team approved the site wiring on 2026-11-10, with the five changes listed under its review below). Built as 0.1.0 on 2026-11-10; the security read's fixes are in `docs/decisions.md`.

## Context

The Captive Origins site buys postage for sample kits through EasyPost. That code sits in `src/lib/shipping` (about
500 lines: `easypost`, `fakeEasyPost`, `address`, `trackerWebhook`, `notices`) and in the endpoint
`src/endpoints/easypostWebhook.ts`. It covers:
- addresses of three kinds (street, PO Box, General Delivery) and their checks;
- carrier quotes and labels, both outbound and prepaid return;
- refunds of unused labels (USPS, within 30 days);
- tracker and refund webhooks, signed and failing closed;
- a fake carrier for tests and dry runs;
- USPS parcel rules (dimensional weight, mailability).

None of this is about kits. Only Kits uses it today, but any Payload site that ships things could.

The owner approved the name on 2026-11-10: **Shipping**,
`@extantape/payload-plugin-shipping`, with EasyPost as the first provider. The kits team builds it,
alongside Sample Kits (`payload-plugin-sample-kits` `docs/architecture/0001-design.md`), under the
owner's rule: agnostic plugins that work on their own and connect through optional adapters.

## Decision

Shipping owns **talking to carriers and the rules of the mail**. The plugin that owns the goods (Sample Kits, or a
shop) owns **what is shipped, why, and where its records live**.

MIT, as a general Payload plugin. Public from its first push, after the audit, which the owner
approves. 0.x until it has seen real use.

## What it owns

| Piece | From today's site |
|---|---|
| **Addresses:** `StoredAddress` (kinds street, PO Box, General Delivery), `addressProblems`, `labelAddress`, `addressKey`, `carriersFor` (PO Box and General Delivery take USPS only), an optional address field group a collection can include | `address.ts` |
| **The carrier provider contract** and the **EasyPost provider:** verify an address, quote, buy a quote, buy (outbound or return), refund, mode (test or production from the key), a 60-second timeout per call, errors in plain words, and "a timed-out buy may have been bought" | `easypost.ts` |
| **The fake provider:** made-up prices, labels marked `fake: true`, deterministic for tests and dry runs | `fakeEasyPost.ts` |
| **Parcel rules:** the parcel from a box's outside size and weight, dimensional weight, billable weight, USPS mailability notes | `boxLadder.ts` (`parcelFor`, `dimWeightLb`, `billableLb`, `uspsNotes`); the kit boxes themselves stay in Sample Kits |
| **The webhook endpoint:** signature check with the provider's secret, refusing when not configured (503) or unsigned or wrongly signed (401), an unknown tracker acknowledged and nothing recorded, a too-old event ignored; then dispatch to the owners' handlers | `trackerWebhook.ts`, `endpoints/easypostWebhook.ts` |
| **Tracking words:** carrier status to plain status (`in_transit`, `delivered`, …), a tracking link per carrier | `notices.ts` (`trackingLink`, the status words); the emails stay with the owner, through Notifications or its own `notify` |

**No collections in 0.1.** Labels are recorded by the plugin that bought them: Sample Kits keeps
`kitFulfillment.outboundLabels` and `return-labels`, under the same names, so there's no migration. A shared
`shipping-labels` ledger (every label, its cost and its refund in one place) is the open question below.

## The shape

The types below are sketches, to be made exact when the code is written.

```ts
shipping({
  provider: easyPost({ apiKey, webhookSecret }),  // the site reads its env and passes them in
  // tests: fakeCarrier({ seed }) from '@extantape/payload-plugin-shipping/testing'
  webhookPath: '/easypost/webhook',            // a root endpoint (config.endpoints): /api/easypost/webhook, as today
  beforeExternalCall: ({ action, mode, req }) => void | Promise<void>,   // 'buy' | 'refund' | 'quote' | 'verify'; throw to refuse
  handlers: [                                  // owners register; the first that claims an event handles it; must be idempotent
    { onTracker: ({ tracking, status, at, req }) => Promise<'handled' | 'unknown'>,
      onRefund:  ({ shipmentId, status, req }) => Promise<'handled' | 'unknown'> },
  ],
})

// What owners call (also reachable as payload.shipping.*):
verifyAddress(a)                                → { ok, errors, corrected }
quote({ from, to, parcel, carrier?, reference }) → Quote
buy(quote) / buyReturn({ customer, hub, parcel, reference }) → Label  // { shipmentId, tracking, carrier, service, rateCents, labelUrl, trackerUrl, mode, fake? }
refund(shipmentId)                               → 'submitted' | 'refunded' | 'rejected' | 'not_applicable'
parcelFor(box, contents) / mailability(parcel)
```

**Rules, enforced and tested:**
- **Side effects are the site's call.** Every buy and refund passes `beforeExternalCall` first. On Captive Origins it's
  wired to `assertExternalSideEffectAllowed`, which refuses on sandboxes and throwaway sites. With no hook, test mode
  (an `EZTK…` key) is allowed and production mode is refused, so the plugin fails closed.
- **Addresses always come from the caller's records.** The plugin never relies on a carrier account's default sender
  or return address.
- **Names and addresses are never logged** and never sent anywhere but the carrier.
- **The webhook fails closed:**
  - no secret configured → 503;
  - an unsigned or wrongly signed body → 401;
  - an event that no handler claims → 200 with "unknown", and nothing written;
  - a handler that throws → 500, so the carrier retries.

## Adapters

- **Sample Kits** takes a `ShippingAdapter` (quote, buy, buyReturn, refund, parcelFor). The site passes Shipping's
  functions in, and the two never import each other. Sample Kits registers a handler for its trackers and refunds,
  which is today's `applyTrackerEvent` and `applyRefundEvent`.
- **Kitting** reads rates for the box-ladder study through Sample Kits' `kitsShippingProvider`, as today. Kitting
  needs no change.
- **Notifications:** Shipping sends nothing itself. Owners send their own messages.

## Site wiring (for the platform team's review)

1. `shipping({ provider: easyPost(...), webhookPath: '/easypost/webhook', beforeExternalCall:
   assertExternalSideEffectAllowed-wrapper })` in `src/plugins`.
2. The site's endpoint `src/endpoints/easypostWebhook.ts` is removed. The plugin's endpoint takes the same path, so
   EasyPost's dashboard setting doesn't change.
3. Sample Kits gets `shipping: { quote, buy, buyReturn, refund, parcelFor }` from Shipping's exports.
4. The env names stay `EASYPOST_API_KEY` and `EASYPOST_WEBHOOK_SECRET`, read by the site and passed in. The plugin
   reads no environment itself.

## The platform team's review (2026-11-10)

Approved with five changes, all now part of this design:

1. **A root endpoint.** The plugin adds its webhook to `config.endpoints`, not to a collection. The URL stays exactly
   `/api/easypost/webhook`, so EasyPost's setting keeps working. A test asserts the exact path.
2. **Verify the raw body.** `req.text()` is read once, and the HMAC is checked over those exact bytes in constant time.
   The body is parsed only after that. With no secret configured, the answer is 503.
3. **Retries arrive twice.** A 500 makes the carrier retry, so every handler must be idempotent, keyed by the event
   id, or else by (tracker, status, datetime). A test sends the same event twice and checks that it writes once.
4. **Fail closed around every outside call.** `beforeExternalCall` runs before every request that costs money or
   reaches outside: buy, refund, tracker create, quote, verify. If it throws, the call doesn't happen. The site wires it
   to `assertExternalSideEffectAllowed('easypost', …)`. On the site side, `src/lib/env.ts` also refuses a production key
   (`EZAK…`) unless `APP_ENV` is prod, with a test in `env.int.spec.ts`, so a copied prod key can't buy postage from
   test. The platform team offered to add that check itself.
5. **The fake provider for tests only.** It's exported from a `/testing` subpath, so a production bundle can't select
   it by accident.

The ledger: not in 0.1. Sample Kits already records each label, with its refund state, on the kit shipment, so the
money trail exists; revisit when the shop buys labels. No collections, so the site's seed data needn't change.

## Tests (this repo)

Vitest with the fake provider, plus an EasyPost provider tested against recorded responses. It never calls EasyPost
from CI. Always covered:
- the side-effects hook refusing a buy or refund;
- production mode refused without a hook;
- the webhook's 503 and 401 cases, the unknown-tracker 200, and retry on a throwing handler;
- address problems for each kind;
- PO Box and General Delivery limited to USPS;
- a timed-out buy reported as "may have been bought";
- no address in logs or errors.

## Open

- **A labels ledger (`shipping-labels`)**: one record per label bought, with cost, refund state and the owner's
  reference. It would give spend reports and refund sweeps for every owner. Against it: Sample Kits keeps its own
  label records under today's names (no migration), so the ledger would duplicate them until a later migration.
  **Proposal:** not in 0.1; revisit when a second owner (the shop) buys labels.
- **International addresses:** the US only for now, as today (`country: 'US'`). The owner says when.
- **Other carriers' providers** (Shippo, direct USPS): the contract allows them. None are planned.
