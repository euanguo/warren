import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diffScreenshots, diffSnapshots } from '../src/main/browser/ops/diff.ts';
import { targetFromBy } from '../src/main/browser/ops/inspector.ts';
import { readPage } from '../src/main/browser/ops/reader.ts';
import { formatCompactSnapshot } from '../src/main/browser/ops/snapshot-compact.ts';

test('formatCompactSnapshot 只保留交互节点大幅压缩文本并注入 site-notes', () => {
  const nodes = [
    { role: 'RootWebArea', name: 'Login', backendNodeId: 1 },
    { role: 'StaticText', name: '这是一段很长的静态介绍文本说明，不应进入 -i 列表', backendNodeId: 2 },
    { role: 'textbox', name: '用户名', value: 'alice', required: true, backendNodeId: 3, ref: '@1' },
    { role: 'button', name: '登录', backendNodeId: 4, ref: '@2' },
    { role: 'checkbox', name: '记住登录态', checked: true, backendNodeId: 5, ref: '@3' },
  ];

  const compact = formatCompactSnapshot({
    url: 'https://example.test/login',
    title: 'Sign In',
    nodes,
    interactiveOnly: true,
    siteNotes: [
      {
        site: 'example.test/login',
        content: '提交后需等 200ms 重定向',
        updatedBy: 'human',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
  });

  assert.match(compact, /^# site-notes/m);
  assert.match(compact, /\[example\.test\/login\] 提交后需等 200ms 重定向/);
  assert.match(compact, /- textbox "用户名" \[value="alice", required, ref=@1\]/);
  assert.match(compact, /- button "登录" \[ref=@2\]/);
  assert.match(compact, /- checkbox "记住登录态" \[checked, ref=@3\]/);
  assert.doesNotMatch(compact, /很长的静态介绍文本/);
  assert.ok(compact.length < JSON.stringify(nodes).length);
});

test('readPage 提取正文/链接过滤/JSON 并附带 siteNotes', async () => {
  const client = {
    currentUrl: () => 'https://example.test/docs',
    title: async () => 'Docs',
    async evaluate(_fn: string, arg?: unknown) {
      const opts = arg as { includeLinks?: boolean; includeData?: boolean };
      return {
        text: '# Heading\nBody line',
        links: opts.includeLinks
          ? [
              { text: 'API Guide', href: 'https://example.test/api/v2' },
              { text: 'Privacy', href: 'https://example.test/privacy' },
            ]
          : undefined,
        data: opts.includeData ? [{ source: '__NEXT_DATA__', payload: { buildId: 'b1' } }] : undefined,
      };
    },
  };

  const result = await readPage(client, {
    links: 'api',
    data: true,
    siteNotes: [{ site: 'example.test', content: 'docs root', updatedBy: 'human', updatedAt: 'x' }],
  });
  assert.equal(result.title, 'Docs');
  assert.equal(result.text, '# Heading\nBody line');
  assert.equal(result.links?.length, 1);
  assert.equal(result.links?.[0]?.href, 'https://example.test/api/v2');
  assert.equal(result.data?.[0]?.source, '__NEXT_DATA__');
  assert.equal(result.siteNotes?.[0]?.site, 'example.test');
});

test('diffSnapshots 与 diffScreenshots 准确识别增删改及哈希', async () => {
  const prev = {
    url: 'https://a.test/1',
    title: 'Step 1',
    nodes: [
      { role: 'textbox', name: 'Name', value: '' },
      { role: 'button', name: 'Next', ref: '@1' },
    ],
  };
  const next = {
    url: 'https://a.test/2',
    title: 'Step 2',
    nodes: [
      { role: 'textbox', name: 'Name', value: 'Alice' },
      { role: 'link', name: 'Dashboard', ref: '@2' },
    ],
  };

  const snapDiff = diffSnapshots(prev, next);
  assert.equal(snapDiff.urlChanged, true);
  assert.equal(snapDiff.titleChanged, true);
  assert.equal(snapDiff.addedCount, 1);
  assert.equal(snapDiff.removedCount, 1);
  assert.equal(snapDiff.changedCount, 1);

  const dir = await mkdtemp(path.join(tmpdir(), 'warren-diff-'));
  try {
    // 最小 24 字节合法 PNG 头 + 不同内容
    const png1 = Buffer.from('89504e470d0a1a0a0000000d494844520000001000000020', 'hex');
    const png2 = Buffer.from('89504e470d0a1a0a0000000d494844520000001400000020', 'hex');
    const fileA = path.join(dir, 'a.png');
    const fileB = path.join(dir, 'b.png');
    await writeFile(fileA, png1);
    await writeFile(fileB, png2);
    const same = await diffScreenshots(fileA, fileA);
    assert.equal(same.match, true);
    assert.equal(same.a.width, 16);
    const diff = await diffScreenshots(fileA, fileB);
    assert.equal(diff.match, false);
    assert.equal(diff.b.width, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('targetFromBy 支持多种语义定位器', () => {
  assert.deepEqual(targetFromBy('role', 'button', 'Submit'), { kind: 'role', role: 'button', name: 'Submit' });
  assert.deepEqual(targetFromBy('label', '密码'), { kind: 'label', text: '密码' });
  assert.deepEqual(targetFromBy('testid', 'submit-btn'), { kind: 'selector', selector: '[data-testid="submit-btn"]' });
});
