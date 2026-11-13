import type { Payload } from 'payload'

import { labelAddress, type LabelAddress, type StoredAddress } from './address.js'
import { CarrierError } from './easypost.js'
import type { ExternalAction, Label, Parcel, Quote, RefundStatus, Req, Resolved, Verification } from './types.js'

const configOf = (payload: Payload): Resolved => {
  const o = payload.config.custom?.shipping as Resolved | undefined
  if (!o) throw new Error('Shipping: the plugin is not configured on this site.')
  return o
}

/**
 * Every call that costs money or reaches the carrier passes the site's `beforeExternalCall` first; if it throws, the
 * call doesn't happen. With no hook, test mode is allowed and production mode is refused: the plugin fails closed.
 */
async function guard(payload: Payload, action: ExternalAction, req?: Req) {
  const o = configOf(payload)
  const mode = o.provider.mode
  if (!mode) throw new CarrierError(0, 'NO_KEY', 'Shipping isn’t set up here.')
  if (o.beforeExternalCall) await o.beforeExternalCall({ action, mode, req })
  else if (mode === 'production') throw new CarrierError(0, 'REFUSED', 'Live postage needs the site’s go-ahead (beforeExternalCall), which isn’t set.')
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

export async function buy(payload: Payload, q: Quote, req?: Req): Promise<Label> {
  await guard(payload, 'buy', req)
  return configOf(payload).provider.buy(q)
}

/** A quote and a purchase. Both addresses always come from the caller: never the carrier account's defaults. */
export async function buyLabel(payload: Payload, input: { from: LabelAddress; to: LabelAddress; parcel: Parcel; carrier?: 'any' | 'USPS'; reference: string }, req?: Req): Promise<Label> {
  // Both checks before anything leaves: a refused purchase costs no quote. The hook sees each action once.
  await guard(payload, 'buy', req)
  await guard(payload, 'quote', req)
  const provider = configOf(payload).provider
  return provider.buy(await provider.quote({ ...input, carrier: carrierFor(input) }))
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
