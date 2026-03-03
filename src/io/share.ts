/**
 * URL-based route sharing.
 *
 * Encodes a fully-computed route into a base64url string placed in the URL
 * hash as `#route=<encoded>`. No server or database required.
 *
 * The hash is updated in-place (history.replaceState) whenever the driver
 * marks a delivery, so the current URL always reflects the latest state and
 * can be copied and shared at any moment.
 *
 * Schema: compact JSON with short keys to minimise URL length.
 *   v    — schema version (currently 1)
 *   dep  — departure time "HH:MM"
 *   s    — start depot {a, la, lo}
 *   e    — end depot (omitted when same as start)
 *   st   — delivery stops in optimised order
 *   seg  — segment drive times in seconds [depot→0, 0→1, …, N→endDepot]
 *
 * Each stop (st[]):
 *   n    — name
 *   a    — normalizedAddress
 *   r    — rawAddress (omitted when equal to a)
 *   p    — phone (omitted when empty)
 *   t    — notes (omitted when empty)
 *   la   — latitude  (5 decimal places ≈ 1 m precision)
 *   lo   — longitude
 *   dv   — delivered: present and 1 when true, omitted otherwise
 */

import type { RouteResult, Stop, Depot, Segment, StopStatus } from '../types.ts';

const SCHEMA_VERSION = 1;

// ── Compact serialized types ──────────────────────────────────────────

interface SDepot  { a: string; la: number; lo: number; }
interface SStop   { n: string; a: string; r?: string; p?: string; t?: string; la: number; lo: number; dv?: 1; }

interface Payload {
  v:    number;
  dep:  string;
  s:    SDepot;
  e?:   SDepot;
  st:   SStop[];
  seg:  number[];
}

// ── Helpers ───────────────────────────────────────────────────────────

function r5(n: number): number { return Math.round(n * 1e5) / 1e5; }

