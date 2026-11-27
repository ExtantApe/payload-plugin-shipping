import { inspect } from 'node:util'

import type { Config, Payload, PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { buy, buyLabel, buyReturn, easyPost, labelAddress, modeOf, quote, quoteReturn, refund, shippingPlugin, verifyAddress, type ShippingHandler, type ShippingOptions, type StoredAddress } from '../src/index.js'
import { fakeCarrier } from '../src/testing.js'

// The audit after 0.1.0 (docs/test-audit.md, 2026-11-26): the go-ahead, money, secrets and the webhook's refusals.
// No database and no network: the plugin's own config, the fake carrier or a made-up fetch, and made-up addresses.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const KEY = 'EZTK_made_up_for_the_audit'
const KEY_SENT = Buffer.from(`${KEY}:`).toString('base64')
const SECRET = 'a-made-up-webhook-secret'
const hub: StoredAddress = { kind: 'po-box', name: 'Made Up Hub', poBox: '123', city: 'Tucson', state: 'AZ', postalCode: '85701' }
const customer = labelAddress({ kind: 'street', name: 'A Made-Up Person', line1: '1 Example St', city: 'Portland', state: 'OR', postalCode: '97201' })
const shop = labelAddress({ kind: 'street', name: 'Made Up Shop', line1: '2 Example Ave', city: 'Tucson', state: 'AZ', postalCode: '85701' })
const parcel = { weightOz: 8, lengthIn: 6, widthIn: 6, heightIn: 2 }
const rate = { id: 'rate_1', carrier: 'USPS', service: 'GroundAdvantage', rate: '4.35' }
const aQuote = { shipmentId: 'shp_1', rate, rateCents: 435, mode: 'test' as const }

/** A site with the plugin on it, as far as the plugin looks: its config and a logger that keeps what it's given. */
const site = (opts: ShippingOptions, base: Partial<Config> = {}) => {
  const config = shippingPlugin(opts)(base as Config) as Config
  const logged: unknown[] = []
  const keep = (...args: unknown[]) => void logged.push(args)
  const payload = { config, logger: { error: keep, warn: keep, info: keep, debug: keep } } as unknown as Payload
  return { payload, config, logged }
}

/** Posts a raw body to the plugin's webhook endpoint. */
const post = async (payload: Payload, raw: string, headers: Record<string, string> = {}): Promise<[number, Doc]> => {
  const endpoint = (payload.config.endpoints as Doc[]).at(-1)!
  const res: Response = await endpoint.handler({ payload, headers: new Headers(headers), text: async () => raw } as unknown as PayloadRequest)
  return [res.status, await res.json()]
}
const trackerAt = (createdAt: string) => JSON.stringify({ id: 'evt_1', created_at: createdAt, description: 'tracker.updated', result: { object: 'Tracker', tracking_code: '9400abc', status: 'delivered', carrier: 'USPS' } })
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Every function that reaches the carrier, by name. */
const outsideCalls = (p: Payload): [string, () => Promise<unknown>][] => [
  ['verifyAddress', () => verifyAddress(p, customer)],
  ['quote', () => quote(p, { from: shop, to: customer, parcel, reference: 'r' })],
  ['quoteReturn', () => quoteReturn(p, { customer, hub: { address: hub }, parcel, reference: 'r' })],
  ['buy', () => buy(p, aQuote)],
  ['buyLabel', () => buyLabel(p, { from: shop, to: customer, parcel, reference: 'r' })],
  ['buyReturn', () => buyReturn(p, { customer, hub: { address: hub }, parcel, reference: 'r' })],
  ['refund', () => refund(p, 'shp_1')],
]

/** An EasyPost provider over a made-up fetch that records each request. */
const recording = (reply: (url: string) => Response | Promise<Response>, apiKey: string | null = KEY) => {
  const sent: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => (sent.push({ url: String(url), init }), reply(String(url)))) as unknown as typeof fetch
  return { provider: easyPost({ apiKey, webhookSecret: SECRET, fetchImpl }), sent }
}
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

