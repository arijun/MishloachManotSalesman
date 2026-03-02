import type { DurationMatrix } from '../types.ts';

function routeDuration(route: number[], matrix: DurationMatrix): number {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    total += matrix[route[i]][route[i + 1]] ?? Infinity;
  }
  return total;
}

/**
 * 2-opt local search improvement.
 *
 * Keeps the first and last nodes of the route fixed (depot / end depot) and
 * only reverses segments among the intermediate stops.
 *
 * @param route  Initial route (array of node indices, start and end fixed).
 * @param matrix n×n drive-time matrix.
 * @returns Improved route (new array; input is not mutated).
 */
export function twoOpt(route: number[], matrix: DurationMatrix): number[] {
  let best = route.slice();
  let improved = true;

  // Inner stops only: indices 1 .. route.length-2
  const inner = best.length - 2;

  while (improved) {
    improved = false;
    for (let i = 1; i <= inner - 1; i++) {
      for (let j = i + 1; j <= inner; j++) {
        // Reverse the segment between i and j (inclusive)
        const candidate = best.slice();
        candidate.splice(i, j - i + 1, ...best.slice(i, j + 1).reverse());

        if (routeDuration(candidate, matrix) < routeDuration(best, matrix)) {
          best = candidate;
          improved = true;
        }
      }
    }
  }

  return best;
}
