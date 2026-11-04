// Deterministic Stack rules, shared by the browser game and the game server.
//
// A run is fully described by its click timeline: the milliseconds (integers,
// measured from the moment the run started) at which the player dropped each
// block. Given the same timeline, the browser and the server compute the exact
// same tower, so the server never has to trust a score sent by the client.
//
// Keep this file free of DOM / Node APIs and of any randomness.

export const RULES = Object.freeze({
  VERSION: 2,
  BLOCK_HEIGHT: 1,
  BASE_SIZE: 10,
  TRAVEL: 17, // how far from the tower centre a new block starts (a longer swing is a faster, harder one)
  BASE_PERIOD_MS: 3000, // one full swing (out and back) on the first level
  MIN_PERIOD_MS: 1100, // fastest swing
  PERIOD_DECAY: 0.975, // each level swings this much faster
  PERFECT_TOLERANCE: 0.25, // drops closer than this snap perfectly onto the tower
  MIN_OVERLAP: 0.02, // anything thinner than this counts as a miss
  MIN_CLICK_GAP_MS: 60, // faster than any human double-tap
  MAX_CLICKS: 5000,
  MAX_RUN_MS: 30 * 60 * 1000,
});

const PRECISION = 1e4;
const q = (v) => Math.round(v * PRECISION) / PRECISION;

/** Axis the block on `level` slides along. Level 0 is the base. */
export const axisFor = (level) => (level % 2 === 1 ? 'x' : 'z');

/** Duration of one full swing on `level`, in ms. */
export function periodFor(level) {
  const p = RULES.BASE_PERIOD_MS * Math.pow(RULES.PERIOD_DECAY, level - 1);
  return Math.max(RULES.MIN_PERIOD_MS, Math.round(p));
}

/** Offset of the sliding block from the centre of the block below it. */
export function offsetAt(level, msSinceSpawn) {
  const t = Math.max(0, msSinceSpawn);
  return q(-RULES.TRAVEL * Math.cos((2 * Math.PI * t) / periodFor(level)));
}

export class StackSim {
  constructor() {
    const s = RULES.BASE_SIZE;
    /** Settled layers, bottom first. Each: { x, z, w, d } (centre + size). */
    this.layers = [{ x: 0, z: 0, w: s, d: s }];
    this.spawnAt = 0;
    this.over = false;
    this.combo = 0;
    this.perfects = 0;
    this.lastClickAt = -Infinity;
  }

  get score() {
    return this.layers.length - 1;
  }

  /** Level index of the block that is currently sliding. */
  get level() {
    return this.layers.length;
  }

  get top() {
    return this.layers[this.layers.length - 1];
  }

  /** Where the sliding block is at absolute run time `nowMs`. */
  movingAt(nowMs) {
    const level = this.level;
    const axis = axisFor(level);
    const top = this.top;
    const off = offsetAt(level, nowMs - this.spawnAt);
    return {
      level,
      axis,
      offset: off,
      x: axis === 'x' ? q(top.x + off) : top.x,
      z: axis === 'z' ? q(top.z + off) : top.z,
      w: top.w,
      d: top.d,
    };
  }

  /**
   * Drop the sliding block at absolute run time `nowMs` (integer ms).
   * Returns { type: 'hit' | 'perfect' | 'miss', placed?, debris? }.
   */
  drop(nowMs) {
    if (this.over) throw new Error('run is over');
    const moving = this.movingAt(nowMs);
    const { axis, level } = moving;
    const top = this.top;
    const size = axis === 'x' ? top.w : top.d;
    const centre = axis === 'x' ? top.x : top.z;

    let delta = moving.offset;
    let perfect = false;
    if (Math.abs(delta) <= RULES.PERFECT_TOLERANCE) {
      delta = 0;
      perfect = true;
    }

    const overlap = q(size - Math.abs(delta));
    this.lastClickAt = nowMs;

    if (overlap < RULES.MIN_OVERLAP) {
      this.over = true;
      this.combo = 0;
      return { type: 'miss', level, debris: { ...moving, axis } };
    }

    const placedCentre = q(centre + delta / 2);
    const placed = {
      x: axis === 'x' ? placedCentre : top.x,
      z: axis === 'z' ? placedCentre : top.z,
      w: axis === 'x' ? overlap : top.w,
      d: axis === 'z' ? overlap : top.d,
    };

    let debris = null;
    const cut = q(Math.abs(delta));
    if (!perfect && cut > 0) {
      const sign = Math.sign(delta);
      const movingCentre = centre + delta;
      const debrisCentre = q(movingCentre + sign * (size / 2 - cut / 2));
      debris = {
        axis,
        level,
        x: axis === 'x' ? debrisCentre : top.x,
        z: axis === 'z' ? debrisCentre : top.z,
        w: axis === 'x' ? cut : top.w,
        d: axis === 'z' ? cut : top.d,
        direction: sign,
      };
    }

    this.layers.push(placed);
    this.spawnAt = nowMs;
    if (perfect) {
      this.combo += 1;
      this.perfects += 1;
    } else {
      this.combo = 0;
    }
    return { type: perfect ? 'perfect' : 'hit', level, placed, debris };
  }
}

/**
 * Checks a click timeline's shape. Returns an error string, or null if valid.
 */
export function validateTimeline(clicks) {
  if (!Array.isArray(clicks)) return 'clicks must be an array';
  if (clicks.length > RULES.MAX_CLICKS) return 'too many clicks';
  let prev = -Infinity;
  for (let i = 0; i < clicks.length; i++) {
    const t = clicks[i];
    if (typeof t !== 'number' || !Number.isInteger(t)) return `click ${i} is not an integer`;
    if (t < 0 || t > RULES.MAX_RUN_MS) return `click ${i} is out of range`;
    if (t - prev < RULES.MIN_CLICK_GAP_MS) return `click ${i} is too fast`;
    prev = t;
  }
  return null;
}

/**
 * Replays a whole run. Every click except the last must land on the tower;
 * the last may miss (game over) or land (player quit).
 * Returns { ok: true, score, perfects, ended, durationMs } or { ok: false, reason }.
 */
export function replay(clicks) {
  const err = validateTimeline(clicks);
  if (err) return { ok: false, reason: err };

  const sim = new StackSim();
  for (let i = 0; i < clicks.length; i++) {
    if (sim.over) return { ok: false, reason: 'clicks after game over' };
    sim.drop(clicks[i]);
  }
  return {
    ok: true,
    score: sim.score,
    perfects: sim.perfects,
    ended: sim.over ? 'miss' : 'quit',
    durationMs: clicks.length ? clicks[clicks.length - 1] : 0,
  };
}