describe('the go-ahead fails closed', () => {
  it('makes no outside call when the hook refuses by rejecting, for every function', async () => {
    const fake = fakeCarrier()
    // An async hook, as a settings lookup would be: its refusal arrives as a rejected promise.
    const { payload } = site({ provider: fake.provider, beforeExternalCall: async () => Promise.reject(new Error('side effects are off here')) })
    for (const [name, call] of outsideCalls(payload)) await expect(call(), name).rejects.toThrow(/side effects are off/)
    expect(fake.calls).toEqual([])
  })

  it('refuses with no key before asking the hook or the carrier', async () => {
    const { provider, sent } = recording(() => answer(200, {}), null)
    const asked: string[] = []
    const { payload } = site({ provider, beforeExternalCall: ({ action }) => void asked.push(action) })
    for (const [name, call] of outsideCalls(payload)) await expect(call(), name).rejects.toMatchObject({ code: 'NO_KEY' })
    expect([asked, sent]).toEqual([[], []])
  })

  it('takes a key for a test key only when it starts with EZTK', () => {
    expect([modeOf('EZTK_made_up'), modeOf('EZAK_made_up_EZTK'), modeOf(' EZTK_made_up'), modeOf('eztk_made_up')]).toEqual(['test', 'production', 'production', 'production'])
    expect([modeOf(''), modeOf(null), modeOf(undefined)]).toEqual([null, null, null])
  })
})

describe('money', () => {
  const buys = (calls: { path: string }[]) => calls.filter((c) => c.path.endsWith('/buy')).length

  it('sends one purchase request per purchase, and never sends an unclear one again', async () => {
    const ok = fakeCarrier()
    await buyLabel(site({ provider: ok.provider }).payload, { from: shop, to: customer, parcel, reference: 'r' })
    expect(ok.calls.map((c) => c.path.replace(/shp_fake\d+/, 'ID'))).toEqual(['/shipments', '/shipments/ID/buy'])

    const unclear = [fakeCarrier({ hang: (path) => path.endsWith('/buy'), timeoutMs: 30 }), fakeCarrier({ fail: (path) => (path.endsWith('/buy') ? { status: 503, code: 'UNAVAILABLE' } : null) })]
    for (const fake of unclear) {
      await expect(buyLabel(site({ provider: fake.provider }).payload, { from: shop, to: customer, parcel, reference: 'r' })).rejects.toMatchObject({ code: 'MAYBE_BOUGHT' })
      expect(buys(fake.calls)).toBe(1)
    }
  })

  it('buys nothing when the quote fails or offers no allowed rate', async () => {
    const refused = fakeCarrier({ fail: (path) => (path === '/shipments' ? { status: 422, code: 'ADDRESS.VERIFY.FAILURE' } : null) })
    await expect(buyLabel(site({ provider: refused.provider }).payload, { from: shop, to: customer, parcel, reference: 'r' })).rejects.toMatchObject({ code: 'ADDRESS.VERIFY.FAILURE' })
    // Only UPS on offer, and a PO Box takes USPS only: no rate, so no purchase.
    const upsOnly = fakeCarrier({ offer: (r) => r.carrier === 'UPS' })
    await expect(buyLabel(site({ provider: upsOnly.provider }).payload, { from: shop, to: labelAddress(hub), parcel, reference: 'r' })).rejects.toMatchObject({ code: 'NO_RATE' })
    expect([buys(refused.calls), buys(upsOnly.calls)]).toEqual([0, 0])
  })

  it('calls a redirected purchase, or a label with no shipment id, unclear', async () => {
    const replies = [answer(301, { error: { code: 'MOVED' } }), answer(200, { tracking_code: '9400111' })]
    for (const reply of replies) {
      const err = await recording(() => reply).provider.buy(aQuote).catch((e) => e)
      expect([err.code, err.message]).toEqual(['MAYBE_BOUGHT', expect.stringMatching(/may have been bought/)])
    }
  })

  it('reports the price in whole cents, and the rate the carrier charged when it differs from the quote', async () => {
    // 4.35 × 100 is 434.99999999999994 in floating point: it must come out as 435.
    const q = await recording(() => answer(201, { id: 'shp_1', rates: [rate] })).provider.quote({ from: shop, to: customer, parcel, reference: 'r' })
    expect(q.rateCents).toBe(435)
    const charged = { id: 'rate_2', carrier: 'USPS', service: 'Priority', rate: '6.10' }
    const label = await recording(() => answer(200, { id: 'shp_1', tracking_code: '9400111', selected_rate: charged })).provider.buy(q)
    expect([label.service, label.rateCents]).toEqual(['Priority', 610])
  })

  it('says so when the carrier rejects a refund', async () => {
    const fake = fakeCarrier({ refund: 'rejected' })
    expect(await refund(site({ provider: fake.provider }).payload, 'shp_1')).toBe('rejected')
  })
})

