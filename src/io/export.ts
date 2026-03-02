import type { RouteResult, Stop, Depot } from '../types.ts';

const GMAPS_MAX_WAYPOINTS = 10;

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function addMinutes(timeStr: string, minutes: number): string {
  const [hh, mm] = timeStr.split(':').map(Number);
  const total = hh * 60 + mm + Math.round(minutes);
  const rh = Math.floor(total / 60) % 24;
  const rm = total % 60;
  const fmt = (n: number) => String(n).padStart(2, '0');
  return `${fmt(rh)}:${fmt(rm)}`;
}

// ── CSV export ───────────────────────────────────────────────────────

export function exportRouteCSV(route: RouteResult, departureTime: string): void {
  const rows: string[][] = [
    ['Order', 'Name', 'Address', 'Phone', 'Notes', 'Est. Arrival'],
  ];

  let cumulativeSec = 0;
  route.orderedStops.forEach((stop, i) => {
    const arrivalTime = addMinutes(departureTime, cumulativeSec / 60);
    const isStop = 'rawAddress' in stop && 'name' in stop;
    const s = stop as Stop & Depot;
    rows.push([
      String(i),
      isStop ? (stop as Stop).name : 'Depot',
      s.normalizedAddress,
      isStop ? (stop as Stop).phone : '',
      isStop ? (stop as Stop).notes : '',
      arrivalTime,
    ]);
    if (i < route.segments.length) {
      cumulativeSec += route.segments[i].durationSec;
    }
  });

  const csv = rows
    .map(r => r.map(cell => `"${cell.replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  download('route.csv', 'text/csv', csv);
}

// ── Print export ─────────────────────────────────────────────────────

export function exportPrintSheet(route: RouteResult, departureTime: string): void {
  let cumulativeSec = 0;
  const stopRows = route.orderedStops
    .map((stop, i) => {
      const arrival = addMinutes(departureTime, cumulativeSec / 60);
      if (i < route.segments.length) cumulativeSec += route.segments[i].durationSec;
      const isStop = 'name' in stop;
      const s = stop as Stop & Depot;
      return `<tr>
        <td>${i}</td>
        <td>${isStop ? (stop as Stop).name : 'Depot'}</td>
        <td>${s.normalizedAddress}</td>
        <td>${isStop ? (stop as Stop).phone : ''}</td>
        <td>${isStop ? (stop as Stop).notes : ''}</td>
        <td>${arrival}</td>
      </tr>`;
    })
    .join('');

  const html = `<!doctype html><html><head><meta charset="UTF-8">
    <title>Delivery Route</title>
    <style>
      body { font-family: sans-serif; font-size: 13px; padding: 1rem; }
      h1 { font-size: 1.2rem; margin-bottom: 0.5rem; }
      p.summary { color: #666; margin-bottom: 1rem; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
      th { background: #f0f0f0; }
      @media print { @page { margin: 1cm; } }
    </style>
  </head><body>
    <h1>Mishloach Manot Delivery Route</h1>
    <p class="summary">Total: ${route.orderedStops.length - 2} stops &middot;
      ~${formatDuration(route.totalDurationSec)}</p>
    <table>
      <thead><tr>
        <th>#</th><th>Name</th><th>Address</th>
        <th>Phone</th><th>Notes</th><th>Est. Arrival</th>
      </tr></thead>
      <tbody>${stopRows}</tbody>
    </table>
  </body></html>`;

  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
    win.print();
  }
}

// ── Google Maps export ───────────────────────────────────────────────

export interface GMapsLeg {
  label: string;
  url: string;
}

/**
 * Splits a route into legs of at most GMAPS_MAX_WAYPOINTS intermediate stops
 * and returns an array of labeled Google Maps Directions URLs.
 */
export function buildGoogleMapsLegs(route: RouteResult): GMapsLeg[] {
  const stops = route.orderedStops;
  if (stops.length < 2) return [];

  const coordOf = (s: Stop | Depot) => {
    const coords = (s as Depot).coords ?? (s as Stop).coords;
    return coords ? `${coords.lat},${coords.lng}` : '';
  };

  const origin = coordOf(stops[0]);
  const destination = coordOf(stops[stops.length - 1]);
  const waypoints = stops.slice(1, -1); // intermediate delivery stops

  const legs: GMapsLeg[] = [];
  let legIndex = 1;

  for (let i = 0; i < waypoints.length; i += GMAPS_MAX_WAYPOINTS) {
    const chunk = waypoints.slice(i, i + GMAPS_MAX_WAYPOINTS);
    const legOrigin = i === 0 ? origin : coordOf(waypoints[i - 1]);
    const legDest = i + GMAPS_MAX_WAYPOINTS >= waypoints.length
      ? destination
      : coordOf(waypoints[i + GMAPS_MAX_WAYPOINTS - 1]);
    const wps = chunk.map(coordOf).join('|');

    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1');
    url.searchParams.set('origin', legOrigin);
    url.searchParams.set('destination', legDest);
    if (wps) url.searchParams.set('waypoints', wps);
    url.searchParams.set('travelmode', 'driving');

    const start = i + 1;
    const end = Math.min(i + GMAPS_MAX_WAYPOINTS, waypoints.length);
    const label = legs.length === 0 && waypoints.length <= GMAPS_MAX_WAYPOINTS
      ? 'Open in Google Maps'
      : `Leg ${legIndex}: stops ${start}–${end}`;

    legs.push({ label, url: url.toString() });
    legIndex++;
  }

  return legs;
}

// ── Apple Maps (per-stop) ────────────────────────────────────────────

export function buildAppleMapsURL(stop: Stop | Depot): string {
  const coords = (stop as Depot).coords ?? (stop as Stop).coords;
  if (!coords) return '';
  return `https://maps.apple.com/?daddr=${coords.lat},${coords.lng}&dirflg=d`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function download(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
