import { Schema, model } from 'mongoose';

// Written after successful effects. Account increments additionally deduplicate
// atomically so replay after a partial failure cannot double-book a payment.
export const ChainEventModel = model('ChainEvent', new Schema({
  _id: { type: String, required: true },
  processedAt: { type: Date, default: Date.now },
}));
