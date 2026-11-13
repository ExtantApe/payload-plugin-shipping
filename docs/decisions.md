# Decisions

Dated decisions for this repo, newest last.

- 2026-11-10: created from the standard repo starter kit.
- 2026-11-10: name approved by the owner: Shipping, `@extantape/payload-plugin-shipping`, EasyPost as the first provider. Built by the kits team, alongside Sample Kits. Design: `docs/architecture/0001-design.md`.
- 2026-11-10: MIT (a general Payload plugin); public from the first push after the audit, which the owner approves.
- 2026-11-10: when a change here adds, removes or renames a collection or field (or changes a type, options, required or a relationship), tell the team that keeps the site's seed data when it merges.
- 2026-11-10: the owner's standing rules apply: an agnostic plugin with optional adapters; public from the first push after the audit; the approved name only; schema changes go to the seed data team ahead of time; no family keyword.
- 2026-11-10 (the kits design and the platform team's review): built with no collections. Carrier errors carry EasyPost's code, never its message text, so an address it echoes can't reach logs or users. Webhook handlers can also come from other plugins at `config.custom.shippingHandlers`.
- 2026-11-10 (security read of 2fcb5d6): a purchase with an unclear outcome (network error, 5xx, unreadable reply, no id or tracking number) fails as `MAYBE_BOUGHT`, never "nothing was bought"; a PO Box or General Delivery address on either side forces USPS; the 7-day window covers refunds too and events dated more than 10 minutes ahead are refused; a handler answer other than handled/unknown gives 500; `buyLabel` asks the hook once per action; address checks return codes only.
