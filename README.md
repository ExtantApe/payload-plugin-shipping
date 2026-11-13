# payload-plugin-shipping

Shipping for Payload: addresses, carrier rates, labels, refunds of unused labels and tracking webhooks, with EasyPost as the first carrier provider.

**Status:** 0.1.0, not on npm yet. 21 tests pass against Payload 3.92 with an in-memory MongoDB and a fake carrier. They cover addresses, parcels, buying, returns, the side-effects hook, production refused without it, a timed-out purchase, errors without addresses, and the webhook's 503, 401 (a custom provider's async check included), unknown, too-old, too-new, retry and refund cases, and purchases whose outcome is unclear. It has never called EasyPost: the request shapes follow EasyPost's documentation and are checked in test mode once a test key is saved. No site uses it yet.

## What it does

- **Addresses** of three kinds (street, PO Box, General Delivery), with `addressProblems` in plain codes, `labelAddress` (refuses a guessed or placeholder address), `addressKey` and `carriersFor`: PO Box and General Delivery take USPS only. Both addresses on a label always come from your records, never a carrier account's defaults.
- **Carrier calls**, through a provider (EasyPost first):
  - `quote`: Ground Advantage first, else the cheapest allowed. A PO Box or General Delivery address on either side gets USPS only, whatever the caller asked;
  - `buy`, and `buyLabel` (a quote then a purchase);
  - `buyReturn`: from the customer to your hub's address, USPS only;
  - `quoteReturn`;
  - `refund`, for an unused label, within 30 days for USPS;
  - `verifyAddress`.
- **Your go-ahead before every outside call.** `beforeExternalCall({ action, mode })` runs before every verify, quote, buy and refund, and a throw stops the call. Without the hook, test mode (an `EZTK…` key) is allowed and production mode is refused, so a copied live key can't buy postage from a test site by accident.
- **Errors in plain words**, with a stable code. They never include a name, an address or your key. A purchase whose outcome is unclear (a timeout, a dropped connection, a 5xx, an unreadable reply, or a label with no tracking number) fails with `MAYBE_BOUGHT` and says it may have been bought, so nobody buys twice. Address checks return EasyPost's codes, never its text.
- **Parcels:** `parcelFor` (a box's outside size, longest side first, and weight), `billableLb` and `dimWeightLb` (USPS dimensional weight past one cubic foot), and `mailability` (too big, too heavy, the nonstandard fees, in words).
- **Tracking:** `trackingLink` for USPS and UPS, and `noticeFor`, which maps a carrier status to out for delivery, delivered or an exception. Sending the emails is yours, through Notifications or your own code.
- **The webhook** at `/api/easypost/webhook` (a root endpoint, `webhookPath`). It fails closed:
  - no secret configured: 503;
  - unsigned or wrongly signed: 401, with the HMAC checked over the raw bytes before anything is parsed. A custom provider's `webhook.verify` may be sync or async, and only an answer of exactly `true` counts: `false`, `1`, an object such as `{ valid: false }`, or an error thrown or rejected is a 401;
  - a tracker or refund event older than 7 days, or dated more than 10 minutes ahead, is ignored, so a captured body can't be replayed later;
  - an event no handler claims: 200 "unknown", nothing written;
  - a handler that throws, or answers anything but `'handled'` or `'unknown'`: 500, so the carrier retries.

  Handlers are yours, or another plugin's, registered at `config.custom.shippingHandlers` with no import. They must be idempotent, because carriers retry.
- **No collections.** The plugin that buys a label records it.
- **A fake carrier for tests and dry runs**, only from `@extantape/payload-plugin-shipping/testing`, so a production bundle can't pick it by accident. Its prices are made up, and every rate and label says `fake: true`.

## On its own, and with others

**On its own:** Shipping needs only Payload and an EasyPost key, which your site passes in, or the fake carrier for tests. It adds no collections, so your own code records each label it buys, and your own handlers answer the webhook.

**Works with:**
- **Sample Kits:** your site passes Shipping's functions into Sample Kits' `adapters.shipping`, and Sample Kits registers its tracking and refund handler at `config.custom.shippingHandlers`. The two never import each other.
- **Notifications:** Shipping sends nothing itself. `noticeFor` turns a carrier status into out for delivery, delivered or a problem, and the plugin that owns the parcel can send that through Notifications.
- **Kitting:** Kitting's box suggestions can use Shipping's rates. From Kitting 0.3.0 (not released yet), pass Shipping's `quote` to Kitting's adapter as it is: `shipping: { provider: ratesFromShipping({ quote, from }) }`. Neither plugin imports the other, and every quote still goes through your `beforeExternalCall` hook. If a quote fails, Kitting packs by its own postage rates and marks the suggestion.

**Family:** Shipping sits in the Fulfillment family, with Kitting, Restock, Sample Kits, Scan, Labels, Wizards, Custody and Sequences, though the families are a working draft and Fulfillment is due to be split into different groups.

## Install

```sh
npm install @extantape/payload-plugin-shipping
```

```ts
import { easyPost, shippingPlugin } from '@extantape/payload-plugin-shipping'

shippingPlugin({
  provider: easyPost({ apiKey: process.env.EASYPOST_API_KEY, webhookSecret: process.env.EASYPOST_WEBHOOK_SECRET }),
  beforeExternalCall: ({ action, mode }) => mySideEffectsCheck('easypost', action, mode), // throw to refuse
  handlers: [{ owner: 'orders', onTracker: async ({ event }) => (await markTracking(event)) ? 'handled' : 'unknown' }],
})
```

The plugin reads no environment: your site passes the key and the secret in.

The go-ahead hook guards the plugin's functions (`quote`, `buy`, `buyLabel`, `refund` and the rest). The provider object itself, from `easyPost()` or `config.custom.shipping.provider`, calls the carrier directly: it's server code, so treat it like your key and go through the functions.

## Limits

- US addresses only for now.
- EasyPost is the only provider. The contract allows others.
- A label ledger across owners is planned, not in 0.1.

## Commands

```sh
npm test          # integration tests, in-memory MongoDB, fake carrier
npm run typecheck
npm run build
```

## License

MIT. See [LICENSE](LICENSE).
