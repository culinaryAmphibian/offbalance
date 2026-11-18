// The job form: validation before anything is sent, what a valid job sends, and that a retry
// after a failed request reuses the same idempotency key (so the server can't save it twice).
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import JobForm from '../../src/components/JobForm';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const fill = values => {
  for (const [label, value] of Object.entries(values)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const VALID = { 'Job name': 'render frames', 'Container image': 'alpine:3.20', 'Hourly cap per provider (ETH)': '0.01' };

describe('JobForm', () => {
  test('an empty form shows its errors, focuses the first one and sends nothing', () => {
    const api = { createJob: vi.fn() };
    render(<JobForm api={api} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(api.createJob).not.toHaveBeenCalled();
    const name = screen.getByLabelText('Job name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(name);
  });

  test('a valid job is sent with an idempotency key, and the new job id is reported', async () => {
    const api = { createJob: vi.fn().mockResolvedValue({ job: { id: '42' } }) };
    const onCreated = vi.fn();
    render(<JobForm api={api} onCreated={onCreated} />);
    fill(VALID);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('42'));
    const [payload, key] = api.createJob.mock.calls[0];
    expect(payload).toMatchObject({ name: 'render frames', maxPrice: '0.01' });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a failed request shows the error, and retrying the same input reuses the same key', async () => {
    const api = { createJob: vi.fn().mockRejectedValueOnce(new Error('Server unavailable')).mockResolvedValue({ job: { id: '7' } }) };
    render(<JobForm api={api} onCreated={vi.fn()} />);
    fill(VALID);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect((await screen.findByRole('alert')).textContent).toBe('Server unavailable');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await vi.waitFor(() => expect(api.createJob).toHaveBeenCalledTimes(2));
    expect(api.createJob.mock.calls[1][1]).toBe(api.createJob.mock.calls[0][1]);
  });

  test('changing the input after a failure gets a new key (it is a different job)', async () => {
    const api = { createJob: vi.fn().mockRejectedValueOnce(new Error('Server unavailable')).mockResolvedValue({ job: { id: '8' } }) };
    render(<JobForm api={api} onCreated={vi.fn()} />);
    fill(VALID);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await screen.findByRole('alert');
    fill({ 'Job name': 'render more frames' });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await vi.waitFor(() => expect(api.createJob).toHaveBeenCalledTimes(2));
    expect(api.createJob.mock.calls[1][1]).not.toBe(api.createJob.mock.calls[0][1]);
  });
});