describe('secrets', () => {
  it('keeps the key and the webhook secret out of the provider object and the site’s config', () => {
    const provider = easyPost({ apiKey: KEY, webhookSecret: SECRET })
    const { config } = site({ provider })
    for (const shown of [inspect(provider, { depth: 10, showHidden: true }), inspect(config, { depth: 10, showHidden: true }), JSON.stringify(config)]) {
      for (const secret of [KEY, KEY_SENT, SECRET]) expect(shown).not.toContain(secret)
    }
  })

  it('sends the key only to EasyPost, in the Authorization header, whatever the shipment id says', async () => {
    const { provider, sent } = recording((url) => answer(200, url.endsWith('/shipments') ? { id: 'shp_1', rates: [rate] } : { id: 'shp_1', tracking_code: '9400111' }))
    const oddId = 'shp_1/../../../elsewhere?to=x#y'
    await provider.verify(customer)
    await provider.quote({ from: shop, to: customer, parcel, reference: 'r' })
    await provider.buy({ ...aQuote, shipmentId: oddId })
    await provider.refund(oddId)
    expect(sent.map((s) => new URL(s.url)).map((u) => [u.origin, u.pathname, u.search, u.hash])).toEqual([
      ['https://api.easypost.com', '/v2/addresses', '', ''],
      ['https://api.easypost.com', '/v2/shipments', '', ''],
      ['https://api.easypost.com', `/v2/shipments/${encodeURIComponent(oddId)}/buy`, '', ''],
      ['https://api.easypost.com', `/v2/shipments/${encodeURIComponent(oddId)}/refund`, '', ''],
    ])
    for (const { url, init } of sent) {
      expect(init.headers).toEqual({ Authorization: `Basic ${KEY_SENT}`, 'Content-Type': 'application/json' })
      expect(url + String(init.body)).not.toContain(KEY)
    }
  })

  it('keeps the key out of every error, even when the failure itself repeats it', async () => {
    const echo = `could not send Authorization: Basic ${KEY_SENT} for ${KEY}`
    const failing = [
      recording(() => Promise.reject(new TypeError(echo))).provider,
      recording(() => answer(401, { error: { code: 'APIKEY.INACTIVE', message: echo } })).provider,
    ]
    for (const provider of failing) {
      const calls = [() => provider.verify(customer), () => provider.quote({ from: shop, to: customer, parcel, reference: 'r' }), () => provider.buy(aQuote), () => provider.refund('shp_1')]
      for (const call of calls) {
        const err = await call().then(() => null, (e) => e as Error)
        expect(err).toBeInstanceOf(Error)
        const shown = [err!.message, err!.stack, inspect(err, { depth: 10, showHidden: true }), JSON.stringify(err)].join('\n')
        for (const secret of [KEY, KEY_SENT, SECRET]) expect(shown).not.toContain(secret)
      }
    }
  })

  it('logs only the kind of error when a webhook handler fails, and answers with no detail', async () => {
    const fake = fakeCarrier()
    const failing: ShippingHandler = { owner: 'orders', onTracker: async ({ event }) => Promise.reject(new Error(`couldn't save ${event.tracking} for A Made-Up Person, 1 Example St`)) }
    const { payload, logged } = site({ provider: fake.provider, handlers: [failing] })
    const raw = trackerAt(ago(0))
    expect(await post(payload, raw, { 'x-hmac-signature': fake.sign(raw) })).toEqual([500, { error: 'Handler failed' }])
    expect(logged).toHaveLength(1)
    const shown = inspect(logged, { depth: 10 })
    for (const detail of ['9400', 'Made-Up Person', 'Example St', SECRET]) expect(shown).not.toContain(detail)
    // A refused body gets no hint of what a good signature looks like.
    expect(await post(payload, raw, { 'x-hmac-signature': 'hmac-sha256-hex=00' })).toEqual([401, { error: 'Unauthorized' }])
  })
})

