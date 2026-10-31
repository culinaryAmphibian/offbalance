// Contract pricing uses wei throughout; the booked window is charged in full.
export const PRICING_POLICY = 'booked-window-v1';
export const PRICING_TERMS = 'The full booked window is charged, even if execution ends early, at each provider’s own quoted rate. Unused cap and unpaid allocations are refunded as withdrawal credits. With consensus, payment requires verified delivery; without quorum, revealers receive their booked charge without delivery. Slashed-stake rewards and returned stakes are separate from work charges. Gas is extra.';
const WEI = 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;
const quoteError = () => new Error('This saved job has a missing or inconsistent pricing quote. Refresh the job; if the problem remains, save a new job. No wallet request was made.');

export function ethWei(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^\d+(?:\.\d{1,18})?$/.test(value)) throw new Error('Enter an ETH hourly cap with up to 18 decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const wei = BigInt(whole) * WEI + BigInt(fraction.padEnd(18, '0'));
  if (wei > MAX_UINT256) throw new Error('The hourly cap or total escrow exceeds the contract amount limit.');
  return wei;
}

export function weiEth(value) {
  const wei = typeof value === 'bigint' ? value : weiString(value);
  const fraction = String(wei % WEI).padStart(18, '0').replace(/0+$/, '');
  return `${wei / WEI}${fraction ? `.${fraction}` : ''}`;
}

function weiString(value) {
  if (typeof value !== 'string' || value.length > 78 || !/^(0|[1-9]\d*)$/.test(value)) throw quoteError();
  const wei = BigInt(value);
  if (wei > MAX_UINT256) throw quoteError();
  return wei;
}

export function quotePricing({ maxPrice, window, k }) {
  if (!Number.isSafeInteger(window) || window < 1 || window > 604800 || !Number.isSafeInteger(k) || k < 1 || k > 255) throw new Error('Choose a valid booked execution window and provider count.');
  const cap = ethWei(maxPrice);
  if (cap === 0n) throw new Error('Enter a positive hourly cap per provider.');
  const charge = (cap * BigInt(window) + 3599n) / 3600n;
  const escrow = charge * BigInt(k);
  if (escrow > MAX_UINT256) throw new Error('The hourly cap or total escrow exceeds the contract amount limit.');
  return { version: 1, policy: PRICING_POLICY, maxHourlyRate: weiEth(cap), maxHourlyRateWei: String(cap),
    perProviderMaxCharge: weiEth(charge), perProviderMaxChargeWei: String(charge),
    totalEscrow: weiEth(escrow), totalEscrowWei: String(escrow), window, k };
}

export function validateSavedPricing(job, { forSubmission = false } = {}) {
  try {
    const saved = job?.pricing;
    if (!saved || saved.version !== 1 || saved.policy !== PRICING_POLICY || job.pricingMigrationRequired) throw quoteError();
    const expected = quotePricing(job);
    if (saved.window !== job.window || saved.k !== job.k) throw quoteError();
    for (const field of ['maxHourlyRate', 'perProviderMaxCharge', 'totalEscrow']) {
      if (weiString(saved[`${field}Wei`]) !== BigInt(expected[`${field}Wei`]) || ethWei(saved[field]) !== BigInt(expected[`${field}Wei`])) throw quoteError();
    }
    if (!/^0x[\da-f]{40}$/i.test(job.buyerWallet ?? '')) throw quoteError();
    if (forSubmission && (!/^0x[\da-f]{40}$/i.test(job.submitWallet ?? '') || job.submitWallet.toLowerCase() !== job.buyerWallet.toLowerCase())) throw quoteError();
    return expected;
  } catch {
    throw quoteError();
  }
}

export function settlementAmounts(settlement) {
  if (settlement == null) return null;
  try {
    if (settlement.version !== 1 || settlement.status !== 'settled') throw new Error();
    const amounts = {};
    for (const field of ['escrow', 'workCharged', 'buyerRefund']) {
      const wei = weiString(settlement[`${field}Wei`]);
      if (settlement[field] != null && ethWei(settlement[field]) !== wei) throw new Error();
      amounts[field] = weiEth(wei);
    }
    if (BigInt(settlement.workChargedWei) + BigInt(settlement.buyerRefundWei) !== BigInt(settlement.escrowWei)) throw new Error();
    return amounts;
  } catch { throw new Error('Settlement amounts are incomplete or inconsistent. Refresh the job.'); }
}
