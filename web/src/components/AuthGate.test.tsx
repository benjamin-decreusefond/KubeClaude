import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AuthGate } from './AuthGate';
import { api } from '../api';
import type { AuthState } from '../types';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      authState: vi.fn(),
      setupAuth: vi.fn(),
      login: vi.fn(),
    },
  };
});

const mocked = api as unknown as {
  authState: ReturnType<typeof vi.fn>;
  setupAuth: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
};

function state(overrides: Partial<AuthState> = {}): AuthState {
  return {
    method: 'forms',
    setupRequired: false,
    authenticated: true,
    username: 'ben',
    via: 'session',
    locked: false,
    staticTokenRequired: false,
    local: false,
    ...overrides,
  };
}

function renderGate() {
  return render(<AuthGate>{(auth) => <div>app for {auth.username ?? 'nobody'}</div>}</AuthGate>);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  // Without `globals: true` testing-library does not register its own cleanup,
  // and every render would stack on the last one's DOM.
  cleanup();
  vi.clearAllMocks();
});

describe('first run', () => {
  test('asks for a password instead of showing the app', async () => {
    mocked.authState.mockResolvedValue(state({ setupRequired: true, authenticated: false, username: null }));
    renderGate();

    expect(await screen.findByText('Set a password')).toBeDefined();
    expect(screen.queryByText(/^app for/)).toBeNull();
  });

  test('will not submit until the password is long enough and both fields match', async () => {
    mocked.authState.mockResolvedValue(state({ setupRequired: true, authenticated: false, username: null }));
    renderGate();
    await screen.findByText('Set a password');

    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Set password' });
    expect(button.disabled).toBe(true);

    const password = screen.getByLabelText<HTMLInputElement>('Password');
    const confirm = screen.getByLabelText<HTMLInputElement>('Confirm password');

    await userEvent.type(password, 'short');
    expect(await screen.findByText('Too short — at least 8 characters.')).toBeDefined();
    expect(button.disabled).toBe(true);

    await userEvent.clear(password);
    await userEvent.type(password, 'a-good-password');
    await userEvent.type(confirm, 'a-different-password');
    expect(await screen.findByText('The two do not match.')).toBeDefined();
    expect(button.disabled).toBe(true);

    await userEvent.clear(confirm);
    await userEvent.type(confirm, 'a-good-password');
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  test('shows the API key exactly once, and only then opens the app', async () => {
    mocked.authState.mockResolvedValue(state({ setupRequired: true, authenticated: false, username: null }));
    mocked.setupAuth.mockResolvedValue({ ...state(), apiKey: 'kc-test-key-value' });
    renderGate();
    await screen.findByText('Set a password');

    await userEvent.type(screen.getByLabelText('Password'), 'a-good-password');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'a-good-password');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));

    expect(await screen.findByText('kc-test-key-value')).toBeDefined();
    expect(mocked.setupAuth.mock.calls[0]?.[0]).toEqual({
      username: 'admin',
      password: 'a-good-password',
      method: 'forms',
      requirement: 'always',
    });
    // Nothing to present on an instance with no static token.
    expect(mocked.setupAuth.mock.calls[0]?.[1]).toBeUndefined();

    // The app is only reached deliberately, so the key is not scrolled past.
    mocked.authState.mockResolvedValue(state());
    await userEvent.click(screen.getByRole('button', { name: 'Open KubeClaude' }));
    expect(await screen.findByText('app for ben')).toBeDefined();
  });

  test('the local bypass is off unless it is asked for', async () => {
    mocked.authState.mockResolvedValue(state({ setupRequired: true, authenticated: false, username: null }));
    mocked.setupAuth.mockResolvedValue({ ...state(), apiKey: 'k' });
    renderGate();
    await screen.findByText('Set a password');

    await userEvent.type(screen.getByLabelText('Password'), 'a-good-password');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'a-good-password');
    await userEvent.click(screen.getByText('Skip authentication on the local network'));
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));

    await waitFor(() =>
      expect(mocked.setupAuth.mock.calls[0]?.[0]).toMatchObject({ requirement: 'local_bypass' }),
    );
  });
});

