import { useSyncExternalStore } from 'react';

/*
  The 3D world reports its time of day and weather here many times a second.
  The page theme (text ink over the sky, day or night surfaces) is written
  straight to the document; components subscribe to just the fields they show.
*/

let state = { ink: '#eef1ff', night: true, minutes: 0, weather: 'clear', icon: 'moon' };
const subs = new Set();

export function setSky(next) {
  const root = document.documentElement;
  if (next.ink !== state.ink) root.style.setProperty('--sky-ink', next.ink);
  if (next.night !== state.night || !root.dataset.sky) root.dataset.sky = next.night ? 'night' : 'day';
  state = { ...next };
  for (const fn of subs) fn();
}

function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** Subscribe to one field of the sky (pass a selector returning a primitive). */
export function useSky(select) {
  return useSyncExternalStore(subscribe, () => select(state));
}

export const clockText = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
