import { createHmac, randomInt } from 'node:crypto'

import { easyPost } from './easypost.js'
import { billableLb, type ParcelSize } from './parcel.js'
import type { CarrierProvider } from './types.js'

/**
 * For tests and dry runs only, from `@extantape/payload-plugin-shipping/testing`, so a production bundle can't
 * pick it by accident. A stand-in for EasyPost: nothing leaves the process. **Its prices are made up** (USPS-shaped,
 * so the logic can be tested); every rate and label says `fake: true`.
 */
export function fakeZone(fromZip = '', toZip = ''): number {
  const a = Number(String(fromZip).slice(0, 3))
  const b = Number(String(toZip).slice(0, 3))
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 5
  const remote = (z: number) => (z >= 995 && z <= 999) || z === 967 || z === 968
  if (remote(a) !== remote(b)) return 8
  return Math.min(8, 1 + Math.floor(Math.abs(a - b) / 120))
}

export function fakePrices(p: ParcelSize, zone: number): { ground: number; priority: number } {
  const lb = billableLb(p)
  const light = p.weightOz <= 15.99 && Math.round(p.lengthIn) * Math.round(p.widthIn) * Math.round(p.heightIn) <= 1728
  let ground = light ? 450 + zone * 25 + Math.ceil(p.weightOz / 4) * 20 : 700 + zone * 60 + (lb - 1) * (35 + zone * 12)
  const long = Math.max(p.lengthIn, p.widthIn, p.heightIn)
  const cubic = Math.round(p.lengthIn) * Math.round(p.widthIn) * Math.round(p.heightIn)
  ground += Math.max(long > 30 ? 1500 : long > 22 ? 400 : 0, cubic > 3456 ? 1500 : 0)
  return { ground, priority: Math.round(ground * 1.4) }
}

const API = 'https://api.easypost.com/v2'
const digits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join('')

/**
 * A fake carrier: EasyPost's shapes answered in memory. `calls` records what was asked, for tests. `fail` makes a
 * path answer with an error, `hang` makes it time out, and `offer` leaves services out of the rates.
 */
export function fakeCarrier(over: { mode?: 'test' | 'production'; refund?: 'submitted' | 'rejected'; webhookSecret?: string | null; fail?: (path: string) => { status: number; code: string } | null; hang?: (path: string) => boolean; timeoutMs?: number; offer?: (rate: { carrier: string; service: string }) => boolean } = {}) {
  const shipments = new Map<string, { id: string; carrier: string; service: string; rate: string; fake: true }[]>()
  const calls: { path: string; body: Record<string, unknown> }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace(API, '')
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>
    calls.push({ path, body })
    if (over.hang?.(path)) {
      await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))))
    }
    const json = (status: number, reply: unknown) => new Response(JSON.stringify(reply), { status, headers: { 'Content-Type': 'application/json' } })
    const failure = over.fail?.(path)
    if (failure) return json(failure.status, { error: { code: failure.code, message: 'made-up failure' } })
    if (path === '/shipments') {
      const s = (body.shipment ?? {}) as { from_address?: { zip?: string }; to_address?: { zip?: string }; parcel?: { weight?: number; length?: number; width?: number; height?: number } }
      const p = s.parcel ?? {}
      const size: ParcelSize = { lengthIn: p.length ?? 6, widthIn: p.width ?? 6, heightIn: p.height ?? 2, weightOz: p.weight ?? 1 }
      const { ground, priority } = fakePrices(size, fakeZone(s.from_address?.zip, s.to_address?.zip))
      const id = `shp_fake${digits(10)}`
      const rates = [
        { id: `rate_g${digits(8)}`, carrier: 'USPS', service: 'GroundAdvantage', rate: (ground / 100).toFixed(2), fake: true as const },
        { id: `rate_p${digits(8)}`, carrier: 'USPS', service: 'Priority', rate: (priority / 100).toFixed(2), fake: true as const },
        { id: `rate_u${digits(8)}`, carrier: 'UPS', service: 'Ground', rate: ((ground - 50) / 100).toFixed(2), fake: true as const },
      ].filter((r) => over.offer?.(r) ?? true)
      shipments.set(id, rates)
      return json(201, { id, rates })
    }
    const buy = path.match(/^\/shipments\/([^/]+)\/buy$/)
    if (buy) {
      const chosen = shipments.get(buy[1]!)?.find((r) => r.id === (body.rate as { id?: string } | undefined)?.id)
      if (!chosen) return json(422, { error: { code: 'SHIPMENT.RATE.INVALID', message: 'That rate isn’t on this shipment.' } })
      return json(200, { id: buy[1], tracking_code: `9400${digits(18)}`, postage_label: { label_url: `https://example.invalid/labels/${buy[1]}.pdf` }, tracker: { public_url: `https://example.invalid/track/${buy[1]}` }, selected_rate: chosen })
    }
    const refund = path.match(/^\/shipments\/([^/]+)\/refund$/)
    if (refund) return json(200, { id: refund[1], refund_status: over.refund ?? 'submitted' })
    if (path === '/addresses') {
      const a = (body.address ?? {}) as { street1?: string; zip?: string }
      return json(201, { ...a, verifications: { delivery: { success: true, errors: [] } } })
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'not answered' } })
  }) as unknown as typeof fetch
  const secret = over.webhookSecret === undefined ? 'a-made-up-webhook-secret' : over.webhookSecret
  const provider: CarrierProvider = easyPost({ apiKey: over.mode === 'production' ? 'EZAK_made_up' : 'EZTK_made_up', webhookSecret: secret, fetchImpl, timeoutMs: over.timeoutMs })
  /** Signs a body the way EasyPost does, for webhook tests. */
  const sign = (raw: string) => `hmac-sha256-hex=${createHmac('sha256', String(secret).normalize('NFKD')).update(raw, 'utf8').digest('hex')}`
  return { provider: { ...provider, name: 'fake' }, calls, shipments, sign }
}
