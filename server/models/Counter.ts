import { Schema, model } from "mongoose";

// Named counters: on-chain job ids, and the last block the event listener processed.
const counterSchema = new Schema({
	_id: { type: String, required: true },
	seq: { type: Number, required: true },
});

export const CounterModel = model("Counter", counterSchema);

// atomically returns the next value; the first call returns 1
export async function nextSeq(name: string): Promise<number> {
	const doc = await CounterModel.findOneAndUpdate(
		{ _id: name },
		{ $inc: { seq: 1 } },
		{ upsert: true, returnDocument: "after" },
	);
	return doc.seq;
}

export async function getSeq(name: string): Promise<number | null> {
	return (await CounterModel.findById(name))?.seq ?? null;
}

export async function setSeq(name: string, seq: number): Promise<void> {
	await CounterModel.updateOne({ _id: name }, { seq }, { upsert: true });
}
