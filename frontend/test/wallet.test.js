import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignInMessage, walletError } from '../src/wallet.js';

const challenge = () => ({ address: '0x1234567890abcdef1234567890abcdef12345678', chainId: 1, nonce: 'abcdefgh1234', issuedAt: '2026-10-18T12:00:00.000Z' });
const location = { host: 'localhost:5173', origin: 'http://localhost:5173' };

test('SIWE message binds wallet, host, origin, chain, nonce and issued time', () => {
  assert.equal(createSignInMessage(challenge(), location), 'localhost:5173 wants you to sign in with your Ethereum account:\n0x1234567890abcdef1234567890abcdef12345678\n\nSign in to Offbalance.\n\nURI: http://localhost:5173\nVersion: 1\nChain ID: 1\nNonce: abcdefgh1234\nIssued At: 2026-10-18T12:00:00.000Z');
});

test('invalid wallet addresses cannot enter a sign-in message', () => {
  for (const address of ['', '0x123', '0x' + 'g'.repeat(40), challenge().address + '\n', challenge().address + '\nURI: https://evil.test']) {
    assert.throws(() => createSignInMessage({ ...challenge(), address }, location), /Invalid wallet or sign-in challenge/);
  }
});

test('chain IDs must be positive safe integers', () => {
  for (const chainId of [0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createSignInMessage({ ...challenge(), chainId }, location), /Invalid wallet or sign-in challenge/);
  }
});

test('nonce must have at least eight alphanumeric characters', () => {
  for (const nonce of ['', 'short', 'abcd efgh', 'abcdefgh\nURI', 'abcdefgh\n', 'abc_defgh']) {
    assert.throws(() => createSignInMessage({ ...challenge(), nonce }, location), /Invalid wallet or sign-in challenge/);
  }
});

test('invalid issued timestamps cannot enter a sign-in message', () => {
  for (const issuedAt of ['not-a-date', '2026', '2026-10-18T12:00:00.000Z\n']) {
    assert.throws(() => createSignInMessage({ ...challenge(), issuedAt }, location), /Invalid sign-in timestamp/);
  }
});

test('wallet errors explain cancellation, pending requests and other failures', () => {
  assert.equal(walletError({ code: 4001 }), 'Wallet request declined. You can try again.');
  assert.equal(walletError({ code: -32002 }), 'A wallet request is already open. Check your wallet.');
  assert.equal(walletError({ message: 'Unsupported chain' }), 'Unsupported chain');
  assert.equal(walletError({}), 'Could not sign in. Try again.');
});
