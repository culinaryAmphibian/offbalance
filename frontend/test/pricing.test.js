import test from 'node:test';
import assert from 'node:assert/strict';
import { quotePricing, ethWei, weiEth, validateSavedPricing, settlementAmounts, PRICING_TERMS } from '../src/pricing.js';
import { convertBudget } from '../src/budget.js';

const quoted = (fields = {}) => ({ maxPrice: '0.01', window: 600, k: 3, ...fields });

test('booked-window escrow uses each provider cap with ceiling at wei precision', () => {
  for (const [input, charge, escrow] of [
    [quoted(), 1666666666666667n, 5000000000000001n],
    [quoted({ maxPrice: '0.000000000000000001', window: 1, k: 5 }), 1n, 5n],
    [quoted({ maxPrice: '0.000000000000003601', window: 1, k: 2 }), 2n, 4n],
    [quoted({ window: 7200, k: 4 }), 20000000000000000n, 80000000000000000n],
  ]) {
    const result = quotePricing(input);
    assert.equal(BigInt(result.perProviderMaxChargeWei), charge);
    assert.equal(BigInt(result.totalEscrowWei), escrow);
    assert.equal(ethWei(result.totalEscrow), escrow);
  }
});

test('USD converts the hourly cap before computing window charges and provider escrow', () => {
  const maxPrice = convertBudget('25.50', 'USD', '3000');
  const quote = quotePricing(quoted({ maxPrice, window: 1800, k: 4 }));
  assert.equal(quote.maxHourlyRate, '0.0085');
  assert.equal(quote.perProviderMaxCharge, '0.00425');
  assert.equal(quote.totalEscrow, '0.017');
});

test('quote math rejects overflow but accepts full-width rates when the result fits', () => {
  const max = (1n << 256n) - 1n;
  assert.equal(quotePricing(quoted({ maxPrice: weiEth(max), window: 3600, k: 1 })).totalEscrowWei, String(max));
  for (const input of [quoted({ maxPrice: weiEth(max), window: 3601, k: 1 }), quoted({ maxPrice: weiEth(max), window: 3600, k: 2 }), quoted({ maxPrice: '0' }), quoted({ window: 0 }), quoted({ k: 1.5 })]) assert.throws(() => quotePricing(input));
});

test('saved quotes compare every ETH/wei pair with immutable job cap, window and count', () => {
  const job = { ...quoted(), buyerWallet: '0x' + 'a'.repeat(40) };
  job.pricing = quotePricing(job);
  assert.deepEqual(validateSavedPricing(job), job.pricing);
  for (const field of ['maxHourlyRate', 'perProviderMaxCharge', 'totalEscrow']) {
    const bad = { ...job, pricing: { ...job.pricing, [field]: '0.001' } };
    assert.throws(() => validateSavedPricing(bad), /pricing quote.*Refresh/);
  }
});

test('settlement remains absent until authoritative totals arrive, with refunds separate from work', () => {
  assert.equal(settlementAmounts(null), null);
  assert.equal(settlementAmounts(undefined), null);
  const settlement = { version: 1, status: 'settled', escrowWei: '100', workChargedWei: '60', buyerRefundWei: '40' };
  assert.deepEqual(settlementAmounts(settlement), { escrow: '0.0000000000000001', workCharged: '0.00000000000000006', buyerRefund: '0.00000000000000004' });
  for (const patch of [{ status: 'pending' }, { workChargedWei: '100' }, { buyerRefundWei: '-1' }, { escrow: '1' }]) assert.throws(() => settlementAmounts({ ...settlement, ...patch }));
});

test('the preconfirmation terms disclose booked charges and a full no-quorum escrow refund', () => {
  for (const phrase of ['full booked window', 'execution ends early', 'own quoted rate', 'refunded', 'Without quorum', 'no work is paid', 'full escrow is refunded', 'providers recover their own stakes', 'Slashed-stake rewards', 'returned stakes']) assert.ok(PRICING_TERMS.includes(phrase), phrase);
});
