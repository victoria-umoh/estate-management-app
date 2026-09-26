/**
 * Naira in the form, kobo on the wire.
 *
 * Parsed as a string rather than with `parseFloat(x) * 100`, because 0.29 * 100
 * is 28.999999999999996 in floating point and the API rightly refuses anything
 * that is not a whole number of minor units. A typed "1,250.5" becomes 125050
 * exactly, or null when it is not an amount at all.
 */
export function parseMoney(input: string): number | null {
  const cleaned = input.replace(/[₦,\s]/g, '');
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;

  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * 100 + fraction;
}

/** Kobo back to what someone would type: 125050 → "1250.50", 500000 → "5000". */
export function minorToInput(minorUnits: number): string {
  const whole = Math.floor(minorUnits / 100);
  const fraction = minorUnits % 100;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, '0')}`;
}

/** Minor units in, naira out. Division happens here and nowhere near the data. */
export function formatMoney(minorUnits: number, exact = false): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'NGN',
    // Whole naira for the ledger's headline figures; kobo where someone is
    // about to type or confirm an exact amount.
    minimumFractionDigits: exact ? 2 : 0,
    maximumFractionDigits: exact ? 2 : 0,
  }).format(minorUnits / 100);
}
