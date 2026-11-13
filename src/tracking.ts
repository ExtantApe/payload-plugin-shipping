import type { TrackerStatus } from './types.js'

/** The carrier's public tracking page for a number. UPS numbers start with 1Z; everything else is taken as USPS. */
export function trackingLink(number: string, carrier?: string | null): string {
  const n = number.replace(/\s/g, '').toUpperCase()
  if (carrier?.toUpperCase() === 'UPS' || (!carrier && /^1Z[0-9A-Z]{16}$/.test(n))) return `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`
  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`
}

export type ShipmentEvent = 'out-for-delivery' | 'delivered' | 'exception'

/** Which customer notice a carrier status means, if any. "Available for pickup" is delivered to a PO Box or General Delivery. */
export function noticeFor(status: TrackerStatus): ShipmentEvent | null {
  if (status === 'out_for_delivery') return 'out-for-delivery'
  if (status === 'delivered' || status === 'available_for_pickup') return 'delivered'
  if (status === 'return_to_sender' || status === 'failure' || status === 'error') return 'exception'
  return null
}

/** USPS refund window for an unused label, in days. */
export const USPS_REFUND_DAYS = 30
