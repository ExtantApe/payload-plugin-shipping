# Changelog

## Unreleased

Test audit after 0.1.0 (`docs/test-audit.md`, 2026-11-26): 16 tests added in `test/safety.test.ts` for the go-ahead, money, secrets and the webhook's refusals. No source changed. Tested: 43 tests with the fake carrier and a made-up `fetch`, each new one shown to fail under a one-line change to the source. Not tested: real EasyPost, which it has still never called.

## 0.1.0 (unreleased)

First version, moved from the first site's `src/lib/shipping` and its box ladder's parcel rules, with the platform team's five review changes: a root webhook endpoint, the HMAC over the raw body, idempotent handlers, `beforeExternalCall` before every outside call (production refused without it), and the fake carrier only at `/testing`.

After the security read: purchases with an unclear outcome fail as `MAYBE_BOUGHT`; PO Box and General Delivery force USPS; the webhook's age window covers refunds and refuses events dated ahead; a handler that doesn't answer gives 500.

Buy each quote once, and the external-call hook allows only true (2026-11-26):

- **Buy each quote once.** `buy` and `buyLabel` claim the quote in a new `shipping-purchases` collection, one record per quote under a unique key, before the carrier is called. A second `buy` of a bought quote answers the first label. One that arrives mid-purchase is refused with `BUY_IN_PROGRESS`. If the claim can't be stored the answer is `NOT_CLAIMED`. None of those calls the carrier. The purchase request also carries an `Idempotency-Key` header made from the quote; EasyPost's documentation doesn't describe that header, so nothing relies on it.
- **Changed: the external-call hook allows only `true`.** `beforeExternalCall` used to allow a call unless it threw. Now the call goes ahead only on an exact `true` or a promise of it, and `false`, nothing at all, `1`, `'yes'`, an object, a throw or a rejected promise all refuse it. Its type is now `boolean | Promise<boolean>`. A hook that only throws to refuse needs `return true` at the end.
- **A 408 or 429 on a purchase is an unknown outcome**, like a timeout, a dropped connection or a 5xx. `MAYBE_BOUGHT` now carries `shipmentId` and says how to settle it, and the quote stays locked against another purchase.
- **New collection:** `shipping-purchases` (quote key, status, shipment id, the label). No name or address, hidden from the admin, closed to every outside read and write. Sites with seed data or migrations need to know about it.

Tested: 27 integration tests with the fake carrier and an in-memory MongoDB, covering two buys in a row, five at the same moment (one carrier purchase call each time), each hook answer, and 408, 429, 500, 503, a dropped connection and a timeout. Not tested: EasyPost itself, which has never been called, so whether it honors the `Idempotency-Key` header is unknown; databases other than MongoDB; two server instances at once (the same unique key covers them, and the test runs in one process).
