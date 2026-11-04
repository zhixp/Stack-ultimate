import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, StackSim, replay, validateTimeline, offsetAt, periodFor, axisFor } from '../shared/stackCore.js';
import { buildRun } from './helpers.js';

test('block starts far out and crosses the centre a quarter swing later', () => {
  assert.equal(offsetAt(1, 0), -RULES.TRAVEL);
  assert.ok(Math.abs(offsetAt(1, periodFor(1) / 4)) < 1e-3);
  assert.ok(Math.abs(offsetAt(1, periodFor(1) / 2) - RULES.TRAVEL) < 1e-3);
});

test('swing speeds up per level but never past the cap', () => {
  assert.ok(periodFor(10) < periodFor(1));
  assert.equal(periodFor(500), RULES.MIN_PERIOD_MS);
});

test('axes alternate', () => {
  assert.equal(axisFor(1), 'x');
  assert.equal(axisFor(2), 'z');
});

test('perfect drops snap and keep the full size', () => {
  const r = replay(buildRun({ hits: 5, errorMs: 0 }));
  assert.equal(r.ok, true);
  assert.equal(r.score, 5);
  assert.equal(r.perfects, 5);
  assert.equal(r.ended, 'miss');
});

test('imperfect drops shrink the tower and drop debris', () => {
  const sim = new StackSim();
  const res = sim.drop(Math.round(periodFor(1) / 4) + 40);
  assert.equal(res.type, 'hit');
  assert.ok(res.placed.w < RULES.BASE_SIZE);
  assert.equal(res.placed.d, RULES.BASE_SIZE);
  assert.ok(res.debris);
  // placed + debris widths add up to the original block
  assert.ok(Math.abs(res.placed.w + res.debris.w - RULES.BASE_SIZE) < 1e-3);
});

test('dropping right away misses', () => {
  const r = replay([RULES.MIN_CLICK_GAP_MS]);
  assert.deepEqual([r.ok, r.score, r.ended], [true, 0, 'miss']);
});

test('replay is deterministic', () => {
  const clicks = buildRun({ hits: 30, errorMs: 25 });
  assert.deepEqual(replay(clicks), replay([...clicks]));
});

test('replay matches the live simulation step by step', () => {
  const clicks = buildRun({ hits: 12, errorMs: 18 });
  const sim = new StackSim();
  for (const t of clicks) sim.drop(t);
  assert.equal(replay(clicks).score, sim.score);
});

test('quitting mid-run is reported as quit', () => {
  const r = replay(buildRun({ hits: 4, endWithMiss: false }));
  assert.equal(r.ended, 'quit');
  assert.equal(r.score, 4);
});

test('timeline validation rejects malformed input', () => {
  assert.match(validateTimeline('nope'), /array/);
  assert.match(validateTimeline([1.5]), /integer/);
  assert.match(validateTimeline([-1]), /range/);
  assert.match(validateTimeline([100, 120]), /too fast/);
  assert.match(validateTimeline([200, 100]), /too fast/);
  assert.match(validateTimeline(new Array(RULES.MAX_CLICKS + 1).fill(0)), /too many/);
  assert.match(validateTimeline([RULES.MAX_RUN_MS + 1]), /range/);
  assert.match(validateTimeline(['100']), /integer/);
  assert.equal(validateTimeline([]), null);
});

test('clicks after game over are rejected', () => {
  const clicks = buildRun({ hits: 2 });
  clicks.push(clicks.at(-1) + 500);
  assert.equal(replay(clicks).ok, false);
});

test('drop after game over throws in the live sim', () => {
  const sim = new StackSim();
  sim.drop(60);
  assert.throws(() => sim.drop(500));
});