describe('signing in', () => {
  test('shows the login form and hands over on success', async () => {
    mocked.authState.mockResolvedValue(state({ authenticated: false, username: null, via: null }));
    mocked.login.mockResolvedValue(state());
    renderGate();

    // "Sign in" is both the card title and the button, so ask for the button.
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeDefined();

    await userEvent.type(screen.getByLabelText('Username'), 'ben');
    await userEvent.type(screen.getByLabelText('Password'), 'a-good-password');

    mocked.authState.mockResolvedValue(state());
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(mocked.login).toHaveBeenCalledWith('ben', 'a-good-password'));
    expect(await screen.findByText('app for ben')).toBeDefined();
  });

  test('a rejected login says so and stays on the form', async () => {
    mocked.authState.mockResolvedValue(state({ authenticated: false, username: null, via: null }));
    mocked.login.mockRejectedValue(new Error('Wrong username or password'));
    renderGate();
    await screen.findByRole('button', { name: 'Sign in' });

    await userEvent.type(screen.getByLabelText('Username'), 'ben');
    await userEvent.type(screen.getByLabelText('Password'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Wrong username or password')).toBeDefined();
    expect(screen.queryByText(/^app for/)).toBeNull();
  });

  test('basic auth explains itself rather than showing a form that cannot work', async () => {
    mocked.authState.mockResolvedValue(
      state({ method: 'basic', authenticated: false, username: null, via: null }),
    );
    renderGate();

    expect(await screen.findByText(/browser should have asked/)).toBeDefined();
    // No form, because a form here could not do anything the browser has not.
    expect(screen.queryByLabelText('Username')).toBeNull();
  });

  test('a proxy that stopped forwarding a user is named as the problem', async () => {
    mocked.authState.mockResolvedValue(
      state({ method: 'external', authenticated: false, username: null, via: null }),
    );
    renderGate();

    expect(await screen.findByText('Not signed in')).toBeDefined();
    expect(screen.getByText(/proxy did not send an authenticated user/)).toBeDefined();
  });
});

describe('when the server cannot be reached', () => {
  test('says so instead of hanging on a spinner', async () => {
    mocked.authState.mockRejectedValue(new Error('Failed to fetch'));
    renderGate();

    expect(await screen.findByText(/Could not reach KubeClaude/)).toBeDefined();
  });
});

test('an authenticated caller goes straight through to the app', async () => {
  mocked.authState.mockResolvedValue(state({ method: 'none', username: null, via: 'open' }));
  renderGate();
  expect(await screen.findByText('app for nobody')).toBeDefined();
});

describe('an instance already protected by a static token', () => {
  test('asks for the token up front rather than refusing once you submit', async () => {
    mocked.authState.mockResolvedValue(
      state({ setupRequired: true, authenticated: false, username: null, via: null, staticTokenRequired: true }),
    );
    mocked.setupAuth.mockResolvedValue({ apiKey: 'kc_key' });

    renderGate();
    // Visible without expanding anything: the field is the only way to comply,
    // and hiding it behind a disclosure is how the form came to look broken.
    const token = await screen.findByLabelText('Static token');

    await userEvent.type(screen.getByLabelText('Password'), 'a-good-password');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'a-good-password');

    // And there is no point letting it be submitted without one.
    expect(screen.getByRole('button', { name: 'Set password' })).toHaveProperty('disabled', true);

    await userEvent.type(token, 'static-token-for-machines');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));

    await waitFor(() => expect(mocked.setupAuth).toHaveBeenCalled());
    // Presented with the request, so the server can check it.
    expect(mocked.setupAuth.mock.calls[0]?.[1]).toBe('static-token-for-machines');
    // And kept, now that it has been accepted.
    expect(localStorage.getItem('kubeclaude.token')).toBe('static-token-for-machines');
  });

  test('a token the server refuses is not kept', async () => {
    mocked.authState.mockResolvedValue(
      state({ setupRequired: true, authenticated: false, username: null, via: null, staticTokenRequired: true }),
    );
    mocked.setupAuth.mockRejectedValue(new Error('This instance is protected by KUBECLAUDE_AUTH_TOKEN'));

    renderGate();
    await userEvent.type(await screen.findByLabelText('Static token'), 'the-wrong-token');
    await userEvent.type(screen.getByLabelText('Password'), 'a-good-password');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'a-good-password');
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));

    await waitFor(() => expect(screen.getByText(/protected by KUBECLAUDE_AUTH_TOKEN/)).toBeTruthy());
    // Storing it would have broken every request after this one, quietly.
    expect(localStorage.getItem('kubeclaude.token')).toBeNull();
  });
});
