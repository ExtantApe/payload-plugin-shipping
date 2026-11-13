import type { Payload, PayloadRequest } from 'payload'

import type { LabelAddress } from './address.js'

export type Req = Partial<PayloadRequest>
export type Mode = 'test' | 'production'
export type Parcel = { weightOz: number; lengthIn?: number | null; widthIn?: number | null; heightIn?: number | null }
export type Rate = { id: string; carrier: string; service: string; rate: string; fake?: boolean }
export type Quote = { shipmentId: string; rate: Rate; rateCents: number; mode: Mode; fake?: boolean }
export type Label = { shipmentId: string; tracking: string; carrier: string; service: string; rateCents: number; labelUrl: string; trackerUrl: string | null; mode: Mode; fake?: boolean }
export type RefundStatus = 'submitted' | 'refunded' | 'rejected' | 'not_applicable'
export type Verification = { ok: boolean; errors: string[]; corrected: { street1?: string; zip?: string } | null }

export type TrackerStatus = 'unknown' | 'pre_transit' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'available_for_pickup' | 'return_to_sender' | 'failure' | 'cancelled' | 'error'
export type TrackerEvent = { id: string; createdAt: string; tracking: string; status: TrackerStatus; carrier: string | null; publicUrl: string | null }
export type RefundEvent = { id: string; createdAt: string; tracking: string; status: RefundStatus }

/** What a carrier provider does. EasyPost is the first; the fake one is for tests. */
export type CarrierProvider = {
  name: string
  /** test or production, from the key. Null when not set up. */
  mode: Mode | null
  verify: (a: LabelAddress) => Promise<Verification>
  quote: (input: { from: LabelAddress; to: LabelAddress; parcel: Parcel; carrier?: 'any' | 'USPS'; reference: string }) => Promise<Quote>
  buy: (quote: Quote) => Promise<Label>
  refund: (shipmentId: string) => Promise<RefundStatus>
  /** Webhooks: is this raw body signed by the carrier, and what does it say? */
  webhook?: {
    configured: boolean
    /** Is the raw body signed by the carrier? Answer exactly `true` (or a promise of it) for yes; anything else, a throw included, is a 401. */
    verify: (raw: string, headers: Headers) => boolean | Promise<boolean>
    parse: (raw: string) => { tracker?: TrackerEvent; refund?: RefundEvent } | null
  }
}

export type ExternalAction = 'verify' | 'quote' | 'buy' | 'refund'

/** An owner's handler for webhook events. Must be idempotent: carriers retry. 'unknown' when it isn't theirs. */
export type ShippingHandler = {
  owner: string
  onTracker?: (args: { event: TrackerEvent; req: PayloadRequest; payload: Payload }) => Promise<'handled' | 'unknown'>
  onRefund?: (args: { event: RefundEvent; req: PayloadRequest; payload: Payload }) => Promise<'handled' | 'unknown'>
}

export type ShippingOptions = {
  provider: CarrierProvider
  /** A root endpoint path. Default '/easypost/webhook', so it serves /api/easypost/webhook. */
  webhookPath?: string
  /** Runs before every call that costs money or reaches the carrier. Throw to refuse. Without it, production mode is refused. */
  beforeExternalCall?: (args: { action: ExternalAction; mode: Mode; req?: Req }) => void | Promise<void>
  handlers?: ShippingHandler[]
  /** Events older than this are ignored, so a captured body can't be replayed later. Default 7. */
  maxEventAgeDays?: number
}

export type Resolved = Required<Pick<ShippingOptions, 'provider' | 'webhookPath' | 'maxEventAgeDays'>> & { beforeExternalCall?: ShippingOptions['beforeExternalCall']; handlers: ShippingHandler[] }
