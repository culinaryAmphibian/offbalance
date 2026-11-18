import { decimalString } from "./models/decimal.ts";
import { bookedCharge, formatEthAmount, parseEthAmount } from "./matching/MatchingEngine.ts";

const MAX_UINT256 = (1n << 256n) - 1n;

export function pricingQuote(job: {
	maxPrice?: Parameters<typeof decimalString>[0] | null; timeWindow: number; minNodesToRunOn: number;
}) {
	const hourlyRate = decimalString(job.maxPrice ?? "0");
	const hourlyRateWei = parseEthAmount(hourlyRate);
	const escrowWei = bookedCharge(hourlyRateWei, job.timeWindow) * BigInt(job.minNodesToRunOn);
	if (hourlyRateWei === 0n || hourlyRateWei > MAX_UINT256 || escrowWei > MAX_UINT256) {
		throw new TypeError("The hourly cap and total escrow must be positive amounts that fit the contract.");
	}
	return { hourlyRateWei, escrowWei, escrow: formatEthAmount(escrowWei) };
}
