import { Schema, type Types } from 'mongoose';

/** Decimal128 may serialize small amounts as 1E-7; managers accept decimal ETH. */
export function decimalString(value: string | number | Types.Decimal128): string {
  const text = String(value);
  const match = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new TypeError('Money must be a non-negative finite decimal.');
  const whole = match[1];
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  if (Math.abs(exponent) > 100) throw new TypeError('Money amount is outside the supported range.');
  const digits = whole + fraction;
  const point = whole.length + exponent;
  const decimal = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` :
    point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [integer, decimals = ''] = decimal.split('.');
  const clean = decimals.replace(/0+$/, '');
  if (clean.length > 18) throw new TypeError('ETH amounts support at most 18 decimal places.');
  return `${integer.replace(/^0+(?=\d)/, '')}${clean ? `.${clean}` : ''}`;
}

export function money(opts: { required?: boolean; default?: number } = {}) {
  return {
    type: Schema.Types.Decimal128,
    ...opts,
    validate: {
      validator: (value: Types.Decimal128 | null) => {
        try { if (value != null) decimalString(value); return true; } catch { return false; }
      },
      message: '{PATH} must be non-negative finite ETH with at most 18 decimal places',
    },
  };
}
