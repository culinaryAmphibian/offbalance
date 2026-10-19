import { Schema, type Types } from "mongoose";

// Money fields. `min` doesn't apply to Decimal128, so check the sign by hand.
export function money(opts: { required?: boolean; default?: number } = {}) {
	return {
		type: Schema.Types.Decimal128,
		...opts,
		validate: {
			validator: (v: Types.Decimal128 | null) => v == null || !v.toString().startsWith("-"),
			message: "{PATH} can't be negative",
		},
	};
}
