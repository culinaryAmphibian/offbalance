const WEI = 10n ** 18n;

function decimal(value, precision, message) {
	if (
		typeof value !== "string" ||
		value.length > 100 ||
		!new RegExp(`^\\d+(?:\\.\\d{1,${precision}})?$`).test(value)
	)
		throw new Error(message);
	const [whole, fraction = ""] = value.split(".");
	const units = BigInt(whole + fraction);
	if (units === 0n) throw new Error(message);
	return { units, scale: fraction.length };
}

export function convertBudget(amount, currency = "ETH", usdPerEth = null) {
	if (!["ETH", "USD"].includes(currency))
		throw new Error("Choose ETH or USD for the budget.");
	const value = decimal(
		amount,
		currency === "ETH" ? 18 : 2,
		currency === "ETH"
			? "Enter a positive ETH budget with up to 18 decimal places (100 characters maximum)."
			: "Enter a positive USD budget with up to 2 decimal places (100 characters maximum).",
	);
	if (currency === "ETH") return amount;
	const rate = decimal(
		usdPerEth,
		18,
		"A valid ETH/USD rate is required to convert a USD budget.",
	);
	const wei =
		(value.units * WEI * 10n ** BigInt(rate.scale)) /
		(rate.units * 10n ** BigInt(value.scale));
	if (wei === 0n)
		throw new Error(
			"This USD budget converts to less than 1 wei. Enter a larger amount.",
		);
	const fraction = String(wei % WEI)
		.padStart(18, "0")
		.replace(/0+$/, "");
	const result = `${wei / WEI}${fraction ? `.${fraction}` : ""}`;
	if (result.length > 100)
		throw new Error(
			"The converted ETH budget is too large. Enter a smaller amount.",
		);
	return result;
}
