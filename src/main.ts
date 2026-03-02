import './style.css';

import type { AppState, Stop, Depot, DurationMatrix } from './types.ts';
import { parseCSVText } from './io/csv.ts';
import { inferCityState, normalizeAddress } from './geo/normalize.ts';
import { geocodeAddress, geocodeBatch } from './geo/geocoder.ts';
import { fetchDurationMatrix, minDriveTimeTo } from './routing/osrm.ts';
import { nearestNeighbor } from './tsp/nearest-neighbor.ts';
import { twoOpt } from './tsp/two-opt.ts';
import { initPreviewMap, updatePreviewMarkers, initRouteMap, renderRoute, highlightStop, invalidateMaps } from './ui/map.ts';
import { renderReviewTable, updateTableRow } from './ui/review-table.ts';
import { renderRouteList } from './ui/route-list.ts';
import { exportRouteCSV, exportPrintSheet, buildGoogleMapsLegs } from './io/export.ts';

// ── State ─────────────────────────────────────────────────────────────

const state: AppState = {
  startAddress: '',
  endAddress: '',
  departureTime: '10:00',
  stops: [],
  depot: null,
  endDepot: null,
  matrix: null,
  route: null,
};

const OUTLIER_THRESHOLD_SEC = 45 * 60; // 45 minutes

// ── DOM refs ──────────────────────────────────────────────────────────

const screenInput  = document.getElementById('screen-input')!;
const screenReview = document.getElementById('screen-review')!;
const screenRoute  = document.getElementById('screen-route')!;

const formInput       = document.getElementById('form-input') as HTMLFormElement;
const inputStartAddr  = document.getElementById('start-address') as HTMLInputElement;
const inputEndAddr    = document.getElementById('end-address') as HTMLInputElement;
const inputTime       = document.getElementById('departure-time') as HTMLInputElement;
const fileInput       = document.getElementById('file-input') as HTMLInputElement;
const dropZone        = document.getElementById('drop-zone')!;
const dropZoneText    = document.getElementById('drop-zone-text')!;
const dropZoneFile    = document.getElementById('drop-zone-filename')!;
const inputError      = document.getElementById('input-error')!;

const btnBackInput    = document.getElementById('btn-back-input')!;
const btnFindRoute    = document.getElementById('btn-find-route') as HTMLButtonElement;
const geocodeProgress = document.getElementById('geocode-progress')!;
const progressLabel   = document.getElementById('progress-label')!;
const progressCount   = document.getElementById('progress-count')!;
const progressFill    = document.getElementById('progress-bar-fill')!;
const reviewTbody     = document.getElementById('review-tbody') as HTMLTableSectionElement;
const reviewError     = document.getElementById('review-error')!;

const btnBackReview   = document.getElementById('btn-back-review')!;
const routeList       = document.getElementById('route-list') as HTMLOListElement;
const routeSummary    = document.getElementById('route-summary')!;
const btnExportCSV    = document.getElementById('btn-export-csv')!;
const btnExportPrint  = document.getElementById('btn-export-print')!;
const btnExportGMaps  = document.getElementById('btn-export-gmaps')!;
const gMapsLegNote    = document.getElementById('gmaps-leg-note')!;

// ── Screen navigation ─────────────────────────────────────────────────

function showScreen(el: HTMLElement): void {
  [screenInput, screenReview, screenRoute].forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  setTimeout(() => invalidateMaps(), 50); // let CSS paint before Leaflet resizes
}

// ── Input screen ──────────────────────────────────────────────────────

let csvText = '';

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  loadFile(file);
});

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file) loadFile(file);
});

function loadFile(file: File): void {
  const reader = new FileReader();
  reader.onload = ev => {
    csvText = (ev.target?.result as string) ?? '';
    dropZoneText.classList.add('hidden');
    dropZoneFile.textContent = file.name;
    dropZoneFile.classList.remove('hidden');
  };
  reader.readAsText(file);
}

