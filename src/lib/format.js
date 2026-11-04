import { formatEther } from 'viem';

export const shortAddress = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

/** ETH amount with sensible precision: 0.0123, 1.25, 0.00009 */
export function eth(wei, max = 5) {
  if (wei == null) return '-';
  const n = Number(formatEther(wei));
  if (n === 0) return '0';
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return n.toLocaleString(undefined, { maximumSignificantDigits: 3, maximumFractionDigits: max + 3 });
}

export function countdown(msLeft) {
  if (msLeft <= 0) return 'settling';
  const s = Math.floor(msLeft / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}
