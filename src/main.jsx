import React from 'react';
import ReactDOM from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import './index.css';
import App from './App';

// Backup polyfill
window.global = window;

const abstractTestnet = {
  id: 11124,
  name: 'Abstract Testnet',
  network: 'abstract-testnet',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { 
    default: { http: ['https://api.testnet.abs.xyz'] },
    public: { http: ['https://api.testnet.abs.xyz'] },
  },
  blockExplorers: { 
    default: { name: 'AbstractScan', url: 'https://sepolia.abscan.org' } 
  },
  testnet: true,
};

ReactDOM.createRoot(document.getElementById('root')).render(
  // REMOVED STRICT MODE TO FIX PHYSICS CRASH
  <PrivyProvider
    appId="cmi8b6gb801eyl70cxuuxdjuu"
    config={{
      loginMethods: ['email', 'wallet'],
      appearance: {
        theme: 'dark',
        accentColor: '#00ff00',
        logo: 'https://abstract.xyz/favicon.ico',
      },
      embeddedWallets: {
        createOnLogin: 'users-without-wallets',
      },
      supportedChains: [abstractTestnet],
      defaultChain: abstractTestnet,
    }}
  >
    <App />
  </PrivyProvider>
);