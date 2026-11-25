/**
 * RPC 派发表。
 *
 * 从 `rpc.ts` 里拆出来，只为一件事：**让写门控能被单测跑到**。
 * `rpc.ts` 顶部 `import { app } from 'electron'`，`node --test` 加载不了它；
 * 这个模块只依赖类型（`import type` 会被擦掉）和两个无 electron 依赖的纯模块，
 * 所以 `tests/rpc-dispatch.test.ts` 能直接加载它、喂一个假的 manager 进去，
 * 断言「没持 lease 的写操作会被拒」这条最贵的边界。
 *
 * **接线只在这里做**：写操作必须走 `writeCall` / `inputCall` / `dialogCall`，
 * 或者显式 `deps.manager.assertWritable`。`tests/rpc-gating.test.ts` 用源码断言盯着这条。
 */
import { fillSecretInto } from './browser/fill-secret.ts';
import { makeEvent, type EnvironmentPatch } from './domain/environment.ts';
import { captureEvidence } from './evidence.ts';
import { runDoctor } from './doctor.ts';
import type { EnvironmentManager } from './environments';
import type { PluginHost } from './plugins/host';
import type { Permission } from './plugins/package.ts';
import type { Store } from './store';
import type { VaultStore } from './vault/store';
import type { BrowserShortcut, ClickOptions, FetchOptions, NavigateOptions, SpaceId, TabRef } from '../shared/types';

export class RpcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 派发表的依赖。全是窄接口或纯值，所以单测可以只实现被走到的那几个方法。
 *
 * `isPackaged` / `quit` 是 electron 唯一的两处渗透点，做成值注入而不是 import app：
 * 打包后 `debug.*` 要关掉（见下面 dispatch 里的说明），测试里则传 false 就能跑。
 */
export interface DispatchDeps {
  manager: EnvironmentManager;
  store: Store;
  vault: VaultStore;
  saveVault: () => Promise<void>;
  plugins: PluginHost;
  isPackaged: boolean;
  /** 允许 debug.* 里改窗口位置/可见性/前台的命令。默认 false：回归不碰用户的窗口。 */
  allowWindowCommands?: boolean;
  quit: () => void;
}

