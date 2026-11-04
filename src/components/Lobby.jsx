import { useEffect, useState } from 'react';
import { ArrowUp, Crown, Minus, Plus } from '@phosphor-icons/react';
import { CONTRACT_ADDRESS, MAX_TICKETS_PER_TX, TICKET_PRESETS } from '../config.js';
import { countdown, eth, shortAddress } from '../lib/format.js';

function useNow(intervalMs) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const Skel = ({ w }) => <span className="skeleton" style={{ width: w }} aria-hidden="true" />;

/** The big type that floats in the sky. `children` sits under the title. */
const Hero = ({ solo, children }) => (
  <section className={`hero ${solo ? 'hero-solo' : ''}`} aria-label="Stack Ultimate">
    <p className="kicker rise">A climbing game on Base</p>
    <h1 className="hero-title rise">
      Stack
      <br />
      Ultimate
    </h1>
    {children}
  </section>
);

export function Lobby({ state, stateError, authenticated, address, busy, hasSession, onLogin, onPlay, onPractice, onBuy, onClaim }) {
  const now = useNow(1000);
  const [count, setCount] = useState(5);
  const loading = !state;
  const tickets = state ? Number(state.tickets) : 0;
  const price = state?.ticketPrice ?? null;
  const total = price != null ? price * BigInt(count) : null;
  const hasKing = Boolean(state?.king && !/^0x0{40}$/i.test(state.king));
  const isKing = hasKing && address && state.king.toLowerCase() === address.toLowerCase();
  const canPlay = authenticated && tickets > 0 && !state?.paused && !busy;
  const msLeft = state ? Number(state.roundEndsAt) * 1000 - now : 0;

  const setClamped = (n) => setCount(Math.max(1, Math.min(MAX_TICKETS_PER_TX, Math.floor(n) || 1)));

  if (!CONTRACT_ADDRESS) {
    return (
      <Hero solo>
        <div className="rise hero-cta">
          <button type="button" className="btn btn-accent btn-hero" onClick={onPractice}>
            <ArrowUp size={18} weight="bold" aria-hidden="true" />
            Start climbing
          </button>
          <p className="hero-note">Free practice. Ranked runs for the prize pot open soon.</p>
        </div>
      </Hero>
    );
  }

  return (
    <>
    <Hero />
    <section className="panel" aria-label="Lobby">
      <div className="pot">
        <span className="eyebrow">Prize pot</span>
        <div className="pot-value">
          {loading ? <Skel w="150px" /> : eth(state.pot)}
          <span className="pot-unit">ETH</span>
        </div>
        <p className="round">
          {loading ? (
            <Skel w="170px" />
          ) : msLeft > 0 ? (
            <>
              Round {state.roundId.toString()} ends in <b>{countdown(msLeft)}</b>
            </>
          ) : (
            <>Round {state.roundId.toString()} is over. The next play pays the winner.</>
          )}
        </p>
      </div>

      <dl className="figures">
        <div>
          <dt>Score to beat</dt>
          <dd>{loading ? <Skel w="44px" /> : state.highScore.toString()}</dd>
          <dd className="sub">
            {loading ? '' : isKing ? (
              <span className="king">
                <Crown size={14} weight="fill" aria-hidden="true" /> You lead
              </span>
            ) : hasKing ? (
              `set by ${shortAddress(state.king)}`
            ) : (
              'Nobody has scored yet'
            )}
          </dd>
        </div>
        <div>
          <dt>Your tickets</dt>
          <dd>{!authenticated ? '0' : loading ? <Skel w="30px" /> : tickets}</dd>
          <dd className="sub">{authenticated && state ? `best run ${state.bestScore.toString()}` : 'log in to see yours'}</dd>
        </div>
      </dl>

      {stateError && !state && <p className="notice notice-warn">Can&apos;t reach Base right now. Retrying.</p>}
      {state?.paused && <p className="notice notice-warn">The game is paused for maintenance.</p>}

      {authenticated && state && state.claimable > 0n && (
        <div className="claim">
          <span>
            You won <b>{eth(state.claimable)} ETH</b>
          </span>
          <button type="button" className="btn btn-ok" onClick={onClaim} disabled={Boolean(busy)}>
            {busy === 'claim' ? 'Claiming' : 'Claim'}
          </button>
        </div>
      )}

      <div className="cta">
        {!authenticated ? (
          <button type="button" className="btn btn-accent btn-xl" onClick={onLogin}>
            Log in to play
          </button>
        ) : (
          <button type="button" className="btn btn-accent btn-xl" onClick={onPlay} disabled={!canPlay}>
            {busy === 'start' ? 'Starting run' : tickets > 0 ? 'Play for the pot' : 'Buy a ticket to play'}
          </button>
        )}
        {authenticated && tickets > 0 && (
          <p className="hint">{hasSession ? 'Each run uses 1 ticket.' : 'Each run uses 1 ticket. Your first run asks for one free signature.'}</p>
        )}
      </div>

      {authenticated && (
        <div className="shop">
          <div className="shop-head">
            <span>Buy tickets</span>
            <span className="muted">{price != null ? `${eth(price)} ETH each` : ''}</span>
          </div>
          <div className="chips" role="group" aria-label="Ticket amount">
            {TICKET_PRESETS.map((n) => (
              <button key={n} type="button" className={`chip ${count === n ? 'chip-on' : ''}`} aria-pressed={count === n} onClick={() => setCount(n)}>
                {n}
              </button>
            ))}
            <div className="stepper">
              <button type="button" aria-label="One fewer ticket" onClick={() => setClamped(count - 1)}>
                <Minus size={14} weight="bold" aria-hidden="true" />
              </button>
              <input
                aria-label="Ticket count"
                inputMode="numeric"
                value={count}
                onChange={(e) => setClamped(Number(e.target.value.replace(/\D/g, '')))}
              />
              <button type="button" aria-label="One more ticket" onClick={() => setClamped(count + 1)}>
                <Plus size={14} weight="bold" aria-hidden="true" />
              </button>
            </div>
          </div>
          <button type="button" className="btn btn-ink btn-lg" onClick={() => onBuy(count)} disabled={!state || state.paused || Boolean(busy)}>
            {busy === 'buy' ? 'Confirming' : `Buy ${count} for ${total != null ? eth(total) : '...'} ETH`}
          </button>
        </div>
      )}

      <button type="button" className="btn-text" onClick={onPractice} disabled={Boolean(busy)}>
        Practice run, free and unranked
      </button>
    </section>
    </>
  );
}
