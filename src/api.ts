import type { CollectionSlug, Payload } from 'payload'

import { labelAddress, type LabelAddress, type StoredAddress } from './address.js'
import { CarrierError, maybeBought, reconcileSteps } from './easypost.js'
import { PURCHASES_SLUG } from './plugin.js'
import type { ExternalAction, Label, Parcel, Quote, RefundStatus, Req, Resolved, Verification } from './types.js'

const configOf = (payload: Payload): Resolved => {
  const o = payload.config.custom?.shipping as Resolved | undefined
  if (!o) throw new Error('Shipping: the plugin is not configured on this site.')
  return o
}

/**
 * Every call that costs money or reaches the carrier passes the site's `beforeExternalCall` first, and goes ahead only
 * when the hook answers exactly `true` (or a promise of it). Any other answer refuses the call: `false`, nothing at
 * all, `1`, `'yes'`, an object, a throw or a rejected promise. With no hook, test mode is allowed and production mode
 * is refused: the plugin fails closed.
 */
async function guard(payload: Payload, action: ExternalAction, req?: Req) {
  const o = configOf(payload)
  const mode = o.provider.mode
  if (!mode) throw new CarrierError(0, 'NO_KEY', 'Shipping isn’t set up here.')
  if (o.beforeExternalCall != null) {
    // A throw or a rejection carries the site's own reason out to the caller, and nothing is sent.
    const answer: unknown = await o.beforeExternalCall({ action, mode, req })
    if (answer !== true) throw new CarrierError(0, 'REFUSED', 'The site’s go-ahead (beforeExternalCall) didn’t answer exactly true, so nothing was sent to the carrier.')
  } else if (mode === 'production') throw new CarrierError(0, 'REFUSED', 'Live postage needs the site’s go-ahead (beforeExternalCall), which isn’t set.')
}

export async function verifyAddress(payload: Payload, a: LabelAddress, req?: Req): Promise<Verification> {
  await guard(payload, 'verify', req)
  return configOf(payload).provider.verify(a)
}

/** PO Box and General Delivery take USPS only, whatever the caller asked: the label addresses say which they are. */
const USPS_ONLY = /^(PO BOX\b|GENERAL DELIVERY$)/i
const carrierFor = (input: { from: LabelAddress; to: LabelAddress; carrier?: 'any' | 'USPS' }): 'any' | 'USPS' =>
  input.carrier === 'USPS' || [input.from, input.to].some((a) => USPS_ONLY.test(a.street1.trim())) ? 'USPS' : 'any'

export async function quote(payload: Payload, input: { from: LabelAddress; to: LabelAddress; parcel: Parcel; carrier?: 'any' | 'USPS'; reference: string }, req?: Req): Promise<Quote> {
  await guard(payload, 'quote', req)
  return configOf(payload).provider.quote({ ...input, carrier: carrierFor(input) })
}

const PURCHASES = PURCHASES_SLUG as CollectionSlug
type Purchase = { id: string | number; status?: 'buying' | 'bought' | 'unknown' | null; label?: Label | null }

/**
 * Buy each quote once. The quote is claimed first, as a record with a unique key, and the carrier is called only by
 * the caller whose claim went in. Everyone else gets the first label when there is one, and is refused otherwise,
 * with nothing sent. The claim is written outside any transaction of the caller's, so rolling that back can't free a
 * quote whose label was bought.
 *
 * - bought: the first label again;
 * - being bought right now, or interrupted before the answer was recorded: `BUY_IN_PROGRESS`;
 * - outcome unknown (a timeout, a dropped connection, a 408, 429 or 5xx): `MAYBE_BOUGHT`, and the quote stays locked;
 * - a clear refusal from the carrier: nothing was bought, so the claim is removed and the quote can be tried again;
 * - the claim can't be stored: `NOT_CLAIMED`, and nothing is sent.
 */
