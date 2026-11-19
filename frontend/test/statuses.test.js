// The job status view against the server's own list of statuses (server/models/JobStatus.ts),
// so a status added on the server can't silently fall through to the generic "new job phase"
// display, and finished jobs look finished.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dateLabel, jobPhase, shortWallet, statusLabel } from '../src/jobs.js';
import { JOB_STATUSES, TERMINAL_STATUSES } from '../../server/models/JobStatus.ts';

const FALLBACK = jobPhase('A_STATUS_NOBODY_SENDS');
const FINISHED = new Set(['completed', 'canceled', 'failed']);

test('every status the server sends has its own phase and a readable label', () => {
  for (const status of JOB_STATUSES) {
    const [phase, note] = jobPhase(status);
    assert.notDeepEqual([phase, note], FALLBACK, `${status} falls through to the generic display`);
    assert.match(statusLabel(status), /^[A-Z][a-z ]+$/, status);
  }
});

test('jobs still in progress are not shown as finished', () => {
  for (const status of JOB_STATUSES.filter(s => !TERMINAL_STATUSES.includes(s))) {
    assert.ok(!FINISHED.has(jobPhase(status)[0]), `${status} is shown as finished`);
  }
});

test('canceled and no-quorum jobs are shown as finished', () => {
  assert.equal(jobPhase('CANCELED')[0], 'canceled');
  assert.equal(jobPhase('NO_QUORUM')[0], 'failed');
});

// B8: PAYOUT is the server's final status for a paid job (DELIVERED -> PAYOUT, and it's terminal),
// so it must look finished, not "Payment is being processed".
test('a paid job (PAYOUT, the server\'s final status) is shown as finished', () => {
    assert.ok(TERMINAL_STATUSES.includes('PAYOUT'));
    assert.ok(FINISHED.has(jobPhase('PAYOUT')[0]), `PAYOUT is shown as "${jobPhase('PAYOUT')[0]}"`);
  });

test('labels, wallets and dates format for display', () => {
  assert.equal(statusLabel('DELIVERY_RECEIPT_VALIDATION'), 'Delivery receipt validation');
  assert.equal(statusLabel(undefined), 'Unknown');
  assert.equal(shortWallet('0x1234567890abcdef1234567890abcdef12345678'), '0x1234…5678');
  assert.equal(dateLabel('not a date'), '—');
  assert.equal(dateLabel(null), '—');
  assert.notEqual(dateLabel('2026-11-16T12:00:00Z'), '—');
});
