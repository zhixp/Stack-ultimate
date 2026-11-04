import { randomUUID } from 'node:crypto';
import { replay, RULES } from '../shared/stackCore.js';
import { HttpError } from './errors.js';

const SESSION_GRACE_MS = 5 * 60_000;

/**
 * Tracks live runs. A run burns its ticket on-chain the moment it starts, so
 * closing the tab on a bad run never refunds the ticket. When the run ends the
 * click timeline is replayed with the shared rules and checked against real
 * time before the score goes on-chain.
 */
export class GameManager {
  constructor({ chain, config, leaderboard, now = Date.now, log = console }) {
    this.chain = chain;
    this.config = config;
    this.leaderboard = leaderboard;
    this.now = now;
    this.log = log;
    this.sessions = new Map(); // id -> session
    this.byPlayer = new Map(); // player -> id of current run
    this.starting = new Set(); // players with a start in flight
  }

  async start(player) {
    if (this.starting.has(player)) throw new HttpError(429, 'A run is already starting');
    this.starting.add(player);
    try {
      // Only one live run per player. Starting again abandons the old one, but
      // we wait for its ticket burn to land so the ticket count below is exact.
      const prevId = this.byPlayer.get(player);
      if (prevId) {
        const prev = this.sessions.get(prevId);
        if (prev && prev.status === 'playing') prev.status = 'abandoned';
        if (prev) await prev.gameId.catch(() => {});
        this.byPlayer.delete(player);
      }

      const state = await this.chain.readPlayer(player);
      if (state.paused) throw new HttpError(503, 'The game is paused right now');
      if (state.tickets === 0n) throw new HttpError(402, 'You have no tickets left', 'no_tickets');

      let started;
      try {
        started = await this.chain.startGame(player);
      } catch (err) {
        this.log.error('[start] startGame failed', err.shortMessage || err.message);
        throw new HttpError(502, 'Could not use your ticket, please try again');
      }

      const session = {
        id: randomUUID(),
        player,
        status: 'playing',
        startedAt: this.now(),
        startTx: started.hash,
        gameId: started.gameId,
        result: null,
      };
      this.sessions.set(session.id, session);
      this.byPlayer.set(player, session.id);
      return {
        sessionId: session.id,
        startTx: started.hash,
        ticketsLeft: Number(state.tickets - 1n),
      };
    } finally {
      this.starting.delete(player);
    }
  }

  /**
   * Idempotent: a retried finish for the same run returns the same result.
   * If only the on-chain write failed, a retry re-sends the already verified
   * score without checking the timeline again.
   */
  finish(player, sessionId, clicks) {
    const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
    if (!session || session.player !== player) return Promise.reject(new HttpError(404, 'Run not found or expired'));
    if (session.result) return session.result;

    if (session.status === 'submit_failed') {
      session.status = 'submitting';
      session.result = this.#submit(session);
    } else if (session.status === 'playing') {
      session.status = 'verifying';
      session.result = this.#verify(session, clicks).then(() => this.#submit(session));
    } else if (session.status === 'abandoned') {
      return Promise.reject(new HttpError(409, 'This run was replaced by a newer one'));
    } else {
      return Promise.reject(new HttpError(409, 'This run is already closed'));
    }
    session.result.catch(() => {});
    return session.result;
  }

  async #verify(session, clicks) {
    const { config } = this;
    const received = this.now();
    const elapsed = received - session.startedAt;

    const run = replay(clicks);
    if (!run.ok) return this.#reject(session, `Invalid run: ${run.reason}`);
    if (run.ended !== 'miss') return this.#reject(session, 'Run did not finish');

    // The timeline cannot be ahead of real time...
    if (run.durationMs > elapsed + config.clockSkewMs) return this.#reject(session, 'Run timeline is ahead of the clock');
    // ...and must not lag far behind it (slowed-down or paused clients).
    const allowedLag = config.finishLagMs + config.finishLagRatio * run.durationMs;
    if (elapsed - run.durationMs > allowedLag) return this.#reject(session, 'Run arrived too late to verify');

    if (run.score >= config.botMinScore && run.perfects / run.score >= config.botPerfectRatio) {
      this.log.warn(`[finish] flagged ${session.player}: ${run.perfects}/${run.score} perfect`);
      return this.#reject(session, 'Run flagged by anti-cheat');
    }

    try {
      session.verified = { run, gameId: await session.gameId };
    } catch (err) {
      this.log.error('[finish] ticket burn failed', err.message);
      this.#close(session, 'failed');
      throw new HttpError(409, 'Your ticket was not used on-chain, so this run cannot be scored');
    }
  }

  async #submit(session) {
    const { run, gameId } = session.verified;
    let tx = null;
    let roundId = null;
    let counted = false;

    if (run.score > 0) {
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await this.chain.submitScore(gameId, run.score);
          ({ hash: tx, roundId, counted } = res);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          this.log.error(`[finish] submitScore attempt ${attempt + 1} failed`, err.shortMessage || err.message);
        }
      }
      if (lastErr) {
        session.status = 'submit_failed'; // the client may retry; the run stays verified
        session.result = null;
        throw new HttpError(502, 'Could not record your score yet, please retry', 'retry');
      }
      this.leaderboard.record({ player: session.player, score: run.score, roundId, counted });
    }

    this.#close(session, 'done');
    return {
      score: run.score,
      perfects: run.perfects,
      gameId: gameId.toString(),
      tx,
      counted,
      roundId: roundId == null ? null : roundId.toString(),
    };
  }

  #reject(session, message) {
    this.#close(session, 'rejected');
    throw new HttpError(422, message, 'rejected');
  }

  #close(session, status) {
    session.status = status;
    if (this.byPlayer.get(session.player) === session.id) this.byPlayer.delete(session.player);
  }

  /** Drops runs nobody finished. Their tickets stay burned. */
  sweep() {
    const cutoff = this.now() - (RULES.MAX_RUN_MS + SESSION_GRACE_MS);
    for (const [id, s] of this.sessions) {
      if (s.startedAt < cutoff) {
        this.sessions.delete(id);
        if (this.byPlayer.get(s.player) === id) this.byPlayer.delete(s.player);
      }
    }
  }
}
