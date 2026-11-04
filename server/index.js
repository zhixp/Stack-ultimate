import { loadConfig } from './config.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  console.error('Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const { app, chain, leaderboard } = createApp(config);

try {
  const onChainOperator = await chain.readOperatorOnChain();
  if (onChainOperator.toLowerCase() !== chain.operator.toLowerCase()) {
    console.error(`OPERATOR_PRIVATE_KEY is ${chain.operator}, but the contract's operator is ${onChainOperator}.`);
    console.error('Fix the key, or call setOperator() from the owner wallet.');
    process.exit(1);
  }
  const balance = await chain.operatorBalance();
  console.log(`Operator ${chain.operator} has ${balance} ETH for gas`);
  if (Number(balance) < 0.001) console.warn('Operator balance is low. Top it up or games will fail to start.');
} catch (err) {
  console.error('Could not reach the contract:', err.shortMessage || err.message);
  process.exit(1);
}

const server = app.listen(config.port, () => {
  console.log(`Stack Ultimate server on :${config.port} (${config.chainName}, contract ${config.contract})`);
});

function shutdown() {
  leaderboard.save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
