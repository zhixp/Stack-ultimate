import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { STACK_ULTIMATE_ABI } from '../shared/stackUltimateAbi.js';
import { CONTRACT_ADDRESS, PRIVY_APP_ID } from './config.js';
import { StackScene } from './game/StackScene.js';
import { useGameState } from './hooks/useGameState.js';
import { useSession } from './hooks/useSession.js';
import { api, ApiError } from './lib/api.js';
import { friendlyError, publicClient, walletClientFor } from './lib/chain.js';
import { TopBar } from './components/TopBar.jsx';
import { Lobby } from './components/Lobby.jsx';
import { GameOver } from './components/GameOver.jsx';
import { Leaderboard } from './components/Leaderboard.jsx';
import { Toasts } from './components/Toasts.jsx';
import { SkyChip } from './components/SkyChip.jsx';
import { setSky } from './lib/sky.js';
import { useToasts } from './hooks/useToasts.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNarrow = () => window.matchMedia('(max-width: 860px)').matches;
const BEST_KEY = 'stack.practice.best';

function practiceBest(score) {
  try {
    const best = Math.max(score, Number(localStorage.getItem(BEST_KEY)) || 0);
    localStorage.setItem(BEST_KEY, String(best));
    return best;
  } catch {
    return score;
  }
}

/** Without a Privy app id the page still works for practice runs. */
const usePrivySafe = PRIVY_APP_ID
  ? usePrivy
  : () => ({ ready: true, authenticated: false, user: null, login: () => {}, logout: () => {} });
const useWalletsSafe = PRIVY_APP_ID ? useWallets : () => ({ wallets: [] });

