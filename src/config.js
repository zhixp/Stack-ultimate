import { isAddress, getAddress } from 'viem';
import { base, baseSepolia, foundry } from 'viem/chains';

const CHAINS = { base, 'base-sepolia': baseSepolia, anvil: foundry };

const env = import.meta.env;
const chainName = env.VITE_CHAIN || 'base-sepolia';

export const CHAIN = CHAINS[chainName] || baseSepolia;
export const CHAIN_LABEL = chainName === 'base' ? 'Base' : chainName === 'anvil' ? 'Local' : 'Base Sepolia';
export const RPC_URL = env.VITE_RPC_URL || CHAIN.rpcUrls.default.http[0];
export const CONTRACT_ADDRESS = isAddress(env.VITE_CONTRACT_ADDRESS || '') ? getAddress(env.VITE_CONTRACT_ADDRESS) : null;
export const API_URL = (env.VITE_API_URL || '').replace(/\/$/, '');
export const PRIVY_APP_ID = env.VITE_PRIVY_APP_ID || '';
export const EXPLORER_URL = CHAIN.blockExplorers?.default?.url || '';

export const TICKET_PRESETS = [1, 5, 10, 25];
export const MAX_TICKETS_PER_TX = 100;
