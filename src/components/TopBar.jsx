import { SignOut, Trophy } from '@phosphor-icons/react';
import { CHAIN_LABEL } from '../config.js';
import { shortAddress } from '../lib/format.js';

export function TopBar({ ready, authenticated, address, onLogin, onLogout, onLeaderboard }) {
  return (
    <header className="topbar">
      <div className="brand" aria-label="Stack Ultimate">
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="brand-name">
          Stack <b>Ultimate</b>
        </span>
      </div>
      <nav className="topbar-actions" aria-label="Account">
        <span className="chain" title={`Running on ${CHAIN_LABEL}`}>
          {CHAIN_LABEL}
        </span>
        <button type="button" className="btn btn-soft btn-board" onClick={onLeaderboard}>
          <Trophy size={17} weight="bold" aria-hidden="true" />
          <span className="board-label">Leaderboard</span>
        </button>
        {authenticated ? (
          <div className="account">
            <span className="account-addr">{address ? shortAddress(address) : 'Loading wallet'}</span>
            <button type="button" className="icon-btn" onClick={onLogout} aria-label="Log out" title="Log out">
              <SignOut size={16} weight="bold" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-ink" onClick={onLogin} disabled={!ready}>
            Log in
          </button>
        )}
      </nav>
    </header>
  );
}
