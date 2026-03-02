export interface Coords {
  lat: number;
  lng: number;
}

export type StopStatus = 'pending' | 'ok' | 'not-found' | 'outlier' | 'user-edited';

export interface Stop {
  id: string;
  name: string;
  phone: string;       // empty string if not provided
  notes: string;       // empty string if not provided
  rawAddress: string;
  normalizedAddress: string;
  coords?: Coords;
  status: StopStatus;
  /** What the geocoder resolved the address to — shown in the review table
   *  so users can spot mismatches (e.g. wrong street, intersection fallback). */
  geocodedAs?: string;
}

/** The depot is the start/end point; not a delivery stop. */
export interface Depot {
  rawAddress: string;
  normalizedAddress: string;
  coords: Coords;
}

/**
 * durationMatrix[i][j] = drive time in seconds from stop i to stop j.
 * Indices correspond to the stops array passed to the TSP solver.
 * null means OSRM could not find a route between those two points.
 */
export type DurationMatrix = (number | null)[][];

export interface Segment {
  from: Stop | Depot;
  to: Stop | Depot;
  durationSec: number;
}

export interface RouteResult {
  /** Full ordered list: depot → stops (in delivery order) → depot */
  orderedStops: (Stop | Depot)[];
  /** Full n×n matrix used by the solver. Empty array in shared/decoded routes
   *  where only the route segments are available. */
  durationMatrix: DurationMatrix;
  totalDurationSec: number;
  segments: Segment[];
}

/** Parsed state held in memory between screens. */
export interface AppState {
  startAddress: string;
  endAddress: string;       // may equal startAddress
  departureTime: string;    // "HH:MM" 24-hour
  stops: Stop[];
  depot: Depot | null;
  endDepot: Depot | null;   // null if same as depot
  matrix: DurationMatrix | null;
  route: RouteResult | null;
}
