const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchReconSafely } = require('../lib/app.js');

const validate = async raw => {
  const url = new URL(raw);
  if (url.hostname === '127.0.0.1' || url.hostname.endsWith('.internal')) {
    return { ok: false, reason: 'private host' };
  }
  return { ok: true, url };
};

function response(status, location, destroyed) {
  return {
    status,
    headers: { get: k => k.toLowerCase() === 'location' ? location : null },
    body: { destroy: () => { if (destroyed) destroyed.count++; } },
  };
}

test('a redirect to private/loopback address is never requested', async () => {
  const called = [];
  const destroyed = { count: 0 };
  const request = async (url, options) => {
    called.push(url);
    assert.equal(options.redirect, 'manual');
    return response(302, 'http://127.0.0.1/admin', destroyed);
  };
  await assert.rejects(
    fetchReconSafely('https://public.example/', {}, { request, validate }),
    /unsafe recon destination/
  );
  assert.deepEqual(called, ['https://public.example/']);
  assert.equal(destroyed.count, 1);
});

test('safe relative redirects are followed and bounded', async () => {
  const called = [];
  const request = async url => {
    called.push(url);
    return called.length === 1
      ? response(301, '/new-path') : response(200, null);
  };
  const result = await fetchReconSafely('https://public.example/start', {},
    { request, validate });
  assert.equal(result.status, 200);
  assert.deepEqual(called,
    ['https://public.example/start', 'https://public.example/new-path']);
});

test('a redirect to another hostname resolves only after safety validation', async () => {
  let calls = 0;
  const request = async () => { calls++; return response(302, 'https://api.internal/x'); };
  await assert.rejects(fetchReconSafely('https://public.example/', {},
    { request, validate }), /private host/);
  assert.equal(calls, 1);
});

test('malformed redirect and redirect loops fail closed', async () => {
  const request = async () => response(302, '/loop');
  await assert.rejects(fetchReconSafely('https://public.example/', {},
    { request, validate, maxRedirects: 2 }), /excessive recon redirects/);
  await assert.rejects(fetchReconSafely('https://public.example/', {},
    { request: async () => response(302, null), validate }), /invalid or excessive/);
});
