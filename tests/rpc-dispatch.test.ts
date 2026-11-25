import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchRpc, type DispatchDeps } from '../src/main/rpc-dispatch.ts';

/**
 * RPC 写门控的**运行时**验证。
 *
 * 这一层以前测不到：`rpc.ts` 顶部 `import { app } from 'electron'`，`node --test` 加载不了。
 * 派发表拆进 `rpc-dispatch.ts` 之后（只依赖类型 + 两个无 electron 的纯模块），
 * 这里能喂一个假的 manager 进去，把「没持 lease 就不能改页面」这条边界真跑一遍。
 *
 * `tests/rpc-gating.test.ts` 是同一件事的静态版本（盯着每个 case 有没有挂门控），
 * 两个一起看：静态守卫保证「接线没漏」，这里保证「接线真的拦得住」。
 */

const ENV = 'alpha';
const LEASE_ID = 'lease-1';

interface FakeLease {
  leaseId: string;
  expiresAt: number;
}

function makeManager(options: { lease?: FakeLease; pageUrl?: string; dormant?: boolean } = {}) {
  const calls: string[] = [];
  const clickArgs: unknown[] = [];
  const navArgs: unknown[] = [];
  const fetchArgs: Array<{ url: string; options: Record<string, unknown> }> = [];
  /** update / create 收到的原文：审批那条反向验收要看 RPC 到底递了什么过去 */
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const pageUrl = options.pageUrl ?? 'https://example.com/';
  const page = {
    currentUrl: () => pageUrl,
    title: async () => 'Example',
    assertNoDialog: () => void calls.push('assertNoDialog'),
    click: async (target: unknown, opts: unknown) => {
      calls.push('click');
      clickArgs.push(opts);
      return { x: 1, y: 2, url: pageUrl, target };
    },
    fill: async () => {
      calls.push('fill');
      return { x: 1, y: 2, url: pageUrl };
    },
    navigate: async (url: string, opts: unknown) => {
      calls.push('navigate');
      navArgs.push(opts);
      return { url };
    },
    fetch: async (url: string, options: Record<string, unknown>) => {
      calls.push('fetch');
      fetchArgs.push({ url, options });
      return { ok: true, status: 200, url };
    },
    snapshotWithRefs: async () => {
      calls.push('snapshotWithRefs');
      return [{ role: 'button', name: 'ok' }];
    },
    snapshot: async () => [{ role: 'button', name: 'ok' }],
    screenshot: async () => {
      calls.push('screenshot');
      return { bytes: 3, sha256: 'abc', format: 'png', source: 'cdp' };
    },
  };
  return {
    calls,
    clickArgs,
    navArgs,
    fetchArgs,
    patches,
    // 复刻 `EnvironmentManager.assertWritable` 的规则：没租约 / 过期 / leaseId 不对，三种都拒
    assertWritable(id: string, leaseId?: string) {
      calls.push('assertWritable');
      const lease = options.lease;
      if (!lease || lease.expiresAt <= Date.now()) {
        throw Object.assign(new Error(`environment ${id} is not leased`), { code: 'ENV_NOT_LEASED' });
      }
      if (!leaseId || leaseId !== lease.leaseId) {
        throw Object.assign(new Error('CONTROL_REVOKED'), { code: 'CONTROL_REVOKED' });
      }
      return lease;
    },
    ensureOperable: () => {
      calls.push('ensureOperable');
      return true;
    },
    detachOperable: () => void calls.push('detachOperable'),
    assertInputOnScreen: () => void calls.push('assertInputOnScreen'),
    assertActiveTab: () => void calls.push('assertActiveTab'),
    // 输入前用 CDP 把 document 焦点交给页面，不激活窗口
    focusForInput: async () => void calls.push('focusForInput'),
    prepareBackgroundInput: async () => false,
    clearBackgroundInput: async () => {},
    assertVisible: () => void calls.push('assertVisible'),
    closeTab: (id: string, space: string, ref: unknown) => {
      calls.push(`closeTab:${id}:${space}:${String(ref)}`);
    },
    controllerFor: () => page,
    hibernate: (id: string) => {
      calls.push(`hibernate:${id}`);
      return true;
    },
    wake: (id: string) => {
      calls.push(`wake:${id}`);
      return true;
    },
    isDormant: () => Boolean(options.dormant),
    list: () => [],
    get: () => undefined,
    hibernateResult: () => ({ ok: true }),
    showWindow: () => void calls.push('showWindow'),
    hideWindow: () => void calls.push('hideWindow'),
    backgroundWindow: () => void calls.push('backgroundWindow'),
    focusWindow: () => void calls.push('focusWindow'),
    layout: () => ({ running: 0 }),
    netAddRule: (id: string, rule: unknown) => {
      calls.push('netAddRule');
      return { id: 'rule-1', env: id, ...(rule as object) };
    },
    // 记录 patch 的原文：审批策略那条反向验收要看 RPC 到底递了什么过去
    update: (id: string, patch: Record<string, unknown>) => {
      calls.push('update');
      patches.push({ id, patch });
      return { id, patch };
    },
    create: (input: Record<string, unknown>) => {
      calls.push('create');
      return { id: input.id, ...input };
    },
  };
}