formInput.addEventListener('submit', async e => {
  e.preventDefault();
  inputError.classList.add('hidden');

  const startAddr = inputStartAddr.value.trim();
  if (!startAddr) { showError(inputError, 'Please enter a start address.'); return; }
  if (!csvText)   { showError(inputError, 'Please load a CSV file.'); return; }

  let parseResult;
  try {
    parseResult = parseCSVText(csvText);
  } catch (err) {
    showError(inputError, String(err));
    return;
  }
  if (parseResult.warnings.length) {
    console.warn('CSV warnings:', parseResult.warnings);
  }

  const cityState = inferCityState(startAddr);
  let nextId = 0;

  state.startAddress   = startAddr;
  state.endAddress     = inputEndAddr.value.trim() || startAddr;
  state.departureTime  = inputTime.value || '10:00';
  state.stops = parseResult.stops.map(s => ({
    ...s,
    id: String(nextId++),
    normalizedAddress: normalizeAddress(s.rawAddress, cityState),
    status: 'pending' as const,
  }));
  state.depot    = null;
  state.endDepot = null;
  state.matrix   = null;
  state.route    = null;

  showScreen(screenReview);
  initPreviewMap('map-preview');
  await runGeocodingPhase();
});

// ── Review screen ─────────────────────────────────────────────────────

btnBackInput.addEventListener('click', () => showScreen(screenInput));

async function runGeocodingPhase(): Promise<void> {
  btnFindRoute.disabled = true;
  reviewError.classList.add('hidden');
  geocodeProgress.classList.remove('hidden');
  progressLabel.textContent = 'Geocoding addresses…';

  // Geocode depot
  const depotResult = await geocodeAddress(normalizeAddress(state.startAddress, inferCityState(state.startAddress)));
  if (!depotResult) {
    showError(reviewError, `Could not geocode start address: "${state.startAddress}". Please check it and try again.`);
    geocodeProgress.classList.add('hidden');
    return;
  }
  state.depot = { rawAddress: state.startAddress, normalizedAddress: normalizeAddress(state.startAddress, inferCityState(state.startAddress)), coords: depotResult.coords };

  if (state.endAddress !== state.startAddress) {
    const endResult = await geocodeAddress(state.endAddress);
    state.endDepot = endResult
      ? { rawAddress: state.endAddress, normalizedAddress: state.endAddress, coords: endResult.coords }
      : state.depot;
  }

  // Geocode stops
  const addresses = state.stops.map(s => s.normalizedAddress);
  const geoResults = await geocodeBatch(addresses, (done, total) => {
    progressFill.style.width = `${(done / total) * 100}%`;
    progressCount.textContent = `${done} / ${total}`;
  });

  geoResults.forEach((r, i) => {
    state.stops[i].coords     = r?.coords;
    state.stops[i].geocodedAs = r?.displayName;
    state.stops[i].status     = r ? 'ok' : 'not-found';
  });

  progressLabel.textContent = 'Fetching drive times…';
  progressFill.style.width = '100%';

  // Fetch OSRM matrix and run outlier detection
  await runOutlierDetection();

  geocodeProgress.classList.add('hidden');
  renderReviewTable(reviewTbody, state.stops, state.depot, onAddressSave);
  updatePreviewMarkers(state.stops, state.depot);
  updateFindRouteButton();
}

async function runOutlierDetection(): Promise<void> {
  const geocodedStops = state.stops.filter(s => s.coords && s.status !== 'not-found');
  if (geocodedStops.length < 2) return;

  const allCoords = geocodedStops.map(s => s.coords!);
  try {
    const matrix = await fetchDurationMatrix(allCoords);
    geocodedStops.forEach((stop, i) => {
      const minSec = minDriveTimeTo(matrix, i);
      if (minSec > OUTLIER_THRESHOLD_SEC) {
        stop.status = 'outlier';
      }
    });
  } catch (err) {
    console.warn('Could not fetch OSRM matrix for outlier check:', err);
  }
}

