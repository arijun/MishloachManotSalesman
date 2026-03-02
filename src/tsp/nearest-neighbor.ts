import type { DurationMatrix } from '../types.ts';

/**
 * Nearest-Neighbor greedy TSP construction heuristic.
 *
 * @param matrix  n×n drive-time matrix (seconds). null entries treated as Infinity.
 * @param startIdx  Index of the starting node (depot).
 * @param endIdx    Index of the ending node (may equal startIdx).
 * @returns Ordered list of node indices, including startIdx at position 0
 *          and endIdx at the last position. Intermediate nodes are the
 *          delivery stops.
 */
export function nearestNeighbor(
  matrix: DurationMatrix,
  startIdx: number,
  endIdx: number,
): number[] {
  const n = matrix.length;
  const deliveryIndices = Array.from({ length: n }, (_, i) => i).filter(
    i => i !== startIdx && i !== endIdx,
  );

  const visited = new Set<number>();
  const route: number[] = [startIdx];
  let current = startIdx;

  while (visited.size < deliveryIndices.length) {
    let bestIdx = -1;
    let bestTime = Infinity;

    for (const idx of deliveryIndices) {
      if (visited.has(idx)) continue;
      const t = matrix[current][idx] ?? Infinity;
      if (t < bestTime) { bestTime = t; bestIdx = idx; }
    }

    if (bestIdx === -1) break; // should not happen
    visited.add(bestIdx);
    route.push(bestIdx);
    current = bestIdx;
  }

  route.push(endIdx);
  return route;
}
