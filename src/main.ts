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
import {
  encodeRoute, decodeRoute, getSharedHash, setRouteHash,
  encodeReviewState, decodeReviewState, getReviewHash, setReviewHash,
} from './io/share.ts';
import type { DecodedRoute, DecodedReviewState } from './io/share.ts';
import { attachAutocomplete } from './ui/autocomplete.ts';
import type { AutocompleteOptions } from './ui/autocomplete.ts';

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

let nextStopId = 0;
let deliveredIds = new Set<string>();
let isSharedView = false;
const OUTLIER_THRESHOLD_SEC = 45 * 60;

// Shared location bias for autocomplete. Set as soon as the start address is
// resolved (either via autocomplete selection or after geocoding the depot).
// Passed as a soft hint to Photon so delivery address suggestions are ranked
// toward the right city without hard-filtering legitimate nearby suburbs.
let biasCoords: import('./types.ts').Coords | null = null;
const getBias = () => biasCoords;

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
const btnSkipCSV      = document.getElementById('btn-skip-csv')!;

const btnBackInput    = document.getElementById('btn-back-input')!;
const btnFindRoute    = document.getElementById('btn-find-route') as HTMLButtonElement;
const btnAddStop      = document.getElementById('btn-add-stop')!;
const geocodeProgress = document.getElementById('geocode-progress')!;
const progressLabel   = document.getElementById('progress-label')!;
const progressCount   = document.getElementById('progress-count')!;
const progressFill    = document.getElementById('progress-bar-fill')!;
const reviewTbody     = document.getElementById('review-tbody') as HTMLTableSectionElement;
const reviewError     = document.getElementById('review-error')!;
const addStopPanel    = document.getElementById('add-stop-panel')!;
const formAddStop     = document.getElementById('form-add-stop') as HTMLFormElement;
const addNameInput    = document.getElementById('add-name') as HTMLInputElement;
const addAddrInput    = document.getElementById('add-address') as HTMLInputElement;
const addPhoneInput   = document.getElementById('add-phone') as HTMLInputElement;
const addNotesInput   = document.getElementById('add-notes') as HTMLInputElement;
const btnCancelAdd    = document.getElementById('btn-cancel-add')!;

const btnBackReview   = document.getElementById('btn-back-review')!;
const routeList       = document.getElementById('route-list') as HTMLOListElement;
const routeSummary    = document.getElementById('route-summary')!;
const btnExportToggle = document.getElementById('btn-export-toggle')!;
const exportPopover   = document.getElementById('export-popover')!;
const gmapsPopover    = document.getElementById('gmaps-popover') as HTMLDivElement;
const btnExportCSV    = document.getElementById('btn-export-csv')!;
const btnExportPrint  = document.getElementById('btn-export-print')!;
const btnExportGMaps  = document.getElementById('btn-export-gmaps')!;
const routeSidebar    = document.getElementById('route-sidebar')!;
const mapRouteEl      = document.getElementById('map-route')!;
const sheetHandle     = document.getElementById('sheet-handle')!;
const btnShare             = document.getElementById('btn-share')!;
const btnShareReview       = document.getElementById('btn-share-review')!;
const sharedReviewBanner   = document.getElementById('shared-review-banner')!;

// ── Autocomplete on address inputs ───────────────────────────────────
//
// Start address: captures coords from the selected suggestion so we can
// bias all subsequent delivery-address lookups to the right city.
// End address: no bias needed (usually same city as start; user types it).
// Delivery inputs: always use getBias so results favour the delivery area.

const deliveryAcOptions: AutocompleteOptions = { getBias };

attachAutocomplete(inputStartAddr, {
  onSelect: (_address, coords) => {
    if (coords) biasCoords = coords;
  },
});
attachAutocomplete(inputEndAddr, deliveryAcOptions);
attachAutocomplete(addAddrInput, deliveryAcOptions);

