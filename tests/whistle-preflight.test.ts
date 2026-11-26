import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRootCa, checkW2, combine, interpreterOf, isVolatilePath } from '../plugins/whistle/preflight.mjs';

const nodeW2 = {
  file: '/opt/homebrew/bin/w2',
  label: '/opt/homebrew/bin/w2',
  exists: true,
  executable: true,
  runsWithExecPath: false,
  head: '#!/usr/bin/env node\nrequire("./bin");\n',
  nodeOnPath: '/opt/homebrew/bin/node',
  pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
  fileExists: () => true,
};

const codes = (result: { errors: Array<{ code: string }> }) => result.errors.map((item) => item.code);
const warningCodes = (result: { warnings: Array<{ code: string }> }) => result.warnings.map((item) => item.code);

test('w2 是 node 壳脚本但 PATH 里没有 node → WHISTLE_NODE_NOT_FOUND', () => {
  const result = checkW2({ ...nodeW2, nodeOnPath: null });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['WHISTLE_NODE_NOT_FOUND']);
  assert.match(result.errors[0].hint, /w2Path|whistle\.js/);

  const healthy = checkW2(nodeW2);
  assert.equal(healthy.ok, true, JSON.stringify(healthy.errors));
});

test('w2 不存在 / 没有执行位各自有错误码', () => {
  assert.deepEqual(codes(checkW2({ ...nodeW2, exists: false })), ['WHISTLE_W2_NOT_FOUND']);
  assert.deepEqual(codes(checkW2({ ...nodeW2, executable: false })), ['WHISTLE_W2_NOT_EXECUTABLE']);
});

test('内置 whistle.js 用 app 自带 node 执行，不要求执行位也不查 PATH 里的 node', () => {
  const result = checkW2({
    ...nodeW2,
    file: '/plugins/whistle/node_modules/whistle/bin/whistle.js',
    head: '',
    executable: false,
    runsWithExecPath: true,
    nodeOnPath: null,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('shebang 指到不存在的绝对 node 路径也算 node 缺失', () => {
  const result = checkW2({
    ...nodeW2,
    head: '#!/usr/local/bin/node\n',
    fileExists: (file: string) => file !== '/usr/local/bin/node',
  });
  assert.deepEqual(codes(result), ['WHISTLE_NODE_NOT_FOUND']);
});

test('/tmp 下的 w2Path 只发 WHISTLE_W2_PATH_VOLATILE 警告，不阻止启动', () => {
  const result = checkW2({ ...nodeW2, file: '/tmp/w2-snapshot/w2', label: '/tmp/w2-snapshot/w2' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(warningCodes(result), ['WHISTLE_W2_PATH_VOLATILE']);
  assert.equal(isVolatilePath('/tmp/w2'), true);
  assert.equal(isVolatilePath('/private/tmp/w2'), true);
  assert.equal(isVolatilePath('/var/folders/x/y/w2'), true);
  assert.equal(isVolatilePath('/opt/homebrew/bin/w2'), false);
});

test('shebang 解析区分 env node / 绝对 node / 其他解释器', () => {
  assert.equal(interpreterOf('#!/usr/bin/env node\n').kind, 'node-from-path');
  assert.equal(interpreterOf('#!/usr/local/bin/node\n').kind, 'node-absolute');
  assert.equal(interpreterOf('#!/bin/sh\n').kind, 'other');
  assert.equal(interpreterOf('\x7fELF').kind, 'none');
});

test('根证书：缺失只提示，存在但解析不了是硬错误', () => {
  const pending = checkRootCa({ file: '/root/.whistle/certs/root.crt', exists: false });
  assert.equal(pending.ok, true);
  assert.deepEqual(warningCodes(pending), ['WHISTLE_ROOT_CA_PENDING']);

  const notPem = checkRootCa({
    file: '/root/root.crt',
    exists: true,
    readFile: () => 'garbage',
    parse: () => {},
  });
  assert.deepEqual(codes(notPem), ['WHISTLE_ROOT_CA_INVALID']);

  const unparsable = checkRootCa({
    file: '/root/root.crt',
    exists: true,
    readFile: () => '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----',
    parse: () => {
      throw new Error('bad asn1');
    },
  });
  assert.deepEqual(codes(unparsable), ['WHISTLE_ROOT_CA_INVALID']);
  assert.match(unparsable.errors[0].message, /bad asn1/);

  const ok = checkRootCa({
    file: '/root/root.crt',
    exists: true,
    readFile: () => '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----',
    parse: () => {},
  });
  assert.equal(ok.ok, true);
});

test('combine 汇总错误与警告', () => {
  const merged = combine([
    checkW2({ ...nodeW2, nodeOnPath: null }),
    checkRootCa({ file: '/tmp/root.crt', exists: false }),
  ]);
  assert.equal(merged.ok, false);
  assert.deepEqual(
    merged.errors.map((item: { code: string }) => item.code),
    ['WHISTLE_NODE_NOT_FOUND'],
  );
  assert.equal(merged.warnings.length, 1);
});
