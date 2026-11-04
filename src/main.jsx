import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import { CHAIN, PRIVY_APP_ID } from './config.js';
import App from './App.jsx';
import '@fontsource-variable/outfit';
import './index.css';

const root = createRoot(document.getElementById('root'));

const app = PRIVY_APP_ID ? (
  <PrivyProvider
    appId={PRIVY_APP_ID}
    config={{
      loginMethods: ['wallet', 'email'],
      appearance: { theme: 'light', accentColor: '#0052FF', walletChainType: 'ethereum-only' },
      embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
      defaultChain: CHAIN,
      supportedChains: [CHAIN],
    }}
  >
    <App />
  </PrivyProvider>
) : (
  <App />
);

root.render(<StrictMode>{app}</StrictMode>);
