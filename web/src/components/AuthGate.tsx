import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from '../api';
import { Banner, Card, Checkbox, Field } from './primitives';
import type { AuthMethod, AuthState } from '../types';

const METHOD_HINT: Record<AuthMethod, string> = {
  forms: 'A login page and a session cookie. What you want unless something in front already authenticates.',
  basic: 'The browser asks for the password itself. Simple, but signing out means closing the browser.',
  none: 'Nobody is asked anything. Only safe when something else — a VPN, a proxy — already gates access.',
  external:
    'A reverse proxy in front (oauth2-proxy, Authelia, Cloudflare Access) has already authenticated the request, and KubeClaude reads the user name from a header.',
};

/**
 * Everything before the app: first-run setup, then the login screen. The state
 * it renders from is the only thing the server will say to an unauthenticated
 * caller, so this component is what turns a 401 into something actionable.
 */
export function AuthGate({ children }: { children: (state: AuthState, reload: () => void) => ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setState(await api.authState());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !state) {
    return (
      <Shell>
        <Banner tone="critical">Could not reach KubeClaude: {error}</Banner>
      </Shell>
    );
  }

  if (!state) return <Shell>Loading…</Shell>;

  if (state.setupRequired && !state.authenticated) {
    return (
      <Shell>
        <Setup onDone={() => void load()} />
      </Shell>
    );
  }

  if (!state.authenticated) {
    return (
      <Shell>
        <Login method={state.method} onDone={() => void load()} />
      </Shell>
    );
  }

  return <>{children(state, () => void load())}</>;
}

/** A centred single-card page, so the login screen does not sit in the app chrome. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="brand" style={{ marginBottom: 18 }}>
          <div className="brand-mark" aria-hidden>
            KC
          </div>
          <div>
            <div className="brand-name">KubeClaude</div>
            <div className="brand-sub">Claude Code, on a schedule</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function Setup({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [method, setMethod] = useState<AuthMethod>('forms');
  const [localBypass, setLocalBypass] = useState(false);
  const [token, setTokenDraft] = useState(getToken());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = username.trim() && password.length >= 8 && confirm === password && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // An instance already protected by KUBECLAUDE_AUTH_TOKEN requires it here,
      // so upgrading a locked-down deployment cannot be hijacked by whoever
      // loads this page first.
      if (token.trim()) setToken(token.trim());
      const result = await api.setupAuth({
        username: username.trim(),
        password,
        method,
        requirement: localBypass ? 'local_bypass' : 'always',
      });
      setApiKey(result.apiKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (apiKey) {
    return (
      <Card title="You are set up" subtitle="Copy the API key now — it is stored hashed and cannot be shown again.">
        <div className="mono-block" style={{ userSelect: 'all' }}>
          {apiKey}
        </div>
        <p className="stat-note" style={{ marginTop: 10 }}>
          Scripts send it as <code>X-Api-Key</code> or <code>Authorization: Bearer</code>. It keeps working
          whatever login method you pick, so automation does not break when you change how you sign in.
        </p>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="primary" onClick={onDone}>
            Open KubeClaude
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card title="Set a password" subtitle="First run. This instance can start Claude sessions that act on your infrastructure, so it should not be open.">
      {error && <Banner tone="critical">{error}</Banner>}

      <Field label="Username">
        <input
          type="text"
          value={username}
          autoComplete="username"
          onChange={(event) => setUsername(event.target.value)}
        />
      </Field>

      <Field label="Password" hint={tooShort ? 'Too short — at least 8 characters.' : 'At least 8 characters.'}>
        <input
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>

      <Field label="Confirm password" hint={mismatch ? 'The two do not match.' : undefined}>
        <input
          type="password"
          value={confirm}
          autoComplete="new-password"
          onChange={(event) => setConfirm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ready) void submit();
          }}
        />
      </Field>

      <Field label="How to sign in" hint={METHOD_HINT[method]}>
        <select value={method} onChange={(event) => setMethod(event.target.value as AuthMethod)}>
          <option value="forms">Forms — a login page</option>
          <option value="basic">Basic — the browser asks</option>
          <option value="external">External — a proxy in front already did</option>
          <option value="none">None — no authentication</option>
        </select>
      </Field>

      <Checkbox
        checked={localBypass}
        onChange={setLocalBypass}
        label="Skip authentication on the local network"
        hint="Anything from 10./172.16-31./192.168./loopback gets in without signing in. Convenient at home; wrong the moment this port is reachable from outside."
      />

      <details style={{ marginTop: 12 }}>
        <summary className="stat-note">This instance already has KUBECLAUDE_AUTH_TOKEN set</summary>
        <Field
          label="Static token"
          hint="Only needed when the server runs with KUBECLAUDE_AUTH_TOKEN. It has to be presented here, so an already-protected instance stays protected while you set a password."
        >
          <input
            type="password"
            value={token}
            onChange={(event) => setTokenDraft(event.target.value)}
            placeholder="Paste the token"
          />
        </Field>
      </details>

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="primary" disabled={!ready} onClick={() => void submit()}>
          {busy ? 'Setting up…' : 'Set password'}
        </button>
      </div>
    </Card>
  );
}

function Login({ method, onDone }: { method: AuthMethod; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (method === 'external') {
    return (
      <Card title="Not signed in" subtitle="This instance trusts a proxy in front of it.">
        <p className="secondary">
          The proxy did not send an authenticated user, so KubeClaude has nothing to trust. Reach it through
          the proxy rather than directly, or check that the proxy still forwards the user header.
        </p>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="ghost" onClick={onDone}>
            Try again
          </button>
        </div>
      </Card>
    );
  }

  if (method === 'basic') {
    return (
      <Card title="Sign in" subtitle="This instance uses HTTP basic authentication.">
        <p className="secondary">
          Your browser should have asked for a username and password. If it did not, reload the page.
        </p>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </Card>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.login(username.trim(), password);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Sign in">
      {error && <Banner tone="critical">{error}</Banner>}
      <Field label="Username">
        <input
          type="text"
          value={username}
          autoComplete="username"
          autoFocus
          onChange={(event) => setUsername(event.target.value)}
        />
      </Field>
      <Field label="Password">
        <input
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="primary" disabled={busy || !username.trim() || !password} onClick={() => void submit()}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </Card>
  );
}
