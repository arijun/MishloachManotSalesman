# Mishloach Manot Route Optimizer — Design Document

## Overview

A single-page web application that solves the Travelling Salesman Problem for
Purim gift deliveries within a city. The user uploads a CSV of recipient
addresses, the app geocodes them, surfaces problems for correction, fetches a
driving-time matrix, runs a TSP heuristic, and displays an optimized delivery
route on a map.

Everything runs in the browser — no backend required.

---

## Technology Stack

### TypeScript, not Rust/WASM

For ≈50 delivery stops the computational load is negligible:

| Algorithm          | Complexity     | For n=50        |
|--------------------|----------------|-----------------|
| Nearest Neighbor   | O(n²)          | ~2,500 ops      |
| 2-opt improvement  | O(n² · iters)  | ~25,000–125,000 |

Both complete in well under 1 ms in JavaScript. Rust/WASM is not justified;
the bottleneck is always network I/O (geocoding + routing), not computation.

**Tooling:** Vite + TypeScript, no framework (vanilla DOM is sufficient for
this scope; Preact is an easy upgrade if the UI grows complex).

### External Services (all free, no API keys)

| Purpose             | Service                          | Notes                                               |
|---------------------|----------------------------------|-----------------------------------------------------|
| Map tiles           | CARTO Light (`basemaps.cartocdn.com`) | No key required; generous CDN; clean aesthetic |
| Geocoding           | Nominatim                        | 1 req/s max; must include Referer header            |
| Fallback geocoding  | Photon (Komoot)                  | Same OSM data; CORS enabled; no key                 |
| Driving-time matrix | OSRM public API                  | Single table request returns full n×n matrix        |

**OSRM Table API** — one HTTP call returns the full n×n duration matrix in
seconds, where `durations[i][j]` is travel time from stop i to stop j:
```
GET http://router.project-osrm.org/table/v1/driving/{lon,lat};{lon,lat};...
    ?annotations=duration
```
The public demo server is not for production use but is fine for a personal
delivery app. The practical coordinate limit is ~100 stops per request, well
above our target of 50.

---

## Application Flow

```
CSV Upload
    │
    ▼
Parse & Normalize
  - detect columns: name, address, phone (optional), notes (optional)
  - if no city in address → append city inferred from start address
    │
    ▼
Geocode (Nominatim, 1 req/s, progress bar)
    │
    └─ Not found → flag for user edit (inline form)
    │
    ▼
Fetch OSRM driving-time matrix (single request for all geocoded stops)
    │
    ▼
Outlier Detection
  - for each stop: find minimum drive time to any other stop
  - if min drive time > 45 minutes → flag as outlier for user edit
    │
    ▼
User Resolves Flagged Addresses
  - inline edit form, re-geocodes on save
  - re-fetches OSRM matrix after all edits committed
    │
    ▼
Run TSP Solver (Nearest Neighbor + 2-opt)
    │
    ▼
Display
  - Map: numbered markers (with popup: name, address, phone, notes) + polyline
  - Sidebar: ordered stop list with cumulative drive time
  - Export options (see below)
```

---

## Module Breakdown

```
src/
├── main.ts                  # App entry, wires modules together, manages state
├── types.ts                 # Shared TypeScript interfaces
│
├── io/
│   ├── csv.ts               # CSV parsing, column auto-detection
│   └── export.ts            # All export formats (CSV, print, maps URLs)
│
├── geo/
│   ├── geocoder.ts          # Nominatim + Photon, rate-limited queue
│   └── normalize.ts         # City inference, address cleaning
│
├── routing/
│   └── osrm.ts              # OSRM Table API client, builds duration matrix (seconds)
│
├── tsp/
│   ├── nearest-neighbor.ts  # Greedy NN construction heuristic
│   └── two-opt.ts           # 2-opt local search improvement
│
└── ui/
    ├── map.ts               # Leaflet map, markers with popups, route polyline
    ├── review-table.ts      # Address review / edit table (flagged rows)
    └── route-list.ts        # Ordered stop list with times
```

### Key Interfaces (types.ts)

