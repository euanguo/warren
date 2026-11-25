import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addExtension,
  assertUnpackedExtension,
  extensionsRoot,
  listExtensions,
  removeExtension,
  safeExtensionName,
} from '../src/main/extensions.ts';

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ manifest_version: 3, name: 'x', version: '1.0.0', ...over });

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'warren-ext-'));
}
/** 断言抛出的错误码 —— 码在 `error.code` 上，别去 match 消息文本（那是给人看的，会改）。 */
async function rejectsWithCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(fn, (err: { code?: string }) => {
    assert.equal(err.code, code);
    return true;
  });
}

async function makeExtension(dir: string, content = manifest()): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), content);
  await writeFile(path.join(dir, 'content.js'), '// noop\n');
  return dir;
}

test('目录名不许路径穿越或隐藏目录', () => {
  assert.equal(safeExtensionName('hello'), 'hello');
  assert.equal(safeExtensionName(' hello '), 'hello');
  for (const bad of ['', '.', '..', '../evil', 'a/b', 'a\\b', '.hidden']) {
    assert.throws(
      () => safeExtensionName(bad),
      (err: { code?: string }) => err.code === 'BAD_EXTENSION_NAME',
      `应拒绝 ${JSON.stringify(bad)}`,
    );
  }
});

test('只接受解包目录：.crx/文件/缺 manifest/坏 JSON 都挡掉', async () => {
  const root = await tmp();
  try {
    const crx = path.join(root, 'x.crx');
    await writeFile(crx, 'not a directory');
    await rejectsWithCode(() => assertUnpackedExtension(crx), 'EXTENSION_NOT_UNPACKED');

    await rejectsWithCode(() => assertUnpackedExtension(path.join(root, 'nope')), 'EXTENSION_NOT_FOUND');

    const noManifest = path.join(root, 'no-manifest');
    await mkdir(noManifest);
    await rejectsWithCode(() => assertUnpackedExtension(noManifest), 'EXTENSION_NO_MANIFEST');

    const badJson = await makeExtension(path.join(root, 'bad-json'), '{oops');
    await rejectsWithCode(() => assertUnpackedExtension(badJson), 'EXTENSION_BAD_MANIFEST');

    const missingKey = await makeExtension(path.join(root, 'missing'), JSON.stringify({ name: 'x' }));
    await rejectsWithCode(() => assertUnpackedExtension(missingKey), 'EXTENSION_BAD_MANIFEST');

    const ok = await makeExtension(path.join(root, 'ok'));
    assert.deepEqual(await assertUnpackedExtension(ok), { name: 'x', version: '1.0.0' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('add 是拷进环境目录，list 只列目录，remove 删目录', async () => {
  const root = await tmp();
  try {
    const storage = path.join(root, 'session');
    const src = await makeExtension(path.join(root, 'src'));

    // 目录不存在时 list 返回空数组，不报错
    assert.deepEqual(await listExtensions(storage), []);

    const added = await addExtension(storage, src, 'hello');
    assert.equal(added.id, 'hello');
    assert.equal(added.dir, path.join(extensionsRoot(storage), 'hello'));
    assert.equal(await readFile(path.join(added.dir, 'manifest.json'), 'utf8'), manifest());

    // 改名再装一份，两份都在
    await addExtension(storage, src, 'hello2');
    assert.deepEqual(
      (await listExtensions(storage)).map((e) => e.id),
      ['hello', 'hello2'],
    );

    // 同名覆盖：改过内容的源再装一次，目标跟着变
    await writeFile(path.join(src, 'content.js'), '// changed\n');
    await addExtension(storage, src, 'hello');
    assert.equal(await readFile(path.join(extensionsRoot(storage), 'hello', 'content.js'), 'utf8'), '// changed\n');

    // 环境目录里塞一个文件，list 不把它当扩展
    await writeFile(path.join(extensionsRoot(storage), 'stray.txt'), 'x');
    assert.deepEqual(
      (await listExtensions(storage)).map((e) => e.id),
      ['hello', 'hello2'],
    );

    assert.equal(await removeExtension(storage, 'hello'), true);
    assert.equal(await removeExtension(storage, 'hello'), false);
    assert.deepEqual(
      (await listExtensions(storage)).map((e) => e.id),
      ['hello2'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