describe('the webhook fails closed', () => {
  const counting = () => {
    const got: string[] = []
    const handler: ShippingHandler = { owner: 'orders', onTracker: async ({ event }) => (got.push(event.createdAt), 'handled') }
    return { got, handler }
  }

  it('answers 503 for a provider with no webhook, or one not configured, even if its check says yes', async () => {
    const { got, handler } = counting()
    const base = fakeCarrier().provider
    const providers = [{ ...base, webhook: undefined }, { ...base, webhook: { ...base.webhook!, configured: false, verify: () => true } }]
    for (const provider of providers) {
      const { payload } = site({ provider, handlers: [handler] })
      expect(await post(payload, trackerAt(ago(0)))).toEqual([503, { error: 'Not configured' }])
    }
    expect(got).toEqual([])
  })

  it('keeps to the site’s own age limit, and to ten minutes ahead', async () => {
    const { got, handler } = counting()
    const fake = fakeCarrier()
    const send = (payload: Payload, raw: string) => post(payload, raw, { 'x-hmac-signature': fake.sign(raw) })
    const oneDay = site({ provider: fake.provider, handlers: [handler], maxEventAgeDays: 1 }).payload
    expect(await send(oneDay, trackerAt(ago(2 * DAY)))).toEqual([200, { result: 'too-old' }])
    expect(await send(oneDay, trackerAt(ago(12 * HOUR)))).toEqual([200, { result: 'handled' }])
    const sevenDays = site({ provider: fake.provider, handlers: [handler] }).payload
    expect(await send(sevenDays, trackerAt(ago(7 * DAY + HOUR)))).toEqual([200, { result: 'too-old' }])
    expect(await send(sevenDays, trackerAt(ago(7 * DAY - HOUR)))).toEqual([200, { result: 'handled' }])
    expect(await send(sevenDays, trackerAt(ago(-11 * MINUTE)))).toEqual([200, { result: 'too-new' }])
    expect(await send(sevenDays, trackerAt(ago(-5 * MINUTE)))).toEqual([200, { result: 'handled' }])
    expect(got).toHaveLength(3)
  })

  it('ignores a signed event whose date can’t be read', async () => {
    const { got, handler } = counting()
    const fake = fakeCarrier()
    const { payload } = site({ provider: fake.provider, handlers: [handler] })
    const raw = trackerAt('not a date')
    expect(await post(payload, raw, { 'x-hmac-signature': fake.sign(raw) })).toEqual([200, { result: 'too-old' }])
    expect(got).toEqual([])
  })
})

describe('no collections', () => {
  it('adds one endpoint and its own settings, and leaves the site’s collections, globals and endpoints as they were', () => {
    const collections = [{ slug: 'orders', fields: [] }]
    const globals = [{ slug: 'settings', fields: [] }]
    const mine = { path: '/mine', method: 'get' as const, handler: async () => new Response('ok') }
    const { config } = site({ provider: fakeCarrier().provider }, { collections, globals, endpoints: [mine], custom: { other: 1 } })
    expect([config.collections, config.globals]).toEqual([collections, globals])
    expect(config.endpoints!.map((e) => [e.path, e.method])).toEqual([['/mine', 'get'], ['/easypost/webhook', 'post']])
    expect(Object.keys(config.custom!).sort()).toEqual(['other', 'shipping'])
  })
})
