import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, parseEther, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { authorizeSessionKey, readSessionKey, revokeSessionKey, sessionKeyAbi } from '../src/sessionKey.js';

const wallet = '0x1111111111111111111111111111111111111111';
const contract = '0x2222222222222222222222222222222222222222';
const digest = `0x${'cd'.repeat(32)}`;
const hash = `0x${'ab'.repeat(32)}`;
const config = () => ({ executionMode: 'chain', chain: { chainId: 31337, address: contract } });
const NOW = 1_800_000_000_000;

function mockWallet({ chain = '0x7a69', status = '0x1', active = null, expiresAt = 0n } = {}) {
  const calls = [];
  return {
    calls,
    request: async request => {
      calls.push(request);
      switch (request.method) {
        case 'eth_accounts': return [wallet];
        case 'eth_chainId': return chain;
        case 'eth_sendTransaction': return hash;
        case 'eth_getTransactionReceipt': return { status };
        case 'eth_call': {
          const { functionName } = decodeFunctionData({ abi: sessionKeyAbi, data: request.params[0].data });
          const result = {
            sessionKeyDigest: digest,
            activeSessionKey: active ?? '0x0000000000000000000000000000000000000000',
            sessionKeys: [wallet, expiresAt],
          }[functionName];
          return encodeFunctionResult({ abi: sessionKeyAbi, functionName, result });
        }
        default: throw new Error(`Unexpected wallet request: ${request.method}`);
      }
    },
  };
}

const sent = provider => provider.calls.filter(call => call.method === 'eth_sendTransaction');

test('authorize signs the contract digest with the new key and funds it in the register call', async () => {
  const provider = mockWallet();
  const result = await authorizeSessionKey(
    { config: config(), owner: wallet, expiresInDays: 30, fundingEth: '0.05' }, provider, { now: () => NOW });

  assert.equal(privateKeyToAccount(result.privateKey).address, result.address);
  assert.equal(result.expiresAt, NOW / 1000 + 30 * 86400);
  assert.equal(result.hash, hash);

  // the digest was requested for this wallet, key and expiry
  const call = provider.calls.find(c => c.method === 'eth_call');
  assert.deepEqual(decodeFunctionData({ abi: sessionKeyAbi, data: call.params[0].data }).args,
    [wallet, result.address, BigInt(result.expiresAt)]);

  const [tx] = sent(provider)[0].params;
  assert.equal(tx.from, wallet);
  assert.equal(tx.to, contract);
  assert.equal(BigInt(tx.value), parseEther('0.05'));
  const { functionName, args } = decodeFunctionData({ abi: sessionKeyAbi, data: tx.data });
  assert.equal(functionName, 'registerSessionKey');
  assert.equal(args[0], result.address);
  assert.equal(args[1], BigInt(result.expiresAt));
  // EIP-191 over the raw digest, as the contract's _ethSignedMessageHash expects
  assert.equal(await recoverMessageAddress({ message: { raw: digest }, signature: args[2] }), result.address);
});

test('each authorization generates a different key', async () => {
  const a = await authorizeSessionKey({ config: config(), owner: wallet }, mockWallet());
  const b = await authorizeSessionKey({ config: config(), owner: wallet }, mockWallet());
  assert.notEqual(a.privateKey, b.privateKey);
});

test('rejects before sending on the wrong chain, wallet, or bad inputs', async () => {
  const provider = mockWallet({ chain: '0x1' });
  await assert.rejects(authorizeSessionKey({ config: config(), owner: wallet }, provider), /Switch your wallet to chain 31337/);
  await assert.rejects(authorizeSessionKey({ config: config(), owner: contract }, mockWallet()), /wallet changed/);
  await assert.rejects(authorizeSessionKey({ config: config(), owner: wallet, expiresInDays: 0 }, mockWallet()), /expiry/);
  await assert.rejects(authorizeSessionKey({ config: config(), owner: wallet, fundingEth: 'lots' }, mockWallet()), /ETH amount/);
  await assert.rejects(authorizeSessionKey({ config: { executionMode: 'local' }, owner: wallet }, mockWallet()), /no real contract/);
  assert.equal(sent(provider).length, 0);
});

test('a reverted registration is reported, so the key is never shown', async () => {
  await assert.rejects(authorizeSessionKey({ config: config(), owner: wallet }, mockWallet({ status: '0x0' })), /failed on-chain/);
});

test('reads the active key and whether it expired', async () => {
  const key = '0x3333333333333333333333333333333333333333';
  assert.equal(await readSessionKey(config(), wallet, mockWallet()), null);
  const live = await readSessionKey(config(), wallet, mockWallet({ active: key, expiresAt: BigInt(NOW / 1000 + 60) }), { now: () => NOW });
  assert.deepEqual(live, { address: key, expiresAt: NOW / 1000 + 60, expired: false });
  const old = await readSessionKey(config(), wallet, mockWallet({ active: key, expiresAt: BigInt(NOW / 1000 - 60) }), { now: () => NOW });
  assert.equal(old.expired, true);
});

test('revoke sends revokeSessionKey from the wallet', async () => {
  const provider = mockWallet();
  assert.deepEqual(await revokeSessionKey(config(), wallet, provider), { hash });
  const [tx] = sent(provider)[0].params;
  assert.equal(decodeFunctionData({ abi: sessionKeyAbi, data: tx.data }).functionName, 'revokeSessionKey');
  assert.equal(tx.value, undefined);
});
