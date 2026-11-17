// Provider setup: the benchmarked machine, the suggested and saved hourly price, the client API
// key, and what's disabled before the provider client has registered the machine.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../src/useProviderBalances', () => ({
  useProviderBalances: () => ({ config: null, available: false, balances: null, error: '', refresh: () => {} }),
}));
const { default: ProviderSetup } = await import('../../src/components/ProviderSetup');

const machine = {
  address: '0x1111111111111111111111111111111111111111', updatedAt: '2026-11-17T00:00:00Z',
  cpu: { model: 'Test CPU', cores: 8, threads: 16, singleThreadMBps: 45, multiThreadMBps: 610 },
  memory: { totalGb: 31.2, bandwidthGBps: 18.5 },
  gpus: [{ vendor: 'nvidia', index: 0, model: 'RTX 2070', vramGb: 8, runtime: 'CUDA 12.4', fp32Tflops: null, memoryBandwidthGBps: null, error: "Docker can't use this GPU" }],
  relative: { cpuSingleThread: 1.2, cpuMultiThread: 2.5, memoryBandwidth: 1.1, gpus: [null], reference: 'i7-9700K' },
};
const suggestedPrice = { formula: { pricePerHour: '0.0012', items: [{ label: 'CPU', detail: ' 16 vCPUs', pricePerHour: '0.0010' }, { label: 'Memory', detail: ' 31 GB', pricePerHour: '0.0002' }] }, market: null };
const api = (provider, extra = {}) => ({
  getProvider: vi.fn().mockResolvedValue({ provider }),
  getProviderTutorial: vi.fn().mockResolvedValue({ tutorial: { title: 'Client setup', steps: ['Run the client.'] } }),
  saveProviderPricing: vi.fn().mockResolvedValue({ provider: { ...provider, pricePerHour: '0.0012' } }),
  ...extra,
});
const registered = (overrides = {}) => ({ registered: true, online: true, lastSeen: '2026-11-17T00:00:00Z', pricePerHour: null, machine, suggestedPrice, ...overrides });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ProviderSetup', () => {
  test('shows the benchmarked machine, including a GPU that can\'t be offered and why', async () => {
    render(<ProviderSetup api={api(registered())} />);
    expect(await screen.findByText(/8 cores · 16 vCPUs/)).toBeTruthy();
    expect(screen.getByText("Not offered for jobs: Docker can't use this GPU")).toBeTruthy();
    expect(screen.getByText(/1.0× is the reference machine: i7-9700K/)).toBeTruthy();
  });

  test('the suggested price can be used and saved', async () => {
    const client = api(registered());
    render(<ProviderSetup api={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use suggested price' }));
    expect(screen.getByLabelText('Price (ETH / hour)').value).toBe('0.0012');
    fireEvent.click(screen.getByRole('button', { name: 'Save price' }));
    expect((await screen.findByText('Hourly price saved.')).textContent).toBe('Hourly price saved.');
    expect(client.saveProviderPricing).toHaveBeenCalledWith({ pricePerHour: '0.0012' });
  });

  test.each(['0', '0.000', 'abc', '1e-3', '-1', '1.0000000000000000001'])('rejects the price %j without calling the server', async value => {
    const client = api(registered());
    render(<ProviderSetup api={client} />);
    fireEvent.change(await screen.findByLabelText('Price (ETH / hour)'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save price' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/positive ETH amount/);
    expect(client.saveProviderPricing).not.toHaveBeenCalled();
  });

  test('a machine not benchmarked yet can\'t be priced', async () => {
    render(<ProviderSetup api={api({ registered: false, online: false, lastSeen: null, pricePerHour: null, machine: null, suggestedPrice: null })} />);
    expect(await screen.findByText("Waiting for the provider client's hardware benchmark.")).toBeTruthy();
    expect(screen.getByLabelText('Price (ETH / hour)').disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Save price' }).disabled).toBe(true);
  });

  test('the client API key is masked and can be copied', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ProviderSetup api={api(registered())} clientKey="secret-api-key" />);
    const key = await screen.findByLabelText('Client API key');
    expect(key.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Copy client API key' }));
    expect(await screen.findByText('Client API key copied.')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('secret-api-key');
  });
});
