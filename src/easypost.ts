import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import type { LabelAddress } from './address.js'
import type { CarrierProvider, Label, Mode, Parcel, Quote, Rate, RefundEvent, RefundStatus, TrackerEvent, TrackerStatus, Verification } from './types.js'

const API = 'https://api.easypost.com/v2'
/** Every EasyPost call gives up after this long. */
export const CALL_TIMEOUT_MS = 60_000

/** An error from EasyPost or the client, in plain words, with a stable code. Never carries an address or a key. */
export class CarrierError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The carrier's shipment, when the error is about one purchase: what to look up when the outcome is unknown. */
    readonly shipmentId?: string,
  ) {
    super(message)
    this.name = 'CarrierError'
  }
}

/** How to find out what happened to a purchase with no clear answer. */
export const reconcileSteps = (shipmentId: string) => `Look up shipment ${shipmentId} with the carrier. If it has a label, use that label or refund it. If it has none, get a new quote and buy that one.`

/** A purchase whose outcome isn't known: it may have been bought, so nobody should simply buy again. */
export const maybeBought = (why: string, shipmentId: string, carrier = 'EasyPost') =>
  new CarrierError(0, 'MAYBE_BOUGHT', `${carrier}’s answer was unclear (${why}). The label may have been bought anyway. ${reconcileSteps(shipmentId)}`, shipmentId)

/** The same quote always gives the same key, and a different shipment or rate gives a different one. */
export const idempotencyKey = (quote: Pick<Quote, 'shipmentId'> & { rate: Pick<Rate, 'id'> }) => createHash('sha256').update(`buy\n${quote.shipmentId}\n${quote.rate.id}`, 'utf8').digest('hex')

export const modeOf = (key?: string | null): Mode | null => (!key ? null : key.startsWith('EZTK') ? 'test' : 'production')

const toEasyPost = (a: LabelAddress) => ({ name: a.name, company: a.company, street1: a.street1, street2: a.street2, city: a.city, state: a.state, zip: a.zip, country: a.country, phone: a.phone })
const parcelBody = (p: Parcel) => ({ weight: p.weightOz, ...(p.lengthIn ? { length: p.lengthIn, width: p.widthIn, height: p.heightIn } : {}) })

/** Ground Advantage first, else the cheapest allowed rate. PO Box and General Delivery take USPS only. */
export function pickRate(rates: Rate[], carrier: 'any' | 'USPS'): Rate | null {
  const allowed = rates.filter((r) => carrier === 'any' || r.carrier.toUpperCase() === 'USPS')
  return allowed.find((r) => r.carrier.toUpperCase() === 'USPS' && r.service === 'GroundAdvantage') ?? [...allowed].sort((a, b) => Number(a.rate) - Number(b.rate))[0] ?? null
}

/**
 * EasyPost, by plain REST (no SDK). The site reads its environment and passes the key and the webhook secret in:
 * the plugin reads no environment. A test key (EZTK…) makes free test labels; any other key is production.
 */
