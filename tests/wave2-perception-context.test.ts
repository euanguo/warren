import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHierarchicalAxNodes } from '../src/main/browser/ax-tree.ts';
import { SessionContextTracker } from '../src/main/browser/ops/context-tracker.ts';
import { ActionLoopDetector } from '../src/main/browser/ops/loop-detector.ts';
import { formatCompactSnapshot } from '../src/main/browser/ops/snapshot-compact.ts';
import { RefTable } from '../src/main/browser/refs.ts';
import type { AxNode } from '../src/shared/types.ts';

test('formatCompactSnapshot 支持视口进度头、屏外省略提示、Saved Flows 与长列表/禁用折叠', () => {
  const nodes: AxNode[] = [
    ...Array.from({ length: 12 }, (_, idx) => ({
      role: 'option',
      name: `城市 ${idx + 1}`,
      ref: `@${idx + 1}`,
      depth: 1,
      selected: idx === 6,
    })),
    ...Array.from({ length: 5 }, (_, idx) => ({
      role: 'button',
      name: `禁用按钮 ${idx + 1}`,
      ref: `@${20 + idx}`,
      depth: 0,
      disabled: true,
    })),
  ];

  const compact = formatCompactSnapshot({
    url: 'https://shop.test/orders',
    title: 'Orders',
    nodes,
    scope: 'viewport',
    viewport: {
      width: 1280,
      height: 800,
      scrollX: 0,
      scrollY: 1600,
      scrollWidth: 1280,
      scrollHeight: 4000,
      abovePx: 1600,
      belowPx: 1600,
      scrollPercentY: 50,
      omittedAbove: 18,
      omittedBelow: 24,
    },
    savedFlows: [{ name: 'list-orders', site: 'shop.test', params: ['status'], description: '读取订单列表' }],
    notesAlreadyLoadedLines: 5,
    interactiveOnly: true,
  });

  assert.match(compact, /# site-notes \(已加载 5 行，未变更\)/);
  assert.match(compact, /# saved-flows/);
  assert.match(compact, /list-orders \[params: status\]: 读取订单列表/);
  assert.match(compact, /viewport: 1280x800 scroll=1600\/4000 \(50%\) \[scope=viewport\]/);
  assert.match(compact, /城市 7.*selected/);
  assert.match(compact, /more option folded @1\.\.@12/);
  assert.match(compact, /4 more disabled button folded/);
  assert.match(compact, /# viewport-omitted: 18 above, 24 below/);

  // 开启 --no-fold 后应完整展开所有项
  const expanded = formatCompactSnapshot({
    url: 'https://shop.test/orders',
    title: 'Orders',
    nodes,
    noFold: true,
    interactiveOnly: true,
  });
  assert.doesNotMatch(expanded, /folded/);
  assert.match(expanded, /城市 10/);
  assert.match(expanded, /禁用按钮 5/);
});

test('SessionContextTracker 同站点每会话仅首访完整注入，内容变化或切站自动重新注入', () => {
  const tracker = new SessionContextTracker();
  const noteV1 = [{ site: 'app.test', content: 'line1\nline2', updatedBy: 'human', updatedAt: 't1' }];
  const flows = [{ name: 'orders', site: 'app.test', params: ['q'] }];

  const first = tracker.consumeHints('env1:agent:active', 'https://app.test/a', {
    siteNotes: noteV1,
    savedFlows: flows,
  });
  assert.equal(first.siteNotes.length, 1);
  assert.equal(first.savedFlows.length, 1);
  assert.equal(first.notesAlreadyLoadedLines, undefined);

  // 同站点二次访问不再重复刷完整笔记和 flow，仅返回已加载行数锚点
  const second = tracker.consumeHints('env1:agent:active', 'https://app.test/b', {
    siteNotes: noteV1,
    savedFlows: flows,
  });
  assert.equal(second.siteNotes.length, 0);
  assert.equal(second.savedFlows.length, 0);
  assert.equal(second.notesAlreadyLoadedLines, 2);

  // 笔记更新后自动重新注入
  const noteV2 = [{ site: 'app.test', content: 'line1\nline2\nline3', updatedBy: 'human', updatedAt: 't2' }];
  const updated = tracker.consumeHints('env1:agent:active', 'https://app.test/b', {
    siteNotes: noteV2,
    savedFlows: flows,
  });
  assert.equal(updated.siteNotes.length, 1);
  assert.equal(updated.savedFlows.length, 0);

  // 切站后再回来重新注入
  tracker.consumeHints('env1:agent:active', 'https://other.test/', {});
  const back = tracker.consumeHints('env1:agent:active', 'https://app.test/a', {
    siteNotes: noteV2,
    savedFlows: flows,
  });
  assert.equal(back.siteNotes.length, 1);
  assert.equal(back.savedFlows.length, 1);
});

test('ActionLoopDetector 检测连续 3 次无进展盲试与 6 步往复重定向', () => {
  const detector = new ActionLoopDetector();
  assert.equal(
    detector.record('s1', {
      action: 'click',
      targetKey: '@5',
      urlBefore: 'https://a.test',
      urlAfter: 'https://a.test',
      changed: false,
    }),
    undefined,
  );
  assert.equal(
    detector.record('s1', {
      action: 'click',
      targetKey: '@5',
      urlBefore: 'https://a.test',
      urlAfter: 'https://a.test',
      changed: false,
    }),
    undefined,
  );
  const stuck = detector.record('s1', {
    action: 'click',
    targetKey: '@5',
    urlBefore: 'https://a.test',
    urlAfter: 'https://a.test',
    changed: false,
  });
  assert.ok(stuck);
  assert.match(stuck, /连续 3 次对 @5 执行 click/);

  // 往复重定向探测
  const detector2 = new ActionLoopDetector();
  const pairs: Array<[string, string]> = [
    ['https://a.test/login', 'https://a.test/home'],
    ['https://a.test/home', 'https://a.test/login'],
    ['https://a.test/login', 'https://a.test/home'],
    ['https://a.test/home', 'https://a.test/login'],
    ['https://a.test/login', 'https://a.test/home'],
    ['https://a.test/home', 'https://a.test/login'],
  ];
  let redirectWarn: string | undefined;
  for (const [u1, u2] of pairs) {
    redirectWarn = detector2.record('s2', {
      action: 'navigate',
      targetKey: u2,
      urlBefore: u1,
      urlAfter: u2,
      changed: true,
    });
  }
  assert.ok(redirectWarn);
  assert.match(redirectWarn, /往复重定向/);
});

test('buildHierarchicalAxNodes 注入 containerScope 且 RefTable.tryHeal 优先在同容器唯一自愈', () => {
  const rawNodes = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'App' }, childIds: ['2', '4'] },
    { nodeId: '2', role: { value: 'dialog' }, name: { value: '编辑订单' }, backendDOMNodeId: 10, childIds: ['3'] },
    { nodeId: '3', role: { value: 'button' }, name: { value: '确认' }, backendDOMNodeId: 11, childIds: [] },
    { nodeId: '4', role: { value: 'dialog' }, name: { value: '删除订单' }, backendDOMNodeId: 20, childIds: ['5'] },
    { nodeId: '5', role: { value: 'button' }, name: { value: '确认' }, backendDOMNodeId: 21, childIds: [] },
  ];
  const ax = buildHierarchicalAxNodes(rawNodes, { frameId: 'f1', loaderId: 'l1' }, false, 100);
  const confirmButtons = ax.filter((n) => n.role === 'button' && n.name === '确认');
  assert.equal(confirmButtons.length, 2);
  assert.equal(confirmButtons[0]!.containerScope, 'dialog:编辑订单');
  assert.equal(confirmButtons[1]!.containerScope, 'dialog:删除订单');

  // 即使页面上有两个同名「确认」按钮，重渲染后旧 backendId 11 变为 111 时，仍可按同容器唯一自愈
  const table = new RefTable();
  const [first, second] = table.registerStable([
    { backendId: 11, role: 'button', name: '确认', containerScope: 'dialog:编辑订单' },
    { backendId: 21, role: 'button', name: '确认', containerScope: 'dialog:删除订单' },
  ]);
  assert.equal(first?.ref, '@1');
  assert.equal(second?.ref, '@2');

  const healed = table.tryHeal(first!.ref, [
    { role: 'button', name: '确认', backendNodeId: 111, containerScope: 'dialog:编辑订单' },
    { role: 'button', name: '确认', backendNodeId: 221, containerScope: 'dialog:删除订单' },
  ]);
  assert.equal(healed?.backendId, 111);
  assert.equal(table.resolve('@1')?.backendId, 111);
});
