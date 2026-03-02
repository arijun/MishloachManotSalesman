import type { Coords } from '../types.ts';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const PHOTON_URL    = 'https://photon.komoot.io/api/';
const RATE_LIMIT_MS = 1100; // slightly over 1 s to be safe

export interface GeocoderResult {
  coords: Coords;
  /** Human-readable description of what the geocoder resolved the address to.
   *  Shown in the review table so users can catch mismatches. */
  displayName: string;
}

export type GeocoderProgressCallback = (done: number, total: number) => void;

// ── Unit number stripping ─────────────────────────────────────────────
//
// Unit numbers (#303, Apt 4, Suite 2B, etc.) are not needed for geocoding
// the building location and actively break Nominatim/Photon queries.
// Strip them before sending the query, but preserve them for display.

const UNIT_RE    = /\s*,?\s*(?:apt\.?|suite|ste\.?|unit|no\.?|apartment)\s+[\w-]+/gi;
const HASH_RE    = /\s*#\s*[\w-]+/g;
const ORDINAL_RE = /^(?:st|nd|rd|th)$/i;

/**
 * Strip unit numbers and house-number letter suffixes before geocoding.
 * These confuse Nominatim/Photon without contributing to location accuracy.
 *
 * Examples:
 *   "7322 Rainier Ave S #303 Seattle, WA"  → "7322 Rainier Ave S Seattle, WA"
 *   "4846A S Morgan St Seattle, WA"         → "4846 S Morgan St Seattle, WA"
 *   "123 Main St Apt 4B, Seattle, WA"       → "123 Main St, Seattle, WA"
 *   "1st Ave N, Seattle, WA"                → unchanged (ordinal preserved)
 */
export function stripUnitForGeocoding(address: string): string {
  return address
    .replace(UNIT_RE, '')
    .replace(HASH_RE, '')
    // Strip letter suffix immediately after leading house number: "4846A " → "4846 "
    // but keep ordinals ("1st", "2nd", "3rd", "4th")
    .replace(/^(\d+)([A-Za-z]{1,2})(?=[\s,])/, (_, num: string, suffix: string) =>
      ORDINAL_RE.test(suffix) ? num + suffix : num,
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Nominatim ─────────────────────────────────────────────────────────

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  place_rank: number; // 30=house, 26=road, <26=area/city/etc.
  address?: { house_number?: string };
}

async function geocodeNominatim(
  rawAddress: string,
): Promise<GeocoderResult | null> {
  const query = stripUnitForGeocoding(rawAddress);
  const houseNumber = extractHouseNumber(query);

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
  });
  let res: Response;
  try {
    res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'Accept-Language': 'en' },
    });
  } catch { return null; }

  if (!res.ok) return null;
  const data = await res.json() as NominatimResult[];
  if (data.length === 0) return null;

  const result = data[0];

  // Reject low-confidence results: if we searched for a specific house number
  // but got back a street (place_rank 26) or higher-level area, don't trust it.
  if (houseNumber && result.place_rank < 28) return null;

  // Also reject if the returned house number doesn't match what we asked for.
  if (
    houseNumber &&
    result.address?.house_number &&
    result.address.house_number !== houseNumber
  ) return null;

  return {
    coords: { lat: parseFloat(result.lat), lng: parseFloat(result.lon) },
    displayName: result.display_name,
  };
}

// ── Photon ────────────────────────────────────────────────────────────

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    housenumber?: string;
    street?: string;
    name?: string;
    city?: string;
    state?: string;
    postcode?: string;
    type?: string;   // "house", "street", "locality", etc.
    osm_type?: string;
  };
}

function buildPhotonDisplayName(p: PhotonFeature['properties']): string {
  return [
    p.housenumber && p.street ? `${p.housenumber} ${p.street}` : (p.name ?? p.street ?? ''),
    p.city,
    p.state,
    p.postcode,
  ].filter(Boolean).join(', ');
}

async function geocodePhoton(
  rawAddress: string,
): Promise<GeocoderResult | null> {
  const query = stripUnitForGeocoding(rawAddress);
  const houseNumber = extractHouseNumber(query);

  const params = new URLSearchParams({ q: query, limit: '3', lang: 'en' });
  let res: Response;
  try {
    res = await fetch(`${PHOTON_URL}?${params}`);
  } catch { return null; }

  if (!res.ok) return null;
  const data = await res.json() as { features: PhotonFeature[] };
  if (!data.features || data.features.length === 0) return null;

  // When we searched for a specific house number, prefer results that have a
  // matching housenumber. Intersection/street results (no housenumber) are
  // only acceptable if the query itself had no house number.
  for (const feature of data.features) {
    const props = feature.properties;
    if (houseNumber) {
      // Skip street/intersection results — they have no housenumber
      if (!props.housenumber) continue;
      // Optionally verify number matches (handles "7322" vs "7320" near-misses)
      if (props.housenumber !== houseNumber) continue;
    }
    const [lng, lat] = feature.geometry.coordinates;
    return { coords: { lat, lng }, displayName: buildPhotonDisplayName(props) };
  }

  // If no house-level result was found, return null rather than a wrong intersection.
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Extract leading house number from an address string, e.g. "7322" from "7322 Rainier Ave S". */
function extractHouseNumber(address: string): string | null {
  const match = /^\s*(\d+)/.exec(address);
  return match ? match[1] : null;
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Geocode a single address, trying Nominatim first then Photon.
 * Unit numbers are stripped before querying; the original address is preserved
 * for display. Returns null if neither service can confidently resolve it.
 */
export async function geocodeAddress(address: string): Promise<GeocoderResult | null> {
  const result = await geocodeNominatim(address);
  if (result) return result;
  await delay(500);
  return geocodePhoton(address);
}

/**
 * Geocode a list of addresses sequentially at ≤1 req/s (Nominatim policy).
 */
export async function geocodeBatch(
  addresses: string[],
  onProgress?: GeocoderProgressCallback,
): Promise<(GeocoderResult | null)[]> {
  const results: (GeocoderResult | null)[] = [];

  for (let i = 0; i < addresses.length; i++) {
    const start = Date.now();
    results.push(await geocodeAddress(addresses[i]));
    onProgress?.(i + 1, addresses.length);

    const elapsed = Date.now() - start;
    if (i < addresses.length - 1 && elapsed < RATE_LIMIT_MS) {
      await delay(RATE_LIMIT_MS - elapsed);
    }
  }

  return results;
}
