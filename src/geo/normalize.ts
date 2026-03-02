/**
 * Address normalization helpers.
 */

// ── City injection ────────────────────────────────────────────────────
//
// Rule: only inject city+state when:
//   • The address has NO commas at all ("123 Oak St") — definitely bare street
//   • OR exactly 2 comma-parts and the second is a bare state abbreviation
//     ("123 Oak St, WA") — clearly missing city
//
// We do NOT inject when the second part is "WA 98118" (state+zip), because
// that format means the city is embedded in the first part ("Street City, ST ZIP"),
// which is very common in Seattle-area addresses pasted from web sources.

const STATE_ALONE_RE = /^[A-Z]{2}$/;

export function inferCityState(startAddress: string): { city: string; state: string } {
  const parts = startAddress.split(',').map(p => p.trim());
  if (parts.length >= 3) {
    const statePart = parts[parts.length - 1].trim().split(/\s+/)[0];
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
  // No commas → bare street address, definitely needs city
  if (parts.length === 1) return true;
  // 3+ parts → has enough structure (Street, City, State or similar)
  if (parts.length >= 3) return false;
  // 2 parts: only inject when second part is a bare state abbreviation ("WA"),
  // not "WA 98118" (state+zip means city is embedded in first part).
  return STATE_ALONE_RE.test(parts[1]);
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