// ── Screen navigation ─────────────────────────────────────────────────

function showScreen(el: HTMLElement): void {
  [screenInput, screenReview, screenRoute].forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  setTimeout(() => invalidateMaps(), 50);
}

// ── Input screen ──────────────────────────────────────────────────────

let csvText = '';

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) loadFile(f); });
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const f = e.dataTransfer?.files[0];
  if (f) loadFile(f);
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

/** Shared setup before entering the review screen. */
function initReviewState(startAddr: string): void {
  state.startAddress  = startAddr;
  state.endAddress    = inputEndAddr.value.trim() || startAddr;
  state.departureTime = inputTime.value || '10:00';
  state.depot         = null;
  state.endDepot      = null;
  state.matrix        = null;
  state.route         = null;
  nextStopId          = state.stops.length; // keep ID counter ahead of existing stops
}

// Load CSV → review
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
  if (parseResult.warnings.length) console.warn('CSV warnings:', parseResult.warnings);

  const cityState = inferCityState(startAddr);
  nextStopId = 0;

  state.stops = parseResult.stops.map(s => ({
    ...s,
    id: String(nextStopId++),
    normalizedAddress: normalizeAddress(s.rawAddress, cityState),
    status: 'pending' as const,
  }));

  initReviewState(startAddr);
  showScreen(screenReview);
  initPreviewMap('map-preview');
  await runGeocodingPhase();
});

// Skip CSV → enter manually
btnSkipCSV.addEventListener('click', () => {
  inputError.classList.add('hidden');
  const startAddr = inputStartAddr.value.trim();
  if (!startAddr) { showError(inputError, 'Please enter a start address first.'); return; }

  nextStopId = 0;
  state.stops = [];
  initReviewState(startAddr);
  showScreen(screenReview);
  initPreviewMap('map-preview');

  // Geocode the depot, then show empty table and the add-stop panel
  void geocodeDepot().then(() => {
    renderReviewTable(reviewTbody, state.stops, state.depot, onAddressSave, deliveryAcOptions);
    updatePreviewMarkers(state.stops, state.depot);
    addStopPanel.classList.remove('hidden');
    addNameInput.focus();
    // No stops yet → Find Route disabled until at least one is added
    updateFindRouteButton();
  });
});

// ── Review screen ─────────────────────────────────────────────────────

btnBackInput.addEventListener('click', () => showScreen(screenInput));

// Add-stop panel toggle
btnAddStop.addEventListener('click', () => {
  const hidden = addStopPanel.classList.contains('hidden');
  addStopPanel.classList.toggle('hidden', !hidden);
  if (hidden) addNameInput.focus();
});

btnCancelAdd.addEventListener('click', () => {
  addStopPanel.classList.add('hidden');
  formAddStop.reset();
});

formAddStop.addEventListener('submit', async e => {
  e.preventDefault();
  const name    = addNameInput.value.trim();
  const address = addAddrInput.value.trim();
  if (!name || !address) return;

  const cityState = inferCityState(state.startAddress);
  const normalized = normalizeAddress(address, cityState);

  const stop: Stop = {
    id:               String(nextStopId++),
    name,
    phone:            addPhoneInput.value.trim(),
    notes:            addNotesInput.value.trim(),
    rawAddress:       address,
    normalizedAddress: normalized,
    status:           'pending',
  };
  state.stops.push(stop);

  formAddStop.reset();
  addStopPanel.classList.add('hidden');

  // Geocode the new stop immediately
  const result = await geocodeAddress(normalized);
  stop.coords     = result?.coords;
  stop.geocodedAs = result?.displayName;
  stop.status     = result ? 'ok' : 'not-found';

  renderReviewTable(reviewTbody, state.stops, state.depot, onAddressSave, deliveryAcOptions);
  updatePreviewMarkers(state.stops, state.depot);
  updateFindRouteButton();
});

