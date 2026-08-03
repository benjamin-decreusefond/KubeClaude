import { useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Card, Checkbox, Field } from './primitives';
import { usePolled } from '../hooks';
import type { AuthConfig, AuthMethod } from '../types';

const METHOD_HINT: Record<AuthMethod, string> = {
  forms: 'A login page and a session cookie, valid until it expires or you sign out.',
  basic:
    'The browser asks for the password on every request. No login page, and no way to sign out short of closing the browser.',
  none: 'Nobody is asked anything. Only safe when something else already gates access to this port.',
  external:
    'A reverse proxy in front — oauth2-proxy, Authelia, Cloudflare Access, an ingress with SSO — has already authenticated the request, and KubeClaude reads the user name out of a header it sends.',
};

/**
 * Everything about who may reach this instance. Kept apart from the rest of
 * Settings because it saves as you go rather than on the page's Save button:
 * a half-applied change to authentication is how people lock themselves out.
 */
export function SecuritySettings() {
  const { data: config, refresh } = usePolled<AuthConfig>(() => api.authConfig(), 0);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!config) return <Card title="Security">Loading…</Card>;

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const changePassword = () => {
    if (newPassword.length < 8 || newPassword !== confirm) return;
    void run(async () => {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    }, 'Password changed. Every other browser has been signed out.');
  };

  return (
    <Card
      title="Security"
      subtitle="Who may reach this instance. Changes here apply immediately, not on Save."
    >
      {error && <Banner tone="critical">{error}</Banner>}
      {notice && <Banner tone="warning" icon="✓">{notice}</Banner>}

      {config.locked && (
        <Banner>
          <code>AUTH_METHOD</code> is set in the environment, so the login method is pinned to{' '}
          <strong>{config.method}</strong> and cannot be changed from here.
        </Banner>
      )}

      <Field label="Authentication" hint={METHOD_HINT[config.method]}>
        <select
          value={config.method}
          disabled={config.locked || busy}
          onChange={(event) =>
            void run(
              () => api.updateAuthConfig({ method: event.target.value as AuthMethod }),
              'Authentication method changed.',
            )
          }
        >
          <option value="forms">Forms — a login page</option>
          <option value="basic">Basic — the browser asks</option>
          <option value="external">External — trust a proxy in front</option>
          <option value="none">None — no authentication</option>
        </select>
      </Field>

      {config.method === 'none' && (
        <Banner tone="critical">
          Anyone who can reach this port can start a Claude session with whatever access you have given it —
          your cluster, your repositories, your tokens. Only leave this off behind a VPN or a proxy that
          authenticates for you.
        </Banner>
      )}

      {config.method === 'external' && (
        <Field
          label="User header"
          hint="The header your proxy sets once it has authenticated someone. Leave it empty to trust the proxy unconditionally — only do that if nothing can reach this port except through it."
        >
          <input
            type="text"
            defaultValue={config.externalUserHeader}
            disabled={busy}
            placeholder="X-Forwarded-User"
            onBlur={(event) =>
              void run(
                () => api.updateAuthConfig({ externalUserHeader: event.target.value.trim() }),
                'User header updated.',
              )
            }
          />
        </Field>
      )}

      {config.method !== 'none' && (
        <>
          <Checkbox
            checked={config.requirement === 'local_bypass'}
            onChange={(value) =>
              void run(
                () => api.updateAuthConfig({ requirement: value ? 'local_bypass' : 'always' }),
                value ? 'The local network no longer has to sign in.' : 'Everyone has to sign in.',
              )
            }
            label="Skip authentication on the local network"
            hint="Requests from 10./172.16-31./192.168./loopback get in without signing in. Convenient at home; wrong the moment this port is reachable from outside."
          />
          {config.behindProxy && (
            <Banner tone={config.requirement === 'local_bypass' ? 'critical' : undefined}>
              Requests are reaching this instance through a proxy and <code>TRUST_PROXY</code> is off, so the
              address KubeClaude sees is the proxy&apos;s, not the caller&apos;s.{' '}
              {config.requirement === 'local_bypass'
                ? 'The bypass above is therefore refused for every request — otherwise anyone who can reach that proxy would get in without signing in. Turn it off, or set TRUST_PROXY=true once the proxy overwrites X-Forwarded-For rather than appending to it.'
                : 'The bypass above would be refused for every request while that is the case. Set TRUST_PROXY=true first, and only once the proxy overwrites X-Forwarded-For rather than appending to it.'}
            </Banner>
          )}
        </>
      )}

      {(config.method === 'forms' || config.method === 'basic') && (
        <div style={{ marginTop: 18, borderTop: '1px solid var(--grid)', paddingTop: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>Password</strong>
            <span className="stat-note">
              Signed in as {config.username} · {config.activeSessions} active session
              {config.activeSessions === 1 ? '' : 's'}
            </span>
          </div>

          <Field label="Username">
            <input
              type="text"
              defaultValue={config.username}
              disabled={busy}
              onBlur={(event) => {
                const username = event.target.value.trim();
                if (!username || username === config.username) return;
                void run(() => api.updateAuthConfig({ username }), 'Username changed.');
              }}
            />
          </Field>

          <div className="grid-2">
            <Field label="Current password">
              <input
                type="password"
                value={currentPassword}
                autoComplete="current-password"
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </Field>
            <Field label="Session lifetime (days)">
              <input
                type="number"
                min={1}
                max={365}
                defaultValue={config.sessionDays}
                onBlur={(event) =>
                  void run(
                    () => api.updateAuthConfig({ sessionDays: Number(event.target.value) }),
                    'Session lifetime updated. It applies to sessions created from now on.',
                  )
                }
              />
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              <input
                type="password"
                value={newPassword}
                autoComplete="new-password"
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </Field>
            <Field
              label="Confirm new password"
              hint={confirm && confirm !== newPassword ? 'The two do not match.' : undefined}
            >
              <input
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(event) => setConfirm(event.target.value)}
              />
            </Field>
          </div>

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button
              className="ghost small"
              disabled={busy}
              onClick={() =>
                void run(() => api.revokeSessions(), 'Every browser has been signed out, including this one.')
              }
            >
              Sign out everywhere
            </button>
            <button
              className="small"
              disabled={busy || newPassword.length < 8 || newPassword !== confirm}
              onClick={changePassword}
            >
              Change password
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 18, borderTop: '1px solid var(--grid)', paddingTop: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>API key</strong>
          <div className="row">
            {config.hasApiKey ? <Badge tone="good">Configured</Badge> : <Badge>None</Badge>}
            {config.staticTokenConfigured && <Badge>KUBECLAUDE_AUTH_TOKEN also set</Badge>}
          </div>
        </div>
        <p className="stat-note" style={{ marginTop: 6 }}>
          Scripts send it as <code>X-Api-Key</code> or <code>Authorization: Bearer</code>, and it is accepted
          whatever the login method says — so automation keeps working when you change how people sign in. It
          is stored hashed, so a new one can only be shown once.
        </p>

        {apiKey && (
          <div className="mono-block" style={{ marginTop: 10, userSelect: 'all' }}>
            {apiKey}
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button
            className="ghost small"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await api.rotateApiKey();
                setApiKey(result.apiKey);
              }, 'New API key generated. The previous one stopped working.')
            }
          >
            {config.hasApiKey ? 'Generate a new key' : 'Generate a key'}
          </button>
        </div>
      </div>
    </Card>
  );
}
