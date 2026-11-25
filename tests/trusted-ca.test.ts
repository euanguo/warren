import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leafSignedByCa, parseCa } from '../src/main/domain/trusted-ca.ts';

/**
 * `trustedCa` 是全项目唯一的证书放宽点，所以它只允许一种实现：
 * **验签通过才放行**。这里的 PEM 是一次性用 openssl 生成的（leaf 由 ca 签发，
 * other-ca 是另一张自签证书），目的就是证明「换一张 CA 就过不去」。
 */
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string): string => readFileSync(path.join(dir, name), 'utf8');

const ca = read('ca.pem');
const leaf = read('leaf.pem');
const otherCa = read('other-ca.pem');

test('由这张 CA 签发的叶子证书通过', () => {
  const parsed = parseCa(ca);
  assert.ok(parsed);
  assert.equal(leafSignedByCa(leaf, parsed), true);
});

test('换一张 CA 就不通过（不是「装了钩子就全放行」）', () => {
  const parsed = parseCa(otherCa);
  assert.ok(parsed);
  assert.equal(leafSignedByCa(leaf, parsed), false);
});

test('CA 自己签自己不算数：叶子必须是叶子', () => {
  // other-ca 是自签的，用 ca 验它必须失败——否则任何一张自签证书都能冒充
  const parsed = parseCa(ca);
  assert.ok(parsed);
  assert.equal(leafSignedByCa(otherCa, parsed), false);
});

test('坏输入一律 false / undefined，不抛异常', () => {
  const parsed = parseCa(ca);
  assert.ok(parsed);
  assert.equal(leafSignedByCa('not a pem', parsed), false);
  assert.equal(leafSignedByCa('', parsed), false);
  assert.equal(parseCa('not a pem'), undefined);
  assert.equal(parseCa(''), undefined);
});
