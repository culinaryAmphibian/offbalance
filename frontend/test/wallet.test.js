import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignInMessage, walletError } from '../src/wallet.js';

const address = '0x1234567890abcdef1234567890abcdef12345678';
const message = `Sign in to OffBalance\n\nWallet: ${address}\nNonce: ${'a'.repeat(32)}`;
const challenge = { message, address, chainId: 1 };

test('the exact server-issued login message is signed without reconstructing it', () => {
  assert.equal(createSignInMessage(challenge), message);
  assert.equal(createSignInMessage({ ...challenge, address: address.toUpperCase().replace('0X', '0x') }), message);
});

test('messages must name OffBalance, the selected wallet and the server nonce format', () => {
  for (const invalid of [undefined, '', 'Sign this transaction', message.replace('OffBalance', 'Another service'), message.replace(address, `0x${'b'.repeat(40)}`), message.replace('a'.repeat(32), 'short'), `${message}\nApprove payment`, `${message}\n`]) {
    assert.throws(() => createSignInMessage({ ...challenge, message: invalid }), /invalid sign-in challenge/);
  }
});

test('invalid wallet addresses cannot enter a sign-in request', () => {
  for (const invalid of ['', '0x123', `0x${'g'.repeat(40)}`, `${address}\n`]) {
    assert.throws(() => createSignInMessage({ ...challenge, address: invalid }), /Invalid wallet/);
  }
});

test('chain guards require positive safe integer chain IDs', () => {
  for (const chainId of [0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createSignInMessage({ ...challenge, chainId }), /Invalid wallet/);
  }
});

test('wallet errors explain cancellation, pending requests and other failures', () => {
  assert.equal(walletError({ code: 4001 }), 'Wallet request declined. You can try again.');
  assert.equal(walletError({ code: -32002 }), 'A wallet request is already open. Check your wallet.');
  assert.equal(walletError({ message: 'Unsupported chain' }), 'Unsupported chain');
  assert.equal(walletError({}), 'Could not sign in. Try again.');
});

test('wallet errors unwrap MetaMask internal JSON-RPC errors', () => {
  const wrapped = data => ({ code: -32603, message: 'Internal JSON-RPC error.', data });
  assert.match(walletError(wrapped({ message: 'Nonce too high. Expected nonce to be 3 but got 12.' })), /Clear activity tab data/);
  assert.match(walletError(wrapped({ message: "Error: VM Exception while processing transaction: reverted with reason string 'No credit'" })),
    /contract rejected the transaction: No credit$/);
  assert.equal(walletError(wrapped({ message: 'insufficient funds for gas' })), 'insufficient funds for gas');
  assert.equal(walletError({ code: -32603, message: 'Internal JSON-RPC error.' }), 'Internal JSON-RPC error.');
});