export function easyPost(opts: { apiKey?: string | null; webhookSecret?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number }): CarrierProvider {
  const key = opts.apiKey ?? null
  const mode = modeOf(key)
  /** `purchase` marks the one call that spends money: it carries the quote's key, and an unclear answer is unknown. */
  const call = async <T>(method: 'GET' | 'POST', path: string, body: unknown, purchase?: { shipmentId: string; key: string }): Promise<T> => {
    if (!key) throw new CarrierError(0, 'NO_KEY', 'EasyPost isn’t set up here.')
    const buying = Boolean(purchase)
    const unknown = (why: string) => maybeBought(why, purchase!.shipmentId)
    let res: Response
    try {
      res = await (opts.fetchImpl ?? fetch)(`${API}${path}`, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? CALL_TIMEOUT_MS),
        method,
        // EasyPost's documentation (read 2026-11-26) doesn't describe an Idempotency-Key header, so nothing here relies
        // on it being honored: the plugin's own purchase record is what keeps a quote to one purchase.
        headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, 'Content-Type': 'application/json', ...(purchase ? { 'Idempotency-Key': purchase.key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      const name = (error as Error)?.name
      // A purchase whose request may have left this machine may still have gone through: say so, never "nothing was bought".
      if (buying) throw unknown(name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK')
      if (name !== 'TimeoutError' && name !== 'AbortError') throw new CarrierError(0, 'NETWORK', 'EasyPost couldn’t be reached. Nothing was bought; try again.')
      throw new CarrierError(0, 'TIMEOUT', 'EasyPost didn’t answer in time. Nothing was bought; try again.')
    }
    const json = (await res.json().catch(() => null)) as ({ error?: { code?: string; message?: string } } & T) | null
    // Only a clear 4xx is a clear refusal. A 5xx or 502 from a gateway, a 408 or 429 (the request may have been taken
    // before the answer was cut short or throttled), or a reply that can't be read, leaves a purchase unknown.
    if (buying && (res.status >= 500 || res.status === 408 || res.status === 429 || (res.ok && !json) || (!res.ok && res.status < 400))) throw unknown(`HTTP_${res.status}`)
    if (!res.ok) throw new CarrierError(res.status, json?.error?.code ?? 'HTTP_ERROR', `EasyPost refused (${json?.error?.code ?? res.status}).`)
    if (!json) throw new CarrierError(res.status, 'BAD_REPLY', 'EasyPost’s reply couldn’t be read. Nothing was bought; try again.')
    return json
  }
  const asLabel = (b: { id?: string; tracking_code?: string; postage_label?: { label_url?: string }; tracker?: { public_url?: string }; selected_rate?: Rate }, fallback: Rate, shipmentId: string): Label => {
    // A label with no shipment id or tracking number can't be refunded or followed: treat the purchase as unknown.
    if (!b.id || !b.tracking_code) throw maybeBought('INCOMPLETE', b.id || shipmentId)
    const chosen = b.selected_rate ?? fallback
    return { shipmentId: b.id, tracking: b.tracking_code, carrier: chosen.carrier, service: chosen.service, rateCents: Math.round(Number(chosen.rate) * 100), labelUrl: b.postage_label?.label_url ?? '', trackerUrl: b.tracker?.public_url ?? null, mode: mode!, ...(chosen.fake ? { fake: true } : {}) }
  }
  return {
    name: 'easypost',
    mode,
    verify: async (a): Promise<Verification> => {
      const r = await call<{ street1?: string; zip?: string; verifications?: { delivery?: { success?: boolean; errors?: { code?: string; message?: string }[] } } }>('POST', '/addresses', { address: { ...toEasyPost(a), verify: true } })
      const v = r.verifications?.delivery
      return { ok: Boolean(v?.success), errors: (v?.errors ?? []).map((e) => e.code ?? 'UNKNOWN'), corrected: v?.success && (r.street1 !== a.street1 || r.zip !== a.zip) ? { street1: r.street1, zip: r.zip } : null }
    },
    quote: async (input): Promise<Quote> => {
      if (!(input.parcel.weightOz > 0)) throw new CarrierError(0, 'NO_WEIGHT', 'The parcel needs a weight.')
      const shipment = await call<{ id: string; rates?: Rate[] }>('POST', '/shipments', { shipment: { from_address: toEasyPost(input.from), to_address: toEasyPost(input.to), parcel: parcelBody(input.parcel), reference: input.reference, options: { label_format: 'PDF' } } })
      const rate = pickRate(shipment.rates ?? [], input.carrier ?? 'any')
      if (!rate) throw new CarrierError(0, 'NO_RATE', input.carrier === 'USPS' ? 'EasyPost offered no USPS rate for this parcel.' : 'EasyPost offered no rate for this parcel.')
      return { shipmentId: shipment.id, rate, rateCents: Math.round(Number(rate.rate) * 100), mode: mode!, ...(rate.fake ? { fake: true } : {}) }
    },
    buy: async (quote) => asLabel(await call('POST', `/shipments/${encodeURIComponent(quote.shipmentId)}/buy`, { rate: { id: quote.rate.id } }, { shipmentId: quote.shipmentId, key: idempotencyKey(quote) }), quote.rate, quote.shipmentId),
    refund: async (shipmentId): Promise<RefundStatus> => (await call<{ refund_status?: RefundStatus }>('POST', `/shipments/${encodeURIComponent(shipmentId)}/refund`, {})).refund_status ?? 'submitted',
    webhook: {
      configured: Boolean(opts.webhookSecret),
      // EasyPost signs the raw body: `X-Hmac-Signature: hmac-sha256-hex=<HMAC>`, the secret NFKD-normalized.
      verify: (raw, headers) => {
        const secret = opts.webhookSecret
        const header = headers.get('x-hmac-signature')
        if (!secret || !header) return false
        const expected = `hmac-sha256-hex=${createHmac('sha256', secret.normalize('NFKD')).update(raw, 'utf8').digest('hex')}`
        const a = Buffer.from(header.trim())
        const b = Buffer.from(expected)
        return a.length === b.length && timingSafeEqual(a, b)
      },
      parse: (raw) => {
        let body: { id?: string; created_at?: string; description?: string; result?: { object?: string; tracking_code?: string; status?: string; carrier?: string; public_url?: string } }
        try {
          body = JSON.parse(raw)
        } catch {
          return null
        }
        const r = body.result
        if (body.id && body.created_at && /^refund\./.test(body.description ?? '') && r?.object === 'Refund' && r.tracking_code && ['submitted', 'refunded', 'rejected', 'not_applicable'].includes(r.status ?? ''))
          return { refund: { id: body.id, createdAt: body.created_at, tracking: r.tracking_code.toUpperCase(), status: r.status as RefundStatus } satisfies RefundEvent }
        if (body.id && body.created_at && /^tracker\./.test(body.description ?? '') && r?.object === 'Tracker' && r.tracking_code && r.status)
          return { tracker: { id: body.id, createdAt: body.created_at, tracking: r.tracking_code.toUpperCase(), status: r.status as TrackerStatus, carrier: r.carrier ?? null, publicUrl: r.public_url ?? null } satisfies TrackerEvent }
        return null
      },
    },
  }
}
