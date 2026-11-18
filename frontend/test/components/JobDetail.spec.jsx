// The job page: the status badge and phase note for each server status, the blockchain submit
// and cancel actions, result download, and how a paid job is shown (B8 in TESTING_PLAN.md).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../src/chain', () => ({ cancelStoredJob: vi.fn(), collectFunds: vi.fn(), submitStoredJob: vi.fn() }));
const chain = await import('../../src/chain');
const { default: JobDetail } = await import('../../src/components/JobDetail');

const config = { executionMode: 'chain', chain: { chainId: 31337, address: '0x2222222222222222222222222222222222222222' } };
const job = overrides => ({ id: '5', name: 'render', status: 'PENDING', executionMode: 'chain', submittedAt: null,
  canSubmit: true, canCancel: true, canViewResults: true, result: { available: false }, ...overrides });
const api = (j, extra = {}) => ({ getJob: vi.fn().mockResolvedValue({ job: j }), getConfig: vi.fn().mockResolvedValue(config), cancelJob: vi.fn(), getResult: vi.fn(), ...extra });
const badge = async () => (await screen.findByRole('heading', { level: 1 })).parentElement.querySelector('.status');

beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('JobDetail', () => {
  test.each([
    ['COMMIT_PHASE', 'running', 'Commit phase'],
    ['REVEAL_PHASE', 'verifying', 'Reveal phase'],
    ['NO_QUORUM', 'failed', 'No quorum'],
    ['CANCELED', 'canceled', 'Canceled'],
  ])('status %s shows a "%s" badge labelled "%s"', async (status, phase, label) => {
    render(<JobDetail api={api(job({ status, submittedAt: '2026-11-17T00:00:00Z', canCancel: false }))} id="5" />);
    const el = await badge();
    expect(el.textContent).toBe(label);
    expect(el.className).toContain(phase);
  });

  // B8: PAYOUT is the server's final status for a paid job, but the page shows it as still
  // verifying ("Payment is being processed"). test.fails passes while that's true.
  test.fails('a paid job (PAYOUT) is shown as completed', async () => {
    render(<JobDetail api={api(job({ status: 'PAYOUT', submittedAt: '2026-11-17T00:00:00Z', canCancel: false }))} id="5" />);
    expect((await badge()).className).toContain('completed');
  });

  test('a saved job not yet on chain offers "Submit to blockchain", and submitting shows the transaction', async () => {
    chain.submitStoredJob.mockResolvedValue({ hash: '0xfeed' });
    const j = job();
    render(<JobDetail api={api(j)} id="5" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Submit to blockchain' }));
    expect((await screen.findByText(/Transaction sent:/)).textContent).toContain('0xfeed');
    expect(chain.submitStoredJob).toHaveBeenCalledWith(j, config, window.ethereum, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  // B16: after this page submits the job, it hides "Cancel" while the transaction is in flight,
  // but never shows it again once the server reports the job submitted; the user has to reload.
  test.fails('after submitting, the cancel button comes back once the server has seen the submission', async () => {
    chain.submitStoredJob.mockResolvedValue({ hash: '0xfeed' });
    const pending = job();
    const client = api(pending);
    render(<JobDetail api={client} id="5" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Submit to blockchain' }));
    await screen.findByText(/Transaction sent:/);
    client.getJob.mockResolvedValue({ job: { ...pending, submittedAt: '2026-11-17T00:00:00Z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('button', { name: 'Cancel job and refund escrow' }, { timeout: 2000 })).toBeTruthy();
  });

  test('cancelling a job that is on chain goes through the wallet; one that is not goes to the server', async () => {
    const onChain = job({ submittedAt: '2026-11-17T00:00:00Z' });
    render(<JobDetail api={api(onChain)} id="5" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel job and refund escrow' }));
    await vi.waitFor(() => expect(chain.cancelStoredJob).toHaveBeenCalledWith(onChain, config, window.ethereum));
    cleanup();

    const local = api(job({ executionMode: 'local' }));
    render(<JobDetail api={local} id="5" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel job' }));
    await vi.waitFor(() => expect(local.cancelJob).toHaveBeenCalledWith('5'));
    expect(chain.cancelStoredJob).toHaveBeenCalledTimes(1);
  });

  test('declining the confirmation cancels nothing', async () => {
    window.confirm.mockReturnValue(false);
    const local = api(job({ executionMode: 'local' }));
    render(<JobDetail api={local} id="5" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel job' }));
    expect(local.cancelJob).not.toHaveBeenCalled();
  });

  test('a verified result downloads under a safe file name', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:result');
    URL.revokeObjectURL = vi.fn();
    const clicked = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicked.push(this.download); });
    const done = job({ status: 'PAYOUT', submittedAt: '2026-11-17T00:00:00Z', canCancel: false,
      result: { available: true, filename: '../../etc/passwd', receiptMode: 'offchain' } });
    const withResult = api(done, { getResult: vi.fn().mockResolvedValue(new Blob(['tar'])) });
    render(<JobDetail api={withResult} id="5" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download result' }));
    await vi.waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]).toBe('.._.._etc_passwd');
    expect(screen.getByText('Verified by coordinator')).toBeTruthy();
  });

  test('results are only offered to the job owner', async () => {
    render(<JobDetail api={api(job({ status: 'PAYOUT', canViewResults: false, canCancel: false, submittedAt: '2026-11-17T00:00:00Z' }))} id="5" />);
    expect(await screen.findByText('Results are available to the job owner.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download result' })).toBeNull();
  });
});
