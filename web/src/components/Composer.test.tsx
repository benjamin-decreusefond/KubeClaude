import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Composer } from './Composer';
import { api } from '../api';
import type { Prompt } from '../types';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, api: { promptFiles: vi.fn(), prompts: vi.fn() } };
});

const mocked = api as unknown as {
  promptFiles: ReturnType<typeof vi.fn>;
  prompts: ReturnType<typeof vi.fn>;
};

function prompt(name: string, text: string): Prompt {
  return { id: name, name, prompt: text } as Prompt;
}

/** The composer as the chat uses it: it owns the draft, this holds it. */
function Harness({ onSubmit = () => undefined }: { onSubmit?: () => void }) {
  const [value, setValue] = useState('');
  return <Composer value={value} onChange={setValue} onSubmit={onSubmit} promptId="chat-1" />;
}

beforeEach(() => {
  mocked.promptFiles.mockReset();
  mocked.prompts.mockReset();
  mocked.promptFiles.mockResolvedValue({
    root: '/data/workspaces/chat-1',
    items: [
      { path: 'server/src/db.ts', directory: false },
      { path: 'server/src/', directory: true },
    ],
  });
  mocked.prompts.mockResolvedValue([prompt('nightly-audit', 'Check the cluster and report.')]);
});

afterEach(cleanup);

test('@ offers files from the working directory and inserts the one you pick', async () => {
  const user = userEvent.setup();
  render(<Harness />);

  await user.click(screen.getByRole('textbox'));
  await user.keyboard('look at @db');

  await waitFor(() => expect(screen.getByRole('option', { name: /server\/src\/db\.ts/ })).toBeTruthy());
  expect(mocked.promptFiles).toHaveBeenCalledWith('chat-1', 'db', expect.any(Number));

  await user.keyboard('{Enter}');
  await waitFor(() => expect((screen.getByRole('textbox')).value).toBe('look at @server/src/db.ts '));
});

test('Enter takes the highlighted suggestion rather than sending', async () => {
  const onSubmit = vi.fn();
  const user = userEvent.setup();
  render(<Harness onSubmit={onSubmit} />);

  await user.click(screen.getByRole('textbox'));
  await user.keyboard('@db');
  await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
  await user.keyboard('{Enter}');

  expect(onSubmit).not.toHaveBeenCalled();

  // With the menu closed, Enter sends as it always did.
  await user.keyboard('{Enter}');
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test('/ lists saved prompts and inserts the whole text', async () => {
  const user = userEvent.setup();
  render(<Harness />);

  await user.click(screen.getByRole('textbox'));
  await user.keyboard('/night');

  await waitFor(() => expect(screen.getByRole('option', { name: /nightly-audit/ })).toBeTruthy());
  await user.keyboard('{Tab}');

  await waitFor(() =>
    expect((screen.getByRole('textbox')).value).toBe('Check the cluster and report.'),
  );
});

test('Escape closes the menu and leaves what you typed alone', async () => {
  const user = userEvent.setup();
  render(<Harness />);

  await user.click(screen.getByRole('textbox'));
  await user.keyboard('@db');
  await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('option')).toBeNull();
  expect((screen.getByRole('textbox')).value).toBe('@db');
});

test('Escape before the suggestions arrive keeps the menu shut', async () => {
  // The lookup is debounced, so there is a window where you have typed a
  // trigger and nothing is on screen yet. Dismissing in that window must not be
  // undone by the answer landing a moment later.
  let release: (value: { root: string; items: Array<{ path: string; directory: boolean }> }) => void = () => undefined;
  mocked.promptFiles.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );

  const user = userEvent.setup();
  render(<Harness />);

  await user.click(screen.getByRole('textbox'));
  await user.keyboard('@db');
  await user.keyboard('{Escape}');

  release({ root: '/w', items: [{ path: 'server/src/db.ts', directory: false }] });
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(screen.queryByRole('option')).toBeNull();
});

test('an ordinary message asks for nothing and sends on Enter', async () => {
  const onSubmit = vi.fn();
  const user = userEvent.setup();
  render(<Harness onSubmit={onSubmit} />);

  await user.click(screen.getByRole('textbox'));
  await user.keyboard('deploy the thing');
  await user.keyboard('{Enter}');

  expect(mocked.promptFiles).not.toHaveBeenCalled();
  expect(mocked.prompts).not.toHaveBeenCalled();
  expect(onSubmit).toHaveBeenCalledTimes(1);
});