function makeDeps(
  manager: ReturnType<typeof makeManager>,
  overrides: Partial<DispatchDeps> = {},
): DispatchDeps & { events: Array<{ type: string; message: string }>; revealed: string[] } {
  const events: Array<{ type: string; message: string }> = [];
  const revealed: string[] = [];
  const deps = {
    manager: manager as never,
    store: {
      record: (event: { type: string; message: string }) => void events.push(event),
      get: () => undefined,
    } as never,
    vault: {
      available: true,
      list: () => [],
      reveal: (ref: string) => {
        revealed.push(ref);
        return { password: 'hunter2' };
      },
    } as never,
    saveVault: async () => {},
    plugins: {} as never,
    isPackaged: false,
    quit: () => {},
    ...overrides,
    events,
    revealed,
  };
  return deps;
}

/** 断言抛出的是指定错误码（不是靠消息文本匹配）。 */
async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(work, (error: Error & { code?: string }) => {
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code ?? '(无 code)'}: ${error.message}`);
    return true;
  });
}

const WRITE_CALLS: Array<[string, Record<string, unknown>]> = [
  ['browser.click', { id: ENV, target: { kind: 'css', selector: '#go' } }],
  ['browser.navigate', { id: ENV, url: 'https://example.com/' }],
  ['browser.fill', { id: ENV, target: { kind: 'css', selector: '#name' }, value: 'x' }],
  ['net.rule.add', { id: ENV, rule: { match: { url: '**/api/**' }, action: { type: 'block' } } }],
  ['vault.fill', { id: ENV, ref: 'example/fixture', target: { kind: 'css', selector: '#password' } }],
];

test('没持 lease 的写操作一律被拒，且不碰 controller / vault', async () => {
  for (const [method, params] of WRITE_CALLS) {
    const manager = makeManager();
    const deps = makeDeps(manager);
    await expectCode(dispatchRpc(deps, method, params), 'ENV_NOT_LEASED');
    assert.deepEqual(manager.calls, ['assertWritable'], `${method} 不该在门控之外再碰别的东西`);
    assert.deepEqual(deps.revealed, [], `${method} 在没租约时连凭据都不该去读`);
  }
});

test('leaseId 不对报 CONTROL_REVOKED（租约被别人顶掉），也不执行动作', async () => {
  const manager = makeManager({ lease: { leaseId: LEASE_ID, expiresAt: Date.now() + 60_000 } });
  const deps = makeDeps(manager);
  await expectCode(
    dispatchRpc(deps, 'browser.click', { id: ENV, leaseId: 'stale-lease', target: { kind: 'css', selector: '#go' } }),
    'CONTROL_REVOKED',
  );
  assert.deepEqual(manager.calls, ['assertWritable']);
});

test('租约过期同样被拒（门控按时间判，不只看有没有这条记录）', async () => {
  const manager = makeManager({ lease: { leaseId: LEASE_ID, expiresAt: Date.now() - 1 } });
  await expectCode(
    dispatchRpc(makeDeps(manager), 'browser.click', {
      id: ENV,
      leaseId: LEASE_ID,
      target: { kind: 'css', selector: '#go' },
    }),
    'ENV_NOT_LEASED',
  );
});

test('持正确 lease 的 click 真的落到 controller 上，并返回收据', async () => {
  const manager = makeManager({ lease: { leaseId: LEASE_ID, expiresAt: Date.now() + 60_000 } });
  const result = await dispatchRpc(makeDeps(manager), 'browser.click', {
    id: ENV,
    leaseId: LEASE_ID,
    target: { kind: 'css', selector: '#go' },
  });

  assert.equal((result as { x: number }).x, 1);
  assert.ok(manager.calls.includes('click'), '门控过了就该真的点');
  // 输入类命令要过这几道：在屏 / 是激活标签 / 没有卡住的 dialog / 把 document 焦点交给页面
  for (const guard of ['assertInputOnScreen', 'assertActiveTab', 'assertNoDialog', 'focusForInput']) {
    assert.ok(manager.calls.includes(guard), `少了 ${guard}`);
  }
});

test('env.egress 返回 environment 的真实代理与可信 CA', async () => {
  const manager = makeManager();
  const deps = makeDeps(manager, {
    store: {
      record: () => {},
      get: (id: string) =>
        id === ENV
          ? {
              id: ENV,
              proxy: 'http://127.0.0.1:8933',
              trustedCa: '/tmp/warren-trusted-ca.pem',
            }
          : undefined,
    } as never,
  });

  const result = (await dispatchRpc(deps, 'env.egress', { id: ENV })) as Record<string, unknown>;

  assert.equal(result.environmentId, ENV);
  assert.equal(result.proxy, 'http://127.0.0.1:8933');
  assert.equal(result.trustedCa, '/tmp/warren-trusted-ca.pem');
});

test('browser.fetch 透传标准 cache 模式', async () => {
  const manager = makeManager({ lease: { leaseId: LEASE_ID, expiresAt: Date.now() + 60_000 } });
  const deps = makeDeps(manager);

  await dispatchRpc(deps, 'browser.fetch', {
    id: ENV,
    leaseId: LEASE_ID,
    url: 'https://cdn.example/app.js',
    cache: 'reload',
  });

  assert.equal(manager.fetchArgs.length, 1);
  assert.equal(manager.fetchArgs[0].url, 'https://cdn.example/app.js');
  assert.equal(manager.fetchArgs[0].options.cache, 'reload');
});

test('Person Space 标签不需要 Agent lease', async () => {
  const manager = makeManager();
  const result = await dispatchRpc(makeDeps(manager), 'tab.close', {
    id: ENV,
    space: 'person',
    ref: 2,
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(manager.calls.includes(`closeTab:${ENV}:person:2`));
  assert.ok(!manager.calls.includes('assertWritable'), 'Person Space 不应该取 Agent lease');
});

test('RPC 参数守卫：非法 button / position / waitUntil 不原样传给 controller', async () => {
  const manager = makeManager({ lease: { leaseId: LEASE_ID, expiresAt: Date.now() + 60_000 } });
  const deps = makeDeps(manager);

  await dispatchRpc(deps, 'browser.click', {
    id: ENV,
    leaseId: LEASE_ID,
    target: { kind: 'css', selector: '#go' },
    button: 'weird',
    position: { x: 'no', y: 1 },
  });
  const click = manager.clickArgs.at(-1) as { button?: unknown; position?: unknown };
  assert.equal(click.button, undefined, '非法 button 不能被当成 never 传下去');
  assert.equal(click.position, undefined, '非法 position 不能被当成 never 传下去');

  await dispatchRpc(deps, 'browser.navigate', {
    id: ENV,
    leaseId: LEASE_ID,
    url: 'https://example.com/',
    waitUntil: 'weird',
  });
  const nav = manager.navArgs.at(-1) as { waitUntil?: unknown };
  assert.equal(nav.waitUntil, undefined, '非法 waitUntil 不能被当成 never 传下去');
});

test('读操作不需要 lease：browser.snapshot 一次都不碰 assertWritable', async () => {
  const manager = makeManager();
  const result = await dispatchRpc(makeDeps(manager), 'browser.snapshot', { id: ENV });

  assert.deepEqual((result as { nodes: unknown[] }).nodes, [{ role: 'button', name: 'ok' }]);
  assert.equal(manager.calls.includes('assertWritable'), false);
  assert.ok(manager.calls.includes('snapshotWithRefs'));
});

test('后台截图用临时可操作视图，不取 lease，结束必摘掉', async () => {
  const manager = makeManager();
  const deps = makeDeps(manager);
  const result = await dispatchRpc(deps, 'browser.screenshot', {
    id: ENV,
    space: 'agent',
  });

  assert.equal((result as { bytes: number }).bytes, 3);
  assert.ok(manager.calls.includes('ensureOperable'));
  assert.ok(manager.calls.includes('screenshot'));
  assert.ok(manager.calls.includes('detachOperable'));
  assert.equal(manager.calls.includes('assertWritable'), false);
});

test('vault.fill 在域名名单外拒绝：记事件、不填、返回值里没有明文', async () => {
  const manager = makeManager({ lease: { leaseId: LEASE_ID, expiresAt: Date.now() + 60_000 } });
  const deps = makeDeps(manager);
  await expectCode(
    dispatchRpc(deps, 'vault.fill', {
      id: ENV,
      leaseId: LEASE_ID,
      ref: 'example/fixture',
      target: { kind: 'css', selector: '#password' },
      allowedDomains: ['other.example'],
    }),
    'PATH_DENIED',
  );
  assert.deepEqual(
    deps.events.map((event) => event.type),
    ['vault.fillDenied'],
  );
  assert.equal(manager.calls.includes('fill'), false, '被拒时绝不能真的填进去');
});

test('vault.fill 命中名单时填充，返回值只报字段、不带值', async () => {
  const manager = makeManager({ lease: { leaseId: LEASE_ID, expiresAt: Date.now() + 60_000 } });
  const deps = makeDeps(manager);
  const result = await dispatchRpc(deps, 'vault.fill', {
    id: ENV,
    leaseId: LEASE_ID,
    ref: 'example/fixture',
    target: { kind: 'css', selector: '#password' },
    allowedDomains: ['example.com'],
  });

  assert.deepEqual(result, { filled: true, ref: 'example/fixture', field: 'password' });
  assert.equal(JSON.stringify(result).includes('hunter2'), false, '明文一个字都不能出现在返回值里');
  assert.ok(manager.calls.includes('fill'));
});

test('缺参数报 BAD_REQUEST，未知方法报 METHOD_NOT_FOUND', async () => {
  const manager = makeManager({ lease: { leaseId: LEASE_ID, expiresAt: Date.now() + 60_000 } });
  const deps = makeDeps(manager);
  await expectCode(dispatchRpc(deps, 'browser.click', { leaseId: LEASE_ID }), 'BAD_REQUEST');
  await expectCode(dispatchRpc(deps, 'browser.nope', { id: ENV }), 'METHOD_NOT_FOUND');
});

test('打包后 debug.* 直接 UNAUTHORIZED（debug.rendererEval 能在渲染层跑任意 JS）', async () => {
  const manager = makeManager();
  const deps = makeDeps(manager, { isPackaged: true });
  await expectCode(dispatchRpc(deps, 'debug.layout', {}), 'UNAUTHORIZED');
  await expectCode(dispatchRpc(deps, 'debug.rendererEval', { script: '1+1' }), 'UNAUTHORIZED');
});

test('窗口态 debug 命令默认禁用，只有显式放行才准动窗口', async () => {
  const manager = makeManager();
  const deps = makeDeps(manager);
  for (const method of ['debug.backgroundWindow', 'debug.showWindow', 'debug.hideWindow', 'debug.focusWindow']) {
    await expectCode(dispatchRpc(deps, method, {}), 'WINDOW_COMMANDS_DISABLED');
  }
  // 纯读诊断不受影响
  const layout = (await dispatchRpc(deps, 'debug.layout', {})) as { running: number };
  assert.equal(layout.running, 0);
  // 显式放行后窗口命令可用（回归专用开关）
  const allowed = makeDeps(manager, { allowWindowCommands: true });
  await dispatchRpc(allowed, 'debug.showWindow', {});
  assert.ok(manager.calls.includes('showWindow'));
});

/*
 * 审批策略的反向验收：**agent 不能给自己放行**。
 *
 * 全局策略只有界面那条 IPC 能写（`main.ts` 的 `settings:set`），RPC 那边连方法都没有；
 * 环境级 `approval` 也只走界面。这条测试盯着「有人顺手把 approval 加进 env.update 的
 * 白名单」——那样 agent 就能把自己的环境设成自动放行，这道门等于不存在。
 * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3.4。
 */
test('env.update 的 RPC 不接受 approval（agent 不能给自己放行）', async () => {
  const manager = makeManager();
  const deps = makeDeps(manager);
  await dispatchRpc(deps, 'env.update', { id: ENV, approval: 'auto', name: 'renamed' });
  assert.equal(manager.patches.length, 1);
  // 同一批里别的字段照常生效，只有 approval 被丢掉
  assert.deepEqual(manager.patches[0], { id: ENV, patch: { name: 'renamed' } });
});

test('env.create 的 RPC 记成 agent 建的', async () => {
  const manager = makeManager();
  const deps = makeDeps(manager);
  const created = (await dispatchRpc(deps, 'env.create', { id: 'beta' })) as { createdBy?: string };
  assert.equal(created.createdBy, 'agent');
});

test('休眠环境被用到时透明唤醒，纯读清单不唤醒', async () => {
  const wakeManager = makeManager({ dormant: true });
  const wakeDeps = makeDeps(wakeManager);
  await dispatchRpc(wakeDeps, 'env.list', { id: ENV });
  assert.ok(!wakeManager.calls.includes(`wake:${ENV}`), 'env.list 不该把休眠环境拉起来');
  await expectCode(dispatchRpc(wakeDeps, 'browser.info', { id: ENV }), 'INTERNAL').catch(() => {});
  assert.ok(wakeManager.calls.includes(`wake:${ENV}`), 'browser.info 要先唤醒');
});

test('env.hibernate / env.wake 显式命令', async () => {
  const manager = makeManager();
  const deps = makeDeps(manager);
  await dispatchRpc(deps, 'env.hibernate', { id: ENV });
  assert.ok(manager.calls.includes(`hibernate:${ENV}`));
  await dispatchRpc(deps, 'env.wake', { id: ENV });
  assert.ok(manager.calls.includes(`wake:${ENV}`));
});