function toBase64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64url(s: string): string {
  // Re-pad and restore standard base64 chars
  const pad = s.length % 4;
  const padded = pad ? s + '='.repeat(4 - pad) : s;
  return atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Encode a computed route into a base64url string suitable for `#route=…`.
 * @param deliveredIds  Set of stop IDs the driver has marked as delivered.
 */
export function encodeRoute(
  route:        RouteResult,
  departureTime: string,
  deliveredIds: ReadonlySet<string>,
): string {
  const all   = route.orderedStops;
  const start = all[0]  as Depot;
  const end   = all[all.length - 1] as Depot;

  const toSD = (d: Depot): SDepot => ({
    a:  d.normalizedAddress,
    la: r5(d.coords.lat),
    lo: r5(d.coords.lng),
  });

  const stops: SStop[] = all.slice(1, -1).map(node => {
    const s = node as Stop;
    const out: SStop = { n: s.name, a: s.normalizedAddress, la: r5(s.coords!.lat), lo: r5(s.coords!.lng) };
    if (s.rawAddress !== s.normalizedAddress) out.r = s.rawAddress;
    if (s.phone) out.p = s.phone;
    if (s.notes) out.t = s.notes;
    if (deliveredIds.has(s.id))              out.dv = 1;
    return out;
  });

  const sameDepot =
    start.normalizedAddress === end.normalizedAddress &&
    start.coords.lat === end.coords.lat;

  const payload: Payload = {
    v:   SCHEMA_VERSION,
    dep: departureTime,
    s:   toSD(start),
    st:  stops,
    seg: route.segments.map(seg => Math.round(seg.durationSec)),
  };
  if (!sameDepot) payload.e = toSD(end);

  return toBase64url(encodeURIComponent(JSON.stringify(payload)));
}

export interface DecodedRoute {
  route:         RouteResult;
  departureTime: string;
  deliveredIds:  Set<string>;
}

/**
 * Decode a `#route=…` value back into a RouteResult.
 * Returns null if the string is malformed or has an incompatible schema version.
 */
export function decodeRoute(encoded: string): DecodedRoute | null {
  let payload: Payload;
  try {
    payload = JSON.parse(decodeURIComponent(fromBase64url(encoded))) as Payload;
  } catch {
    return null;
  }
  if (payload.v !== SCHEMA_VERSION) return null;

  const toDepot = (sd: SDepot): Depot => ({
    rawAddress:        sd.a,
    normalizedAddress: sd.a,
    coords:            { lat: sd.la, lng: sd.lo },
  });

  const startDepot = toDepot(payload.s);
  const endDepot   = payload.e ? toDepot(payload.e) : startDepot;

  const deliveredIds = new Set<string>();
  const stops: Stop[] = payload.st.map((s, i) => {
    const id = String(i);
    if (s.dv) deliveredIds.add(id);
    return {
      id,
      name:              s.n,
      normalizedAddress: s.a,
      rawAddress:        s.r ?? s.a,
      phone:             s.p ?? '',
      notes:             s.t ?? '',
      coords:            { lat: s.la, lng: s.lo },
      status:            'ok' as const,
    };
  });

  const orderedStops = [startDepot, ...stops, endDepot];

  const segments: Segment[] = orderedStops.slice(0, -1).map((from, i) => ({
    from,
    to:          orderedStops[i + 1],
    durationSec: payload.seg[i] ?? 0,
  }));

  const route: RouteResult = {
    orderedStops,
    durationMatrix: [], // not needed for display
    totalDurationSec: payload.seg.reduce((a, b) => a + b, 0),
    segments,
  };

  return { route, departureTime: payload.dep, deliveredIds };
}

// ── Hash helpers ──────────────────────────────────────────────────────

const HASH_PREFIX = '#route=';

export function getSharedHash(): string | null {
  const h = window.location.hash;
  return h.startsWith(HASH_PREFIX) ? h.slice(HASH_PREFIX.length) : null;
}

export function setRouteHash(encoded: string): void {
  history.replaceState(null, '', HASH_PREFIX + encoded);
}

// ── Review state sharing ───────────────────────────────────────────────
//
// Encodes the address-review phase into #review=<base64url> so collaborators
// can open the same list, add more stops, and then find a route together.
//
// Schema (compact JSON, short keys):
//   v    — schema version (1)
//   dep  — departure time "HH:MM"
//   sd   — start depot {a, la, lo}
//   ed   — end depot (omitted when same as start)
//   st   — stops array
//
// Each stop (st[]):
//   n    — name
//   a    — normalizedAddress
//   r    — rawAddress (omitted when equal to a)
//   p    — phone (omitted when empty)
//   t    — notes (omitted when empty)
//   la   — latitude  (5 dp; omitted for not-found stops)
//   lo   — longitude (5 dp; omitted for not-found stops)
//   s    — status shorthand: 'ok'|'ue'(user-edited)|'nf'(not-found)|'out'(outlier)

interface RDepot { a: string; la: number; lo: number; }
interface RStop {
  n: string; a: string; r?: string; p?: string; t?: string;
  la?: number; lo?: number;
  s: string;
}
interface ReviewPayload { v: 1; dep: string; sd: RDepot; ed?: RDepot; st: RStop[]; }

const STATUS_SH: Partial<Record<StopStatus, string>> = {
  'ok': 'ok', 'user-edited': 'ue', 'not-found': 'nf', 'outlier': 'out',
};
const STATUS_UN: Record<string, StopStatus> = {
  'ok': 'ok', 'ue': 'user-edited', 'nf': 'not-found', 'out': 'outlier',
};

export function encodeReviewState(
  depot: Depot,
  endDepot: Depot | null,
  stops: Stop[],
  departureTime: string,
): string {
  const toRD = (d: Depot): RDepot => ({ a: d.normalizedAddress, la: r5(d.coords.lat), lo: r5(d.coords.lng) });
  const sameDepot = !endDepot ||
    (depot.normalizedAddress === endDepot.normalizedAddress && depot.coords.lat === endDepot.coords.lat);
  const payload: ReviewPayload = {
    v: 1, dep: departureTime, sd: toRD(depot),
    st: stops.map(s => {
      const rs: RStop = { n: s.name, a: s.normalizedAddress, s: STATUS_SH[s.status] ?? 'nf' };
      if (s.rawAddress !== s.normalizedAddress) rs.r = s.rawAddress;
      if (s.phone) rs.p = s.phone;
      if (s.notes) rs.t = s.notes;
      if (s.coords) { rs.la = r5(s.coords.lat); rs.lo = r5(s.coords.lng); }
      return rs;
    }),
  };
  if (!sameDepot) payload.ed = toRD(endDepot!);
  return toBase64url(encodeURIComponent(JSON.stringify(payload)));
}

export interface DecodedReviewState {
  depot: Depot;
  endDepot: Depot | null;
  stops: Stop[];
  departureTime: string;
}

export function decodeReviewState(encoded: string): DecodedReviewState | null {
  let payload: ReviewPayload;
  try {
    payload = JSON.parse(decodeURIComponent(fromBase64url(encoded))) as ReviewPayload;
  } catch { return null; }
  if (payload.v !== 1) return null;

  const toDepot = (rd: RDepot): Depot => ({
    rawAddress: rd.a, normalizedAddress: rd.a, coords: { lat: rd.la, lng: rd.lo },
  });
  const depot    = toDepot(payload.sd);
  const endDepot = payload.ed ? toDepot(payload.ed) : null;
  const stops: Stop[] = payload.st.map((rs, i) => ({
    id: String(i),
    name: rs.n, normalizedAddress: rs.a, rawAddress: rs.r ?? rs.a,
    phone: rs.p ?? '', notes: rs.t ?? '',
    coords: rs.la !== undefined && rs.lo !== undefined ? { lat: rs.la, lng: rs.lo } : undefined,
    status: STATUS_UN[rs.s] ?? 'not-found',
  }));
  return { depot, endDepot, stops, departureTime: payload.dep };
}

const REVIEW_HASH_PREFIX = '#review=';

export function getReviewHash(): string | null {
  const h = window.location.hash;
  return h.startsWith(REVIEW_HASH_PREFIX) ? h.slice(REVIEW_HASH_PREFIX.length) : null;
}

export function setReviewHash(encoded: string): void {
  history.replaceState(null, '', REVIEW_HASH_PREFIX + encoded);
}

// ── URL shortening ─────────────────────────────────────────────────────

/**
 * Shorten a URL via is.gd. Falls back to the original URL on any error
 * (network failure, CORS, rate limit, etc.).
 */
export async function shortenUrl(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `https://is.gd/create.php?format=json&url=${encodeURIComponent(url)}`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return url;
    const data = await res.json() as { shorturl?: string };
    return data.shorturl ?? url;
  } catch {
    return url;
  }
}

/**
 * Share a URL using the Web Share API on mobile, or copy to clipboard on desktop.
 * Returns true if sharing/copying succeeded.
 */
export async function shareOrCopy(url: string, title = 'Delivery route'): Promise<boolean> {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return true;
    } catch {
      // User cancelled or share failed — fall through to clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    prompt('Copy this link:', url);
    return false;
  }
}
