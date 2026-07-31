import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after, beforeEach } from 'node:test';
import type { FastifyRequest } from 'fastify';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-auth-test-'));
process.env.DATA_DIR = tmpDir;
process.env.KUBECLAUDE_AUTH_TOKEN = 'static-token-for-machines';

const { migrate, db } = await import('../src/db.js');
const authStore = await import('../src/store/auth.js');
const { hashSecret, verifySecret, randomToken } = await import('../src/auth/secrets.js');
const { authenticate, isLocalAddress, isPublicPath, localBypassApplies, normaliseMethod, readCookie } =
  await import('../src/auth/guard.js');

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  authStore.clearSessions();
  authStore.updateAuthConfig({
    method: 'forms',
    requirement: 'always',
    externalUserHeader: 'X-Forwarded-User',
    username: 'operator',
  });
});

/** Enough of a Fastify request for the guard, which only reads these. */
function request(overrides: {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  ip?: string;
} = {}): FastifyRequest {
  return {
    headers: overrides.headers ?? {},
    query: overrides.query ?? {},
    ip: overrides.ip ?? '203.0.113.9',
  } as unknown as FastifyRequest;
}

test('a hashed secret verifies, and anything else does not', async () => {
  const hash = await hashSecret('correct horse battery staple');
  assert.equal(await verifySecret('correct horse battery staple', hash), true);
  assert.equal(await verifySecret('Correct horse battery staple', hash), false);
  assert.equal(await verifySecret('', hash), false);
  // A missing or corrupted hash must fail closed rather than wave things through.
  assert.equal(await verifySecret('anything', null), false);
  assert.equal(await verifySecret('anything', 'not-a-hash'), false);
  assert.equal(await verifySecret('anything', 'scrypt$aa$bb'), false);
});

test('the password is checked against the username too', async () => {
  await authStore.setPassword('a-good-password');
  assert.equal(await authStore.verifyPassword('operator', 'a-good-password'), true);
  assert.equal(await authStore.verifyPassword('OPERATOR', 'a-good-password'), true);
  assert.equal(await authStore.verifyPassword('someone-else', 'a-good-password'), false);
  assert.equal(await authStore.verifyPassword('operator', 'wrong'), false);
});

test('changing the password revokes every session', async () => {
  await authStore.setPassword('first-password');
  const token = randomToken();
  authStore.createSession(token, 30, null);
  assert.ok(authStore.useSession(token));

  await authStore.setPassword('second-password');
  assert.equal(authStore.useSession(token), null);
});

test('a session expires, and an expired one is cleaned up on use', () => {
  const token = randomToken();
  authStore.createSession(token, 1, null);
  assert.ok(authStore.useSession(token, new Date(Date.now() + 3_600_000)));
  assert.equal(authStore.useSession(token, new Date(Date.now() + 2 * 86_400_000)), null);
  // The lookup deleted it, so it is gone even for a caller who is "on time".
  assert.equal(authStore.useSession(token), null);
  assert.equal(authStore.countSessions(), 0);
});

test('forms auth accepts a session cookie and refuses everything else', async () => {
  await authStore.setPassword('a-good-password');
  const token = randomToken();
  authStore.createSession(token, 30, null);

  const withCookie = await authenticate(request({ headers: { cookie: `kubeclaude_session=${token}` } }));
  assert.equal(withCookie.allowed, true);
  assert.equal(withCookie.via, 'session');

  assert.equal((await authenticate(request())).allowed, false);
  assert.equal((await authenticate(request({ headers: { cookie: 'kubeclaude_session=nope' } }))).allowed, false);
});

test('an API key works whatever the login method is', async () => {
  await authStore.setPassword('a-good-password');
  const key = await authStore.rotateApiKey();

  for (const method of ['forms', 'basic', 'external'] as const) {
    authStore.updateAuthConfig({ method });
    const outcome = await authenticate(request({ headers: { 'x-api-key': key } }));
    assert.equal(outcome.allowed, true, `${method} should still accept an API key`);
    assert.equal(outcome.via, 'api-key');
  }

  // As a bearer token, and on the query string for EventSource.
  assert.equal((await authenticate(request({ headers: { authorization: `Bearer ${key}` } }))).allowed, true);
  assert.equal((await authenticate(request({ query: { apikey: key } }))).allowed, true);

  // Rotating it invalidates the old one.
  await authStore.rotateApiKey();
  assert.equal((await authenticate(request({ headers: { 'x-api-key': key } }))).allowed, false);
});

test('the static environment token is still accepted', async () => {
  const outcome = await authenticate(request({ headers: { authorization: 'Bearer static-token-for-machines' } }));
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.via, 'api-key');
  assert.equal((await authenticate(request({ headers: { 'x-api-key': 'nearly-right' } }))).allowed, false);
});

test('basic auth accepts the credentials and challenges without them', async () => {
  await authStore.setPassword('a-good-password');
  authStore.updateAuthConfig({ method: 'basic' });

  const encoded = Buffer.from('operator:a-good-password').toString('base64');
  const ok = await authenticate(request({ headers: { authorization: `Basic ${encoded}` } }));
  assert.equal(ok.allowed, true);
  assert.equal(ok.via, 'basic');

  const missing = await authenticate(request());
  assert.equal(missing.allowed, false);
  // Without the challenge the browser never shows its credentials dialog.
  assert.equal(missing.challenge, true);

  const wrong = Buffer.from('operator:guess').toString('base64');
  assert.equal((await authenticate(request({ headers: { authorization: `Basic ${wrong}` } }))).allowed, false);
});

