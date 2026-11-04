import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, isAddress, isHex } from 'viem';
import { HttpError } from './errors.js';

const NONCE_TTL_MS = 5 * 60_000;
const MAX_PENDING_NONCES = 20_000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signInMessage({ address, nonce, issuedAt, chainId }) {
  return [
    'Sign in to Stack Ultimate',
    '',
    'This only proves you own this wallet. It is free and cannot move funds.',
    '',
    `Wallet: ${address}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

/**
 * One wallet signature buys a session token that lasts `ttlMs`. The token is
 * an HMAC over (address, expiry), so the server needs no session storage.
 */
export function createAuth({ secret, publicClient, chainId, ttlMs, now = Date.now }) {
  const nonces = new Map(); // nonce -> { address, message, expires }

  function prune() {
    const t = now();
    for (const [k, v] of nonces) if (v.expires <= t) nonces.delete(k);
  }

  function sign(payload) {
    return createHmac('sha256', secret).update(payload).digest();
  }

  function issueToken(address) {
    const expiresAt = now() + ttlMs;
    const payload = `${address.toLowerCase()}.${expiresAt}`;
    return { token: `${b64url(payload)}.${b64url(sign(payload))}`, expiresAt };
  }

  function readToken(token) {
    if (typeof token !== 'string' || token.length > 512) return null;
    const [p, s] = token.split('.');
    if (!p || !s) return null;
    const payload = Buffer.from(p, 'base64url').toString('utf8');
    const given = Buffer.from(s, 'base64url');
    const expected = sign(payload);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const [addr, exp] = payload.split('.');
    if (!isAddress(addr) || !(Number(exp) > now())) return null;
    return getAddress(addr);
  }

  return {
    issueNonce(rawAddress) {
      if (typeof rawAddress !== 'string' || !isAddress(rawAddress)) throw new HttpError(400, 'Invalid wallet address');
      if (nonces.size >= MAX_PENDING_NONCES) prune();
      // Still full: evict the oldest so a flood can't lock real players out.
      while (nonces.size >= MAX_PENDING_NONCES) nonces.delete(nonces.keys().next().value);
      const address = getAddress(rawAddress);
      const nonce = randomBytes(16).toString('hex');
      const message = signInMessage({ address, nonce, issuedAt: new Date(now()).toISOString(), chainId });
      nonces.set(nonce, { address, message, expires: now() + NONCE_TTL_MS });
      return { nonce, message };
    },

    async verify({ address: rawAddress, nonce, signature }) {
      if (typeof nonce !== 'string' || typeof rawAddress !== 'string' || !isAddress(rawAddress)) {
        throw new HttpError(400, 'Invalid sign-in request');
      }
      if (typeof signature !== 'string' || !isHex(signature) || signature.length > 20_000) {
        throw new HttpError(400, 'Invalid signature');
      }
      const entry = nonces.get(nonce);
      nonces.delete(nonce); // single use, even when verification fails
      if (!entry || entry.expires <= now()) throw new HttpError(401, 'Sign-in expired, please try again');
      const address = getAddress(rawAddress);
      if (entry.address !== address) throw new HttpError(401, 'Wallet mismatch');

      // publicClient.verifyMessage also handles smart wallets (ERC-1271 / ERC-6492),
      // e.g. Coinbase Smart Wallet on Base.
      let valid = false;
      try {
        valid = await publicClient.verifyMessage({ address, message: entry.message, signature });
      } catch {
        valid = false;
      }
      if (!valid) throw new HttpError(401, 'Signature check failed');
      return { address, ...issueToken(address) };
    },

    readToken,

    middleware(req, _res, next) {
      const header = req.get('authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const address = readToken(token);
      if (!address) return next(new HttpError(401, 'Please sign in again', 'auth'));
      req.player = address;
      next();
    },
  };
}
