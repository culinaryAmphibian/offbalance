// Display an ETH amount (decimal string, number or wei bigint) with a fixed number of decimals.
// Rounds half up on the decimal string itself, so large values keep full precision.
export function formatEth(value, digits = 3, { wei = false } = {}) {
  if (value === null || value === undefined || value === '') return '—';
  let text;
  if (typeof value === 'bigint') {
    if (value < 0n) return '—';
    text = wei ? weiToEth(value) : value.toString();
  } else {
    text = String(value).trim();
  }
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return '—';
  const scale = 10n ** BigInt(digits);
  const fraction = (match[2] ?? '').padEnd(digits + 1, '0');
  let scaled = BigInt(match[1]) * scale + BigInt(fraction.slice(0, digits) || '0');
  if (Number(fraction[digits]) >= 5) scaled += 1n;
  const whole = scaled / scale;
  const rest = (scaled % scale).toString().padStart(digits, '0');
  return digits ? `${whole}.${rest}` : String(whole);
}

function weiToEth(value) {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
