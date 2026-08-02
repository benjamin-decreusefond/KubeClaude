import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { api } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { reportError: vi.fn() } };
});

const mocked = api as unknown as { reportError: ReturnType<typeof vi.fn> };

function Boom(): JSX.Element {
  throw new Error('the page exploded');
}

beforeEach(() => {
  mocked.reportError.mockReset();
  mocked.reportError.mockResolvedValue({});
  // React logs the caught error itself; the test is about what we do with it.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('a page that throws leaves the shell standing and says so', () => {
  render(
    <ErrorBoundary where="/runs">
      <Boom />
    </ErrorBoundary>,
  );

  expect(screen.getByText('This page stopped working')).toBeTruthy();
  expect(screen.getByText(/the page exploded/)).toBeTruthy();
});

test('the fault is filed, with where it happened and a stack', async () => {
  // A message of its own: the reporter stays quiet about a fault it has just
  // filed, which is the whole point of it and would swallow this one.
  function Unique(): JSX.Element {
    throw new Error('a fault nothing else in this file raises');
  }

  render(
    <ErrorBoundary where="/runs">
      <Unique />
    </ErrorBoundary>,
  );

  await waitFor(() => expect(mocked.reportError).toHaveBeenCalledTimes(1));
  const [report] = mocked.reportError.mock.calls[0] as [{ message: string; detail?: string; context?: string }];
  expect(report.message).toBe('a fault nothing else in this file raises');
  expect(report.context).toBe('/runs');
  expect(report.detail).toContain('component stack');
});

test('"Try again" re-renders rather than reloading the tab', async () => {
  let shouldThrow = true;
  function Sometimes(): JSX.Element {
    if (shouldThrow) throw new Error('the page exploded');
    return <div>recovered</div>;
  }

  render(
    <ErrorBoundary>
      <Sometimes />
    </ErrorBoundary>,
  );

  shouldThrow = false;
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByText('recovered')).toBeTruthy();
});
