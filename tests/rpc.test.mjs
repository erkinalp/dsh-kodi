/**
 * tests/rpc.test.mjs — the JSON-RPC transport contract.
 *
 * Every case runs against tests/mock-kodi.mjs on an ephemeral port; nothing
 * here needs a real Kodi. The assertions follow CONTRACTS.md §src/rpc.mjs:
 * JSON-RPC 2.0 POST, basic auth, typed error kinds, redacted endpoint and no
 * password in any message.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startMockKodi } from './mock-kodi.mjs';
import { KodiRpc, KodiRpcError } from '../src/rpc.mjs';

/**
 * Start a mock Kodi and close it when the test ends.
 * @param {import('node:test').TestContext} t
 * @param {Parameters<typeof startMockKodi>[0]} [options]
 * @returns {Promise<Awaited<ReturnType<typeof startMockKodi>>>}
 */
async function mockKodi(t, options = {}) {
  const kodi = await startMockKodi(options);
  t.after(() => kodi.close());
  return kodi;
}

test('call posts JSON-RPC 2.0 with basic auth and returns the result', async (t) => {
  const kodi = await mockKodi(t);
  /** @type {Array<{url: string, init: any}>} */
  const seen = [];
  const rpc = new KodiRpc({
    url: kodi.url,
    user: 'kodi',
    password: 'kodi',
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init });
      return fetch(url, init);
    },
  });

  assert.equal(await rpc.call('JSONRPC.Ping'), 'pong');
  assert.deepEqual(await rpc.call('Application.GetProperties', { properties: ['volume', 'muted'] }), { volume: 62, muted: false });

  assert.equal(seen.length, 2);
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.method, 'JSONRPC.Ping');
  assert.deepEqual(body.params, {});
  assert.equal(typeof body.id, 'number');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['content-type'], 'application/json');
  assert.equal(seen[0].init.headers.authorization, `Basic ${Buffer.from('kodi:kodi').toString('base64')}`);
  assert.equal(seen[0].url, kodi.url);

  // ids increment per call
  assert.deepEqual(kodi.calls.map((call) => call.id), [1, 2]);
});

test('call forwards params to Kodi verbatim', async (t) => {
  const kodi = await mockKodi(t);
  const rpc = new KodiRpc({ url: kodi.url, user: 'kodi', password: 'kodi' });

  await rpc.call('Application.SetVolume', { volume: 12 });
  const [call] = kodi.findCalls('Application.SetVolume');
  assert.deepEqual(call.params, { volume: 12 });
  assert.equal(kodi.state.volume, 12);
});

test('HTTP 401 becomes kind "auth" and never leaks the password', async (t) => {
  const kodi = await mockKodi(t, { password: 'kodi' });
  const rpc = new KodiRpc({ url: kodi.url, user: 'kodi', password: 'wrong-secret' });

  await assert.rejects(rpc.call('JSONRPC.Ping'), (error) => {
    assert.ok(error instanceof KodiRpcError, 'error is a KodiRpcError');
    assert.equal(error.name, 'KodiRpcError');
    assert.equal(error.kind, 'auth');
    assert.equal(error.code, 'EAUTH');
    assert.equal(error.method, 'JSONRPC.Ping');
    assert.match(error.message, /401/);
    assert.ok(!error.message.includes('wrong-secret'), 'password must not appear in the message');
    return true;
  });

  assert.ok(!rpc.endpoint.includes('wrong-secret'));
  assert.ok(!rpc.authHeader.includes('wrong-secret'));
});

test('methods removed from Kodi 21 answer -32601 through the transport untouched', async (t) => {
  // Measured against live Kodi 21.3: JSONRPC.GetVersion and the
  // VideoLibrary.GetInProgress* endpoints no longer exist.
  const kodi = await mockKodi(t);
  const rpc = new KodiRpc({ url: kodi.url, user: 'kodi', password: 'kodi' });

  for (const method of ['JSONRPC.GetVersion', 'VideoLibrary.GetInProgressMovies', 'VideoLibrary.GetInProgressEpisodes']) {
    await assert.rejects(rpc.call(method), (error) => {
      assert.equal(error.kind, 'rpc');
      assert.equal(error.code, -32601);
      assert.match(error.message, /Method not found/);
      assert.equal(error.method, method);
      return true;
    });
  }
});

test('a JSON-RPC error object becomes kind "rpc" with code, message and method', async (t) => {
  const kodi = await mockKodi(t, { failMode: { kind: 'rpc-error', code: -32602, message: 'Invalid params' } });
  const rpc = new KodiRpc({ url: kodi.url, user: 'kodi', password: 'kodi' });

  await assert.rejects(rpc.call('VideoLibrary.GetMovies', { limits: { start: 0, end: 1 } }), (error) => {
    assert.ok(error instanceof KodiRpcError);
    assert.equal(error.kind, 'rpc');
    assert.equal(error.code, -32602);
    assert.equal(error.method, 'VideoLibrary.GetMovies');
    assert.match(error.message, /Invalid params/);
    assert.equal(error.data, null);
    return true;
  });
});

