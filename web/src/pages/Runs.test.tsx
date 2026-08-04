import { MemoryRouter } from 'react-router-dom';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Runs } from './Runs';
import { api } from '../api';
import type { Run, RunStatus } from '../types';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { runs: vi.fn(), cancelRun: vi.fn() }, streamUrl: () => '/api/stream' };
});

const mocked = api as unknown as { runs: ReturnType<typeof vi.fn>; cancelRun: ReturnType<typeof vi.fn> };

function run(id: string, status: RunStatus, promptName: string): Run {
  return {
    id,
    promptName,
    status,
    triggerType: status === 'queued' ? 'goal' : 'manual',
    queuedAt: new Date().toISOString(),
    startedAt: null,
    durationMs: null,
    totalTokens: 0,
    costUsd: 0,
    resumeOfRunId: null,
  } as Run;
}

beforeEach(() => {
  mocked.runs.mockReset();
  mocked.cancelRun.mockReset();
  mocked.cancelRun.mockResolvedValue({});
  // EventSource does not exist in jsdom, and the page opens one on mount.
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a queued run can be cancelled from the list it appears in', async () => {
  // The case that has nowhere else to go: a goal iteration waiting its turn.
  // It has no prompt page and no chat, so the list is the only place to reach it.
  mocked.runs.mockResolvedValue({ items: [run('r1', 'queued', 'Keep the cluster tidy')], total: 1 });

  render(
    <MemoryRouter>
      <Runs />
    </MemoryRouter>,
  );

  const cancel = await screen.findByRole('button', { name: 'Cancel' });
  await userEvent.click(cancel);

  await waitFor(() => expect(mocked.cancelRun).toHaveBeenCalledWith('r1'));
});

test('a running run offers to be stopped, a finished one offers nothing', async () => {
  mocked.runs.mockResolvedValue({
    items: [run('r2', 'running', 'Nightly audit'), run('r3', 'succeeded', 'Nightly audit')],
    total: 2,
  });

  render(
    <MemoryRouter>
      <Runs />
    </MemoryRouter>,
  );

  await screen.findByRole('button', { name: 'Stop' });
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
});

test('queued runs have a filter of their own', async () => {
  mocked.runs.mockResolvedValue({ items: [], total: 0 });

  render(
    <MemoryRouter>
      <Runs />
    </MemoryRouter>,
  );

  await userEvent.click(await screen.findByRole('button', { name: 'Queued' }));
  await waitFor(() =>
    expect(mocked.runs.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'queued' }),
  );
});

test('a failed cancel says so, instead of leaving the row unexplained', async () => {
  mocked.runs.mockResolvedValue({ items: [run('r4', 'queued', 'Keep the cluster tidy')], total: 1 });
  mocked.cancelRun.mockRejectedValue(new Error('run already finished'));

  render(
    <MemoryRouter>
      <Runs />
    </MemoryRouter>,
  );

  const cancel = await screen.findByRole('button', { name: 'Cancel' });
  await userEvent.click(cancel);

  await screen.findByText('run already finished');
});
