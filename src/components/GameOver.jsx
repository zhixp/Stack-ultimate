import { ArrowSquareOut, CheckCircle, Crown, WarningCircle } from '@phosphor-icons/react';
import { txUrl } from '../lib/chain.js';
import { CHAIN_LABEL } from '../config.js';

const STATUS = {
  verifying: { tone: 'pending', text: 'Checking your run' },
  recorded: { tone: 'ok', text: `Saved on ${CHAIN_LABEL}` },
  recordedOld: { tone: 'ok', text: 'Saved. The round ended before you finished, so it does not count for this pot.' },
  zero: { tone: 'muted', text: 'No blocks placed, nothing to save' },
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

export function GameOver({ result, highScore, tickets, onAgain, onLobby, onRetry }) {
  const s = STATUS[result.status] || STATUS.error;
  const done = result.status !== 'verifying';
  const practice = result.status === 'practice';
  const leads = result.status === 'recorded' && highScore != null && result.score > 0 && result.score >= Number(highScore);
  const link = txUrl(result.tx);

  return (
    <section className="panel panel-over" aria-live="polite">
      {practice && <span className="eyebrow">Practice</span>}
      <div className="final-score">{result.score}</div>
      <p className="final-meta">
        {result.score === 1 ? '1 block' : `${result.score} blocks`}
        {result.perfects > 0 && `, ${result.perfects} perfect`}
      </p>

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
          <a href={link} target="_blank" rel="noreferrer" aria-label="View transaction">
            <ArrowSquareOut size={16} weight="bold" aria-hidden="true" />
          </a>
        )}
      </p>

      <div className="row">
        {result.status === 'error' && result.retryable ? (
          <button type="button" className="btn btn-accent btn-lg" onClick={onRetry}>
            Try saving again
          </button>
        ) : practice ? (
          <button type="button" className="btn btn-accent btn-lg" onClick={() => onAgain(true)}>
            Practice again
          </button>
        ) : (
          <button type="button" className="btn btn-accent btn-lg" onClick={() => onAgain(false)} disabled={!done || tickets < 1}>
            {tickets > 0 ? `Play again (${tickets} left)` : 'Out of tickets'}
          </button>
        )}
        <button type="button" className="btn btn-soft btn-lg" onClick={onLobby} disabled={!done}>
          Lobby
        </button>
      </div>
    </section>
  );
}
