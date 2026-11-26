import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchicalAxNodes } from '../src/main/browser/ax-tree.ts';
import { formatCompactSnapshot } from '../src/main/browser/ops/snapshot-compact.ts';
import { RefTable } from '../src/main/browser/refs.ts';
import type { AxNode } from '../src/shared/types.ts';

test('buildHierarchicalAxNodes 还原真实树深、合并相邻文本、剪除同名子文本并折叠 select 选项', () => {
  const rawNodes = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'App' }, childIds: ['2', '5', '9'] },
    { nodeId: '2', role: { value: 'dialog' }, name: { value: 'Confirm' }, childIds: ['3', '4'] },
    { nodeId: '3', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 10, childIds: ['3a'] },
    { nodeId: '3a', role: { value: 'StaticText' }, name: { value: 'Submit' }, backendDOMNodeId: 11 },
    { nodeId: '4', role: { value: 'StaticText' }, name: { value: 'Hello' }, backendDOMNodeId: 12 },
    { nodeId: '5', role: { value: 'StaticText' }, name: { value: 'Part A' }, backendDOMNodeId: 13 },
    { nodeId: '9', role: { value: 'combobox' }, name: { value: 'Plan' }, backendDOMNodeId: 20, childIds: ['9p'] },
    { nodeId: '9p', role: { value: 'MenuListPopup' }, name: { value: '' }, childIds: ['9o1', '9o2'] },
    { nodeId: '9o1', role: { value: 'MenuListOption' }, name: { value: 'Free' } },
    { nodeId: '9o2', role: { value: 'MenuListOption' }, name: { value: 'Pro' } },
  ];

  const nodes = buildHierarchicalAxNodes(rawNodes, { frameId: 'f1', loaderId: 'L1' }, false, 100);
  const dialog = nodes.find((n) => n.role === 'dialog');
  const btn = nodes.find((n) => n.role === 'button');
  const combo = nodes.find((n) => n.role === 'combobox');

  assert.equal(dialog?.depth, 0);
  assert.equal(btn?.depth, 1);
  // 与父 button 同名的子 StaticText 必须被剪除
  assert.equal(nodes.filter((n) => n.name === 'Submit').length, 1);
  // MenuListPopup 选项被折叠到 combobox.optionsSummary
  assert.deepEqual(combo?.optionsSummary, ['Free', 'Pro']);
  assert.equal(
    nodes.some((n) => n.role === 'MenuListPopup'),
    false,
  );
});

test('formatCompactSnapshot 支持真实缩进、按 depth 裁剪、3 态 unchecked、nth 消歧、-u、密码脱敏与 --filter', () => {
  const nodes: AxNode[] = [
    { role: 'navigation', name: 'Main Nav', depth: 0 },
    { role: 'link', name: 'Docs', url: 'https://example.test/docs', depth: 1, ref: '@1' },
    { role: 'heading', name: 'Settings', level: 2, depth: 0 },
    { role: 'textbox', name: 'Password', value: 'should-never-leak', sensitive: true, depth: 1, ref: '@2' },
    { role: 'checkbox', name: 'Beta', checked: false, depth: 1, ref: '@3' },
    { role: 'button', name: 'Delete', depth: 1, ref: '@4' },
    { role: 'button', name: 'Delete', depth: 1, ref: '@5' },
    { role: 'button', name: 'Deep Action', depth: 3, ref: '@6' },
  ];

  const full = formatCompactSnapshot({
    url: 'https://example.test',
    title: 'Test',
    nodes,
    urls: true,
    maxDepth: 2,
  });

  // 真实 2 空格缩进
  assert.match(full, /^  - link "Docs" \[ref=@1\] -> https:\/\/example\.test\/docs/m);
  // -d 2 裁剪 depth=3 的节点，不误伤 level=2 但 depth=0 的 heading
  assert.match(full, /heading "Settings"/);
  assert.doesNotMatch(full, /Deep Action/);
  // 密码定宽脱敏，绝不泄漏明文
  assert.match(full, /value="••••••••"/);
  assert.doesNotMatch(full, /should-never-leak/);
  // 3 态 unchecked 显式输出
  assert.match(full, /- checkbox "Beta" \[unchecked, ref=@3\]/);
  // 同名按钮自动 nth=0 / nth=1 消歧
  assert.match(full, /- button "Delete" \[nth=0, ref=@4\]/);
  assert.match(full, /- button "Delete" \[nth=1, ref=@5\]/);

  // --filter 保留命中节点及其语义祖先 navigation
  const filtered = formatCompactSnapshot({ url: 'https://example.test', title: 'Test', nodes, filter: 'docs' });
  assert.match(filtered, /navigation "Main Nav"/);
  assert.match(filtered, /link "Docs"/);
  assert.doesNotMatch(filtered, /Delete/);
});