async function onAddressSave(stopId: string, newAddress: string): Promise<void> {
  const stop = state.stops.find(s => s.id === stopId);
  if (!stop) return;

  stop.normalizedAddress = newAddress;
  stop.status = 'pending';
  updateTableRow(reviewTbody, stop);

  const geoResult = await geocodeAddress(newAddress);
  stop.coords     = geoResult?.coords;
  stop.geocodedAs = geoResult?.displayName;
  stop.status     = geoResult ? 'user-edited' : 'not-found';
  updateTableRow(reviewTbody, stop);
  updatePreviewMarkers(state.stops, state.depot);
  updateFindRouteButton();
}

function updateFindRouteButton(): void {
  const hasFlagged = state.stops.some(
    s => s.status === 'not-found' || s.status === 'outlier',
  );
  btnFindRoute.disabled = hasFlagged;
}

btnFindRoute.addEventListener('click', () => {
  void runRouteSolver();
});

// ── Route solver ──────────────────────────────────────────────────────

async function runRouteSolver(): Promise<void> {
  const depot    = state.depot!;
  const endDepot = state.endDepot ?? depot;
  const stops    = state.stops.filter(s => s.coords);

  // Build the coordinate list: depot + stops + endDepot (if different)
  const sameDepot = !state.endDepot;
  const allNodes  = sameDepot
    ? [depot, ...stops]
    : [depot, ...stops, endDepot];

  const coords = allNodes.map(n => {
    const c = (n as Depot).coords ?? (n as Stop).coords!;
    return c;
  });

  let matrix: DurationMatrix;
  try {
    matrix = await fetchDurationMatrix(coords);
  } catch (err) {
    showError(reviewError, `Could not fetch routing data: ${String(err)}`);
    return;
  }

  state.matrix = matrix;

  const startIdx = 0;
  const endIdx   = sameDepot ? 0 : allNodes.length - 1;

  const initialRoute = nearestNeighbor(matrix, startIdx, endIdx);
  const optimizedRoute = twoOpt(initialRoute, matrix);

  const orderedStops = optimizedRoute.map(i => allNodes[i]);
  const segments = [];
  let totalSec = 0;

  for (let i = 0; i < optimizedRoute.length - 1; i++) {
    const from = optimizedRoute[i];
    const to   = optimizedRoute[i + 1];
    const dur  = matrix[from][to] ?? 0;
    totalSec  += dur;
    segments.push({ from: allNodes[from], to: allNodes[to], durationSec: dur });
  }

  state.route = { orderedStops, durationMatrix: matrix, totalDurationSec: totalSec, segments };

  showScreen(screenRoute);
  initRouteMap('map-route');
  renderRoute(state.route);
  renderRouteList(routeList, routeSummary, state.route, state.departureTime,
    i => { if (state.route) highlightStop(i, state.route); });
  setupExportButtons();
}

// ── Route screen ──────────────────────────────────────────────────────

btnBackReview.addEventListener('click', () => showScreen(screenReview));

function setupExportButtons(): void {
  if (!state.route) return;

  btnExportCSV.onclick = () => exportRouteCSV(state.route!, state.departureTime);
  btnExportPrint.onclick = () => exportPrintSheet(state.route!, state.departureTime);

  const legs = buildGoogleMapsLegs(state.route);
  if (legs.length === 1) {
    btnExportGMaps.textContent = 'Google Maps ↗';
    btnExportGMaps.onclick = () => window.open(legs[0].url, '_blank');
    gMapsLegNote.classList.add('hidden');
  } else if (legs.length > 1) {
    // Replace the single button with one per leg
    const toolbar = btnExportGMaps.parentElement!;
    btnExportGMaps.remove();
    legs.forEach(leg => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.textContent = leg.label + ' ↗';
      btn.onclick = () => window.open(leg.url, '_blank');
      toolbar.appendChild(btn);
    });
    gMapsLegNote.textContent = `Route split into ${legs.length} legs (Google Maps limit: 10 waypoints each)`;
    gMapsLegNote.classList.remove('hidden');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function showError(el: HTMLElement, msg: string): void {
  el.textContent = msg;
  el.classList.remove('hidden');
}
