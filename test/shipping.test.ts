import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type Config, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  addressProblems,
  billableLb,
  buy,
  buyLabel,
  buyReturn,
  easyPost,
  carriersFor,
  labelAddress,
  mailability,
  noticeFor,
  parcelFor,
  quote,
  refund,
  shippingPlugin,
  trackingLink,
  verifyAddress,
  type ShippingHandler,
  type StoredAddress,
} from '../src/index.js'
import { fakeCarrier } from '../src/testing.js'

// Made-up addresses and a fake carrier; nothing reaches EasyPost.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let mongo: MongoMemoryReplSet
const instances: Payload[] = []
const hub: StoredAddress = { kind: 'po-box', name: 'Made Up Hub', poBox: '123', city: 'Tucson', state: 'AZ', postalCode: '85701' }
const customer = labelAddress({ kind: 'street', name: 'A Made-Up Person', line1: '1 Example St', city: 'Portland', state: 'OR', postalCode: '97201' })
const shop = labelAddress({ kind: 'street', name: 'Made Up Shop', line1: '2 Example Ave', city: 'Tucson', state: 'AZ', postalCode: '85701' })
const parcel = { weightOz: 8, lengthIn: 6, widthIn: 6, heightIn: 2 }

const site = async (name: string, opts: Partial<Parameters<typeof shippingPlugin>[0]> & { fake?: Parameters<typeof fakeCarrier>[0] } = {}, extra: ((c: Config) => Config)[] = []) => {
  const fake = fakeCarrier(opts.fake ?? {})
  const p = await getPayload({
    key: name,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri(name), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [] }],
      plugins: [shippingPlugin({ provider: fake.provider, ...opts }), ...extra],
    }),
  } as never)
  instances.push(p)
  keys.set(p, name)
  return { p, fake }
}
const keys = new WeakMap<Payload, string>()
const post = (p: Payload, path: string, raw: string, headers: Record<string, string> = {}) =>
  handleEndpoints({ config: Promise.resolve(p.config), payloadInstanceCacheKey: keys.get(p), request: new Request(`https://site.example.com/api${path}`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', ...headers } }) } as never)
const trackerBody = (over: Doc = {}) => JSON.stringify({ id: 'evt_1', created_at: new Date().toISOString(), description: 'tracker.updated', result: { object: 'Tracker', tracking_code: '9400abc', status: 'delivered', carrier: 'USPS' }, ...over })

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
}, 120_000)
afterAll(async () => {
  for (const p of instances) await p.destroy().catch(() => undefined)
  await mongo?.stop()
})

describe('addresses and parcels', () => {
  it('finds each kind of address problem, and keeps PO Box and General Delivery to USPS', () => {
    expect(addressProblems({ kind: 'street', city: 'X', state: 'AZ', postalCode: '85701' })).toEqual(['street'])
    expect(addressProblems({ kind: 'po-box', poBox: 'abc', city: 'X', state: 'AZ', postalCode: '85701' })).toEqual(['name', 'poBox'])
    expect(addressProblems({ kind: 'general-delivery', name: 'A', city: 'X', state: 'AZ', postalCode: '85701' })).toEqual(['gdZip'])
    expect(addressProblems(hub, { placeholder: true })).toEqual(['placeholder'])
    expect(() => labelAddress({ kind: 'street' })).toThrow(/can't go on a label/)
    expect(labelAddress(hub).street1).toBe('PO BOX 123')
    expect([carriersFor('po-box'), carriersFor('general-delivery'), carriersFor('street')]).toEqual(['USPS', 'USPS', 'any'])
  })

  it('works out the parcel, billable weight and what USPS says', () => {
    const p = parcelFor({ outside: [2, 6, 6], emptyWeightOz: 3 }, 8.4)!
    expect(p).toEqual({ lengthIn: 6, widthIn: 6, heightIn: 2, weightOz: 11.4 })
    expect(billableLb(p)).toBe(1)
    expect(billableLb({ lengthIn: 14, widthIn: 14, heightIn: 14, weightOz: 32 })).toBe(20) // dimensional weight past 1 cu ft
    expect(mailability({ lengthIn: 40, widthIn: 30, heightIn: 30, weightOz: 10 }).mailable).toBe(false)
    expect(mailability({ lengthIn: 25, widthIn: 6, heightIn: 6, weightOz: 10 }).notes).toContain('over 22 in long: nonstandard fee')
  })

  it('links to the carrier’s tracking page and maps statuses to notices', () => {
    expect(trackingLink('9400 1234')).toContain('usps.com')
    expect(trackingLink('1Z999AA10123456784')).toContain('ups.com')
    expect([noticeFor('out_for_delivery'), noticeFor('available_for_pickup'), noticeFor('return_to_sender'), noticeFor('in_transit')]).toEqual(['out-for-delivery', 'delivered', 'exception', null])
  })
})

describe('buying postage', () => {
  it('quotes Ground Advantage first, buys it, and says the label is fake', async () => {
    const { p } = await site('buy')
    const q = await quote(p, { from: shop, to: customer, parcel, reference: 'order-1' })
    expect([q.rate.service, q.mode, q.fake]).toEqual(['GroundAdvantage', 'test', true])
    const l = await buy(p, q)
    expect([l.carrier, l.service, l.fake, l.rateCents]).toEqual(['USPS', 'GroundAdvantage', true, q.rateCents])
    expect(await refund(p, l.shipmentId)).toBe('submitted')
  })

  it('sends both addresses from the caller, never the account’s defaults', async () => {
    const { p, fake } = await site('addresses')
    await buyLabel(p, { from: shop, to: customer, parcel, reference: 'order-2' })
    const sent = fake.calls.find((c) => c.path === '/shipments')!.body.shipment as Doc
    expect([sent.from_address.street1, sent.to_address.street1]).toEqual(['2 Example Ave', '1 Example St'])
  })

  it('buys returns from the hub’s record, USPS only, and refuses a placeholder hub', async () => {
    const { p, fake } = await site('returns')
    const l = await buyReturn(p, { customer, hub: { address: hub }, parcel, reference: 'kit-1' })
    expect(l.carrier).toBe('USPS')
    expect((fake.calls.find((c) => c.path === '/shipments')!.body.shipment as Doc).to_address.street1).toBe('PO BOX 123')
    await expect(buyReturn(p, { customer, hub: { address: hub }, parcel, carrier: 'UPS', reference: 'kit-1' })).rejects.toThrow(/USPS only/)
    await expect(buyReturn(p, { customer, hub: { address: hub, placeholder: true }, parcel, reference: 'kit-1' })).rejects.toThrow(/placeholder/)
  })

  it('runs the site’s hook before every outside call, and makes none when it refuses', async () => {
    const asked: string[] = []
    let refuse = false
    const { p, fake } = await site('hook', { beforeExternalCall: ({ action }) => { asked.push(action); if (refuse) throw new Error('side effects are off here') } })
    const q = await quote(p, { from: shop, to: customer, parcel, reference: 'r' })
    await verifyAddress(p, customer)
    refuse = true
    fake.calls.length = 0
    await expect(buy(p, q)).rejects.toThrow(/side effects are off/)
    await expect(refund(p, 'shp_x')).rejects.toThrow(/side effects are off/)
    await expect(quote(p, { from: shop, to: customer, parcel, reference: 'r' })).rejects.toThrow(/side effects are off/)
    expect(fake.calls).toEqual([])
    expect(asked).toEqual(['quote', 'verify', 'buy', 'refund', 'quote'])
  })

  it('refuses production mode when the site gave no hook', async () => {
    const { p, fake } = await site('prod', { fake: { mode: 'production' } })
    await expect(quote(p, { from: shop, to: customer, parcel, reference: 'r' })).rejects.toMatchObject({ code: 'REFUSED' })
    expect(fake.calls).toEqual([])
  })

  it('says a timed-out purchase may have gone through, and keeps names and addresses out of errors', async () => {
    const { p } = await site('timeout', { fake: { hang: (path) => path.endsWith('/buy'), timeoutMs: 50 } })
    const q = await quote(p, { from: shop, to: customer, parcel, reference: 'r' })
    await expect(buy(p, q)).rejects.toThrow(/may have been bought/)
    const { p: p2 } = await site('refused', { fake: { fail: (path) => (path === '/shipments' ? { status: 422, code: 'ADDRESS.VERIFY.FAILURE' } : null) } })
    const err = await quote(p2, { from: shop, to: customer, parcel, reference: 'r' }).catch((e) => e)
    expect(String(err.message)).not.toMatch(/Example St|Made-Up Person|Portland/)
    expect(err.code).toBe('ADDRESS.VERIFY.FAILURE')
  })
})

describe('the webhook', () => {
  it('lives at exactly /api/easypost/webhook, as a root endpoint', async () => {
    const { p } = await site('path')
    expect(p.config.endpoints.some((e) => e.path === '/easypost/webhook' && e.method === 'post')).toBe(true)
  })

  it('answers 503 with no secret, and 401 for an unsigned or wrongly signed body', async () => {
    const { p } = await site('nosecret', { fake: { webhookSecret: null } })
    expect((await post(p, '/easypost/webhook', trackerBody())).status).toBe(503)
    const { p: p2, fake } = await site('signed')
    expect((await post(p2, '/easypost/webhook', trackerBody())).status).toBe(401)
    expect((await post(p2, '/easypost/webhook', trackerBody(), { 'x-hmac-signature': 'hmac-sha256-hex=00' })).status).toBe(401)
    // Signed over different bytes: the check is on the raw body.
    const raw = trackerBody()
    expect((await post(p2, '/easypost/webhook', raw + ' ', { 'x-hmac-signature': fake.sign(raw) })).status).toBe(401)
  })

  it('passes a signed tracker to the handler that claims it, once per event even when retried', async () => {
    const seen = new Set<string>()
    let writes = 0
    const handler: ShippingHandler = {
      owner: 'kits',
      onTracker: async ({ event }) => {
        if (event.tracking !== '9400ABC') return 'unknown'
        if (!seen.has(event.id)) (seen.add(event.id), writes++)
        return 'handled'
      },
    }
    const { p, fake } = await site('handled', { handlers: [handler] })
    const raw = trackerBody()
    for (let i = 0; i < 2; i++) {
      const res = await post(p, '/easypost/webhook', raw, { 'x-hmac-signature': fake.sign(raw) })
      expect([res.status, await res.json()]).toEqual([200, { result: 'handled' }])
    }
    expect(writes).toBe(1)
  })

  it('acknowledges an unknown tracker without writing, ignores old events, and returns 500 when a handler throws', async () => {
    let throws = false
    const late: ShippingHandler = { owner: 'late', onTracker: async () => { if (throws) throw new Error('made-up'); return 'unknown' } }
    // A handler registered by another plugin, after Shipping, with no import.
    const { p, fake } = await site('unknown', {}, [(c: Config) => ({ ...c, custom: { ...c.custom, shippingHandlers: [late] } })])
    const raw = trackerBody()
    expect(await (await post(p, '/easypost/webhook', raw, { 'x-hmac-signature': fake.sign(raw) })).json()).toEqual({ result: 'unknown' })
    const old = trackerBody({ created_at: new Date(Date.now() - 8 * 86_400_000).toISOString() })
    expect(await (await post(p, '/easypost/webhook', old, { 'x-hmac-signature': fake.sign(old) })).json()).toEqual({ result: 'too-old' })
    throws = true
    const errorLog = vi.spyOn(p.logger, 'error')
    expect((await post(p, '/easypost/webhook', raw, { 'x-hmac-signature': fake.sign(raw) })).status).toBe(500)
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('9400')
  })

  it('accepts a body only when verify answers exactly true, sync or async; any other answer or a throw is 401 and reaches no handler', async () => {
    let answer: () => unknown = () => false
    const got: string[] = []
    const handlers: ShippingHandler[] = [{ owner: 'kits', onTracker: async ({ event }) => (got.push(event.id), 'handled') }]
    const base = fakeCarrier().provider
    // A custom provider whose signature check is the site's own (async, as a key-store lookup would be).
    const provider = { ...base, name: 'custom', webhook: { ...base.webhook!, configured: true, verify: (() => answer()) as never } }
    const { p } = await site('custom-verify', { provider, handlers })
    const raw = trackerBody()
    const NOT_TRUE: [string, () => unknown][] = [
      ['a promise of false', async () => false],
      ['1', () => 1],
      ["'yes'", () => 'yes'],
      ['{ valid: false }', () => ({ valid: false })],
      ['a promise of { valid: false }', async () => ({ valid: false })],
      ['a thrown error', () => {
        throw new Error('key store down')
      }],
      ['a rejected promise', async () => {
        throw new Error('key store down')
      }],
    ]
    for (const [what, a] of NOT_TRUE) {
      answer = a
      expect((await post(p, '/easypost/webhook', raw)).status, what).toBe(401)
    }
    expect(got).toEqual([])
    for (const a of [() => true, async () => true]) {
      answer = a
      expect(await (await post(p, '/easypost/webhook', raw)).json()).toEqual({ result: 'handled' })
    }
    expect(got).toHaveLength(2)
  })

  it('passes refund events to refund handlers', async () => {
    const got: string[] = []
    const { p, fake } = await site('refunds', { handlers: [{ owner: 'kits', onRefund: async ({ event }) => (got.push(`${event.tracking}:${event.status}`), 'handled') }] })
    const raw = JSON.stringify({ id: 'evt_2', created_at: new Date().toISOString(), description: 'refund.successful', result: { object: 'Refund', tracking_code: '9400xyz', status: 'refunded' } })
    expect(await (await post(p, '/easypost/webhook', raw, { 'x-hmac-signature': fake.sign(raw) })).json()).toEqual({ result: 'handled' })
    expect(got).toEqual(['9400XYZ:refunded'])
  })
})

describe('what the security read found', () => {
  const rate = { id: 'rate_1', carrier: 'USPS', service: 'GroundAdvantage', rate: '5.00' }
  const q = { shipmentId: 'shp_1', rate, rateCents: 500, mode: 'test' as const }
  const answering = (reply: () => Promise<Response>) => easyPost({ apiKey: 'EZTK_made_up', fetchImpl: (async () => reply()) as unknown as typeof fetch })
  const reply = (status: number, body: unknown) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

  it('never says "nothing was bought" when a purchase’s outcome is unclear', async () => {
    const unclear = [
      answering(async () => { throw new TypeError('fetch failed') }), // a reset after the request left
      answering(reply(502, '<html>Bad gateway</html>')),
      answering(reply(500, { error: { code: 'INTERNAL' } })),
      answering(reply(200, 'not json')),
      answering(reply(200, { id: 'shp_1' })), // no tracking number: couldn't be refunded or followed
    ]
    for (const provider of unclear) {
      const err = await provider.buy(q).catch((e) => e)
      expect([err.code, err.message]).toEqual(['MAYBE_BOUGHT', expect.stringMatching(/may have been bought/)])
      expect(err.message).not.toMatch(/Nothing was bought/)
    }
    // A clear refusal is still a refusal, and a quote that can't connect bought nothing.
    expect(await answering(reply(422, { error: { code: 'SHIPMENT.RATE.INVALID' } })).buy(q).catch((e) => e.code)).toBe('SHIPMENT.RATE.INVALID')
    expect(await answering(async () => { throw new TypeError('fetch failed') }).quote({ from: shop, to: customer, parcel, reference: 'r' }).catch((e) => e.message)).toMatch(/Nothing was bought/)
  })

  it('returns address problems as codes only, never the carrier’s text', async () => {
    const v = await answering(reply(200, { verifications: { delivery: { success: false, errors: [{ code: 'E.ADDRESS.NOT_FOUND', message: 'Address not found: 1 Example St' }] } } })).verify(customer)
    expect(v.errors).toEqual(['E.ADDRESS.NOT_FOUND'])
  })

  it('buys only USPS for a PO Box or General Delivery, whatever the caller asked', async () => {
    // With no Ground Advantage offered, the cheapest rate is UPS: a street address takes it, a PO Box or General Delivery doesn't.
    const { p, fake } = await site('pobox', { fake: { offer: (r) => r.service !== 'GroundAdvantage' } })
    expect((await quote(p, { from: shop, to: customer, parcel, reference: 'r' })).rate.carrier).toBe('UPS') // the control
    const poBox = labelAddress(hub)
    const gd = labelAddress({ kind: 'general-delivery', name: 'A Made-Up Person', city: 'Tucson', state: 'AZ', postalCode: '85726-9999' })
    for (const to of [poBox, gd]) {
      const l = await buyLabel(p, { from: shop, to, parcel, carrier: 'any', reference: 'r' })
      expect(l.carrier).toBe('USPS')
      expect((fake.calls.filter((c) => c.path === '/shipments').at(-1)!.body.shipment as Doc).to_address.street1).toBe(to.street1)
    }
  })

  it('ignores replayed refunds and events dated ahead, and fails closed when a handler doesn’t answer', async () => {
    const answers: (string | undefined)[] = []
    const { p, fake } = await site('window', { handlers: [{ owner: 'kits', onRefund: async () => answers.shift() as never, onTracker: async () => answers.shift() as never }] })
    const refundAt = (at: number) => JSON.stringify({ id: 'evt_3', created_at: new Date(at).toISOString(), description: 'refund.successful', result: { object: 'Refund', tracking_code: '9400xyz', status: 'refunded' } })
    const send = async (raw: string) => { const r = await post(p, '/easypost/webhook', raw, { 'x-hmac-signature': fake.sign(raw) }); return [r.status, await r.json()] }
    expect(await send(refundAt(Date.now() - 8 * 86_400_000))).toEqual([200, { result: 'too-old' }])
    expect(await send(trackerBody({ created_at: new Date(Date.now() + 86_400_000).toISOString() }))).toEqual([200, { result: 'too-new' }])
    const noDate = JSON.stringify({ id: 'evt_4', description: 'refund.successful', result: { object: 'Refund', tracking_code: '9400xyz', status: 'refunded' } })
    expect(await send(noDate)).toEqual([200, { result: 'ignored' }])
    answers.push(undefined)
    expect((await send(refundAt(Date.now())))[0]).toBe(500)
    answers.push('handled')
    expect(await send(refundAt(Date.now()))).toEqual([200, { result: 'handled' }])
  })

  it('asks the site’s hook once per action for a whole purchase, and buys nothing when it refuses the purchase', async () => {
    const asked: string[] = []
    const { p, fake } = await site('once', { beforeExternalCall: ({ action }) => { asked.push(action); if (action === 'buy' && asked.length > 2) throw new Error('no more postage') } })
    await buyLabel(p, { from: shop, to: customer, parcel, reference: 'r' })
    expect(asked).toEqual(['buy', 'quote'])
    fake.calls.length = 0
    await expect(buyLabel(p, { from: shop, to: customer, parcel, reference: 'r' })).rejects.toThrow(/no more postage/)
    expect(fake.calls).toEqual([])
  })
})

describe('start-up', () => {
  it('refuses without a provider, or with a webhook path that isn’t a path', () => {
    expect(() => shippingPlugin({} as never)({} as never)).toThrow(/provider/)
    expect(() => shippingPlugin({ provider: fakeCarrier().provider, webhookPath: 'webhook' })({} as never)).toThrow(/webhookPath/)
  })
})
