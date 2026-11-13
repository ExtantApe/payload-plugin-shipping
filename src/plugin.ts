import type { Config, Endpoint, Payload, PayloadRequest, Plugin } from 'payload'

import type { Resolved, ShippingHandler, ShippingOptions } from './types.js'

const DAY = 86_400_000
/** Clocks differ a little; an event dated further ahead than this is refused. */
const FUTURE_SKEW_MS = 10 * 60_000
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

/** Every handler: the plugin's own options and those other plugins registered at `config.custom.shippingHandlers`. */
export const handlersOf = (payload: Payload): ShippingHandler[] => {
  const o = payload.config.custom!.shipping as Resolved
  const extra = payload.config.custom?.shippingHandlers as ShippingHandler[] | undefined
  return [...o.handlers, ...(Array.isArray(extra) ? extra : [])]
}

/** Only an answer of exactly `true` (or a promise of it) passes; anything else, a thrown or rejected error included, is no. */
async function signedExactly(check: () => unknown): Promise<boolean> {
  try {
    return (await check()) === true
  } catch {
    return false
  }
}

/**
 * The carrier's webhook. It fails closed:
 * - no secret configured: 503;
 * - an unsigned or wrongly signed body: 401, checked over the raw bytes before anything is parsed. Only `verify`
 *   answering exactly `true` (sync or async) counts; anything else, a throw included, is 401;
 * - too old (a captured body replayed later), dated in the future, or not ours: 200, nothing written;
 * - no handler claims it: 200 "unknown", nothing written;
 * - a handler throws, or answers anything but "handled" or "unknown": 500, so the carrier retries (handlers must be idempotent).
 */
const webhook = (path: string): Endpoint => ({
  path,
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const o = req.payload.config.custom!.shipping as Resolved
    const hook = o.provider.webhook
    if (!hook?.configured) return json({ error: 'Not configured' }, 503)
    const raw = (await req.text?.()) ?? ''
    // Only an exact `true`, awaited: a promise (a custom provider's async verify), any other truthy answer, or a
    // throw is unsigned. EasyPost's own verify is sync and answers a boolean.
    if (!(await signedExactly(() => hook.verify(raw, req.headers)))) return json({ error: 'Unauthorized' }, 401)
    const ev = hook.parse(raw)
    if (!ev) return json({ result: 'ignored' })
    // Both kinds of event: a captured body can't be replayed after the window, nor dated ahead to outlive it.
    const at = new Date((ev.tracker ?? ev.refund)!.createdAt).getTime()
    if (!(at > Date.now() - o.maxEventAgeDays * DAY)) return json({ result: 'too-old' })
    if (!(at < Date.now() + FUTURE_SKEW_MS)) return json({ result: 'too-new' })
    try {
      for (const h of handlersOf(req.payload)) {
        const fn = ev.tracker ? h.onTracker : h.onRefund
        if (!fn) continue
        const result = ev.tracker ? await h.onTracker!({ event: ev.tracker, req, payload: req.payload }) : await h.onRefund!({ event: ev.refund!, req, payload: req.payload })
        if (result === 'handled') return json({ result: 'handled' })
        // A handler that forgot to answer may have half-done its work: fail closed, so the carrier retries.
        if (result !== 'unknown') throw new Error('shipping: a handler answered neither "handled" nor "unknown"')
      }
      return json({ result: 'unknown' })
    } catch (error) {
      req.payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'shipping: a webhook handler failed; the carrier will retry' })
      return json({ error: 'Handler failed' }, 500)
    }
  },
})

/** Shipping: addresses, carrier quotes and labels, refunds of unused labels, and the carrier's webhook. */
export const shippingPlugin =
  (options: ShippingOptions): Plugin =>
  (config: Config): Config => {
    if (!options?.provider || typeof options.provider.quote !== 'function') throw new Error('Shipping: give a `provider`, for example easyPost({ apiKey, webhookSecret }).')
    const o: Resolved = {
      provider: options.provider,
      webhookPath: options.webhookPath ?? '/easypost/webhook',
      maxEventAgeDays: options.maxEventAgeDays ?? 7,
      beforeExternalCall: options.beforeExternalCall,
      handlers: options.handlers ?? [],
    }
    if (!o.webhookPath.startsWith('/')) throw new Error('Shipping: webhookPath starts with "/".')
    return {
      ...config,
      custom: { ...config.custom, shipping: o },
      // A root endpoint, so the URL is exactly /api<webhookPath>.
      endpoints: [...(config.endpoints ?? []), webhook(o.webhookPath)],
    }
  }