test('formatCompactSnapshot 分层 Token 预算按 80/20 首尾保留，不截断底部操作栏', () => {
  const nodes: AxNode[] = Array.from({ length: 120 }, (_, i) => ({
    role: 'button',
    name: `Row Action Item Number ${i + 1}`,
    depth: 0,
    ref: `@${i + 1}`,
  }));
  const text = formatCompactSnapshot({
    url: 'https://example.test/list',
    title: 'Long List',
    nodes,
    interactiveOnly: true,
    maxTokens: 450,
  });
  assert.match(text, /Row Action Item Number 1"/, '应保留头部按钮');
  assert.match(text, /Row Action Item Number 120"/, '80/20 截断必须护住末尾按钮/弹窗');
  assert.match(text, /token-budget truncated/);
});

test('RefTable.registerStable 跨快照稳定复用 @N、按 frame loaderId 精准失效、并支持唯一重绘自愈', () => {
  const refs = new RefTable();
  const first = refs.registerStable(
    [
      { backendId: 100, frameId: 'main', loaderId: 'L1', role: 'button', name: 'Save' },
      { backendId: 200, frameId: 'sub', loaderId: 'S1', role: 'button', name: 'Pay' },
    ],
    { main: 'L1', sub: 'S1' },
  );
  assert.equal(first[0]?.ref, '@1');
  assert.equal(first[1]?.ref, '@2');

  // 二次快照：主文档未导航且出现新按钮 101，老按钮 100 必须保持 @1，新按钮为 @3 且 isNew=true
  const second = refs.registerStable(
    [
      { backendId: 100, frameId: 'main', loaderId: 'L1', role: 'button', name: 'Save' },
      { backendId: 101, frameId: 'main', loaderId: 'L1', role: 'button', name: 'Cancel' },
      { backendId: 200, frameId: 'sub', loaderId: 'S1', role: 'button', name: 'Pay' },
    ],
    { main: 'L1', sub: 'S1' },
  );
  assert.deepEqual(second[0], { ref: '@1', isNew: false });
  assert.deepEqual(second[1], { ref: '@3', isNew: true });
  assert.deepEqual(second[2], { ref: '@2', isNew: false });

  // 仅子 iframe 独立重载（S1 -> S2）：主文档 @1/@3 仍有效，子 frame @2 精确报 TARGET_STALE
  refs.updateFrameLoaders({ main: 'L1', sub: 'S2' });
  assert.equal(refs.resolve('@1').backendId, 100);
  assert.throws(
    () => refs.resolve('@2'),
    (e: unknown) => (e as { code?: string }).code === 'TARGET_STALE',
  );

  // React 重绘自愈：原 100 节点被替换为新 backendId 999，唯一匹配 (main, button, Save) 自动自愈
  const healed = refs.tryHeal('@1', [{ role: 'button', name: 'Save', backendNodeId: 999, frameId: 'main' }]);
  assert.deepEqual(healed, { backendId: 999, healed: true });
  assert.equal(refs.resolve('@1').backendId, 999);

  // 存在 2 个同名候选时拒绝自愈，绝不盲点错元素
  const ambiguous = refs.tryHeal('@1', [
    { role: 'button', name: 'Save', backendNodeId: 801, frameId: 'main' },
    { role: 'button', name: 'Save', backendNodeId: 802, frameId: 'main' },
  ]);
  assert.equal(ambiguous, null);
});
