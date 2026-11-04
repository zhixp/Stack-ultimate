import { createPublicClient, createWalletClient, http, parseEventLogs, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { STACK_ULTIMATE_ABI as abi } from '../shared/stackUltimateAbi.js';

/**
 * Operator-side contract access. Every transaction goes through one queue with
 * a locally tracked nonce, so concurrent games never collide on nonces.
 */
export function createChain({ chain, rpcUrl, operatorKey, contract, publicClient: injectedPublic }) {
  const transport = http(rpcUrl, { retryCount: 3, timeout: 20_000 });
  const publicClient = injectedPublic || createPublicClient({ chain, transport });
  const account = privateKeyToAccount(operatorKey);
  const wallet = createWalletClient({ chain, transport, account });

  let queue = Promise.resolve();
  let nextNonce = null;

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  function send(functionName, args) {
    return enqueue(async () => {
      // Simulate first: a revert surfaces here with its custom error name
      // instead of burning gas on-chain.
      const { request } = await publicClient.simulateContract({ address: contract, abi, functionName, args, account });
      if (nextNonce === null) {
        nextNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
      }
      try {
        const hash = await wallet.writeContract({ ...request, nonce: nextNonce });
        nextNonce += 1;
        return hash;
      } catch (err) {
        nextNonce = null; // resync from the node next time
        throw err;
      }
    });
  }

  async function confirm(hash) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
    return receipt;
  }

  return {
    publicClient,
    operator: account.address,

    async readPlayer(player) {
      const s = await publicClient.readContract({ address: contract, abi, functionName: 'getState', args: [player] });
      return s;
    },

    async readOperatorOnChain() {
      return publicClient.readContract({ address: contract, abi, functionName: 'operator' });
    },

    async operatorBalance() {
      return formatEther(await publicClient.getBalance({ address: account.address }));
    },

    /** Sends startGame and returns the hash right away plus a promise of the gameId. */
    async startGame(player) {
      const hash = await send('startGame', [player]);
      const gameId = confirm(hash).then((receipt) => {
        const [log] = parseEventLogs({ abi, logs: receipt.logs, eventName: 'GameStarted' });
        if (!log) throw new Error('GameStarted event missing');
        return log.args.gameId;
      });
      gameId.catch(() => {}); // callers attach their own handlers
      return { hash, gameId };
    },

    async submitScore(gameId, score) {
      try {
        const hash = await send('submitScore', [gameId, BigInt(score)]);
        const receipt = await confirm(hash);
        const [log] = parseEventLogs({ abi, logs: receipt.logs, eventName: 'GameResult' });
        return { hash, roundId: log ? log.args.roundId : null, counted: log ? log.args.counted : false };
      } catch (err) {
        // An earlier attempt may have landed even though we never saw its
        // receipt. If the game is already closed on-chain, it was recorded.
        const [, gameRound, open] = await publicClient.readContract({
          address: contract,
          abi,
          functionName: 'games',
          args: [gameId],
        });
        if (open) throw err;
        const current = await publicClient.readContract({ address: contract, abi, functionName: 'roundId' });
        return { hash: null, roundId: gameRound, counted: gameRound === current };
      }
    },
  };
}