```typescript
interface Stop {
  id: string;
  name: string;
  phone?: string;             // optional; shown in map popup
  notes?: string;             // optional; shown in map popup
  rawAddress: string;
  normalizedAddress: string;
  coords?: { lat: number; lng: number };
  status: 'pending' | 'ok' | 'not-found' | 'outlier' | 'user-edited';
}

interface RouteResult {
  orderedStops: Stop[];       // start → deliveries → end
  durationMatrix: number[][];  // seconds; [i][j] = drive time i→j
  totalDurationSec: number;
  segments: { from: Stop; to: Stop; durationSec: number }[];
}
```

---

## CSV Format

Expected input (header row auto-detected; column names are flexible):

```csv
Name,Address,Phone,Notes
Goldberg family,123 Oak St,(410) 555-0101,Leave at door
Levy,456 Elm Ave Apt 2,,Dog in yard - knock loudly
Cohen,789 Maple Dr,(410) 555-0303,
```

Column name matching (case-insensitive):
- **name**: `name`, `recipient`, `family`
- **address**: `address`, `addr`, `location`, `street`
- **phone**: `phone`, `phone number`, `cell`, `mobile`, `tel`
- **notes**: `notes`, `note`, `instructions`, `comment`, `comments`

Parser behavior:
- Skip blank rows
- Tolerate leading/trailing whitespace and RFC 4180 quoted fields
- Phone and notes columns are optional; rows without them work fine

---

## Address Normalization & Validation

### City Inference
```
city = parseCity(startAddress)  // e.g. "Baltimore"
state = parseState(startAddress) // e.g. "MD"

if stop.rawAddress has < 2 comma-separated parts
   OR second part looks like only a zip or state:
    stop.normalizedAddress = rawAddress + ", " + city + ", " + state
```

### Geocoding Failure
Nominatim returns empty results for unrecognized addresses. The UI shows an
inline edit form with the raw address pre-filled. On save, re-geocode
immediately (bypassing the rate-limited batch).

### Outlier Detection (drive-time based)
Runs after the OSRM matrix is fetched for all geocoded stops:
```
for each stop s:
    minDriveSec = min(matrix[s][other] for other in allStops if other != s)
    if minDriveSec > 45 * 60:   // 45 minutes
        s.status = 'outlier'
```
The flagged stop is shown on the map with a red marker so the user can see its
geocoded position and decide whether to correct or keep it.

After all user edits are committed, the matrix is re-fetched and outlier
detection re-runs before the TSP solver is invoked.

---

## TSP Algorithm

### 1. Nearest Neighbor Construction (O(n²))
1. Start at the depot (start address).
2. Repeatedly visit the unvisited stop with the shortest drive time from the
   current position.
3. Finish at the end address (defaults to start address if not specified).

### 2. 2-opt Local Search (O(n² per pass))
Iteratively reverse sub-segments of the tour to remove crossing paths:
```
repeat until no improvement:
  for i in 0..n-2:
    for j in i+2..n:
      if reversing segment [i+1..j] reduces total drive time:
        reverse it, continue outer loop
```
Typically converges in O(n) passes → O(n³) total. For n=50 this is ~125,000
operations — effectively instant in JavaScript.

**Result quality:** NN + 2-opt consistently achieves within 5–10% of optimal
for city-scale instances. For 50 stops this is the right complexity tradeoff.

---

## Map Popups

Each marker popup shows all available fields:

```
[#3] Cohen Family
📍 789 Maple Dr, Baltimore, MD
📞 (410) 555-0303
📝 Leave with neighbor
```

Phone and notes are omitted from the popup if the CSV did not include those
columns or the row's values are blank.

---

## Export Options

### 1. Ordered CSV
Exports the route in delivery order with all fields:
```csv
Order,Name,Address,Phone,Notes,Estimated Arrival
1,Start,123 Start St,...
2,Goldberg family,123 Oak St,(410) 555-0101,Leave at door,10:15 AM
...
```
Arrival times are estimated from a user-specified departure time (defaults to
current time + 5 minutes).

### 2. Printable Sheet
Opens a new tab with a clean, printer-friendly HTML page: numbered list of
stops with address, phone, notes, and estimated arrival. No map (to save ink).

### 3. Google Maps Directions URL

Google Maps Directions URLs support up to **10 intermediate waypoints** in the
browser URL scheme. The app generates the URL and opens it in a new tab:

