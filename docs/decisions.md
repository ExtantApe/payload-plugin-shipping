# Decisions

Dated decisions for this repo, newest last.

- 2026-11-10: created from the ops starter kit, area `captive-origins`.
- 2026-11-10: name approved by the owner (`~/Code/ops/plugin-names.md`): Shipping, `@extantape/payload-plugin-shipping`, EasyPost as the first provider. Assigned to code-91 (Kits) by Helm. Built in P4 with Sample Kits. Design: `docs/architecture/0001-design.md`.
- 2026-11-10: MIT (a general Payload plugin); public from the first push after the audit; the `gh repo create … --public` command goes through Helm.
- 2026-11-10: when a change here adds, removes or renames a collection or field (or changes a type, options, required or a relationship), tell Seed World when it merges (`~/Code/ops/rules/seed-remix-on-schema-change.md`).
- 2026-11-10: decision feed acknowledged through D16 (`~/Code/ops/decisions/`): D2 agnostic plugin with optional adapters; D5 public from the first push after the audit; D6 the approved name only; D8 schema changes to Seed World ahead; D12 no family keyword.
- 2026-11-10 (Plugins Lead, K78; Kits' design and Platform's review): built with no collections. Carrier errors carry EasyPost's code, never its message text, so an address it echoes can't reach logs or users. Webhook handlers can also come from other plugins at `config.custom.shippingHandlers`.
- 2026-11-10 (Plugins Lead, security read of 2fcb5d6): a purchase with an unclear outcome (network error, 5xx, unreadable reply, no id or tracking number) fails as `MAYBE_BOUGHT`, never "nothing was bought"; a PO Box or General Delivery address on either side forces USPS; the 7-day window covers refunds too and events dated more than 10 minutes ahead are refused; a handler answer other than handled/unknown gives 500; `buyLabel` asks the hook once per action; address checks return codes only.
