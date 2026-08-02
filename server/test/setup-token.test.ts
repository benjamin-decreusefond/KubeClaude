import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { startTestApp, type TestApp } from './helpers/app.js';

/**
 * First run on an instance that is already protected by KUBECLAUDE_AUTH_TOKEN.
 *
 * The refusal is deliberate — a deployment behind a public ingress must not be
 * claimable by whoever loads the page first — but a refusal is only useful if
 * the screen doing the asking knows about it in advance. That is what
 * `staticTokenRequired` is for: without it the form offers no visible way to
 * comply and reads as broken.
 */
const TOKEN = 'the-static-token';

let kube: TestApp;

before(async () => {
  kube = await startTestApp({ env: { KUBECLAUDE_AUTH_TOKEN: TOKEN } });
});
after(async () => kube.close());

test('the setup screen is told the token will be required', async () => {
  const response = await kube.request({ method: 'GET', url: '/api/auth/state' });
  const state = response.json<{ setupRequired: boolean; staticTokenRequired: boolean }>();

  assert.equal(state.setupRequired, true);
  assert.equal(state.staticTokenRequired, true);
});

test('setting a password without the token is refused', async () => {
  const response = await kube.request({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'owner', password: 'a-good-password' },
  });

  assert.equal(response.status, 401);
  assert.match(response.json<{ error: string }>().error, /KUBECLAUDE_AUTH_TOKEN/);
});

test('a wrong token is refused as firmly as none at all', async () => {
  const response = await kube.request({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'owner', password: 'a-good-password' },
    headers: { authorization: 'Bearer not-the-token' },
  });

  assert.equal(response.status, 401);
});

test('presenting it sets the password, and then it stops being special', async () => {
  const response = await kube.request({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username: 'owner', password: 'a-good-password' },
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 201);

  const state = await kube.request({ method: 'GET', url: '/api/auth/state' });
  const body = state.json<{ setupRequired: boolean; staticTokenRequired: boolean }>();
  assert.equal(body.setupRequired, false);
  // The token still works as a machine credential; there is simply no longer a
  // password to set, so the setup screen has nothing to say about it.
  assert.equal(body.staticTokenRequired, false);
});
