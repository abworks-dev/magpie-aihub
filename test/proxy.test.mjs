import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyFor, bypassed } from '../src/proxy.mjs';

const URL_ = 'https://aihub.top/api/v1/auth/me';

test('Magpie prefixed variable wins over a plain one', () => {
  assert.equal(proxyFor(URL_, { MAGPIE_HTTPS_PROXY: 'http://magpie:7890', HTTPS_PROXY: 'http://plain:8080' }), 'http://magpie:7890');
});

test('a plain HTTPS_PROXY is still honoured', () => {
  assert.equal(proxyFor(URL_, { HTTPS_PROXY: 'http://plain:8080' }), 'http://plain:8080');
});

test('no proxy configured means a direct request', () => {
  assert.equal(proxyFor(URL_, {}), undefined);
  assert.equal(proxyFor(URL_, { HTTPS_PROXY: '   ' }), undefined);
  assert.equal(proxyFor('not a url', { HTTPS_PROXY: 'http://plain:8080' }), 'http://plain:8080');
});

test('NO_PROXY bypasses the proxy for the matching host only', () => {
  assert.equal(proxyFor(URL_, { MAGPIE_HTTPS_PROXY: 'http://magpie:7890', MAGPIE_NO_PROXY: 'aihub.top' }), undefined);
  assert.equal(proxyFor(URL_, { MAGPIE_HTTPS_PROXY: 'http://magpie:7890', NO_PROXY: 'localhost,127.0.0.1' }), 'http://magpie:7890');
  assert.equal(proxyFor(URL_, { MAGPIE_HTTPS_PROXY: 'http://magpie:7890', NO_PROXY: 'notaihub.top' }), 'http://magpie:7890');
  assert.equal(proxyFor(URL_, { MAGPIE_HTTPS_PROXY: 'http://magpie:7890', NO_PROXY: '*' }), undefined);
});

test('a rule matches the host and its subdomains, never a suffix impostor', () => {
  assert.equal(bypassed('api.aihub.top', 'aihub.top'), true);
  assert.equal(bypassed('aihub.top.evil.test', 'aihub.top'), false);
  assert.equal(bypassed('aihub.top', '.aihub.top'), true);
  assert.equal(bypassed('aihub.top', 'aihub.top:443'), true);
});
