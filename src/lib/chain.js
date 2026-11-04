import { createPublicClient, createWalletClient, custom, http, BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';
import { CHAIN, RPC_URL, EXPLORER_URL } from '../config.js';

export const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL, { retryCount: 2 }) });

/** Wallet client for a Privy wallet, switched to the game's chain first. */
export async function walletClientFor(wallet) {
  if (!wallet) throw new Error('Connect a wallet first');
  const chainId = Number(String(wallet.chainId || '').split(':').pop());
  if (chainId !== CHAIN.id) await wallet.switchChain(CHAIN.id);
  const provider = await wallet.getEthereumProvider();
  return createWalletClient({ account: wallet.address, chain: CHAIN, transport: custom(provider) });
}

export const txUrl = (hash) => (EXPLORER_URL && hash ? `${EXPLORER_URL}/tx/${hash}` : null);
export const addressUrl = (a) => (EXPLORER_URL && a ? `${EXPLORER_URL}/address/${a}` : null);

const REVERT_MESSAGES = {
  Paused: 'The game is paused right now.',
  WrongPayment: 'Ticket price changed. Refresh and try again.',
  InvalidCount: 'You can buy 1 to 100 tickets at a time.',
  NothingToClaim: 'Nothing to claim yet.',
  TransferFailed: 'Payout failed. Your wallet must be able to receive ETH.',
};

/** Turns wallet / contract errors into one short sentence for the player. */
export function friendlyError(err) {
  if (!err) return 'Something went wrong.';
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return 'You cancelled the request.';
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    const name = revert?.data?.errorName;
    if (name && REVERT_MESSAGES[name]) return REVERT_MESSAGES[name];
    const text = `${err.shortMessage} ${err.details || ''}`.toLowerCase();
    if (text.includes('insufficient funds')) return `Not enough ETH on ${CHAIN.name} to cover this.`;
    return err.shortMessage || 'Transaction failed.';
  }
  const msg = String(err.message || err);
  if (/reject|denied|cancel/i.test(msg)) return 'You cancelled the request.';
  return msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;
}
