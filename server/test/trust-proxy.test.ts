import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signIn, startTestApp } from './helpers/app.js';

/**
 * `X-Forwarded-For` is attacker-controlled on any request that reaches the
 * server directly. `request.ip` feeds two security decisions — the
 * local-network auth bypass and the login lockout key — so trusting that
 * header must be opt-in, not the default.
 */
test('a spoofed X-Forwarded-For does not grant the local-network bypass unless TRUST_PROXY is on', async () => {
  const kube = await startTestApp();
  try {
    await signIn(kube);
    await kube.request({
      method: 'PATCH',
      url: '/api/auth/config',
      payload: { requirement: 'local_bypass' },
    });

    // A real remote client, claiming (via a header only it controls) to be
    // loopback. Fastify's inject lets us set the actual socket address.
    const spoofed = await kube.app.inject({
      method: 'GET',
      url: '/api/status',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });

    assert.equal(spoofed.statusCode, 401, 'a forged X-Forwarded-For must not pass as local');

    // The same header read the other way round, which is the failure that
    // actually happens: behind an ingress the socket peer *is* private, so a
    // plain private-range check would wave the whole internet through. The
    // forwarded header is the evidence that the address is a hop, not a caller.
    const direct = await kube.app.inject({
      method: 'GET',
      url: '/api/status',
      remoteAddress: '10.42.0.7',
    });
    assert.equal(direct.statusCode, 200, 'a client actually on the LAN still gets the bypass');

    const viaIngress = await kube.app.inject({
      method: 'GET',
      url: '/api/status',
      remoteAddress: '10.42.0.7',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    assert.equal(viaIngress.statusCode, 401, "a proxied request must not inherit the proxy's locality");
  } finally {
    await kube.close();
  }
});
