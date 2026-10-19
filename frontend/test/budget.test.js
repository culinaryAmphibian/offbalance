import test from 'node:test';
import assert from 'node:assert/strict';
import { convertBudget } from '../src/budget.js';

test('ETH budgets retain their exact decimal spelling and wei precision', () => {
  for (const amount of ['1', '0.01', '0.000000000000000001', '001.0000', '999999999999999999999999999.123456789012345678']) {
    assert.equal(convertBudget(amount), amount);
    assert.equal(convertBudget(amount, 'ETH', null), amount);
  }
});

test('USD conversion divides exact decimal amounts without floating-point rounding', () => {
  assert.equal(convertBudget('25.50', 'USD', '3000'), '0.0085');
  assert.equal(convertBudget('1', 'USD', '3'), '0.333333333333333333');
  assert.equal(convertBudget('0.10', 'USD', '0.30'), '0.333333333333333333');
  assert.equal(convertBudget('1', 'USD', '0.000000000000000001'), '1000000000000000000');
  assert.equal(convertBudget('5.00', 'USD', '2.500000000000000000'), '2');
  assert.equal(convertBudget('00001.00', 'USD', '00002.00'), '0.5');
});

test('USD conversion rounds down to wei and never exceeds its submitted USD amount', () => {
  assert.equal(convertBudget('0.01', 'USD', '10000000000000000'), '0.000000000000000001');
  assert.equal(convertBudget('0.01', 'USD', '3333333333333333'), '0.000000000000000003');
  assert.throws(() => convertBudget('0.01', 'USD', '10000000000000001'), /less than 1 wei/);
  assert.throws(() => convertBudget('1.00', 'USD', '1000000000000000001'), /less than 1 wei/);
});

test('budgets reject zero, nondecimal, negative, numeric and excessive precision inputs', () => {
  for (const value of ['', '0', '0.000', '-1', '+1', '.1', '1.', '1e3', ' 1', '1 ', 'NaN', 'Infinity', null, 1, {}, '0.0000000000000000001']) {
    assert.throws(() => convertBudget(value), /positive ETH hourly cap/);
  }
  for (const value of ['', '0', '0.00', '-1', '.1', '1.', '1e3', ' 1', 'NaN', 'Infinity', null, 1, '0.001', '1.000']) {
    assert.throws(() => convertBudget(value, 'USD', '3000'), /positive USD hourly cap/);
  }
  assert.throws(() => convertBudget('1', 'EUR'), /Choose ETH or USD/);
});

test('USD conversion requires a positive plain decimal rate with at most 18 decimal places', () => {
  for (const rate of [null, undefined, '', '0', '0.000', '-1', '1e3', '.1', '1.', ' 1', 'NaN', 'Infinity', 3000, {}, '0.0000000000000000001']) {
    assert.throws(() => convertBudget('1', 'USD', rate), /valid ETH\/USD rate/);
  }
});

test('input and converted budgets obey the API length limit', () => {
  assert.equal(convertBudget('9'.repeat(100)), '9'.repeat(100));
  assert.throws(() => convertBudget('9'.repeat(101)), /100 characters/);
  assert.throws(() => convertBudget('9'.repeat(101), 'USD', '3000'), /100 characters/);
  assert.throws(() => convertBudget('1', 'USD', '9'.repeat(101)), /valid ETH\/USD rate/);
  assert.throws(() => convertBudget('9'.repeat(100), 'USD', '0.000000000000000001'), /converted ETH hourly cap is too large/);
});
