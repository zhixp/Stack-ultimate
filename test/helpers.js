import { periodFor } from '../shared/stackCore.js';

/**
 * Builds a click timeline that lands `hits` blocks and then misses.
 * `errorMs` shifts each drop away from the perfect moment (0 = bot-perfect).
 */
export function buildRun({ hits, errorMs = 30, start = 0, endWithMiss = true }) {
  const clicks = [];
  let t = start;
  for (let level = 1; level <= hits; level++) {
    t += Math.round(periodFor(level) / 4) + errorMs;
    clicks.push(t);
  }
  if (endWithMiss) clicks.push(t + 100);
  return clicks;
}
