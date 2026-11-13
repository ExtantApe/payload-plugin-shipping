# Changelog

## 0.1.0 (unreleased)

First version, moved from Captive Origins' `src/lib/shipping` and its box ladder's parcel rules, with Platform's five review changes: a root webhook endpoint, the HMAC over the raw body, idempotent handlers, `beforeExternalCall` before every outside call (production refused without it), and the fake carrier only at `/testing`.

After the security read: purchases with an unclear outcome fail as `MAYBE_BOUGHT`; PO Box and General Delivery force USPS; the webhook's age window covers refunds and refuses events dated ahead; a handler that doesn't answer gives 500.

Tested: 20 integration tests with the fake carrier. Never called EasyPost.