export async function dispatchRpc(
  deps: DispatchDeps,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const str = (key: string): string => {
    const value = params[key];
    if (typeof value !== 'string' || !value) throw new RpcError('BAD_REQUEST', `missing string param: ${key}`);
    return value;
  };
  const optionalLease = typeof params.leaseId === 'string' ? params.leaseId : undefined;
  // 标签寻址：不传就作用于该环境当前激活的标签
  // （PRD 第一条：人和 agent 看的是同一个页面实例）
  const tabRef = (key: string): TabRef => {
    const value = params[key];
    if (typeof value === 'number' || (typeof value === 'string' && value)) return value;
    throw new RpcError('BAD_REQUEST', `missing tab ref param: ${key}`);
  };
  const optionalTab: TabRef | undefined =
    typeof params.tabId === 'number' || (typeof params.tabId === 'string' && params.tabId)
      ? (params.tabId as TabRef)
      : undefined;
  // Agent RPC 默认只操作 Agent Space；显式 --space=person 只用于诊断/受控人工命令。
  const space: SpaceId = params.space === 'person' ? 'person' : 'agent';

  /*
   * 休眠环境对调用方透明：任何「真的要用页面/控制权」的命令都先唤醒。
   * 纯读清单（env.list / env.get / events.list / debug.* / ping）不唤醒 —— 否则
   * 「看一眼列表」就把刚休眠的环境全拉起来，休眠机制等于没做。
   */
  const WAKE_PREFIXES = ['browser.', 'net.', 'extension.', 'evidence.', 'vault.fill'];
  const WAKE_TAB = new Set([
    'tab.new',
    'tab.select',
    'tab.close',
    'tab.closeOthers',
    'tab.closeRight',
    'tab.reorder',
    'tab.mute',
    'tab.reopen',
  ]);
  const WAKE_ENV = new Set([
    'env.start',
    'env.select',
    'env.acquire',
    'env.takeover',
    'env.release',
    'env.renew',
    'env.egress',
    'env.doctor',
    'env.moveToGroup',
    'debug.sendInput',
    'debug.shortcut',
    'debug.point',
    'debug.rendererEval',
  ]);
  const shouldWake =
    WAKE_ENV.has(method) || WAKE_TAB.has(method) || WAKE_PREFIXES.some((prefix) => method.startsWith(prefix));
  if (shouldWake && typeof params.id === 'string' && deps.manager.isDormant(params.id)) {
    deps.manager.wake(params.id);
  }

  const num = (key: string): number | undefined =>
    typeof params[key] === 'number' ? (params[key] as number) : undefined;
  const reqNum = (key: string): number => {
    const value = num(key);
    if (value === undefined) throw new RpcError('BAD_REQUEST', `missing number param: ${key}`);
    return value;
  };
  const asWaitUntil = (value: unknown): NavigateOptions['waitUntil'] =>
    value === 'commit' || value === 'domcontentloaded' || value === 'load' || value === 'networkidle'
      ? value
      : undefined;
  const asButton = (value: unknown): ClickOptions['button'] =>
    value === 'left' || value === 'middle' || value === 'right' ? value : undefined;
  const asPosition = (value: unknown): ClickOptions['position'] => {
    if (typeof value !== 'object' || value === null) return undefined;
    const { x, y } = value as { x?: unknown; y?: unknown };
    return typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined;
  };
  const asCredentials = (value: unknown): FetchOptions['credentials'] =>
    value === 'omit' || value === 'include' ? value : undefined;
  const asFetchCache = (value: unknown): FetchOptions['cache'] => {
    switch (value) {
      case 'default':
      case 'no-store':
      case 'reload':
      case 'no-cache':
      case 'force-cache':
      case 'only-if-cached':
        return value;
      default:
        return undefined;
    }
  };
  const asHeaders = (value: unknown): Record<string, string> | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== 'string') return undefined;
      out[key] = item;
    }
    return out;
  };
  const navOptions = (p: Record<string, unknown>): NavigateOptions => ({
    referer: typeof p.referer === 'string' ? p.referer : undefined,
    timeoutMs: typeof p.timeoutMs === 'number' ? p.timeoutMs : undefined,
    waitUntil: asWaitUntil(p.waitUntil),
  });
  const clickOptions = (p: Record<string, unknown>): ClickOptions => ({
    button: asButton(p.button),
    clickCount: typeof p.clickCount === 'number' ? p.clickCount : undefined,
    delay: typeof p.delay === 'number' ? p.delay : undefined,
    position: asPosition(p.position),
    timeoutMs: typeof p.timeoutMs === 'number' ? p.timeoutMs : undefined,
    label: typeof p.label === 'string' ? p.label : undefined,
    steps: typeof p.steps === 'number' ? p.steps : undefined,
    noWaitAfter: Boolean(p.noWaitAfter),
    navigationTimeoutMs: typeof p.navigationTimeoutMs === 'number' ? p.navigationTimeoutMs : undefined,
  });
  const fetchOptions = (p: Record<string, unknown>): FetchOptions => ({
    method: typeof p.method === 'string' ? p.method : undefined,
    headers: asHeaders(p.headers),
    body: typeof p.body === 'string' ? p.body : undefined,
    cache: asFetchCache(p.cache),
    timeoutMs: typeof p.timeoutMs === 'number' ? p.timeoutMs : undefined,
    credentials: asCredentials(p.credentials),
    saveAs: typeof p.saveAs === 'string' ? p.saveAs : undefined,
  });
  const controller = () => deps.manager.controllerFor(str('id'), optionalTab, space);
  const invoke = (method: string, args: unknown[]): unknown => {
    const target = controller() as unknown as Record<string, (...a: unknown[]) => unknown>;
    return target[method](...args);
  };
  /** 写操作：必须持 lease。 */
  const writeCall = (method: string, ...args: unknown[]): unknown => {
    const id = str('id');
    deps.manager.assertWritable(id, optionalLease, space);
    return invoke(method, args);
  };
  /**
   * 输入类：还要页面收得到输入 + 目标必须是激活标签（CDP 输入只作用于激活 webContents）。
   *
   * 后台环境（视图没挂在窗口上）Chromium 会把输入丢掉，所以这里先把它**临时挂到窗口最底层**
   * （`ensureOperable`），用完在 finally 里摘掉——这样 agent 能并行操作非当前显示的环境，
   * 而人看到的还是上面那个视图。
   */
  const inputCall = async (method: string, ...args: unknown[]): Promise<unknown> => {
    const id = str('id');
    deps.manager.assertWritable(id, optionalLease, space);
    // controllerFor 会懒建 Agent Space 的第一个标签；必须先有标签，ensureOperable 才有视图可挂。
    const controller = deps.manager.controllerFor(id, optionalTab, space);
    const temporary = deps.manager.ensureOperable(id, space);
    let emulatedViewport = false;
    try {
      // 视图被界面让开 / 尺寸为 0 时输入会被丢掉（表现为挂到 RPC 超时），先拒绝
      deps.manager.assertInputOnScreen(id, space);
      deps.manager.assertActiveTab(id, optionalTab, space);
      controller.assertNoDialog();
      // 页面焦点用 CDP 仿真，不激活 Warren 窗口；后台脚本不能抢用户前台。
      await deps.manager.focusForInput(id, space);
      if (temporary) emulatedViewport = await deps.manager.prepareBackgroundInput(id, space);
      return await invoke(method, args);
    } finally {
      if (emulatedViewport) await deps.manager.clearBackgroundInput(id, space);
      if (temporary) deps.manager.detachOperable(id, space);
    }
  };
  /**
   * dialog 处理：浏览器侧命令，不发输入，所以不要求窗口在前台、也不要求是激活标签。
   * 必须留着这条「不挑环境状态」的路，否则 dialog 卡住时连 accept/dismiss 都调不动。
   */
  const dialogCall = (method: string, ...args: unknown[]): unknown => {
    const id = str('id');
    deps.manager.assertWritable(id, optionalLease, space);
    return invoke(method, args);
  };

  switch (method) {
    case 'ping':
      return { pong: true, pid: process.pid };

    case 'env.list':
      return deps.manager.list();

    case 'env.get':
      return deps.manager.get(str('id')) ?? null;

    /*
     * 审批策略**只读**。写只有界面那条 IPC —— 见上面 `env.update` 的注释。
     * agent 读它是为了知道「现在要不要等人交还」，不是为了改。
     */
    case 'settings.get':
      return deps.store.appSettings();

    case 'env.create':
      return deps.manager.create({
        id: str('id'),
        name: typeof params.name === 'string' ? params.name : undefined,
        proxy: typeof params.proxy === 'string' ? params.proxy : undefined,
        startUrl: typeof params.startUrl === 'string' ? params.startUrl : undefined,
        headed: typeof params.headed === 'boolean' ? params.headed : undefined,
        // 走 RPC 的一定是 agent（CLI）。人那条路是 main.ts 的 IPC。
        createdBy: 'agent',
      });

    /*
     * 扩展是**环境配置**的一部分（和 env.update 一样不改页面状态），所以不挂 lease 门控。
     * 装在 `<storagePath>/extensions/` 下，见 src/main/extensions.ts。
     */
    case 'extension.list':
      return deps.manager.extensionsOf(str('id'));

    case 'extension.add':
      return deps.manager.extensionAdd(
        str('id'),
        str('dir'),
        typeof params.name === 'string' ? params.name : undefined,
      );

    case 'extension.remove':
      return deps.manager.extensionRemove(str('id'), str('name'));

    case 'env.remove':
      await deps.manager.remove(str('id'));
      return { ok: true };

    case 'env.update': {
      const patch: EnvironmentPatch = {};
      /*
       * **故意不读 `params.approval`**：审批策略是信任决定，agent 能给自己放行的话这道门
       * 就等于不存在。只有界面那条 IPC（`main.ts` 的 `env:update`）能带这个字段。
       * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3.4 —— 别顺手把它加进来。
       */
      if (typeof params.name === 'string') patch.name = params.name;
      // `null` / `''` 都是「清掉」：CLI 的 `--proxy=none` 要能解绑
      if (params.proxy === null || params.proxy === 'none' || params.proxy === '') patch.proxy = null;
      else if (typeof params.proxy === 'string') patch.proxy = params.proxy;
      if (params.trustedCa === null || params.trustedCa === 'none' || params.trustedCa === '') patch.trustedCa = null;
      else if (typeof params.trustedCa === 'string') patch.trustedCa = params.trustedCa;
      if (typeof params.startUrl === 'string') patch.startUrl = params.startUrl;
      if (typeof params.headed === 'boolean') patch.headed = params.headed;
      return deps.manager.update(str('id'), patch);
    }

    case 'env.start':
      return deps.manager.start(str('id'));

    case 'env.stop':
      deps.manager.stop(str('id'));
      return { ok: true };

    case 'env.hibernate':
      return { ok: deps.manager.hibernate(str('id'), 'manual') };

    case 'env.wake':
      return { ok: deps.manager.wake(str('id')) };

    case 'env.select':
      deps.manager.select(str('id'));
      return { ok: true };

    case 'env.acquire':
      return deps.manager.acquire(
        str('id'),
        'agent',
        typeof params.label === 'string' ? params.label : undefined,
        space,
      );

    case 'env.takeover':
      return deps.manager.takeover(str('id'), 'human', space);

    case 'env.release':
      deps.manager.release(str('id'), str('leaseId'), 'agent');
      return { ok: true };

    case 'env.renew':
      return deps.manager.renew(str('id'), str('leaseId'));

    case 'env.egress': {
      const id = str('id');
      const controller = deps.manager.controllerFor(id, undefined, space);
      const snapshot = await controller.snapshot({ limit: 200 });
      const environment = deps.store.get(id);
      return {
        environmentId: id,
        proxy: environment?.proxy ?? null,
        trustedCa: environment?.trustedCa ?? null,
        url: controller.currentUrl(),
        title: await controller.title(),
        nodes: snapshot.length,
      };
    }

    case 'env.doctor': {
      const id = str('id');
      const localPorts = Array.isArray(params.localPorts)
        ? params.localPorts.filter((port): port is number => typeof port === 'number')
        : undefined;
      return runDoctor(deps.manager, deps.store, id, { localPorts });
    }

    case 'events.list':
      return deps.store.events(typeof params.environmentId === 'string' ? params.environmentId : undefined);

    case 'evidence.capture':
      return captureEvidence(deps.manager, str('id'), {
        name: typeof params.name === 'string' ? params.name : undefined,
        screenshot: params.screenshot !== false,
      });

    // ── 标签 ────────────────────────────────────────────────────
    // 标签活在 Environment 里面，共用它的 session / 代理 / 登录态。
    // 不传 tabId 的 browser.* 就作用于当前激活标签。
    case 'tab.list':
      return deps.manager.tabsOf(str('id'), space);

    case 'tab.new': {
      const id = str('id');
      if (space === 'agent') deps.manager.assertWritable(id, optionalLease, space);
      return deps.manager.newTab(
        id,
        typeof params.url === 'string' ? params.url : undefined,
        {
          activate: params.background !== true,
        },
        space,
      );
    }

    case 'tab.select': {
      const id = str('id');
      if (space === 'agent') deps.manager.assertWritable(id, optionalLease, space);
      return deps.manager.selectTab(id, space, tabRef('ref'));
    }

    case 'tab.close': {
      const id = str('id');
      if (space === 'agent') deps.manager.assertWritable(id, optionalLease, space);
      deps.manager.closeTab(id, space, tabRef('ref'));
      return { ok: true };
    }

    case 'tab.closeOthers':
    case 'tab.closeRight': {
      const id = str('id');
      if (space === 'agent') deps.manager.assertWritable(id, optionalLease, space);
      deps.manager.closeTabs(id, space, tabRef('ref'), method === 'tab.closeRight' ? 'right' : 'others');
      return { ok: true };
    }

    case 'tab.reorder': {
      const id = str('id');
      if (space === 'agent') deps.manager.assertWritable(id, optionalLease, space);
      return deps.manager.reorderTab(id, space, reqNum('from'), reqNum('to'));
    }

    case 'tab.mute': {
      const id = str('id');
      if (space === 'agent') deps.manager.assertWritable(id, optionalLease, space);
      return deps.manager.muteTab(id, space, tabRef('ref'), params.muted !== false);
    }

    case 'tab.reopen': {
      const id = str('id');
      if (space === 'agent') deps.manager.assertWritable(id, optionalLease, space);
      return deps.manager.reopenTab(id, space);
    }

    // ── 分组 ────────────────────────────────────────────────────
    // 只影响侧栏组织，不碰运行时。
    case 'group.list':
      return deps.manager.listGroups();

    case 'group.create':
      return deps.manager.createGroup({
        id: typeof params.id === 'string' && params.id ? params.id : undefined,
        name: str('name'),
      });

    case 'group.rename':
      return deps.manager.renameGroup(str('id'), str('name'));

    case 'group.remove':
      return deps.manager.removeGroup(str('id'));

    case 'group.collapse':
      return deps.manager.setGroupCollapsed(str('id'), Boolean(params.collapsed));

    case 'group.reorder': {
      if (!Array.isArray(params.ids)) throw new RpcError('BAD_REQUEST', 'ids must be an array');
      await deps.manager.reorderGroups(params.ids.map(String));
      return { ok: true };
    }

    case 'env.moveToGroup': {
      // groupId 显式允许 null/undefined 表示移出分组
      const groupId = typeof params.groupId === 'string' && params.groupId ? params.groupId : undefined;
      return deps.manager.moveToGroup(str('id'), groupId);
    }

    case 'env.reorder': {
      if (!Array.isArray(params.ids)) throw new RpcError('BAD_REQUEST', 'ids must be an array');
      const groupId = typeof params.groupId === 'string' && params.groupId ? params.groupId : undefined;
      await deps.manager.reorderEnvironments(groupId, params.ids.map(String));
      return { ok: true };
    }

    /*
     * 诊断通道。打包后关掉：`debug.rendererEval` 能在 app 的渲染层里执行任意 JS。
     * 它有 token 鉴权、socket 是 0600，所以同用户进程才调得到——不算漏洞。
     * 但打包后没有任何理由还开着它，白给攻击面留一条路。
     */
    case 'debug.layout':
    case 'debug.focusWindow':
    case 'debug.rendererEval':
    case 'debug.shortcut':
    case 'debug.point':
    case 'debug.sendInput':
    case 'debug.hideWindow':
    case 'debug.backgroundWindow':
    case 'debug.showWindow':
    case 'debug.quit': {
      if (deps.isPackaged) throw new RpcError('UNAUTHORIZED', 'debug.* is unavailable in packaged builds');
      /*
       * 窗口态命令默认关掉：backgroundWindow / showWindow / focusWindow / hideWindow
       * 会移窗口、改 opacity、切 Dock / 前台，回归跑起来会反复打断用户当前操作。
       * 需要专门验离屏 / 托盘恢复时，主进程带 `WARREN_ALLOW_WINDOW_COMMANDS=1` 起，
       * 脚本再显式 `WARREN_REGRESS_WINDOW=1`。
       */
      const WINDOW_METHODS = new Set([
        'debug.focusWindow',
        'debug.hideWindow',
        'debug.backgroundWindow',
        'debug.showWindow',
      ]);
      if (WINDOW_METHODS.has(method) && deps.allowWindowCommands !== true) {
        throw new RpcError('WINDOW_COMMANDS_DISABLED', `${method} 默认禁用（WARREN_ALLOW_WINDOW_COMMANDS=1 开启）`);
      }
      if (method === 'debug.hideWindow') {
        deps.manager.hideWindow();
        return { hidden: true };
      }
      if (method === 'debug.backgroundWindow') {
        deps.manager.backgroundWindow();
        return { background: true };
      }
      if (method === 'debug.showWindow') {
        deps.manager.showWindow(false);
        return { hidden: false, focused: false };
      }
      if (method === 'debug.sendInput') {
        /*
         * 实验探针：用 Electron 原生的 `sendInputEvent` 注入一次点击（**不走 CDP**）。
         *
         * 问的问题：视图没显示在窗口上（后台环境）时，原生注入能不能落到页面？
         * （这个探针问出答案之后，正式做法是 `ensureOperable` 把后台视图临时挂到底层。）
         * 「窗口不在前台」那一半 2026-10-17 已实测：CDP 输入照样落地，不需要原生注入。
         */
        const wc = deps.manager.controllerFor(str('id'), optionalTab, space).webContents;
        const x = reqNum('x');
        const y = reqNum('y');
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        return {
          ok: true,
          focused: wc.isFocused(),
          // `visibilityState` 是页面自报的活跃状态：视图没挂到窗口上时它是 hidden
          visibility: await wc.executeJavaScript('document.visibilityState', true).catch(() => 'unknown'),
        };
      }
      if (method === 'debug.point') {
        // 跨源 iframe 的坐标换算没法靠人眼判断（点错了不报错），这里把两个点并排返回
        return await deps.manager.controllerFor(str('id'), optionalTab, space).probePoint(params.target as never);
      }
      if (method === 'debug.quit') {
        // 优雅退出。存在的理由：没有别的办法从脚本触发 `before-quit`
        // （⌘Q 要真按键），而「退出时辅助进程死没死」只能这样实测。
        setTimeout(() => deps.quit(), 50);
        return { ok: true };
      }
      if (method === 'debug.shortcut') {
        // 真按键要靠菜单加速键，脚本发不出来（见 EnvironmentManager.sendShortcut）
        deps.manager.sendShortcut(params.shortcut as BrowserShortcut);
        return { ok: true };
      }
      if (method === 'debug.rendererEval') {
        return { value: await deps.manager.evalInRenderer(str('script')) };
      }
      if (method === 'debug.focusWindow') return deps.manager.focusWindow();
      return deps.manager.layout();
    }

    // ── Vault ────────────────────────────────────────────────────
    // 只暴露「列清单」和「填进页面」。没有 reveal：调用方永远拿不到明文。
    case 'vault.list':
      return { available: deps.vault.available, credentials: deps.vault.list() };

    case 'vault.add': {
      const secret = params.secret as Record<string, string> | undefined;
      if (!secret || typeof secret !== 'object') throw new RpcError('BAD_REQUEST', 'secret is required');
      const summary = deps.vault.add({
        provider: str('provider'),
        label: typeof params.label === 'string' ? params.label : '',
        secret,
      });
      await deps.saveVault();
      return summary;
    }

    case 'vault.remove': {
      const removed = deps.vault.remove(str('ref'));
      await deps.saveVault();
      return { removed };
    }

    case 'vault.fill': {
      const id = str('id');
      deps.manager.assertWritable(id, optionalLease, space);
      const ref = str('ref');
      const field = (typeof params.field === 'string' ? params.field : 'password') as 'username' | 'password' | 'token';
      const secret = deps.vault.reveal(ref);
      const value = secret[field];
      if (!value) throw new RpcError('CREDENTIAL_FIELD_MISSING', `${ref} 没有 ${field}`);
      const controller = deps.manager.controllerFor(id, optionalTab, space);
      // 域名名单（抄 Browser Use secret_bindings）：不在名单的 origin 拒绝填充并记事件
      const allowedDomains = Array.isArray(params.allowedDomains)
        ? (params.allowedDomains as unknown[]).map(String)
        : undefined;
      await fillSecretInto(
        {
          manager: deps.manager,
          environmentId: id,
          space,
          controller,
          tab: optionalTab,
        },
        params.target as never,
        value,
        {
          allowedDomains,
          onDenied: (host) => {
            deps.store.record(
              makeEvent('vault.fillDenied', `${ref} 不在 ${host || '未知域'} 的允许名单内`, 'system', id),
            );
          },
        },
      );
      // 只回传「填了哪个字段」，不回传值
      return { filled: true, ref, field };
    }

    // ── 插件 ─────────────────────────────────────────────────────
    case 'plugin.list':
      return deps.plugins.list();

    case 'plugin.install':
      return deps.plugins.install(str('source'));

    case 'plugin.update':
      return deps.plugins.update(str('id'));

    case 'plugin.enable':
      return deps.plugins.enable(str('id'));

    case 'plugin.disable':
      await deps.plugins.disable(str('id'));
      return { ok: true };

    case 'plugin.uninstall':
      await deps.plugins.uninstall(str('id'));
      return { ok: true };

    case 'plugin.grant':
      return deps.plugins.grant(str('id'), (params.permissions as Permission[]) ?? []);

    case 'plugin.reload':
      return deps.plugins.reload(str('id'));

    case 'plugin.logs':
      return deps.plugins.logs(str('id'), typeof params.limit === 'number' ? params.limit : 200);

    case 'plugin.config.set':
      return deps.plugins.setSetting(str('id'), str('key'), str('value'));

    case 'plugin.rpc':
      /*
       * 走 RPC 的插件调用一律是 agent：`ui` 只从 `main.ts` 的 `plugin:rpc` IPC 进来。
       * 插件据此把「只给人看」的通道（账号插件的 reveal）关掉。
       */
      return deps.plugins.rpc(str('id'), str('method'), params.input ?? null, {
        leaseId: typeof params.leaseId === 'string' ? params.leaseId : undefined,
        environmentId: typeof params.environmentId === 'string' ? params.environmentId : undefined,
        caller: 'agent',
      });

    case 'plugin.run':
      // `env` 可选：跟环境无关的命令（列实例、起实例）不需要它
      return deps.plugins.run(str('id'), str('command'), {
        environmentId: typeof params.env === 'string' ? params.env : '',
        input: params.input,
        leaseId: typeof params.leaseId === 'string' ? params.leaseId : undefined,
      });

    // ── 写操作：必须持有效 lease ──────────────────────────────────
    // 分级见 PLAN §6.2：写 = assertWritable；输入类再加 assertVisible + 目标须是激活标签。
    case 'browser.navigate': {
      const id = str('id');
      deps.manager.assertWritable(id, optionalLease, space);
      return deps.manager.controllerFor(id, optionalTab, space).navigate(str('url'), navOptions(params));
    }

    case 'browser.reload': {
      const id = str('id');
      deps.manager.assertWritable(id, optionalLease, space);
      return deps.manager.controllerFor(id, optionalTab, space).reload(navOptions(params));
    }

    case 'browser.goBack': {
      const id = str('id');
      deps.manager.assertWritable(id, optionalLease, space);
      deps.manager.controllerFor(id, optionalTab, space).goBack();
      return deps.manager.controllerFor(id, optionalTab, space).navigationState();
    }

    case 'browser.goForward': {
      const id = str('id');
      deps.manager.assertWritable(id, optionalLease, space);
      deps.manager.controllerFor(id, optionalTab, space).goForward();
      return deps.manager.controllerFor(id, optionalTab, space).navigationState();
    }

    case 'browser.click':
      return inputCall('click', params.target as never, clickOptions(params));

    case 'browser.dblclick':
      return inputCall('dblclick', params.target as never, clickOptions(params));

    case 'browser.hover':
      return inputCall('hover', params.target as never, clickOptions(params));

    case 'browser.drag':
      return inputCall('drag', params.source as never, params.target as never, clickOptions(params));

    case 'browser.fill':
      return inputCall('fill', params.target as never, str('value'), {
        clearFirst: params.clearFirst === undefined ? undefined : Boolean(params.clearFirst),
        timeoutMs: num('timeoutMs'),
      });

    case 'browser.selectOption':
      return inputCall('selectOption', params.target as never, params.value as never, {
        timeoutMs: num('timeoutMs'),
      });

    case 'browser.focus':
      return inputCall('focus', params.target as never, { timeoutMs: num('timeoutMs') });

    case 'browser.press': {
      // 老形式 press(key) 仍可用；新形式 press(target, chord)
      if (params.target === undefined) return inputCall('press', str('key'));
      return inputCall('press', params.target as never, str('chord'), {
        delay: num('delay'),
        timeoutMs: num('timeoutMs'),
      });
    }

    case 'browser.setInputFiles':
      return inputCall('setInputFiles', params.target as never, params.paths as never);

    case 'browser.acceptDialog':
      return dialogCall('acceptDialog', typeof params.prompt === 'string' ? params.prompt : undefined);

    case 'browser.dismissDialog':
      return dialogCall('dismissDialog');

    case 'browser.downloadSaveAs':
      return writeCall('downloadSaveAs', str('downloadId'), str('path'));

    case 'browser.downloadCancel':
      return writeCall('downloadCancel', str('downloadId'));

    // 逃生舱：写门控，但**允许后台标签**（可变页面状态，不能只读）
    case 'browser.evaluate':
      return writeCall('evaluate', str('fn'), params.arg, { timeoutMs: num('timeoutMs') });

    case 'browser.fetch':
      return writeCall('fetch', str('url'), fetchOptions(params));

    case 'browser.cdp':
      return writeCall('cdp', str('method'), (params.params as Record<string, unknown>) ?? {});

    case 'browser.clearDataForOrigin':
      return writeCall(
        'clearDataForOrigin',
        str('origin'),
        typeof params.types === 'string' ? params.types : undefined,
      );

    case 'browser.mouseClick':
      return inputCall('mouseClick', reqNum('x'), reqNum('y'), clickOptions(params));

    case 'browser.mouseMove':
      return inputCall('mouseMove', reqNum('x'), reqNum('y'), {
        label: typeof params.label === 'string' ? params.label : undefined,
      });

    case 'browser.mouseDown':
      return inputCall('mouseDown', { button: params.button as never, x: num('x'), y: num('y') });

    case 'browser.mouseUp':
      return inputCall('mouseUp', { button: params.button as never, x: num('x'), y: num('y') });

    case 'browser.mouseWheel':
      return inputCall('mouseWheel', num('deltaX') ?? 0, num('deltaY') ?? 0, {
        label: typeof params.label === 'string' ? params.label : undefined,
      });

    case 'browser.keyboardDown':
      return inputCall('keyboardDown', str('key'));

    case 'browser.keyboardUp':
      return inputCall('keyboardUp', str('key'));

    case 'browser.keyboardPress':
      return inputCall('keyboardPress', str('chord'), { delay: num('delay') });

    case 'browser.keyboardType':
      return inputCall('keyboardType', str('text'), { delay: num('delay') });

    case 'browser.keyboardInsert':
      return inputCall('keyboardInsert', str('text'));

    case 'browser.keyboardPaste':
      return inputCall('keyboardPaste', params.content as never);

    // ── 读操作：不需要 lease ─────────────────────────────────────
    case 'browser.snapshot': {
      const id = str('id');
      const controller = deps.manager.controllerFor(id, optionalTab, space);
      // 只有这条路径分配 `@N`：ref 表是 agent 的会话状态，别的读快照调用不许动它
      const nodes = await controller.snapshotWithRefs({
        scope: params.scope as never,
        root: typeof params.root === 'string' ? params.root : undefined,
        limit: num('limit'),
        includeActionMarks: Boolean(params.includeActionMarks),
        includeStableLocator: Boolean(params.includeStableLocator),
        interactiveOnly: Boolean(params.interactiveOnly),
        roles: Array.isArray(params.roles) ? (params.roles as string[]) : undefined,
        selector: typeof params.selector === 'string' ? params.selector : undefined,
      });
      return { url: controller.currentUrl(), title: await controller.title(), nodes };
    }

    case 'browser.waitFor': {
      const id = str('id');
      await deps.manager.controllerFor(id, optionalTab, space).waitFor(params.predicate as never, {
        timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined,
      });
      return { ok: true };
    }

    case 'browser.waitForURL':
      return deps.manager
        .controllerFor(str('id'), optionalTab, space)
        .waitForURL(params.matcher as never, { timeoutMs: num('timeoutMs') });

    case 'browser.waitForSelector':
      return deps.manager.controllerFor(str('id'), optionalTab, space).waitForSelector(params.target as never, {
        state: params.state as never,
        timeoutMs: num('timeoutMs'),
      });

    case 'browser.waitForFunction':
      return deps.manager.controllerFor(str('id'), optionalTab, space).waitForFunction(str('fn'), params.arg, {
        timeoutMs: num('timeoutMs'),
        polling: num('polling'),
      });

    case 'browser.waitForLoadState':
      await deps.manager.controllerFor(str('id'), optionalTab, space).waitForLoadState(params.state as never, {
        timeoutMs: num('timeoutMs'),
        idleMs: num('idleMs'),
      });
      return { ok: true };

    case 'browser.waitForTimeout':
      await deps.manager.controllerFor(str('id'), optionalTab, space).waitForTimeout(num('ms') ?? 0);
      return { ok: true };

    case 'browser.waitForEvent':
      return deps.manager.controllerFor(str('id'), optionalTab, space).waitForEvent(str('kind') as never, {
        timeoutMs: num('timeoutMs'),
      });

    case 'browser.info':
      return deps.manager.controllerFor(str('id'), optionalTab, space).info();

    case 'browser.events':
      return deps.manager.controllerFor(str('id'), optionalTab, space).events();

    case 'browser.downloadStatus':
      return deps.manager.controllerFor(str('id'), optionalTab, space).downloadStatus(str('downloadId'));

    case 'browser.console':
      return deps.manager.consoleEntries(str('id'));

    case 'browser.network':
      return deps.manager.networkEntries(str('id'));

    // ── 网络拦截规则 ─────────────────────────────────────────────
    // 看规则 / 看命中是读；**改规则改变页面行为，是写操作**（要 lease）。
    case 'net.rules':
      return deps.manager.netRules(str('id'));

    /*
     * 响应体只在 HAR 录制期间才有（抓它要让跨源响应跳过 CORS 检查，所以不常开）。
     * 没录制时报 NET_BODY_NEEDS_RECORDING，消息里直接给下一步命令。
     */
    case 'net.body':
      return deps.manager.netBody(str('id'), reqNum('index'));

    case 'net.hits':
      return deps.manager.netHits(str('id'), num('limit'));

    case 'net.rule.add': {
      const id = str('id');
      deps.manager.assertWritable(id, optionalLease, space);
      return deps.manager.netAddRule(id, params.rule, 'agent');
    }

    case 'net.rule.set': {
      const id = str('id');
      deps.manager.assertWritable(id, optionalLease, space);
      return deps.manager.netSetRuleEnabled(id, str('ruleId'), Boolean(params.enabled), 'agent');
    }

    case 'net.rule.remove': {
      const id = str('id');
      deps.manager.assertWritable(id, optionalLease, space);
      return { removed: deps.manager.netRemoveRule(id, str('ruleId'), 'agent') };
    }

    case 'net.passthrough': {
      const id = str('id');
      deps.manager.assertWritable(id, optionalLease, space);
      return deps.manager.netPassthrough(
        id,
        {
          match: str('match'),
          isRegex: Boolean(params.isRegex),
          method: typeof params.method === 'string' ? params.method : undefined,
          forMs: reqNum('forMs'),
        },
        'agent',
      );
    }

    case 'net.record': {
      const id = str('id');
      deps.manager.assertWritable(id, optionalLease, space);
      return await deps.manager.netRecord(
        id,
        str('action'),
        typeof params.output === 'string' ? params.output : undefined,
        'agent',
      );
    }

    case 'net.replay': {
      const id = str('id');
      deps.manager.assertWritable(id, optionalLease, space);
      return await deps.manager.netReplay(
        id,
        str('action'),
        typeof params.file === 'string' ? params.file : undefined,
        Boolean(params.offline),
        'agent',
      );
    }

    case 'browser.screenshot': {
      const id = str('id');
      const controller = deps.manager.controllerFor(id, optionalTab, space);
      /*
       * 截图和输入一样依赖「页面真的在出帧」。后台环境临时挂到窗口最底层，
       * 不改变显示中的页面，也不激活窗口；finally 必须摘掉临时视图。
       */
      const temporary = deps.manager.ensureOperable(id, space);
      try {
        return await controller.screenshot({
          format: params.format as never,
          fullPage: Boolean(params.fullPage),
          clip: params.clip as never,
          path: typeof params.path === 'string' ? params.path : undefined,
          encoding: params.encoding === 'base64' ? 'base64' : undefined,
        });
      } finally {
        if (temporary) deps.manager.detachOperable(id, space);
      }
    }

    case 'browser.highlight': {
      // 高亮只画个框：不改 DOM、不改页面状态，所以是读操作（不需要 lease）
      const id = str('id');
      return deps.manager.controllerFor(id, optionalTab, space).highlight(params.target as never);
    }

    default:
      throw new RpcError('METHOD_NOT_FOUND', `unknown method: ${method}`);
  }
}