```
https://www.google.com/maps/dir/?api=1
  &origin={start lat,lng}
  &destination={end lat,lng}
  &waypoints={stop1 lat,lng}|{stop2 lat,lng}|...
  &travelmode=driving
```

**For routes with >10 stops:** the app splits the route into consecutive
segments of ≤10 stops each and generates multiple Google Maps links (e.g.,
"Leg 1: stops 1–10", "Leg 2: stops 11–20"). Each link is a separate button
that opens a new tab.

UX: a banner explains the limitation and the multi-link approach.

### 4. Apple Maps URL

Apple Maps supports a directions URL but only with a single destination in its
web scheme (`maps.apple.com`). The app offers an "Open in Apple Maps" button
that launches turn-by-turn navigation to the **next unvisited stop**, useful
for on-the-go navigation during the delivery run.

```
https://maps.apple.com/?daddr={lat,lng}&dirflg=d
```

A "Next Stop" button in the route list updates this link as the user marks
stops complete.

---

## UI Design

### Screen 1 — Input
- File picker or drag-and-drop for CSV
- Text field: start address (required)
- Text field: end address (optional; defaults to start)
- Time picker: estimated departure time (for arrival time calculations)
- "Load Addresses" button

### Screen 2 — Review
- Progress bar while geocoding + fetching OSRM matrix
- Table: Order | Name | Address | Phone | Notes | Status
  - Status chip: ✓ OK / ✗ Not Found / ⚠ Outlier
  - Flagged rows have inline edit fields; Save re-geocodes that row
- Map preview: green markers = OK, red = flagged
- "Find Route" button (disabled until all flags resolved)

### Screen 3 — Route
- Full-width map: numbered markers + route polyline
- Sidebar: ordered stop list
  - Each row: stop number, name, address, estimated arrival
  - Expandable to show phone + notes
  - Checkbox to mark stop as delivered (dims the marker on map)
  - "Apple Maps" button per row for per-stop navigation
- Export toolbar: [Download CSV] [Print Sheet] [Google Maps ↗]

---

## Implementation Phases

### Phase 0 — Scaffold
- [ ] `npm create vite@latest . -- --template vanilla-ts`
- [ ] `npm i leaflet @types/leaflet`
- [ ] Basic HTML shell with three screen `<section>` elements
- [ ] CSS: mobile-friendly layout, sidebar + map split for Screen 3

### Phase 1 — Data In
- [ ] CSV parser with column auto-detection (`io/csv.ts`)
- [ ] Address normalizer / city inference (`geo/normalize.ts`)
- [ ] Input screen UI

### Phase 2 — Geocoding
- [ ] Rate-limited Nominatim client with Photon fallback (`geo/geocoder.ts`)
- [ ] Review screen table with inline edit
- [ ] Map preview with status-colored markers

### Phase 3 — Routing & Validation
- [ ] OSRM table client (`routing/osrm.ts`)
- [ ] Outlier detection using drive-time matrix
- [ ] Re-geocode + re-fetch flow after user edits

### Phase 4 — TSP
- [ ] NN construction (`tsp/nearest-neighbor.ts`)
- [ ] 2-opt improvement (`tsp/two-opt.ts`)

### Phase 5 — Display & Export
- [ ] Route map: polyline, numbered markers, popups with phone/notes
- [ ] Route sidebar with arrival times and delivered checkboxes
- [ ] CSV export, print sheet, Google Maps multi-leg URLs, Apple Maps per-stop
  (`io/export.ts`)

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Nominatim rate limit (1 req/s) | Client-side queue with delay; progress bar |
| OSRM demo server reliability | Catch HTTP errors; "Retry" button; note that self-hosting is possible |
| Google Maps waypoint limit (10) | Multi-leg URL split with clear UX explanation |
| Apple Maps multi-stop limitation | Offer per-stop "Navigate here" button as workaround |
| OSRM coordinate string length at 50 stops | ~1,000 chars — well within URL limits |
| Ambiguous geocode results (wrong city) | Outlier check catches most; user can edit |

---

## Out of Scope (for now)

- Traffic-aware routing (requires commercial API)
- Multiple drivers / vehicle routing problem
- Real-time GPS tracking
- Saving/loading sessions (localStorage would be straightforward to add)
- PWA / offline support
