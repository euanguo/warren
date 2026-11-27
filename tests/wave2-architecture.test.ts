import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { WebContents, WebContentsView } from 'electron';
import { validateCliInvocation } from '../bin/commands.mjs';
import { resolveErrorDetails, sampleBuiltInRemedies } from '../src/main/browser/ops/remedy.ts';
import { createMainLogger } from '../src/main/logger.ts';
import { EnvironmentNetOps, type NetInterceptable } from '../src/main/net/ops.ts';
import { matchUrl, pickRule } from '../src/main/net/rules.ts';
import { DevToolsHost } from '../src/main/ui/devtools-host.ts';
import type { WindowLayerManager } from '../src/main/ui/layer-manager.ts';
import { LayerOrderModel, type LayerSlot } from '../src/main/ui/layer-order.ts';
import type { NetRule, ViewportRect } from '../src/shared/types.ts';

test('Wave 2：主进程滚动文件日志器自动落盘并按阈值轮转 main.1.log', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'warren-logger-'));
  try {
    const logger = createMainLogger(dir, { maxBytes: 60 });
    logger.info('boot', 'first entry with enough bytes to exceed threshold quickly 1234567890');
    logger.error('crash', 'second entry triggers rotation', new Error('boom'));
    assert.equal(existsSync(path.join(dir, 'main.log')), true);
    assert.equal(existsSync(path.join(dir, 'main.1.log')), true);
    const current = readFileSync(path.join(dir, 'main.log'), 'utf8');
    assert.ok(current.includes('[ERROR] [crash] second entry triggers rotation'));
    assert.ok(current.includes('boom'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Wave 2：DevToolsHost(managePageBounds=false) 打开与关闭停靠面板不覆写模拟视口 page bounds', async () => {
  const model = new LayerOrderModel<WebContentsView>();
  const pageBoundsLog: ViewportRect[] = [];
  const simulatedBounds: ViewportRect = { x: 420, y: 120, width: 390, height: 844 };

  const layers = {
    setSlot(
      slot: LayerSlot,
      view: WebContentsView | undefined,
      options?: { visible?: boolean; bounds?: ViewportRect },
    ) {
      model.setSlot(slot, view, options?.bounds);
      if (options?.visible !== undefined) model.setVisible(slot, options.visible);
    },
    slotView: (slot: LayerSlot) => model.get(slot).view,
    setBounds(slot: LayerSlot, bounds: ViewportRect) {
      model.setBounds(slot, bounds);
      if (slot === 'page') pageBoundsLog.push({ ...bounds });
    },
    setVisible: (slot: LayerSlot, visible: boolean) => model.setVisible(slot, visible),
    snapshot: () => model.snapshot(),
    viewVisible: () => true,
    isViewportReady: () => true,
  } as unknown as WindowLayerManager;

  layers.setBounds('page', simulatedBounds);
  pageBoundsLog.length = 0;

  const targetWc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setDevToolsWebContents: () => {},
    openDevTools: () => {},
    closeDevTools: () => {},
    isDevToolsOpened: () => false,
  }) as unknown as WebContents;

  const createDockView = () =>
    ({
      webContents: Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        close: () => {},
      }),
    }) as unknown as WebContentsView;

  const host = new DevToolsHost(
    layers,
    () => {},
    createDockView,
    () => true,
    { managePageBounds: false },
  );
  host.setViewport({ x: 0, y: 0, width: 1200, height: 900 });
  host.openForTab('tab-1', targetWc, 'right');
  host.closeForTab('tab-1');

  assert.deepEqual(pageBoundsLog, []);
  assert.deepEqual(model.get('page').bounds, simulatedBounds);
});

test('Wave 2：net/rules 正则缓存与单趟 priority 选路正确，net/ops.drop 先 detach 再移出', () => {
  const rules: NetRule[] = [
    { id: 'r1', enabled: true, priority: 10, match: { url: '*api/v1*' }, action: { type: 'block' } },
    {
      id: 'r2',
      enabled: true,
      priority: 20,
      match: { url: '^https://example\\.com/api/v1/users$', isRegex: true },
      action: { type: 'passthrough' },
    },
    { id: 'r3', enabled: true, priority: 20, match: { url: '*example.com/api/*' }, action: { type: 'block' } },
    { id: 'r4', enabled: true, priority: 99, expiresAt: 100, match: { url: '*' }, action: { type: 'block' } },
    {
      id: 'r5',
      enabled: true,
      priority: 99,
      match: { url: '[invalid-regex', isRegex: true },
      action: { type: 'block' },
    },
  ];

  // r4 已过期、r5 正则非法被忽略；r2 与 r3 同优先级 20，先加的 r2 胜出
  assert.equal(pickRule(rules, 'https://example.com/api/v1/users', 'GET', 1000)?.id, 'r2');
  assert.equal(pickRule(rules, 'https://example.com/api/v2/items', 'GET', 1000)?.id, 'r3');
  assert.equal(matchUrl('[invalid-regex', 'https://example.com', true), false);

  let detached = 0;
  const ops = new EnvironmentNetOps({
    record: () => {},
    onChange: () => {},
    createInterceptor: () =>
      ({
        detach: () => {
          detached += 1;
        },
      }) as unknown as NetInterceptable,
  });
  ops.for('alpha');
  ops.drop('alpha');
  assert.equal(detached, 1);
});

test('Wave 2：新增错误码（ENV_BUSY / ENV_NOT_VISIBLE / TAB_NOT_VISIBLE / FILL_UNCONFIRMED）的 remedy 均合法可执行', () => {
  for (const code of ['ENV_BUSY', 'ENV_NOT_VISIBLE', 'TAB_NOT_VISIBLE', 'FILL_UNCONFIRMED']) {
    const details = resolveErrorDetails({ code }, { envId: 'demo' });
    assert.ok(details?.hint, `${code} 应有 hint`);
    assert.ok(details?.remedy, `${code} 应有 remedy`);
  }
  for (const cmd of sampleBuiltInRemedies()) {
    const argv = cmd.split(/\s+/).slice(1);
    const parsed = validateCliInvocation(argv);
    assert.equal(parsed.ok, true, `remedy 非法：${cmd}`);
  }
});
