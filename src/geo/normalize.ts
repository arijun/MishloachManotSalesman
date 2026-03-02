/**
 * Address normalization helpers.
 *
 * City inference rule: if a raw address appears to have fewer than two
 * comma-separated components (e.g. "123 Oak St"), or the second component
 * looks like only a state abbreviation or zip code, append the city and state
 * from the start address.
 */

const STATE_ABBR_RE = /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/;
const ZIP_ONLY_RE   = /^\d{5}(-\d{4})?$/;

export function inferCityState(startAddress: string): { city: string; state: string } {
  // Expect "..., City, ST" or "..., City, ST ZIP"
  const parts = startAddress.split(',').map(p => p.trim());
  if (parts.length >= 3) {
    const statePart = parts[parts.length - 1].trim().split(/\s+/)[0]; // first token = state abbr
    const city = parts[parts.length - 2].trim();
    return { city, state: statePart };
  }
  if (parts.length === 2) {
    return { city: parts[1].trim(), state: '' };
  }
  return { city: '', state: '' };
}

export function needsCityInjection(address: string): boolean {
  const parts = address.split(',').map(p => p.trim());
  if (parts.length < 2) return true;
  const second = parts[1];
  // Only a state abbreviation or zip on the second comma-part → missing city
  if (STATE_ABBR_RE.test(second) || ZIP_ONLY_RE.test(second)) return true;
  return false;
}

export function normalizeAddress(
  rawAddress: string,
  cityState: { city: string; state: string },
): string {
  if (!needsCityInjection(rawAddress)) return rawAddress.trim();
  const { city, state } = cityState;
  const suffix = [city, state].filter(Boolean).join(', ');
  return suffix ? `${rawAddress.trim()}, ${suffix}` : rawAddress.trim();
}