async function buyOnce(payload: Payload, q: Quote): Promise<Label> {
  const provider = configOf(payload).provider
  const shipmentId = typeof q?.shipmentId === 'string' ? q.shipmentId.trim() : ''
  if (!shipmentId || !q.rate?.id) throw new CarrierError(0, 'BAD_QUOTE', 'This quote has no shipment or rate, so it can’t be bought. Get a new quote.')
  // One label per shipment: the rate isn't in the key, so a second rate on the same shipment can't buy a second label.
  const quoteKey = `${provider.name}:${provider.mode}:${shipmentId}`
  const held = async (limit: number) => (await payload.find({ collection: PURCHASES, where: { quoteKey: { equals: quoteKey } }, limit, depth: 0, pagination: false })).docs as unknown as Purchase[]
  const inProgress = () => new CarrierError(0, 'BUY_IN_PROGRESS', `This quote is already being bought, or a purchase of it was interrupted, so nothing was sent to the carrier. If this doesn’t clear in a minute, the label may have been bought. ${reconcileSteps(shipmentId)}`, shipmentId)
  const notClaimed = () => new CarrierError(0, 'NOT_CLAIMED', 'The purchase couldn’t be recorded, so nothing was sent to the carrier. Nothing was bought; try again.', shipmentId)

  let claim: Purchase
  try {
    claim = (await payload.create({ collection: PURCHASES, data: { quoteKey, status: 'buying', shipmentId } as never, depth: 0, disableTransaction: true })) as unknown as Purchase
  } catch {
    // Either the quote is already claimed (the unique key refused this one) or the record couldn't be written.
    const first = (await held(1).catch(() => []))[0]
    if (!first) throw notClaimed()
    if (first.status === 'bought' && first.label) return first.label
    if (first.status === 'unknown') throw maybeBought('an earlier purchase of this quote got no clear answer', shipmentId, 'The carrier')
    throw inProgress()
  }
  // Belt and braces, for a database whose unique index isn't built yet: anyone who sees a second claim steps back.
  const claims = await held(2).catch(() => null)
  if (!claims || claims.length !== 1) {
    await payload.delete({ collection: PURCHASES, id: claim.id, depth: 0, disableTransaction: true }).catch(() => undefined)
    throw claims ? inProgress() : notClaimed()
  }

  const record = (data: Record<string, unknown>) =>
    payload.update({ collection: PURCHASES, id: claim.id, data: data as never, depth: 0, disableTransaction: true }).catch((error: unknown) => {
      // The claim stays as it was, which still locks the quote.
      payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'shipping: a purchase’s outcome couldn’t be recorded; its quote stays locked' })
    })
  let label: Label
  try {
    label = await provider.buy(q)
  } catch (error) {
    if (error instanceof CarrierError && error.code !== 'MAYBE_BOUGHT') {
      // A clear refusal: nothing was bought. If the claim can't be removed it stays, and the quote stays locked.
      await payload.delete({ collection: PURCHASES, id: claim.id, depth: 0, disableTransaction: true }).catch(() => undefined)
      throw error
    }
    await record({ status: 'unknown' })
    // An error that isn't the provider's own says nothing about the purchase, so it's unknown too.
    throw error instanceof CarrierError && error.shipmentId ? error : maybeBought('UNKNOWN', shipmentId, 'The carrier')
  }
  await record({ status: 'bought', label })
  return label
}

/**
 * Buys a quote's label, once. A second call with the same quote answers the first label without calling the carrier,
 * and calls made at the same moment end in one purchase. See `buyOnce` for each answer.
 */
export async function buy(payload: Payload, q: Quote, req?: Req): Promise<Label> {
  await guard(payload, 'buy', req)
  return buyOnce(payload, q)
}

/** A quote and a purchase. Both addresses always come from the caller: never the carrier account's defaults. */
export async function buyLabel(payload: Payload, input: { from: LabelAddress; to: LabelAddress; parcel: Parcel; carrier?: 'any' | 'USPS'; reference: string }, req?: Req): Promise<Label> {
  // Both checks before anything leaves: a refused purchase costs no quote. The hook sees each action once.
  await guard(payload, 'buy', req)
  await guard(payload, 'quote', req)
  return buyOnce(payload, await configOf(payload).provider.quote({ ...input, carrier: carrierFor(input) }))
}

/**
 * A return label from the customer to a hub, written out from the hub's record, USPS only (PO Box and General
 * Delivery take nothing else). Refuses a placeholder or incomplete hub address, and any other carrier.
 */
export async function buyReturn(payload: Payload, input: { customer: LabelAddress; hub: { address?: StoredAddress | null; placeholder?: boolean | null }; parcel: Parcel; carrier?: string; reference: string }, req?: Req): Promise<Label> {
  if (input.carrier && input.carrier.toUpperCase() !== 'USPS') throw new CarrierError(0, 'USPS_ONLY', 'Return labels are USPS only.')
  const to = labelAddress(input.hub.address, { placeholder: input.hub.placeholder })
  return buyLabel(payload, { from: input.customer, to, parcel: input.parcel, carrier: 'USPS', reference: input.reference }, req)
}

export async function quoteReturn(payload: Payload, input: { customer: LabelAddress; hub: { address?: StoredAddress | null; placeholder?: boolean | null }; parcel: Parcel; reference: string }, req?: Req): Promise<Quote> {
  const to = labelAddress(input.hub.address, { placeholder: input.hub.placeholder })
  return quote(payload, { from: input.customer, to, parcel: input.parcel, carrier: 'USPS', reference: input.reference }, req)
}

/** Ask for an unused label's money back (USPS: within 30 days, never scanned). */
export async function refund(payload: Payload, shipmentId: string, req?: Req): Promise<RefundStatus> {
  await guard(payload, 'refund', req)
  return configOf(payload).provider.refund(shipmentId)
}
