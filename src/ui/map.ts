import L from 'leaflet';
import type { Stop, Depot, RouteResult } from '../types.ts';

const TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>';

function makeNumberedIcon(label: string | number, color: string): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:28px;height:28px;border-radius:50%;
      background:${color};color:#fff;
      display:flex;align-items:center;justify-content:center;
      font-size:12px;font-weight:700;font-family:system-ui,sans-serif;
      border:2px solid rgba(0,0,0,0.2);box-shadow:0 1px 4px rgba(0,0,0,0.3);
    ">${label}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function popupContent(stop: Stop | Depot, label: string): string {
  const s = stop as Stop;
  const isStop = 'name' in stop;
  const name   = isStop ? s.name : label;
  const addr   = stop.normalizedAddress;
  const phone  = isStop && s.phone ? `<br><small>${s.phone}</small>` : '';
  const notes  = isStop && s.notes ? `<br><small><em>${s.notes}</em></small>` : '';
  return `<strong>${name}</strong><br><small>${addr}</small>${phone}${notes}`;
}

// ── Preview map (Screen 2) ────────────────────────────────────────────

let previewMap: L.Map | null = null;
let previewMarkers: L.Marker[] = [];

export function initPreviewMap(elementId: string): void {
  if (previewMap) { previewMap.remove(); }
  previewMap = L.map(elementId).setView([39.2904, -76.6122], 11); // default: Baltimore
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(previewMap);
}

export function updatePreviewMarkers(stops: Stop[], depot: Depot | null): void {
  if (!previewMap) return;
  previewMarkers.forEach(m => m.remove());
  previewMarkers = [];

  const points: L.LatLng[] = [];

  if (depot?.coords) {
    const m = L.marker([depot.coords.lat, depot.coords.lng], {
      icon: makeNumberedIcon('S', '#6b7280'),
    })
      .bindPopup(popupContent(depot, 'Start'))
      .addTo(previewMap);
    previewMarkers.push(m);
    points.push(L.latLng(depot.coords.lat, depot.coords.lng));
  }

  stops.forEach(stop => {
    if (!stop.coords) return;
    const color = stop.status === 'ok' || stop.status === 'user-edited'
      ? '#2563eb' : '#dc2626';
    const m = L.marker([stop.coords.lat, stop.coords.lng], {
      icon: makeNumberedIcon('•', color),
    })
      .bindPopup(popupContent(stop, stop.name))
      .addTo(previewMap!);
    previewMarkers.push(m);
    points.push(L.latLng(stop.coords.lat, stop.coords.lng));
  });

  if (points.length > 0) {
    previewMap.fitBounds(L.latLngBounds(points), { padding: [30, 30] });
  }
}

// ── Route map (Screen 3) ──────────────────────────────────────────────

let routeMap: L.Map | null = null;
let routeLayer: L.LayerGroup | null = null;

export function initRouteMap(elementId: string): void {
  if (routeMap) { routeMap.remove(); }
  routeMap = L.map(elementId);
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(routeMap);
  routeLayer = L.layerGroup().addTo(routeMap);
}

export function renderRoute(result: RouteResult): void {
  if (!routeMap || !routeLayer) return;
  routeLayer.clearLayers();

  const latlngs: L.LatLng[] = [];

  result.orderedStops.forEach((stop, i) => {
    const coords = (stop as Depot).coords ?? (stop as Stop).coords;
    if (!coords) return;

    const ll = L.latLng(coords.lat, coords.lng);
    latlngs.push(ll);

    const isFirst = i === 0;
    const isLast  = i === result.orderedStops.length - 1;
    const isDepot = isFirst || isLast;
    const label   = isDepot ? (isFirst ? 'S' : 'E') : String(i);
    const color   = isDepot ? '#6b7280' : '#2563eb';

    L.marker(ll, { icon: makeNumberedIcon(label, color) })
      .bindPopup(popupContent(stop, isFirst ? 'Start' : 'End'))
      .addTo(routeLayer!);
  });

  // Draw route polyline
  if (latlngs.length > 1) {
    L.polyline(latlngs, {
      color: '#2563eb',
      weight: 3,
      opacity: 0.7,
      dashArray: '6, 4',
    }).addTo(routeLayer!);
  }

  routeMap.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
}

/** Highlight a single stop on the route map (e.g. on sidebar hover). */
export function highlightStop(stopIndex: number, result: RouteResult): void {
  if (!routeMap) return;
  const stop = result.orderedStops[stopIndex];
  const coords = (stop as Depot).coords ?? (stop as Stop).coords;
  if (coords) routeMap.setView([coords.lat, coords.lng], 15, { animate: true });
}

export function invalidateMaps(): void {
  previewMap?.invalidateSize();
  routeMap?.invalidateSize();
}
