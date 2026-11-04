import { isAddress, getAddress } from 'viem';
import { base, baseSepolia, foundry } from 'viem/chains';

export const CHAINS = { base, 'base-sepolia': baseSepolia, anvil: foundry };

function int(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}

export function loadConfig(env = process.env) {
  const errors = [];
  const chainName = env.CHAIN || 'base-sepolia';
  const chain = CHAINS[chainName];
  if (!chain) errors.push(`CHAIN must be one of ${Object.keys(CHAINS).join(', ')}`);

  const operatorKey = env.OPERATOR_PRIVATE_KEY || '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(operatorKey)) errors.push('OPERATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');

  const contract = env.CONTRACT_ADDRESS || '';
  if (!isAddress(contract)) errors.push('CONTRACT_ADDRESS must be a valid address');

  const sessionSecret = env.SESSION_SECRET || '';
  if (sessionSecret.length < 32) errors.push('SESSION_SECRET must be at least 32 characters');

  if (errors.length) throw new Error(`Invalid server config:\n  - ${errors.join('\n  - ')}`);

  return Object.freeze({
    chain,
    chainName,
    rpcUrl: env.RPC_URL || chain.rpcUrls.default.http[0],
    operatorKey,
    contract: getAddress(contract),
    sessionSecret,
    port: int(env, 'PORT', 8787),
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    dataDir: env.DATA_DIR || 'data',
    staticDir: env.STATIC_DIR || 'dist',
    sessionTtlMs: int(env, 'SESSION_TTL_HOURS', 24 * 7) * 3600_000,
    // Anti-cheat. A run's timeline must line up with real time: the final
    // drop has to reach the server within FINISH_LAG_MS (+ a share of the run).
    clockSkewMs: int(env, 'CLOCK_SKEW_MS', 1500),
    finishLagMs: int(env, 'FINISH_LAG_MS', 5000),
    finishLagRatio: int(env, 'FINISH_LAG_RATIO', 0.02),
    botMinScore: int(env, 'BOT_MIN_SCORE', 25),
    botPerfectRatio: int(env, 'BOT_PERFECT_RATIO', 0.9),
    rateLimitPerMin: int(env, 'RATE_LIMIT_PER_MIN', 120),
  });
}
