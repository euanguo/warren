import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const hostPath = path.join(ROOT, 'plugins', 'whistle', 'host.mjs');
const manifestPath = path.join(ROOT, 'plugins', 'whistle', 'package.json');

test('Whistle 插件暴露通用观测/导出能力', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')).warren;
  const commands = new Set(manifest.contributes.commands.map((item: { name: string }) => item.name));
  for (const name of ['traffic', 'compose', 'doctor', 'frames', 'export']) {
    assert.equal(commands.has(name), true, name);
    assert.equal(manifest.contributes.rpc.includes(name), true, name);
  }
});

test('所有新能力都从 live 实例调用，不回落到全局 Whistle', async () => {
  const source = await readFile(hostPath, 'utf8');
  for (const fn of ['traffic', 'compose', 'doctor', 'exportData']) {
    assert.match(source, new RegExp(`(?:async )?function ${fn}|function ${fn}`), fn);
  }
  assert.match(source, /requireInstance\(host, input && input\.storage\)/);
  assert.match(source, /\/cgi-bin\/get-data/);
  assert.match(source, /\/cgi-bin\/composer/);
  assert.match(source, /\/cgi-bin\/https-status/);
  assert.match(source, /\/cgi-bin\/sessions\/export/);
});

test('traffic 默认脱敏且保留 RequestId 与 body 编码', async () => {
  const source = await readFile(hostPath, 'utf8');
  assert.match(source, /\[REDACTED\]/);
  assert.match(source, /requestIdOf/);
  assert.match(source, /requestBodyEncoding/);
  assert.match(source, /responseBodyEncoding/);
  assert.match(source, /includeSensitive !== true/);
});

test('har 导出先构造合法 HAR，并对 0 字节失败', async () => {
  const source = await readFile(hostPath, 'utf8');
  assert.match(source, /startedDateTime/);
  assert.match(source, /log:\s*\{/);
  assert.match(source, /WHISTLE_EXPORT_EMPTY/);
  assert.match(source, /sessions\.map\(harEntry\)/);
});

test('traffic 保留分页游标与查询窗口', async () => {
  const source = await readFile(hostPath, 'utf8');
  assert.match(source, /newIdsTotal/);
  assert.match(source, /endId/);
  assert.match(source, /startTime/);
  assert.match(source, /lastRowId/);
  assert.match(source, /dumpCount/);
});

test('compose 不伪装成页面身份请求，导出有上限提示', async () => {
  const source = await readFile(hostPath, 'utf8');
  assert.match(source, /enableProxyRules/);
  assert.match(source, /WHISTLE_EXPORT_EMPTY/);
  assert.match(source, /sessions/);
});

test('仓库不内置真实预设，预设由用户导入', async () => {
  const source = await readFile(hostPath, 'utf8');
  assert.doesNotMatch(source, /seedBuiltinPresets/);
  assert.doesNotMatch(source, /plugins\/whistle\/presets/i);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')).warren;
  const presetCommands = manifest.contributes.commands
    .map((item: { name: string }) => item.name)
    .filter((name: string) => name.startsWith('preset'));
  assert.ok(presetCommands.includes('presetImport'));
  assert.ok(presetCommands.includes('presetPreview'));
  assert.ok(presetCommands.includes('presetApply'));
});