test('external auth trusts the proxy header, and only that', async () => {
  authStore.updateAuthConfig({ method: 'external', externalUserHeader: 'X-Forwarded-User' });

  const forwarded = await authenticate(request({ headers: { 'x-forwarded-user': 'ben@example.com' } }));
  assert.equal(forwarded.allowed, true);
  assert.equal(forwarded.via, 'proxy');
  assert.equal(forwarded.username, 'ben@example.com');

  // A proxy that stopped sending the header is a misconfiguration, not an
  // invitation: the door stays shut.
  assert.equal((await authenticate(request())).allowed, false);
  assert.equal((await authenticate(request({ headers: { 'x-forwarded-user': '  ' } }))).allowed, false);

  // An empty header name is the explicit "trust it unconditionally" setting.
  authStore.updateAuthConfig({ externalUserHeader: '' });
  assert.equal((await authenticate(request())).allowed, true);
});

test('a session still works after switching to proxy authentication', async () => {
  await authStore.setPassword('a-good-password');
  const token = randomToken();
  authStore.createSession(token, 30, null);

  // Whoever flips this switch is holding a session this instance issued after a
  // password. Refusing it would lock them out between the click and the next
  // request, before they could see whether the proxy header even arrives.
  authStore.updateAuthConfig({ method: 'external', externalUserHeader: 'X-Forwarded-User' });
  const outcome = await authenticate(request({ headers: { cookie: `kubeclaude_session=${token}` } }));
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.via, 'session');

  // A stranger without the header is still refused.
  assert.equal((await authenticate(request())).allowed, false);
});

test('with no auth, everything is allowed', async () => {
  authStore.updateAuthConfig({ method: 'none' });
  const outcome = await authenticate(request());
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.via, 'open');
});

test('before setup, forms auth refuses and says why', async () => {
  // A fresh install has no password: the API stays shut, and the refusal has to
  // be distinguishable from a wrong password so the UI can offer setup instead.
  db.prepare('UPDATE auth_config SET password_hash = NULL WHERE id = 1').run();
  assert.equal(authStore.getAuthConfig().configured, false);

  const outcome = await authenticate(request());
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.setupRequired, true);

  // Basic auth cannot be talked into a challenge it could never satisfy.
  authStore.updateAuthConfig({ method: 'basic' });
  const encoded = Buffer.from('operator:whatever').toString('base64');
  const guessed = await authenticate(request({ headers: { authorization: `Basic ${encoded}` } }));
  assert.equal(guessed.allowed, false);
  assert.equal(guessed.setupRequired, true);
});

test('the local bypass only applies when it is turned on', async () => {
  await authStore.setPassword('a-good-password');
  assert.equal(localBypassApplies(request({ ip: '192.168.1.20' })), false);

  authStore.updateAuthConfig({ requirement: 'local_bypass' });
  assert.equal(localBypassApplies(request({ ip: '192.168.1.20' })), true);
  assert.equal(localBypassApplies(request({ ip: '203.0.113.9' })), false);

  // With no auth at all there is nothing to bypass.
  authStore.updateAuthConfig({ method: 'none' });
  assert.equal(localBypassApplies(request({ ip: '192.168.1.20' })), false);
});

test('private addresses are recognised and public ones are not', () => {
  for (const local of ['127.0.0.1', '::1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '172.31.255.254', '::ffff:10.0.0.4', 'fd00::1', 'fe80::1']) {
    assert.equal(isLocalAddress(local), true, `${local} should be local`);
  }
  for (const remote of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.9', '100.64.0.1', '2001:db8::1', '', undefined]) {
    assert.equal(isLocalAddress(remote), false, `${remote} should not be local`);
  }
});

test('only the login endpoints and the static shell are public', () => {
  assert.equal(isPublicPath('/'), true);
  assert.equal(isPublicPath('/assets/index.js'), true);
  assert.equal(isPublicPath('/healthz'), true);
  assert.equal(isPublicPath('/api/auth/state'), true);
  assert.equal(isPublicPath('/api/auth/login'), true);
  assert.equal(isPublicPath('/api/auth/setup'), true);

  assert.equal(isPublicPath('/api/prompts'), false);
  assert.equal(isPublicPath('/api/runs?limit=10'), false);
  assert.equal(isPublicPath('/api/auth/config'), false);
  assert.equal(isPublicPath('/api/auth/api-key'), false);
});

test('cookies are read by name, not by prefix', () => {
  const headers = { cookie: 'other=1; kubeclaude_session=abc%3D; kubeclaude_session_extra=zzz' };
  assert.equal(readCookie(request({ headers }), 'kubeclaude_session'), 'abc=');
  assert.equal(readCookie(request({ headers }), 'missing'), null);
  assert.equal(readCookie(request(), 'kubeclaude_session'), null);
});

test('only the four known methods are accepted from the environment', () => {
  assert.equal(normaliseMethod('forms'), 'forms');
  assert.equal(normaliseMethod(' External '), 'external');
  assert.equal(normaliseMethod('oauth'), null);
  assert.equal(normaliseMethod(''), null);
});
