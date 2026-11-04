import { useCallback, useRef } from 'react';
import { api, ApiError } from '../lib/api.js';
import { walletClientFor } from '../lib/chain.js';

const key = (address) => `stack.session.${address.toLowerCase()}`;
const SAFETY_MS = 60_000;

function load(address) {
  try {
    const raw = localStorage.getItem(key(address));
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && typeof s.token === 'string' && s.expiresAt - SAFETY_MS > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function save(address, session) {
  try {
    localStorage.setItem(key(address), JSON.stringify(session));
  } catch {
    /* storage blocked: the session just lasts for this page */
  }
}

function clear(address) {
  try {
    localStorage.removeItem(key(address));
  } catch {
    /* ignore */
  }
}

/**
 * Game-server session. The player signs one free message, then plays for a
 * week without any more wallet prompts.
 */
export function useSession(wallet) {
  const memory = useRef(new Map());
  const pending = useRef(null);

  const ensure = useCallback(async () => {
    if (!wallet) throw new Error('Connect a wallet first');
    const address = wallet.address;
    const cached = memory.current.get(address.toLowerCase()) || load(address);
    if (cached && cached.expiresAt - SAFETY_MS > Date.now()) return cached.token;
    if (pending.current) return pending.current;

    pending.current = (async () => {
      const { nonce, message } = await api('/auth/nonce', { body: { address } });
      const client = await walletClientFor(wallet);
      const signature = await client.signMessage({ account: address, message });
      const session = await api('/auth/verify', { body: { address, nonce, signature } });
      memory.current.set(address.toLowerCase(), session);
      save(address, session);
      return session.token;
    })();
    try {
      return await pending.current;
    } finally {
      pending.current = null;
    }
  }, [wallet]);

  /** Runs `fn(token)`, signing in again once if the server forgot us. */
  const withSession = useCallback(
    async (fn) => {
      const token = await ensure();
      try {
        return await fn(token);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'auth' && wallet) {
          memory.current.delete(wallet.address.toLowerCase());
          clear(wallet.address);
          return fn(await ensure());
        }
        throw err;
      }
    },
    [ensure, wallet],
  );

  const hasSession = useCallback(() => {
    if (!wallet) return false;
    return Boolean(memory.current.get(wallet.address.toLowerCase()) || load(wallet.address));
  }, [wallet]);

  return { ensure, withSession, hasSession };
}
