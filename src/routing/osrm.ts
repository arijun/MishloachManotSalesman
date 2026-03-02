import type { Coords, DurationMatrix } from '../types.ts';

const OSRM_BASE = 'http://router.project-osrm.org/table/v1/driving';

interface OSRMTableResponse {
  code: string;
  durations: (number | null)[][];
}

/**
 * Fetch a full n×n driving-time matrix (in seconds) from the OSRM public API.
 * Returns null values for pairs where OSRM cannot find a route.
 *
 * @throws if the network request fails or OSRM returns a non-Ok code.
 */
export async function fetchDurationMatrix(coords: Coords[]): Promise<DurationMatrix> {
  if (coords.length === 0) return [];

  const coordStr = coords
    .map(c => `${c.lng.toFixed(6)},${c.lat.toFixed(6)}`)
    .join(';');

  const url = `${OSRM_BASE}/${coordStr}?annotations=duration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OSRM request failed: HTTP ${res.status}`);
  }

  const data = await res.json() as OSRMTableResponse;
  if (data.code !== 'Ok') {
    throw new Error(`OSRM error: ${data.code}`);
  }

  return data.durations;
}

/**
 * Find the minimum drive time (in seconds) from a given row to any other row.
 * Ignores null entries and the diagonal (self → self).
 */
export function minDriveTimeTo(matrix: DurationMatrix, rowIdx: number): number {
  let min = Infinity;
  const row = matrix[rowIdx];
  for (let j = 0; j < row.length; j++) {
    if (j === rowIdx) continue;
    const v = row[j];
    if (v !== null && v < min) min = v;
  }
  return min;
}
