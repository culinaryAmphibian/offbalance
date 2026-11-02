// The job view's Result box: delivery and payment derived from the stored job.
import test from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { JobStatus } from "../models/JobStatus.ts";
import { deliveryState, paymentState, serializeJob } from "../routes/serialize.ts";

const provider = new Types.ObjectId();
const at = new Date("2026-11-02T20:00:00Z");
const delivered = { provider, hash: "ab", deliveryTime: at, location: "x", contentVerified: true, receiptVerified: false, receiptMode: "offchain" };
// only the fields the state functions read
const job = (fields: Record<string, unknown>) => ({
	_id: new Types.ObjectId(), status: JobStatus.PENDING, submittedAt: null, results: [], payouts: [], settledAt: null, ...fields,
}) as unknown as Parameters<typeof deliveryState>[0];

test("delivery follows the job's phase and the delivered results", () => {
	assert.equal(deliveryState(job({ status: JobStatus.COMMIT_PHASE })).status, "NOT_STARTED");
	assert.equal(deliveryState(job({ status: JobStatus.AWAITING_DELIVERY })).status, "AWAITING_DELIVERY");
	assert.deepEqual(deliveryState(job({ status: JobStatus.DELIVERY_RECEIPT_VALIDATION, results: [delivered] })),
		{ status: "DELIVERED", providersDelivered: 1, receivedAt: at, verifiedAt: at });
	assert.equal(deliveryState(job({ status: JobStatus.PAYOUT })).status, "NOT_DELIVERED");
	assert.equal(deliveryState(job({ status: JobStatus.NO_QUORUM })).status, "NO_CONSENSUS");
	assert.equal(deliveryState(job({ status: JobStatus.CANCELED })).status, "CANCELED");
	// an unverified upload doesn't count
	assert.equal(deliveryState(job({ status: JobStatus.AWAITING_DELIVERY, results: [{ ...delivered, contentVerified: false }] })).status, "AWAITING_DELIVERY");
});

test("payment is escrowed, then paid out or refunded", () => {
	assert.equal(paymentState(job({})).status, "NOT_STARTED");
	assert.deepEqual(paymentState(job({ status: JobStatus.COMMIT_PHASE, submittedAt: at })),
		{ status: "ESCROWED", settledAt: null, paidToProviders: null, payouts: [] });
	const paid = paymentState(job({ status: JobStatus.PAYOUT, submittedAt: at, settledAt: at, payouts: [
		{ provider, amount: Types.Decimal128.fromString("0.005") },
		{ provider: new Types.ObjectId(), amount: Types.Decimal128.fromString("0.0049999999999999") },
	] }));
	assert.equal(paid.status, "PAID");
	assert.equal(paid.settledAt, at);
	assert.equal(paid.paidToProviders, "0.0099999999999999");
	for (const status of [JobStatus.NO_QUORUM, JobStatus.CANCELED]) {
		assert.deepEqual(paymentState(job({ status, submittedAt: at, settledAt: at })),
			{ status: "REFUNDED", settledAt: at, paidToProviders: null, payouts: [] });
	}
});

test("serialized jobs carry delivery, payment and the amount spent", () => {
	const base = { onChainJobId: 3, owner: new Types.ObjectId(), providers: [provider], env: new Map(), requirements: {},
		dockerImageDigest: `x@sha256:${"a".repeat(64)}`, command: [], maxPrice: Types.Decimal128.fromString("1"), runningPrice: Types.Decimal128.fromString("1") };
	const paid = serializeJob(job({ ...base, status: JobStatus.PAYOUT, submittedAt: at, settledAt: at, results: [delivered],
		payouts: [{ provider, amount: Types.Decimal128.fromString("0.01") }] }));
	assert.equal(paid.delivery.status, "DELIVERED");
	assert.equal(paid.payment.status, "PAID");
	assert.equal(paid.spent, "1"); // the escrow, not the sum of payouts
	assert.equal(serializeJob(job({ ...base, status: JobStatus.NO_QUORUM, submittedAt: at })).spent, "0");
	assert.equal(serializeJob(job({ ...base, status: JobStatus.REVEAL_PHASE, submittedAt: at })).spent, null);
});
