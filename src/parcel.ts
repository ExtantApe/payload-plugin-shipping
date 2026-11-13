/** A parcel's outside size, in inches, and its weight, in ounces. */
export type ParcelSize = { lengthIn: number; widthIn: number; heightIn: number; weightOz: number }

/**
 * A box holding some contents: its outside size, longest side first, and its weight. The box's own weight and the
 * contents' weight come from the caller, who knows what's in it.
 */
export function parcelFor(box: { outside: [number, number, number] | null; emptyWeightOz?: number | null }, contentsWeightOz: number): ParcelSize | null {
  if (!box.outside) return null
  const [lengthIn, widthIn, heightIn] = [...box.outside].sort((a, b) => b - a) as [number, number, number]
  return { lengthIn, widthIn, heightIn, weightOz: Math.round(((box.emptyWeightOz ?? 0) + contentsWeightOz) * 10) / 10 }
}

/** USPS dimensional weight in pounds (volume ÷ 139), which counts only past one cubic foot. */
export function dimWeightLb(p: ParcelSize): number {
  return (Math.round(p.lengthIn) * Math.round(p.widthIn) * Math.round(p.heightIn)) / 139
}

/** The weight USPS charges for, in whole pounds: the actual weight, or the dimensional weight past 1 cu ft. */
export function billableLb(p: ParcelSize): number {
  const actual = p.weightOz / 16
  const cubic = Math.round(p.lengthIn) * Math.round(p.widthIn) * Math.round(p.heightIn)
  return Math.max(1, Math.ceil(cubic > 1728 ? Math.max(actual, dimWeightLb(p)) : actual))
}

/**
 * What USPS's rules say about a parcel (DMM 101, 223 and 283): too big or too heavy to mail, the nonstandard fees,
 * dimensional weight past one cubic foot. Plain words; the fee amounts come from the rates.
 */
export function mailability(p: ParcelSize): { mailable: boolean; notes: string[] } {
  const [l, w, h] = [p.lengthIn, p.widthIn, p.heightIn].sort((a, b) => b - a) as [number, number, number]
  const girth = 2 * (w + h)
  const cubicIn = Math.round(l) * Math.round(w) * Math.round(h)
  const notes: string[] = []
  let mailable = true
  if (p.weightOz > 70 * 16) {
    mailable = false
    notes.push('over 70 lb: too heavy to mail')
  }
  if (l + girth > 130) {
    mailable = false
    notes.push('over 130 in length plus girth: too big to mail')
  } else if (l + girth > 108) notes.push('over 108 in length plus girth: oversized')
  if (l > 30) notes.push('over 30 in long: nonstandard fee')
  else if (l > 22) notes.push('over 22 in long: nonstandard fee')
  if (cubicIn > 3456) notes.push('over 2 cubic feet: nonstandard fee')
  if (cubicIn > 1728) notes.push(`over 1 cubic foot: dimensional weight (${Math.ceil(dimWeightLb(p))} lb)`)
  return { mailable, notes }
}
