# Changelog

## Unreleased

Test audit after 0.1.0 (`docs/test-audit.md`, 2026-11-26): 16 tests added in `test/safety.test.ts` for the go-ahead, money, secrets and the webhook's refusals. No source changed. Tested: 37 tests with the fake carrier and a made-up `fetch`, each new one shown to fail under a one-line change to the source. Not tested: real EasyPost, which it has still never called.

## 0.1.0 (unreleased)

First version, moved from the first site's `src/lib/shipping` and its box ladder's parcel rules, with the platform team's five review changes: a root webhook endpoint, the HMAC over the raw body, idempotent handlers, `beforeExternalCall` before every outside call (production refused without it), and the fake carrier only at `/testing`.

After the security read: purchases with an unclear outcome fail as `MAYBE_BOUGHT`; PO Box and General Delivery force USPS; the webhook's age window covers refunds and refuses events dated ahead; a handler that doesn't answer gives 500.

Tested: 20 integration tests with the fake carrier. Never called EasyPost.
