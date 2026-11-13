import { createHash } from 'node:crypto'

/**
 * Mailing addresses for labels (kits plan §6, owner 2026-11-09). A hub's address is one of three
 * kinds, switchable in the admin without a code change:
 * - street: a street address (also a private mailbox at a mail store, which is street-style);
 * - po-box: a USPS PO Box, with no street;
 * - general-delivery: USPS General Delivery at a post office: "GENERAL DELIVERY" as the street line and
 *   the office's ZIP+4 ending in -9999. Mail waits there about 30 days, so returns need prompt pickup.
 * PO Box and General Delivery take USPS only. Labels always carry the address from the record, never
 * a carrier account's default. Names and addresses live in the database only.
 */

export const ADDRESS_KINDS = ['street', 'po-box', 'general-delivery'] as const
export type AddressKind = (typeof ADDRESS_KINDS)[number]

export type StoredAddress = {
  kind?: AddressKind | null
  /** The recipient line, e.g. a person's name. */
  name?: string | null
  /** The "C/O" line: the company the mail is in care of. */
  company?: string | null
  line1?: string | null
  line2?: string | null
  poBox?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
  phone?: string | null
}

/** What a label needs (EasyPost's address shape). */
export type LabelAddress = { name: string; company: string | null; street1: string; street2: string | null; city: string; state: string; zip: string; country: 'US'; phone: string | null }

export type AddressProblem = 'placeholder' | 'name' | 'street' | 'poBox' | 'city' | 'state' | 'zip' | 'gdZip'

const clean = (v?: string | null) => (v ?? '').trim()
const ZIP = /^\d{5}(-\d{4})?$/

/** Why this address can't go on a label, or an empty list. */
export function addressProblems(a: StoredAddress | null | undefined, opts: { placeholder?: boolean | null } = {}): AddressProblem[] {
  const out: AddressProblem[] = []
  if (opts.placeholder) out.push('placeholder')
  const kind = a?.kind ?? 'street'
  // A PO Box or General Delivery item is only handed to the named person.
  if (kind !== 'street' && !clean(a?.name)) out.push('name')
  if (kind === 'street' && !clean(a?.line1)) out.push('street')
  if (kind === 'po-box' && !/^\d{1,10}$/.test(clean(a?.poBox).replace(/^(PO\s*BOX\s*)/i, ''))) out.push('poBox')
  if (!clean(a?.city)) out.push('city')
  if (!/^[A-Z]{2}$/i.test(clean(a?.state))) out.push('state')
  const zip = clean(a?.postalCode)
  if (!ZIP.test(zip)) out.push('zip')
  else if (kind === 'general-delivery' && !/^\d{5}-9999$/.test(zip)) out.push('gdZip')
  return out
}

/** The address as it goes on a label. Refuses an address with problems: no label to a guessed address. */
export function labelAddress(a: StoredAddress | null | undefined, opts: { placeholder?: boolean | null } = {}): LabelAddress {
  const problems = addressProblems(a, opts)
  if (problems.length) throw new AddressError(problems)
  const kind = a!.kind ?? 'street'
  const street1 = kind === 'po-box' ? `PO BOX ${clean(a!.poBox).replace(/^(PO\s*BOX\s*)/i, '')}` : kind === 'general-delivery' ? 'GENERAL DELIVERY' : clean(a!.line1)
  return {
    name: clean(a!.name) || clean(a!.company),
    company: clean(a!.company) ? `C/O ${clean(a!.company).replace(/^C\/O\s*/i, '')}` : null,
    street1,
    // PO Box and General Delivery have no street; a second line would confuse the carrier.
    street2: kind === 'street' ? clean(a!.line2) || null : null,
    city: clean(a!.city),
    state: clean(a!.state).toUpperCase(),
    zip: clean(a!.postalCode),
    country: 'US',
    phone: clean(a!.phone) || null,
  }
}

/**
 * A short fingerprint of where a label sends mail, so a label made for an older hub address can be
 * found after the address changes. Only the delivery fields count, not the phone.
 */
export function addressKey(a: LabelAddress): string {
  const fields = [a.name, a.company ?? '', a.street1, a.street2 ?? '', a.city, a.state, a.zip].map((f) => f.trim().toUpperCase().replace(/\s+/g, ' '))
  return createHash('sha256').update(fields.join('|')).digest('hex').slice(0, 16)
}

/** Carriers allowed to deliver to this kind of address. */
export const carriersFor = (kind: AddressKind | null | undefined): 'any' | 'USPS' => (kind && kind !== 'street' ? 'USPS' : 'any')

export class AddressError extends Error {
  constructor(readonly problems: AddressProblem[]) {
    super(`The address can't go on a label: ${problems.join(', ')}.`)
  }
}
