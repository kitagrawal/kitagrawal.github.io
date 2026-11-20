import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';

const realFetch = globalThis.fetch;
let upstreamCalls;
let upstreamImpl;

const makeEnv = (over = {}) => ({
  ASSETS: { fetch: async req => new Response('asset:' + new URL(req.url).pathname, { status: 200 }) },
  CANCEL_LIMITER: { limit: async () => ({ success: true }) },
  CANCEL_API_URL: 'https://upstream.example/cancel',
  CANCEL_SHARED_SECRET: 'shh',
  SUBSCRIBE_URL: 'https://pay.example/link',
  ...over,
});

const post = (body = '{"c":"cus_123"}', headers = {}) =>
  new Request('https://appliedailetter.com/api/cancel', { method: 'POST', body, headers });

beforeEach(() => {
  upstreamCalls = [];
  upstreamImpl = async () => new Response('{"done":true,"until":1700000000}', { status: 200 });
  globalThis.fetch = async (url, init) => {
    upstreamCalls.push({ url, init });
    return upstreamImpl(url, init);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

test('cancel forwards body and secret header, returns the upstream status and body', async () => {
  const res = await worker.fetch(post(), makeEnv());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { done: true, until: 1700000000 });
  assert.equal(upstreamCalls.length, 1);
  const { url, init } = upstreamCalls[0];
  assert.equal(url, 'https://upstream.example/cancel');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-Cancel-Secret'], 'shh');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.body, '{"c":"cus_123"}');
});

test('cancel passes an upstream error status through', async () => {
  upstreamImpl = async () => new Response('{"error":"support"}', { status: 403 });
  const res = await worker.fetch(post(), makeEnv());
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'support' });
});

test('cancel rate-limits by CF-Connecting-IP and answers 429 without calling upstream', async () => {
  const keys = [];
  const env = makeEnv({ CANCEL_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: false }) } });
  const res = await worker.fetch(post('{}', { 'CF-Connecting-IP': '203.0.113.9' }), env);
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'support' });
  assert.deepEqual(keys, ['203.0.113.9']);
  assert.equal(upstreamCalls.length, 0);
});

test('cancel answers 503 when a secret is unset', async () => {
  for (const missing of ['CANCEL_API_URL', 'CANCEL_SHARED_SECRET']) {
    const res = await worker.fetch(post(), makeEnv({ [missing]: undefined }));
    assert.equal(res.status, 503, missing);
    assert.deepEqual(await res.json(), { error: 'support' });
  }
  assert.equal(upstreamCalls.length, 0);
});

test('cancel answers 502 when the upstream call throws', async () => {
  upstreamImpl = async () => { throw new TypeError('network down'); };
  const res = await worker.fetch(post(), makeEnv());
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'support' });
});

test('cancel answers 405 to other methods', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await worker.fetch(new Request('https://appliedailetter.com/api/cancel', { method }), makeEnv());
    assert.equal(res.status, 405, method);
  }
  assert.equal(upstreamCalls.length, 0);
});

test('/subscribe redirects to SUBSCRIBE_URL, and to / when unset', async () => {
  const set = await worker.fetch(new Request('https://appliedailetter.com/subscribe'), makeEnv());
  assert.equal(set.status, 302);
  assert.equal(set.headers.get('location'), 'https://pay.example/link');

  const head = await worker.fetch(new Request('https://appliedailetter.com/subscribe', { method: 'HEAD' }), makeEnv());
  assert.equal(head.status, 302);

  const unset = await worker.fetch(new Request('https://appliedailetter.com/subscribe'), makeEnv({ SUBSCRIBE_URL: undefined }));
  assert.equal(unset.status, 302);
  assert.equal(unset.headers.get('location'), 'https://appliedailetter.com/');
});

test('www redirects to the apex, keeping path and query', async () => {
  const res = await worker.fetch(new Request('https://www.appliedailetter.com/unsubscribe.html?c=cus_1'), makeEnv());
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://appliedailetter.com/unsubscribe.html?c=cus_1');
});

test('www redirect also applies to /api/cancel and /subscribe', async () => {
  for (const path of ['/api/cancel', '/subscribe']) {
    const res = await worker.fetch(new Request('https://www.appliedailetter.com' + path, { method: 'POST' }), makeEnv());
    assert.equal(res.status, 301, path);
  }
  assert.equal(upstreamCalls.length, 0);
});

test('everything else goes to the static assets', async () => {
  const res = await worker.fetch(new Request('https://appliedailetter.com/book.html'), makeEnv());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'asset:/book.html');
});

test('/subscribe falls back to / when SUBSCRIBE_URL is malformed', async () => {
  const res = await worker.fetch(new Request('https://appliedailetter.com/subscribe'), makeEnv({ SUBSCRIBE_URL: 'not a url' }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://appliedailetter.com/');
});
