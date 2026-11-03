import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'viem';
import { formatEth } from '../src/eth.js';

test('formats ETH with three decimals, rounding half up', () => {
  assert.equal(formatEth('0'), '0.000');
  assert.equal(formatEth('1'), '1.000');
  assert.equal(formatEth('0.005'), '0.005');
  assert.equal(formatEth('0.0054'), '0.005');
  assert.equal(formatEth('0.0055'), '0.006');
  assert.equal(formatEth('0.9996'), '1.000');
  assert.equal(formatEth('123456789.123456789123456789'), '123456789.123');
  assert.equal(formatEth(0.25), '0.250');
});

test('formats wei bigints and rejects junk', () => {
  assert.equal(formatEth(parseEther('0.006'), 3, { wei: true }), '0.006');
  assert.equal(formatEth(1n, 3, { wei: true }), '0.000');
  for (const bad of [null, undefined, '', 'abc', '-1', '1e-7']) assert.equal(formatEth(bad), '—');
});
