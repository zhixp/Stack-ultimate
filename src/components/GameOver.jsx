import { ArrowClockwise, ArrowSquareOut, CheckCircle, Crown, WarningCircle } from '@phosphor-icons/react';
import { txUrl } from '../lib/chain.js';
import { CHAIN_LABEL } from '../config.js';

const STATUS = {
  verifying: { tone: 'pending', text: 'Checking your run' },
  recorded: { tone: 'ok', text: `Saved on ${CHAIN_LABEL}` },
  recordedOld: { tone: 'ok', text: 'Saved. The round ended before you finished, so it does not count for this pot.' },
  zero: { tone: 'muted', text: 'No floors placed, nothing to save' },
  rejected: { tone: 'bad' },
  error: { tone: 'bad' },
  practice: { tone: 'muted', text: 'Practice runs are not saved' },
};

/** Three blocks settling into place: the loading state for "verifying". */
const StackLoader = () => (
  <span className="stack-loader" aria-hidden="true">
    <i />
    <i />
    <i />
  </span>
);

export function GameOver({ result, highScore, bestScore, tickets, onAgain, onLobby, onRetry }) {
  const s = STATUS[result.status] || STATUS.error;
  const done = result.status !== 'verifying';
  const practice = result.status === 'practice';
  const leads = result.status === 'recorded' && highScore != null && result.score > 0 && result.score >= Number(highScore);
  const link = txUrl(result.tx);
  const best = practice ? result.best : bestScore != null ? Math.max(Number(bestScore), result.score) : null;

  return (
    <section className="hero hero-over" aria-live="polite" aria-label="Run over">
      <p className="kicker rise">{practice ? 'Practice run' : 'The tower fell'}</p>
      <h1 className="hero-title rise">
        Floor <span className="tnum">{result.score}</span>
      </h1>

      <div className="rise over-body">
        <dl className="stats">
          {best != null && (
            <div>
              <dd>{best}</dd>
              <dt>Best</dt>
            </div>
          )}
          <div>
            <dd>{result.perfects}</dd>
            <dt>Perfect drops</dt>
          </div>
          {!practice && highScore != null && (
            <div>
              <dd>{Number(highScore)}</dd>
              <dt>Score to beat</dt>
            </div>
          )}
        </dl>

        {leads && (
          <p className="lead-banner">
            <Crown size={18} weight="fill" aria-hidden="true" /> Top score this round
          </p>
        )}

        <p className={`status status-${s.tone}`}>
          {s.tone === 'pending' && <StackLoader />}
          {s.tone === 'ok' && <CheckCircle size={18} weight="fill" aria-hidden="true" />}
          {s.tone === 'bad' && <WarningCircle size={18} weight="fill" aria-hidden="true" />}
          <span>{s.text || result.message}</span>
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer" aria-label="View transaction">
              <ArrowSquareOut size={16} weight="bold" aria-hidden="true" />
            </a>
          )}
        </p>

        <div className="row">
          {result.status === 'error' && result.retryable ? (
            <button type="button" className="btn btn-accent btn-hero" onClick={onRetry}>
              Try saving again
            </button>
          ) : practice ? (
            <button type="button" className="btn btn-accent btn-hero" onClick={() => onAgain(true)}>
              <ArrowClockwise size={18} weight="bold" aria-hidden="true" />
              Climb again
            </button>
          ) : (
            <button type="button" className="btn btn-accent btn-hero" onClick={() => onAgain(false)} disabled={!done || tickets < 1}>
              <ArrowClockwise size={18} weight="bold" aria-hidden="true" />
              {tickets > 0 ? `Climb again (${tickets} left)` : 'Out of tickets'}
            </button>
          )}
          <button type="button" className="btn btn-glass btn-hero" onClick={onLobby} disabled={!done}>
            Lobby
          </button>
        </div>
      </div>
    </section>
  );
}
