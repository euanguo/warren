import assert from 'node:assert/strict';
import test from 'node:test';
import { addressSecurity, resolveAddressInput } from '../src/renderer/lib/address-input.ts';

test('裸主机名补 https，本地回环补 http', () => {
  assert.equal(resolveAddressInput('example.com'), 'https://example.com/');
  assert.equal(resolveAddressInput('example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.equal(resolveAddressInput('127.0.0.1:8899'), 'http://127.0.0.1:8899/');
  assert.equal(resolveAddressInput('localhost:8899/login'), 'http://localhost:8899/login');
});

test('显式协议原样保留，且只放行 http/https', () => {
  assert.equal(resolveAddressInput('http://example.com/x'), 'http://example.com/x');
  assert.equal(resolveAddressInput('https://example.com'), 'https://example.com/');
  assert.equal(resolveAddressInput('file:///etc/passwd'), null);
  assert.equal(resolveAddressInput('javascript:alert(1)'), null);
});

test('不是地址的输入返回 null——不静默发给搜索引擎', () => {
  assert.equal(resolveAddressInput(''), null);
  assert.equal(resolveAddressInput('   '), null);
  assert.equal(resolveAddressInput('怎么修 electron 的坑'), null);
  assert.equal(resolveAddressInput('hello world'), null);
  assert.equal(resolveAddressInput('just-a-word'), null);
});

test('连接安全状态只看协议', () => {
  assert.equal(addressSecurity('https://example.com'), 'secure');
  assert.equal(addressSecurity('http://127.0.0.1:8899'), 'insecure');
  assert.equal(addressSecurity('about:blank'), 'none');
  assert.equal(addressSecurity(''), 'none');
});