export default function App() {
  const { ready, authenticated, user, login, logout } = usePrivySafe();
  const { wallets } = useWalletsSafe();
  const wallet = useMemo(() => {
    if (!authenticated) return null;
    const primary = user?.wallet?.address?.toLowerCase();
    return wallets.find((w) => w.address.toLowerCase() === primary) || wallets[0] || null;
  }, [authenticated, user, wallets]);
  const address = wallet?.address;

  const { state, error: stateError, refresh } = useGameState(address);
  const session = useSession(wallet);
  const { toasts, push, dismiss } = useToasts();

  const [phase, setPhase] = useState('lobby'); // lobby | playing | over
  const [busy, setBusy] = useState(null); // null | 'start' | 'buy' | 'claim'
  const [mode, setMode] = useState('ranked');
  const [live, setLive] = useState({ score: 0, combo: 0, flash: 0 });
  const [result, setResult] = useState(null);
  const [showBoard, setShowBoard] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [narrow, setNarrow] = useState(isNarrow);

  const stageRef = useRef(null);
  const sceneRef = useRef(null);
  const runRef = useRef(null); // { sessionId, clicks }
  const handlers = useRef({});

  // ------------------------------------------------------------ 3D scene
  useEffect(() => {
    const scene = new StackScene(stageRef.current, {
      onDrop: (e) => handlers.current.onDrop?.(e),
      onEnd: (e) => handlers.current.onEnd?.(e),
      onWorld: setSky,
    });
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 860px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    // Only the lobby card covers part of the world; the other screens float their type in the sky.
    if (phase !== 'lobby' || !CONTRACT_ADDRESS) scene.setShift(0, 0);
    else if (narrow) scene.setShift(0, -0.2);
    else scene.setShift(-0.12, 0);
  }, [phase, narrow]);

  // ------------------------------------------------------------- runs
  const submitRun = useCallback(
    async (run) => {
      setResult({ status: 'verifying', score: run.score, perfects: run.perfects });
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await session.withSession((token) =>
            api('/game/finish', { token, body: { sessionId: run.sessionId, clicks: run.clicks } }),
          );
          setResult({
            status: res.score === 0 ? 'zero' : res.counted ? 'recorded' : 'recordedOld',
            score: res.score,
            perfects: res.perfects,
            tx: res.tx,
          });
          refresh();
          return;
        } catch (err) {
          lastErr = err;
          const retryable = err instanceof ApiError && (err.status === 0 || err.code === 'retry' || err.status >= 500);
          if (!retryable) break;
          await sleep(1200 * (attempt + 1));
        }
      }
      const retryable = lastErr instanceof ApiError && lastErr.code === 'retry';
      setResult({
        status: lastErr instanceof ApiError && lastErr.code === 'rejected' ? 'rejected' : 'error',
        score: run.score,
        perfects: run.perfects,
        message: lastErr?.message || 'Could not save this run.',
        retryable,
      });
      refresh();
    },
    [session, refresh],
  );

  handlers.current.onDrop = (e) => setLive((l) => ({ score: e.score, combo: e.combo, flash: e.type === 'perfect' ? l.flash + 1 : l.flash }));
  handlers.current.onEnd = (e) => {
    setPhase('over');
    setConfirmExit(false);
    if (mode === 'practice' || !runRef.current) {
      setResult({ status: 'practice', score: e.score, perfects: e.perfects, best: practiceBest(e.score) });
      return;
    }
    const run = { ...runRef.current, clicks: e.clicks, score: e.score, perfects: e.perfects };
    runRef.current = run;
    submitRun(run);
  };

  const beginRun = useCallback(
    async (practice) => {
      if (busy) return;
      setResult(null);
      setLive({ score: 0, combo: 0, flash: 0 });
      if (practice) {
        runRef.current = null;
        setMode('practice');
        setPhase('playing');
        sceneRef.current?.start();
        return;
      }
      if (!authenticated) return login();
      setBusy('start');
      try {
        const res = await session.withSession((token) => api('/game/start', { token, body: {} }));
        runRef.current = { sessionId: res.sessionId };
        setMode('ranked');
        setPhase('playing');
        sceneRef.current?.start();
        refresh();
      } catch (err) {
        setPhase('lobby');
        push(err instanceof ApiError ? err.message : friendlyError(err), { tone: 'error' });
      } finally {
        setBusy(null);
      }
    },
    [busy, authenticated, login, session, refresh, push],
  );

  const leaveRun = useCallback(() => {
    sceneRef.current?.stop();
    runRef.current = null;
    setConfirmExit(false);
    setResult(null);
    setPhase('lobby');
    refresh();
  }, [refresh]);

  // --------------------------------------------------------- wallet txs
  const sendTx = useCallback(
    async (kind, functionName, args, value, successText) => {
      if (busy) return;
      setBusy(kind);
      const toastId = push('Confirm in your wallet', { ttl: 0 });
      try {
        const client = await walletClientFor(wallet);
        const hash = await client.writeContract({
          address: CONTRACT_ADDRESS,
          abi: STACK_ULTIMATE_ABI,
          functionName,
          args,
          value,
          account: wallet.address,
        });
        push('Waiting for Base to confirm', { id: toastId, ttl: 0 });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status !== 'success') throw new Error('Transaction reverted.');
        push(successText, { id: toastId, tone: 'success' });
        refresh();
      } catch (err) {
        push(friendlyError(err), { id: toastId, tone: 'error' });
      } finally {
        setBusy(null);
      }
    },
    [busy, wallet, push, refresh],
  );

  const buy = useCallback(
    (count) => {
      if (!state) return;
      const value = state.ticketPrice * BigInt(count);
      sendTx('buy', 'buyTickets', [BigInt(count)], value, `${count} ticket${count === 1 ? '' : 's'} added. Good luck!`);
    },
    [state, sendTx],
  );
  const claim = useCallback(() => sendTx('claim', 'claim', [], undefined, 'Prize sent to your wallet.'), [sendTx]);

  // -------------------------------------------------------------- input
  useEffect(() => {
    const onKey = (e) => {
      if (phase !== 'playing' || confirmExit) return;
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (!e.repeat) sceneRef.current?.drop();
      } else if (e.code === 'Escape') {
        if (mode === 'practice') leaveRun();
        else setConfirmExit(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, mode, confirmExit, leaveRun]);

  const onStagePointer = (e) => {
    if (phase !== 'playing' || confirmExit) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    sceneRef.current?.drop();
  };

  const tickets = state ? Number(state.tickets) : 0;

  return (
    <div className={`app phase-${phase}`}>
      <div ref={stageRef} className="stage" onPointerDown={onStagePointer} />

      {phase !== 'playing' && (
        <TopBar
          ready={ready}
          authenticated={authenticated}
          address={address}
          onLogin={login}
          onLogout={logout}
          onLeaderboard={() => setShowBoard(true)}
        />
      )}

      {phase === 'playing' && (
        <div className="hud">
          <div className="hud-floor">
            <span className="label">
              Floor{mode === 'practice' && <span className="label-dim"> · practice</span>}
            </span>
            <span className="num" key={live.score}>
              {live.score}
            </span>
            {live.combo > 0 && (
              <span className="hud-combo" key={`c${live.flash}`}>
                {live.combo > 1 ? `Perfect x${live.combo}` : 'Perfect'}
              </span>
            )}
          </div>
          <div className="hud-right">
            <SkyChip />
            <button
              type="button"
              className="btn btn-glass"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => (mode === 'practice' ? leaveRun() : setConfirmExit(true))}
            >
              {mode === 'practice' ? 'Exit' : 'Leave'}
            </button>
          </div>
          {live.score === 0 && <div className="hud-hint">Tap, click or press Space to drop</div>}
        </div>
      )}
      {phase !== 'playing' && (
        <div className={`sky-corner ${phase === 'lobby' && CONTRACT_ADDRESS ? 'sky-corner-card' : ''}`}>
          <SkyChip />
        </div>
      )}

      {confirmExit && (
        <div className="sheet-backdrop">
          <div className="sheet sheet-small" role="alertdialog" aria-modal="true" aria-label="Leave this run?">
            <h2>Leave this run?</h2>
            <p className="muted">The ticket is already spent. Leaving ends this run without a score.</p>
            <div className="row">
              <button type="button" className="btn btn-accent btn-lg" onClick={() => setConfirmExit(false)}>
                Keep playing
              </button>
              <button type="button" className="btn btn-soft btn-lg" onClick={leaveRun}>
                Leave
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === 'lobby' && (
        <Lobby
          state={state}
          stateError={stateError}
          authenticated={authenticated}
          address={address}
          busy={busy}
          hasSession={session.hasSession()}
          onLogin={login}
          onPlay={() => beginRun(false)}
          onPractice={() => beginRun(true)}
          onBuy={buy}
          onClaim={claim}
        />
      )}

      {phase === 'over' && result && (
        <GameOver
          result={result}
          highScore={state?.highScore}
          bestScore={state?.bestScore}
          tickets={tickets}
          onAgain={beginRun}
          onLobby={() => {
            setResult(null);
            setPhase('lobby');
            sceneRef.current?.stop();
          }}
          onRetry={() => runRef.current && submitRun(runRef.current)}
        />
      )}

      <Leaderboard open={showBoard} onClose={() => setShowBoard(false)} me={address} />
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}
