// The session key panel: authorizing (key shown once), revoking, and what it shows for an
// existing, expired or missing key.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../src/sessionKey', () => ({ authorizeSessionKey: vi.fn(), readSessionKey: vi.fn(), revokeSessionKey: vi.fn() }));
const { authorizeSessionKey, readSessionKey, revokeSessionKey } = await import('../../src/sessionKey');
const { default: SessionKeyPanel } = await import('../../src/components/SessionKeyPanel');

const OWNER = '0x1111111111111111111111111111111111111111';
const KEY = '0x3333333333333333333333333333333333333333';
const config = { executionMode: 'chain', chain: { chainId: 31337, address: '0x2222222222222222222222222222222222222222' } };
const api = (cfg = config) => ({ getConfig: vi.fn().mockResolvedValue(cfg) });
const inAnHour = Math.floor(Date.now() / 1000) + 3600;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SessionKeyPanel', () => {
  test('authorizing shows the private key once, with the chosen expiry and funding', async () => {
    readSessionKey.mockResolvedValue(null);
    authorizeSessionKey.mockResolvedValue({ privateKey: '0xsecret', address: KEY, expiresAt: inAnHour });
    render(<SessionKeyPanel api={api()} wallet={OWNER} />);
    const button = await screen.findByRole('button', { name: 'Authorize provider client' });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Expires after (days)'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Fund with (ETH)'), { target: { value: '0.1' } });
    fireEvent.click(button);
    const key = await screen.findByLabelText('Session key (shown once)');
    expect(key.value).toBe('0xsecret');
    expect(key.type).toBe('password');
    expect(authorizeSessionKey).toHaveBeenCalledWith({ config, owner: OWNER, expiresInDays: '7', fundingEth: '0.1' });
  });

  test('an active key can be replaced or revoked; revoking hides the key and says so', async () => {
    readSessionKey.mockResolvedValue({ address: KEY, expiresAt: inAnHour, expired: false });
    revokeSessionKey.mockResolvedValue({});
    render(<SessionKeyPanel api={api()} wallet={OWNER} />);
    expect(await screen.findByRole('button', { name: 'Authorize a new key' })).toBeTruthy();
    expect(screen.getByText(/Current key 0x3333…3333 · expires/)).toBeTruthy();
    readSessionKey.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Session key revoked/);
    expect(revokeSessionKey).toHaveBeenCalledWith(config, OWNER);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke key' })).toBeNull());
  });

  test('an expired key offers a new authorization but no revoke', async () => {
    readSessionKey.mockResolvedValue({ address: KEY, expiresAt: 1, expired: true });
    render(<SessionKeyPanel api={api()} wallet={OWNER} />);
    expect(await screen.findByText(/expired/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Authorize provider client' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revoke key' })).toBeNull();
  });

  test('a declined wallet request shows why and shows no key', async () => {
    readSessionKey.mockResolvedValue(null);
    authorizeSessionKey.mockRejectedValue(Object.assign(new Error('nope'), { code: 4001 }));
    render(<SessionKeyPanel api={api()} wallet={OWNER} />);
    const button = await screen.findByRole('button', { name: 'Authorize provider client' });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe('Wallet request declined. You can try again.');
    expect(screen.queryByLabelText('Session key (shown once)')).toBeNull();
  });

  test('without a contract (local or demo mode) the panel is hidden', async () => {
    const { container } = render(<SessionKeyPanel api={api({ executionMode: 'local', chain: null })} wallet={OWNER} />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
    expect(readSessionKey).not.toHaveBeenCalled();
  });
});
