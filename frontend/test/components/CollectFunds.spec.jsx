// "Collect funds": what it shows and allows for each balance, and what a collection does.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { parseEther } from 'viem';

vi.mock('../../src/chain', () => ({ collectFunds: vi.fn() }));
const { collectFunds } = await import('../../src/chain');
const { default: CollectFunds } = await import('../../src/components/CollectFunds');

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const config = { executionMode: 'chain', chain: { chainId: 31337, address: OTHER } };
const chain = (balances, extra = {}) => ({ config, available: true, balances, error: '', refresh: vi.fn(), ...extra });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('CollectFunds', () => {
  test('shows the collectable amount and collects it to the wallet', async () => {
    collectFunds.mockResolvedValue({ hash: '0xabc', wei: parseEther('0.0065') });
    const onCollected = vi.fn();
    const state = chain({ wallet: WALLET, account: WALLET, credits: parseEther('0.0065'), stake: 0n });
    render(<CollectFunds chain={state} onCollected={onCollected} />);
    expect(screen.getByText('0.007')).toBeTruthy(); // rounded to 3 decimals
    fireEvent.click(screen.getByRole('button', { name: 'Collect funds' }));
    expect(await screen.findByText('Collected 0.007 ETH to your wallet.')).toBeTruthy();
    expect(collectFunds).toHaveBeenCalledWith(config, window.ethereum);
    expect(state.refresh).toHaveBeenCalled();
    expect(onCollected).toHaveBeenCalled();
  });

  test('under StrictMode, a collection is confirmed and the button comes back', async () => {
    collectFunds.mockResolvedValue({ hash: '0xabc', wei: parseEther('0.0065') });
    const state = chain({ wallet: WALLET, account: WALLET, credits: parseEther('0.0065'), stake: 0n });
    render(<StrictMode><CollectFunds chain={state} /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: 'Collect funds' }));
    expect(await screen.findByText('Collected 0.007 ETH to your wallet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collect funds' }).disabled).toBe(false);
  });

  test('nothing to collect: the button is disabled', () => {
    render(<CollectFunds chain={chain({ wallet: WALLET, account: WALLET, credits: 0n, stake: 0n })} />);
    expect(screen.getByRole('button', { name: 'Collect funds' }).disabled).toBe(true);
  });

  test('earnings belong to another wallet: disabled, and it says which wallet to switch to', () => {
    render(<CollectFunds chain={chain({ wallet: WALLET, account: OTHER, credits: parseEther('1'), stake: 0n })} />);
    expect(screen.getByRole('button', { name: 'Collect funds' }).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain(OTHER);
  });

  test('a declined wallet request is explained and the button comes back', async () => {
    collectFunds.mockRejectedValue(Object.assign(new Error('User rejected'), { code: 4001 }));
    render(<CollectFunds chain={chain({ wallet: WALLET, account: WALLET, credits: parseEther('1'), stake: 0n })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Collect funds' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Wallet request declined. You can try again.');
    expect(screen.getByRole('button', { name: 'Collect funds' }).disabled).toBe(false);
  });

  test('demo mode (no contract): nothing is shown', () => {
    const { container } = render(<CollectFunds chain={{ config: { executionMode: 'demo' }, available: false, balances: null, refresh: vi.fn() }} />);
    expect(container.innerHTML).toBe('');
  });
});