async function geocodeDepot(): Promise<void> {
  const normalized = normalizeAddress(state.startAddress, inferCityState(state.startAddress));
  const result = await geocodeAddress(normalized);
  if (!result) {
    showError(reviewError, `Could not geocode start address: "${state.startAddress}". Please go back and check it.`);
    return;
  }
  state.depot = { rawAddress: state.startAddress, normalizedAddress: normalized, coords: result.coords };
  // Ensure bias is set even if the user typed the start address instead of
  // selecting from the autocomplete dropdown.
  biasCoords ??= result.coords;

  if (state.endAddress !== state.startAddress) {
    const endResult = await geocodeAddress(state.endAddress);
    state.endDepot = endResult
      ? { rawAddress: state.endAddress, normalizedAddress: state.endAddress, coords: endResult.coords }
      : state.depot;
  }
}

async function runGeocodingPhase(): Promise<void> {
  btnFindRoute.disabled = true;
  reviewError.classList.add('hidden');
  geocodeProgress.classList.remove('hidden');
  progressLabel.textContent = 'Geocoding addresses…';

  await geocodeDepot();
  if (!state.depot) { geocodeProgress.classList.add('hidden'); return; }

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

  progressLabel.textContent = 'Checking for outliers…';
  progressFill.style.width = '100%';
  await runOutlierDetection();

  geocodeProgress.classList.add('hidden');
  renderReviewTable(reviewTbody, state.stops, state.depot, onAddressSave, deliveryAcOptions);
  updatePreviewMarkers(state.stops, state.depot);
  updateFindRouteButton();
}

