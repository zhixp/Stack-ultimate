import { useEffect, useState } from 'react';
import { X } from '@phosphor-icons/react';
import { api } from '../lib/api.js';
import { shortAddress } from '../lib/format.js';

export function Leaderboard({ open, onClose, me }) {
  const [tab, setTab] = useState('round');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    api('/leaderboard', { signal: ctrl.signal })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => ctrl.abort();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const rows = data ? (tab === 'round' ? data.round : data.allTime) : [];

  return (
    <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Leaderboard">
        <div className="sheet-head">
          <h2>Leaderboard</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'round'} className={tab === 'round' ? 'on' : ''} onClick={() => setTab('round')}>
            Round {data ? data.roundId : ''}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>
            All time
          </button>
        </div>
        {error && <p className="notice notice-warn">{error}</p>}
        {!data && !error && (
          <div className="board-skeleton" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="skeleton" />
            ))}
          </div>
        )}
        {data && rows.length === 0 && <p className="muted center">No scores yet. The first run sets the bar.</p>}
        <ol className="board">
          {rows.map((r, i) => (
            <li key={r.player} className={me && r.player.toLowerCase() === me.toLowerCase() ? 'me' : ''}>
              <span className={`rank rank-${i + 1}`}>{i + 1}</span>
              <span className="who">{shortAddress(r.player)}</span>
              <span className="pts">{r.score}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
