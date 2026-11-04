import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAuth } from './auth.js';
import { createChain } from './chain.js';
import { GameManager } from './games.js';
import { HttpError } from './errors.js';
import { Leaderboard } from './leaderboard.js';
import { RULES } from '../shared/stackCore.js';

const MAX_TRACKED_IPS = 50_000;

function rateLimiter(perMinute) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (req, _res, next) => {
    const key = req.ip || 'unknown';
    if (hits.size >= MAX_TRACKED_IPS && !hits.has(key)) hits.clear(); // a flood of fake IPs can't grow memory
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (n > perMinute) return next(new HttpError(429, 'Too many requests, slow down'));
    next();
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((body) => res.json(body), next);

export function createApp(config, deps = {}) {
  const chain = deps.chain || createChain(config);
  const auth = createAuth({
    secret: config.sessionSecret,
    publicClient: chain.publicClient,
    chainId: config.chain.id,
    ttlMs: config.sessionTtlMs,
  });
  const leaderboard = deps.leaderboard || new Leaderboard(config.dataDir);
  const games = new GameManager({ chain, config, leaderboard, log: deps.log || console });
  const sweeper = setInterval(() => games.sweep(), 60_000);
  sweeper.unref();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin && config.allowedOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const api = express.Router();
  api.use(rateLimiter(config.rateLimitPerMin));
  api.use(express.json({ limit: '64kb' }));

  api.get('/health', wrap(async () => ({
    ok: true,
    chainId: config.chain.id,
    contract: config.contract,
    operator: chain.operator,
    rules: RULES.VERSION,
  })));

  // The sign-in message names the site it is for: an allowed browser origin, else this server.
  const signInOrigin = (req) => {
    const origin = req.get('origin');
    return origin && config.allowedOrigins.includes(origin) ? origin : `${req.protocol}://${req.get('host')}`;
  };
  api.post('/auth/nonce', wrap((req) => auth.issueNonce(req.body?.address, signInOrigin(req))));
  api.post('/auth/verify', wrap((req) => auth.verify(req.body || {})));
  api.get('/auth/me', auth.middleware, wrap((req) => ({ address: req.player })));

  api.post('/game/start', auth.middleware, wrap((req) => games.start(req.player)));
  api.post('/game/finish', auth.middleware, wrap((req) => games.finish(req.player, req.body?.sessionId, req.body?.clicks)));

  let roundCache = { at: 0, value: null };
  api.get('/leaderboard', wrap(async () => {
    if (Date.now() - roundCache.at > 10_000 || roundCache.value === null) {
      const s = await chain.readPlayer('0x0000000000000000000000000000000000000000');
      roundCache = { at: Date.now(), value: s.roundId };
    }
    return { roundId: roundCache.value.toString(), ...leaderboard.top(roundCache.value) };
  }));

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/api', api);

  const staticDir = resolve(config.staticDir);
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(resolve(staticDir, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON', code: 'error' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large', code: 'error' });
    console.error('[server] unexpected error', err);
    res.status(500).json({ error: 'Something went wrong on our side', code: 'error' });
  });

  return { app, games, leaderboard, chain, close: () => clearInterval(sweeper) };
}
