import { useCallback, useEffect, useRef, useState } from 'react';
import { zeroAddress } from 'viem';
import { STACK_ULTIMATE_ABI } from '../../shared/stackUltimateAbi.js';
import { CONTRACT_ADDRESS } from '../config.js';
import { publicClient } from '../lib/chain.js';

const POLL_MS = 8000;

/** Polls the contract for the lobby: pot, round, king, and the player's tickets. */
export function useGameState(address) {
  const player = address || zeroAddress;
  // Results are tagged with the address they belong to, so switching wallets
  // never shows the previous wallet's tickets.
  const [snap, setSnap] = useState({ player: null, value: null, error: null });
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!CONTRACT_ADDRESS) return;
    const id = ++seq.current;
    try {
      const value = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: STACK_ULTIMATE_ABI,
        functionName: 'getState',
        args: [player],
      });
      if (id === seq.current) setSnap({ player, value, error: null });
    } catch (error) {
      if (id === seq.current) setSnap((s) => ({ ...s, error }));
    }
  }, [player]);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const current = snap.player === player;
  return { state: current ? snap.value : null, error: snap.error, refresh };
}
