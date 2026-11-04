// Full stack test: local anvil chain + real contract + real server over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { STACK_ULTIMATE_ABI as abi } from '../shared/stackUltimateAbi.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { buildRun } from './helpers.js';

// Well-known anvil dev keys (public test keys, hold no real funds).
const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  operator: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  alice: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  bob: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
};
const PORT = 8600 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;
const PRICE = 10n ** 14n;

let anvil, server, ctx, baseUrl, contract;
const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const walletFor = (key) => createWalletClient({ chain: foundry, transport: http(RPC), account: privateKeyToAccount(key) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log() {}, warn() {}, error() {} };

async function api(path, { body, token, method } = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function signIn(key) {
  const account = privateKeyToAccount(key);
  const { body: n } = await api('/auth/nonce', { body: { address: account.address } });
  const signature = await account.signMessage({ message: n.message });
  const { status, body } = await api('/auth/verify', { body: { address: account.address, nonce: n.nonce, signature } });
  assert.equal(status, 200, JSON.stringify(body));
  return body.token;
}

async function buy(key, count) {
  const w = walletFor(key);
  const hash = await w.writeContract({ address: contract, abi, functionName: 'buyTickets', args: [BigInt(count)], value: PRICE * BigInt(count) });
  await pub.waitForTransactionReceipt({ hash });
}

/** Plays a run in real time so the server's clock checks see a genuine run. */
async function playRun(token, clicks) {
  const { status, body } = await api('/game/start', { body: {}, token });
  assert.equal(status, 200, JSON.stringify(body));
  const t0 = Date.now();
  const wait = (clicks.at(-1) ?? 0) - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
  return { sessionId: body.sessionId, res: await api('/game/finish', { body: { sessionId: body.sessionId, clicks }, token }) };
}

before(async () => {
  anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await sleep(200);
    }
  }
  const { bytecode } = JSON.parse(readFileSync(new URL('../shared/stackUltimateBytecode.json', import.meta.url)));
  const deployer = walletFor(KEYS.deployer);
  const hash = await deployer.deployContract({
    abi,
    bytecode,
    args: [privateKeyToAccount(KEYS.operator).address, PRICE, 1000, 8000, 86400n],
  });
  contract = (await pub.waitForTransactionReceipt({ hash })).contractAddress;

  const config = loadConfig({
    CHAIN: 'anvil',
    RPC_URL: RPC,
    OPERATOR_PRIVATE_KEY: KEYS.operator,
    CONTRACT_ADDRESS: contract,
    SESSION_SECRET: 'test-secret-test-secret-test-secret!',
    DATA_DIR: '',
    STATIC_DIR: 'does-not-exist',
    FINISH_LAG_MS: '1500',
    BOT_MIN_SCORE: '4',
    RATE_LIMIT_PER_MIN: '10000',
    ALLOWED_ORIGINS: 'https://play.example',
  });
  ctx = createApp(config, { log: quiet });
  await new Promise((r) => {
    server = ctx.app.listen(0, () => r());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  ctx?.close();
  server?.close();
  anvil?.kill();
});

test('health reports the contract', async () => {
  const { body } = await api('/health');
  assert.equal(body.contract.toLowerCase(), contract.toLowerCase());
});

test('sign-in rejects a signature from another wallet', async () => {
  const alice = privateKeyToAccount(KEYS.alice);
  const bob = privateKeyToAccount(KEYS.bob);
  const { body: n } = await api('/auth/nonce', { body: { address: alice.address } });
  const signature = await bob.signMessage({ message: n.message });
  const res = await api('/auth/verify', { body: { address: alice.address, nonce: n.nonce, signature } });
  assert.equal(res.status, 401);
});

test('sign-in message is EIP-4361 and names only an allowed site', async () => {
  const { parseSiweMessage } = await import('viem/siwe');
  const nonceFrom = async (origin) => {
    const res = await fetch(`${baseUrl}/api/auth/nonce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ address: privateKeyToAccount(KEYS.alice).address }),
    });
    return parseSiweMessage((await res.json()).message);
  };
  const allowed = await nonceFrom('https://play.example');
  assert.equal(allowed.domain, 'play.example');
  assert.equal(allowed.chainId, foundry.id);
  assert.ok(allowed.expirationTime > allowed.issuedAt);
  // A phishing page can't get our server to put its own domain in the message.
  const foreign = await nonceFrom('https://evil.example');
  assert.notEqual(foreign.domain, 'evil.example');
});

test('a nonce can only be used once', async () => {
  const alice = privateKeyToAccount(KEYS.alice);
  const { body: n } = await api('/auth/nonce', { body: { address: alice.address } });
  const signature = await alice.signMessage({ message: n.message });
  assert.equal((await api('/auth/verify', { body: { address: alice.address, nonce: n.nonce, signature } })).status, 200);
  assert.equal((await api('/auth/verify', { body: { address: alice.address, nonce: n.nonce, signature } })).status, 401);
});

test('game endpoints need a valid session', async () => {
  assert.equal((await api('/game/start', { body: {} })).status, 401);
  assert.equal((await api('/game/start', { body: {}, token: 'forged.token' })).status, 401);
});

test('starting without tickets is refused', async () => {
  const token = await signIn(KEYS.bob);
  const res = await api('/game/start', { body: {}, token });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'no_tickets');
});

test('honest run: ticket burned, score verified and recorded on-chain', async () => {
  const alice = privateKeyToAccount(KEYS.alice).address;
  const token = await signIn(KEYS.alice);
  await buy(KEYS.alice, 5);

  const clicks = buildRun({ hits: 3, errorMs: 35 });
  const { sessionId, res } = await playRun(token, clicks);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.score, 3);
  assert.equal(res.body.counted, true);

  const s = await pub.readContract({ address: contract, abi, functionName: 'getState', args: [alice] });
  assert.equal(s.tickets, 4n);
  assert.equal(s.highScore, 3n);
  assert.equal(s.king, alice);

  // Re-sending the same finish is idempotent and records nothing new.
  const again = await api('/game/finish', { body: { sessionId, clicks }, token });
  assert.deepEqual(again.body, res.body);

  const lb = await api('/leaderboard');
  assert.equal(lb.body.round[0].player, alice);
  assert.equal(lb.body.round[0].score, 3);
});

test('forged timeline that runs ahead of real time is rejected', async () => {
  const token = await signIn(KEYS.alice);
  const { body } = await api('/game/start', { body: {}, token });
  const clicks = buildRun({ hits: 40, errorMs: 0 });
  const res = await api('/game/finish', { body: { sessionId: body.sessionId, clicks }, token });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /ahead of the clock/);
});

test('slowed-down run (timeline far behind real time) is rejected', async () => {
  const token = await signIn(KEYS.alice);
  const { body } = await api('/game/start', { body: {}, token });
  await sleep(2500);
  const res = await api('/game/finish', { body: { sessionId: body.sessionId, clicks: buildRun({ hits: 1 }) }, token });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /too late/);
});

test('bot-perfect run is flagged', async () => {
  const token = await signIn(KEYS.alice);
  const { res } = await playRun(token, buildRun({ hits: 4, errorMs: 0 }));
  assert.equal(res.status, 422);
  assert.match(res.body.error, /anti-cheat/);
});

test('a run must end in a miss', async () => {
  const token = await signIn(KEYS.alice);
  const { res } = await playRun(token, buildRun({ hits: 2, endWithMiss: false }));
  assert.equal(res.status, 422);
});

test("cannot finish someone else's run", async () => {
  const aliceToken = await signIn(KEYS.alice);
  const bobToken = await signIn(KEYS.bob);
  const { body } = await api('/game/start', { body: {}, token: aliceToken });
  const res = await api('/game/finish', { body: { sessionId: body.sessionId, clicks: [] }, token: bobToken });
  assert.equal(res.status, 404);
});

test('tickets run out and the server refuses further runs', async () => {
  const alice = privateKeyToAccount(KEYS.alice).address;
  const token = await signIn(KEYS.alice);
  let s = await pub.readContract({ address: contract, abi, functionName: 'getState', args: [alice] });
  for (let i = 0n; i < s.tickets; i++) {
    const r = await api('/game/start', { body: {}, token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const res = await api('/game/start', { body: {}, token });
  assert.equal(res.status, 402);
  s = await pub.readContract({ address: contract, abi, functionName: 'getState', args: [alice] });
  assert.equal(s.tickets, 0n);
});

test('malformed bodies are handled cleanly', async () => {
  const token = await signIn(KEYS.alice);
  const res = await fetch(`${baseUrl}/api/game/finish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const bad = await api('/game/finish', { body: { sessionId: 42, clicks: 'x' }, token });
  assert.equal(bad.status, 404);
});