async function runOutlierDetection(): Promise<void> {
  const geocodedStops = state.stops.filter(s => s.coords && s.status !== 'not-found');
  if (geocodedStops.length < 2) return;

  try {
    const matrix = await fetchDurationMatrix(geocodedStops.map(s => s.coords!));
    geocodedStops.forEach((stop, i) => {
      if (minDriveTimeTo(matrix, i) > OUTLIER_THRESHOLD_SEC) stop.status = 'outlier';
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

  const result = await geocodeAddress(newAddress);
  stop.coords     = result?.coords;
  stop.geocodedAs = result?.displayName;
  stop.status     = result ? 'user-edited' : 'not-found';
  updateTableRow(reviewTbody, stop);
  updatePreviewMarkers(state.stops, state.depot);
  updateFindRouteButton();
}

function updateFindRouteButton(): void {
  const hasFlagged = state.stops.some(s => s.status === 'not-found' || s.status === 'outlier');
  const hasStops   = state.stops.length > 0;
  btnFindRoute.disabled = hasFlagged || !hasStops;
}

btnFindRoute.addEventListener('click', () => { void runRouteSolver(); });

function onDeliveredChange(stopId: string, delivered: boolean): void {
  if (delivered) deliveredIds.add(stopId);
  else deliveredIds.delete(stopId);
  if (state.route) {
    setRouteHash(encodeRoute(state.route, state.departureTime, deliveredIds));
  }
}

// ── Route solver ──────────────────────────────────────────────────────

async function runRouteSolver(): Promise<void> {
  const depot    = state.depot!;
  const endDepot = state.endDepot ?? depot;
  const stops    = state.stops.filter(s => s.coords);
  const sameDepot = !state.endDepot;
  const allNodes  = sameDepot ? [depot, ...stops] : [depot, ...stops, endDepot];
  const coords    = allNodes.map(n => (n as Depot).coords ?? (n as Stop).coords!);

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
  const optimizedRoute = twoOpt(nearestNeighbor(matrix, startIdx, endIdx), matrix);

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
  deliveredIds = new Set<string>();
  isSharedView = false;

  setRouteHash(encodeRoute(state.route, state.departureTime, deliveredIds));
  sheetOpen = false;
  routeSidebar.classList.remove('sheet-open');
  showScreen(screenRoute);
  initRouteMap('map-route');
  renderRoute(state.route);
  renderRouteList(routeList, routeSummary, state.route, state.departureTime,
    deliveredIds,
    i => { if (state.route) highlightStop(i, state.route); },
    onDeliveredChange,
  );
  setupExportButtons();
}

// ── Bottom sheet (mobile route screen) ───────────────────────────────

let sheetOpen = false;
const isMobile = () => window.innerWidth <= 700;

function setSheetOpen(open: boolean): void {
  sheetOpen = open;
  routeSidebar.classList.toggle('sheet-open', open);
  setTimeout(() => invalidateMaps(), 320);
}

// Drag handle: swipe or tap to toggle
let dragStartY = 0;
sheetHandle.addEventListener('touchstart', e => {
  dragStartY = e.touches[0].clientY;
}, { passive: true });
sheetHandle.addEventListener('touchend', e => {
  if (!isMobile()) return;
  const dy = dragStartY - e.changedTouches[0].clientY;
  if (Math.abs(dy) < 10) setSheetOpen(!sheetOpen);
  else if (dy > 30)      setSheetOpen(true);
  else if (dy < -30)     setSheetOpen(false);
}, { passive: true });

// Tap collapsed header / summary to expand
routeSidebar.querySelector('.sidebar-header')!.addEventListener('click', () => {
  if (isMobile() && !sheetOpen) setSheetOpen(true);
});
routeSummary.addEventListener('click', () => {
  if (isMobile() && !sheetOpen) setSheetOpen(true);
});

// Tap map to collapse
mapRouteEl.addEventListener('click', () => {
  if (isMobile() && sheetOpen) setSheetOpen(false);
});

// ── Export popover ────────────────────────────────────────────────────

btnExportToggle.addEventListener('click', e => {
  e.stopPropagation();
  const closing = !exportPopover.classList.contains('hidden');
  exportPopover.classList.toggle('hidden', closing);
  gmapsPopover.classList.add('hidden');
});

// Clicking anywhere outside closes all popovers
document.addEventListener('click', () => {
  exportPopover.classList.add('hidden');
  gmapsPopover.classList.add('hidden');
});

// ── Route screen ──────────────────────────────────────────────────────

btnBackReview.addEventListener('click', () => {
  if (isSharedView) {
    // Review screen was never set up in the shared-route flow — initialize it now.
    initPreviewMap('map-preview');
    renderReviewTable(reviewTbody, state.stops, state.depot, onAddressSave, deliveryAcOptions);
    updatePreviewMarkers(state.stops, state.depot);
    updateFindRouteButton();
  }
  showScreen(screenReview);
});

btnShareReview.addEventListener('click', () => {
  if (!state.depot) return;
  const encoded = encodeReviewState(state.depot, state.endDepot, state.stops, state.departureTime);
  setReviewHash(encoded);
  navigator.clipboard.writeText(window.location.href).then(() => {
    btnShareReview.textContent = 'Copied!';
    btnShareReview.classList.add('copied');
    setTimeout(() => {
      btnShareReview.textContent = 'Share List';
      btnShareReview.classList.remove('copied');
    }, 2000);
  }).catch(() => {
    prompt('Copy this link:', window.location.href);
  });
});

btnShare.addEventListener('click', () => {
  exportPopover.classList.add('hidden');
  navigator.clipboard.writeText(window.location.href).then(() => {
    const orig = btnExportToggle.textContent!;
    btnExportToggle.textContent = '✓ Copied!';
    setTimeout(() => { btnExportToggle.textContent = orig; }, 2000);
  }).catch(() => {
    prompt('Copy this link:', window.location.href);
  });
});

function setupExportButtons(): void {
  if (!state.route) return;
  btnExportCSV.onclick   = () => exportRouteCSV(state.route!, state.departureTime);
  btnExportPrint.onclick = () => exportPrintSheet(state.route!, state.departureTime);

  const legs = buildGoogleMapsLegs(state.route);
  gmapsPopover.innerHTML = '';

  if (legs.length === 1) {
    btnExportGMaps.textContent = 'Google Maps ↗';
    btnExportGMaps.onclick = () => window.open(legs[0].url, '_blank');
  } else {
    // Multiple legs: button opens a popover listing each leg
    btnExportGMaps.textContent = 'Google Maps ↗';
    legs.forEach(leg => {
      const item = document.createElement('button');
      item.className = 'toolbar-popover-item';
      item.textContent = `${leg.label} ↗`;
      item.addEventListener('click', e => {
        e.stopPropagation();
        gmapsPopover.classList.add('hidden');
        window.open(leg.url, '_blank');
      });
      gmapsPopover.appendChild(item);
    });
    btnExportGMaps.onclick = e => {
      e.stopPropagation();
      const closing = !gmapsPopover.classList.contains('hidden');
      gmapsPopover.classList.toggle('hidden', closing);
      exportPopover.classList.add('hidden');
    };
  }
}

// ── Shared route ──────────────────────────────────────────────────────

function loadSharedRouteView(decoded: DecodedRoute): void {
  // Reconstruct AppState so the review screen is usable if the user goes Back.
  const all = decoded.route.orderedStops;
  state.depot = all[0] as Depot;
  const lastDepot = all[all.length - 1] as Depot;
  state.endDepot = (
    state.depot.normalizedAddress !== lastDepot.normalizedAddress ||
    state.depot.coords.lat !== lastDepot.coords.lat
  ) ? lastDepot : null;
  state.startAddress = state.depot.normalizedAddress;
  state.endAddress   = state.endDepot?.normalizedAddress ?? state.startAddress;
  state.stops = all.slice(1, -1) as Stop[];
  nextStopId  = state.stops.length;
  biasCoords ??= state.depot.coords;

  sheetOpen = false;
  routeSidebar.classList.remove('sheet-open');
  showScreen(screenRoute);
  initRouteMap('map-route');
  renderRoute(state.route!);
  renderRouteList(
    routeList, routeSummary, state.route!, state.departureTime,
    deliveredIds,
    i => { if (state.route) highlightStop(i, state.route!); },
    onDeliveredChange,
  );
  setupExportButtons();
}

function loadSharedReviewState(decoded: DecodedReviewState): void {
  state.depot        = decoded.depot;
  state.endDepot     = decoded.endDepot;
  state.stops        = decoded.stops;
  state.departureTime = decoded.departureTime;
  state.startAddress = decoded.depot.normalizedAddress;
  state.endAddress   = decoded.endDepot?.normalizedAddress ?? state.startAddress;
  nextStopId  = decoded.stops.length;
  biasCoords ??= decoded.depot.coords;

  sharedReviewBanner.classList.remove('hidden');
  showScreen(screenReview);
  initPreviewMap('map-preview');
  renderReviewTable(reviewTbody, state.stops, state.depot, onAddressSave, deliveryAcOptions);
  updatePreviewMarkers(state.stops, state.depot);
  updateFindRouteButton();
}

// On page load, detect #route= or #review= hashes and skip the input screen.
(function checkSharedRoute(): void {
  const routeHash = getSharedHash();
  if (routeHash) {
    const decoded = decodeRoute(routeHash);
    if (decoded) {
      isSharedView = true;
      deliveredIds = decoded.deliveredIds;
      state.route = decoded.route;
      state.departureTime = decoded.departureTime;
      loadSharedRouteView(decoded);
      return;
    }
  }
  const reviewHash = getReviewHash();
  if (reviewHash) {
    const decoded = decodeReviewState(reviewHash);
    if (decoded) loadSharedReviewState(decoded);
  }
})();

// ── Helpers ───────────────────────────────────────────────────────────

function showError(el: HTMLElement, msg: string): void {
  el.textContent = msg;
  el.classList.remove('hidden');
}
