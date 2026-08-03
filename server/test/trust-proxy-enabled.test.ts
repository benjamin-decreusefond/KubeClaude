import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signIn, startTestApp } from './helpers/app.js';

/**
 * The other half of the TRUST_PROXY contract, in its own process — `config`
 * is read once at import, so this cannot share a file with the default-off
 * case in trust-proxy.test.ts.
 */
test('TRUST_PROXY=true derives request.ip from X-Forwarded-For as documented', async () => {
  const kube = await startTestApp({ env: { TRUST_PROXY: 'true' } });
  try {
    await signIn(kube);
    await kube.request({
      method: 'PATCH',
      url: '/api/auth/config',
      payload: { requirement: 'local_bypass' },
    });

    const viaProxy = await kube.app.inject({
      method: 'GET',
      url: '/api/status',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });

    assert.equal(viaProxy.statusCode, 200, 'once trusted, the forwarded address is honoured');
  } finally {
    await kube.close();
  }
});
