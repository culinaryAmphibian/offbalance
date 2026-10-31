import { decimalString } from './models/decimal.ts';
import { formatEthAmount, parseEthAmount } from './matching/MatchingEngine.ts';

export const PRICING_VERSION = 1;
export const PRICING_POLICY = 'booked-window-v1';
export const MAX_UINT256 = (1n << 256n) - 1n;
export type PricingQuote = {
  version: number; policy: string; maxHourlyRate: string; maxHourlyRateWei: string;
  perProviderMaxCharge: string; perProviderMaxChargeWei: string; totalEscrow: string; totalEscrowWei: string;
  window: number; k: number;
};
export function uint256(value: bigint): bigint {
  if (value < 0n || value > MAX_UINT256) throw new TypeError('Pricing amount exceeds uint256.');
  return value;
}
export function bookedChargeWei(rate: bigint, seconds: number): bigint {
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new TypeError('Booking window must be positive integer seconds.');
  uint256(rate);
  return uint256((rate * BigInt(seconds) + 3599n) / 3600n);
}
export function createPricingQuote(input: { maxPrice?: unknown; timeWindow: number; minNodesToRunOn: number }): PricingQuote {
  if (!Number.isSafeInteger(input.minNodesToRunOn) || input.minNodesToRunOn < 1) throw new TypeError('Provider count must be a positive integer.');
  const cap = parseEthAmount(decimalString(input.maxPrice as Parameters<typeof decimalString>[0]));
  if (cap === 0n) throw new TypeError('Hourly cap must be positive.');
  const charge = bookedChargeWei(cap, input.timeWindow);
  const escrow = uint256(charge * BigInt(input.minNodesToRunOn));
  return { version: PRICING_VERSION, policy: PRICING_POLICY, maxHourlyRate: formatEthAmount(cap), maxHourlyRateWei: String(cap),
    perProviderMaxCharge: formatEthAmount(charge), perProviderMaxChargeWei: String(charge),
    totalEscrow: formatEthAmount(escrow), totalEscrowWei: String(escrow), window: input.timeWindow, k: input.minNodesToRunOn };
}
export function validatePricingQuote(job: { maxPrice?: unknown; timeWindow: number; minNodesToRunOn: number; pricing?: unknown; buyerWallet?: string | null }): PricingQuote {
  const expected = createPricingQuote(job);
  const actual = job.pricing as Partial<PricingQuote> | null;
  if (actual && Object.entries(expected).some(([key, value]) => actual[key as keyof PricingQuote] !== value)) {
    throw new TypeError('Pricing migration required: missing, unsupported or inconsistent booked-window quote.');
  }
  return expected;
}
