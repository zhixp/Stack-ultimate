// Local dev only: deploys StackUltimate to anvil (localhost:8545) using anvil's
// public test keys, and gives anvil account #2 fifty tickets.
// Operator = anvil account #1. Prints the contract address.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { STACK_ULTIMATE_ABI as abi } from '../shared/stackUltimateAbi.js';

const { bytecode } = JSON.parse(readFileSync(new URL('../shared/stackUltimateBytecode.json', import.meta.url)));
const rpc = http('http://127.0.0.1:8545');
const pub = createPublicClient({ chain: foundry, transport: rpc });
const wallet = (key) => createWalletClient({ chain: foundry, transport: rpc, account: privateKeyToAccount(key) });

const deployer = wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const hash = await deployer.deployContract({
  abi,
  bytecode,
  args: ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 10n ** 14n, 1000, 8000, 86400n],
});
const { contractAddress } = await pub.waitForTransactionReceipt({ hash });

const player = wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
await pub.waitForTransactionReceipt({
  hash: await player.writeContract({ address: contractAddress, abi, functionName: 'buyTickets', args: [50n], value: 50n * 10n ** 14n }),
});
console.log(contractAddress);
