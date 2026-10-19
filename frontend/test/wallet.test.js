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