test('a hanging request becomes kind "timeout" and honours the per-call override', async (t) => {
  const kodi = await mockKodi(t, { failMode: 'hang' });
  const rpc = new KodiRpc({ url: kodi.url, user: 'kodi', password: 'kodi', timeoutMs: 5000 });

  const startedAt = Date.now();
  await assert.rejects(rpc.call('JSONRPC.Ping', {}, { timeoutMs: 120 }), (error) => {
    assert.ok(error instanceof KodiRpcError);
    assert.equal(error.kind, 'timeout');
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.method, 'JSONRPC.Ping');
    assert.match(error.message, /did not answer/);
    assert.match(error.message, /120ms/);
    return true;
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 2000, `per-call timeout should win over the 5000ms default (took ${elapsed}ms)`);
});

test('non-2xx becomes kind "transport" with the HTTP status', async (t) => {
  const kodi = await mockKodi(t, { failMode: 'http-500' });
  const rpc = new KodiRpc({ url: kodi.url, user: 'kodi', password: 'kodi' });

  await assert.rejects(rpc.call('JSONRPC.Ping'), (error) => {
    assert.equal(error.kind, 'transport');
    assert.equal(error.code, 'HTTP_500');
    assert.match(error.message, /HTTP 500/);
    return true;
  });
});

test('a non-JSON body becomes kind "transport" (EBADJSON)', async (t) => {
  const kodi = await mockKodi(t, { failMode: 'garbage' });
  const rpc = new KodiRpc({ url: kodi.url, user: 'kodi', password: 'kodi' });

  await assert.rejects(rpc.call('JSONRPC.Ping'), (error) => {
    assert.equal(error.kind, 'transport');
    assert.equal(error.code, 'EBADJSON');
    assert.match(error.message, /non-JSON/);
    return true;
  });
});

test('a closed endpoint becomes kind "transport" naming the redacted endpoint', async (t) => {
  const kodi = await startMockKodi({ password: 'kodi' });
  const { url } = kodi;
  await kodi.close();

  const rpc = new KodiRpc({ url, user: 'kodi', password: 'kodi', timeoutMs: 1000 });
  await assert.rejects(rpc.call('JSONRPC.Ping'), (error) => {
    assert.equal(error.kind, 'transport');
    assert.match(error.message, /Kodi is not reachable at/);
    assert.ok(error.message.includes(rpc.endpoint));
    assert.ok(!error.message.includes('kodi:kodi@'));
    return true;
  });
});

test('an empty url or disable() produces kind "disabled" without any request', async (t) => {
  const noEndpoint = new KodiRpc({ url: '' });
  assert.equal(noEndpoint.disabled, true);
  await assert.rejects(noEndpoint.call('JSONRPC.Ping'), (error) => {
    assert.equal(error.kind, 'disabled');
    assert.equal(error.code, 'EDISABLED');
    return true;
  });

  const kodi = await mockKodi(t);
  const rpc = new KodiRpc({ url: kodi.url, user: 'kodi', password: 'kodi' });
  assert.equal(await rpc.call('JSONRPC.Ping'), 'pong');
  assert.equal(kodi.calls.length, 1);

  rpc.disable();
  await assert.rejects(rpc.call('JSONRPC.Ping'), (error) => error.kind === 'disabled');
  assert.equal(kodi.calls.length, 1, 'disabled calls must not reach Kodi');

  rpc.enable();
  assert.equal(await rpc.call('JSONRPC.Ping'), 'pong');
});

test('endpoint and wsUrl are redacted; authHeader carries the credential', () => {
  const rpc = new KodiRpc({ url: 'http://kodi:s3cret@127.0.0.1:9/jsonrpc', user: 'kodi', password: 's3cret' });
  assert.equal(rpc.endpoint, 'http://127.0.0.1:9/jsonrpc');
  assert.equal(rpc.wsUrl, 'ws://127.0.0.1:9/jsonrpc');
  assert.ok(!rpc.endpoint.includes('s3cret'));
  assert.ok(!rpc.wsUrl.includes('s3cret'));
  assert.ok(!rpc.wsUrl.includes('@'));
  assert.equal(rpc.authHeader, `Basic ${Buffer.from('kodi:s3cret').toString('base64')}`);

  const secure = new KodiRpc({ url: 'https://kodi:s3cret@example.test/jsonrpc', password: 's3cret' });
  assert.ok(secure.wsUrl.startsWith('wss://example.test'));
  assert.ok(!secure.wsUrl.includes('s3cret'));
  assert.ok(!secure.wsUrl.includes('@'));

  const anonymous = new KodiRpc({ url: 'http://127.0.0.1:8080/jsonrpc' });
  assert.equal(anonymous.authHeader, null);
});

test('an invalid url is still reported without throwing', () => {
  const rpc = new KodiRpc({ url: 'not a url at all' });
  assert.equal(typeof rpc.endpoint, 'string');
  assert.equal(rpc.wsUrl, null);
});
