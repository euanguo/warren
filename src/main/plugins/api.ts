/**
 * 插件的 host API。
 *
 * 同一份实现供两种运行时使用（见 runtime.ts）：
 * - sandbox：直接给插件一个嵌套对象
 * - host：插件在子进程里，通过 JSON-RPC 按路径调用，落到同一张表
 *
 * 权限门控都在这里，插件永远拿不到没被授予的能力。
 */
import type { Permission } from '../../shared/permissions.ts';
import type { Environment, PluginSettingDescriptor } from '../../shared/types.ts';
import { fillSecretInto } from '../browser/fill-secret.ts';
import type { BrowserController } from '../browser/controller.ts';
import type { EnvironmentManager } from '../environments';
import { maskHint } from '../vault/store.ts';
import type { PluginSettings } from './settings.ts';
import type { PluginStorage } from './storage.ts';

export interface HostApiDeps {
  pluginId: string;
  /**
   * 当前这次调用绑定的环境。由核心的调用级上下文提供（见 host.ts 的 AsyncLocalStorage），
   * 不是插件级共享状态——否则同一插件的并发调用会互相覆盖环境。
   */
  currentEnvironmentId: () => string | undefined;
  require: (permission: Permission) => void;
  manager: EnvironmentManager;
  vault: {
    available: boolean;
    list(): Array<{ ref: string; provider: string; label: string; usernameHint: string }>;
    reveal(ref: string): { username?: string; password?: string; token?: string; totp?: string };
  };
  storage: PluginStorage;
  settings: PluginSettings;
  descriptors: PluginSettingDescriptor[];
  record: (type: string, message: string) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  signal: (channel: string, payload: unknown) => void;
  /** 写操作惰性取 lease：读操作不再把控制权从人手里抢走 */
  withLease: <T>(envId: string, fn: (leaseId: string) => Promise<T>) => Promise<T>;
}

export type HostHandler = (...args: unknown[]) => Promise<unknown> | unknown;

/**
 * 插件后端的环境视图：leaseId / leaseExpiresAt 是主进程内部凭据形状，不出边界。
 * storagePath 保留 —— whistle 要把 trusted-ca.pem 放进环境目录。
 */
type PluginEnvironmentView = Omit<Environment, 'leaseId' | 'leaseExpiresAt'>;

function toPluginEnvironment(env: Environment): PluginEnvironmentView {
  const copy: Environment = { ...env };
  delete copy.leaseId;
  delete copy.leaseExpiresAt;
  return copy;
}

/**
 * 浏览器能力的**单一来源表**。
 *
 * 一条 = 「插件能调的路径」+「要哪个权限」+「读还是写」+「怎么落到 controller」。
 * 加一个能力只改这张表 —— 权限检查、lease、环境校验都不用碰（这就是这次重构的目的：
 * 以前每加一个方法都要手抄一遍 `require` + `write` + `assertWritable`，抄漏一次就是提权）。
 *
 * `write: true` 的自动走 `withLease` + `assertWritable`。
 * `run` 的返回值必须 JSON 可序列化 —— host 运行时是走 JSON-RPC 出去的。
 */
interface BrowserCapability {
  permission: Permission;
  write?: boolean;
  run: (controller: BrowserController, args: unknown[]) => unknown;
}

const BROWSER_CAPABILITIES: Record<string, BrowserCapability> = {
  // ── 读：页面观察 ────────────────────────────────────────────────
  'browser.url': { permission: 'browser.dom.read', run: (c) => c.currentUrl() },
  'browser.title': { permission: 'browser.dom.read', run: (c) => c.title() },
  'browser.info': { permission: 'browser.dom.read', run: (c) => c.info() },
  'browser.events': { permission: 'browser.dom.read', run: (c) => c.events() },
  'browser.snapshot': {
    permission: 'browser.dom.read',
    run: async (c) => ({ url: c.currentUrl(), title: await c.title(), nodes: await c.snapshot() }),
  },
  'browser.highlight': {
    permission: 'browser.dom.read',
    run: (c, [target]) => c.highlight(target as never),
  },
  'browser.screenshot': {
    permission: 'browser.screenshot',
    run: async (c, [options]) => c.screenshot((options ?? {}) as never),
  },
  // ── 读：等待 ────────────────────────────────────────────────────
  // 等待全是读操作（不改页面），但会占住一次 RPC，超时受 exec 的 60s 上限约束。
  'browser.waitFor': { permission: 'browser.dom.read', run: (c, [p, o]) => c.waitFor(p as never, (o ?? {}) as never) },
  'browser.waitForSelector': {
    permission: 'browser.dom.read',
    run: (c, [t, o]) => c.waitForSelector(t as never, (o ?? {}) as never),
  },
  'browser.waitForURL': {
    permission: 'browser.dom.read',
    run: (c, [m, o]) => c.waitForURL(m as never, (o ?? {}) as never),
  },
  'browser.waitForFunction': {
    permission: 'browser.dom.read',
    run: (c, [fn, arg, o]) => c.waitForFunction(text(fn), arg, (o ?? {}) as never),
  },
  'browser.waitForLoadState': {
    permission: 'browser.dom.read',
    run: (c, [state, o]) => c.waitForLoadState(state as never, (o ?? {}) as never),
  },
  'browser.waitForTimeout': {
    permission: 'browser.dom.read',
    run: (c, [ms]) => {
      const value = Number(ms);
      if (!Number.isFinite(value) || value < 0) {
        throw Object.assign(new Error('browser.waitForTimeout 需要非负毫秒数'), { code: 'PLUGIN_BAD_REQUEST' });
      }
      return c.waitForTimeout(value);
    },
  },
  'browser.waitForEvent': {
    permission: 'browser.dom.read',
    run: (c, [kind, o]) => c.waitForEvent(kind as never, (o ?? {}) as never),
  },

  // ── 写：导航 ────────────────────────────────────────────────────
  'browser.navigate': { permission: 'browser.navigate', write: true, run: (c, [url]) => c.navigate(text(url)) },
  'browser.reload': { permission: 'browser.navigate', write: true, run: (c, [o]) => c.reload((o ?? {}) as never) },
  'browser.goBack': {
    permission: 'browser.navigate',
    write: true,
    run: (c) => {
      c.goBack();
      return c.navigationState();
    },
  },
  'browser.goForward': {
    permission: 'browser.navigate',
    write: true,
    run: (c) => {
      c.goForward();
      return c.navigationState();
    },
  },

  // ── 写：页面动作 ────────────────────────────────────────────────
  'browser.click': {
    permission: 'browser.input',
    write: true,
    run: (c, [t, o]) => c.click(t as never, (o ?? {}) as never),
  },
  'browser.dblclick': {
    permission: 'browser.input',
    write: true,
    run: (c, [t, o]) => c.dblclick(t as never, (o ?? {}) as never),
  },
  'browser.hover': {
    permission: 'browser.input',
    write: true,
    run: (c, [t, o]) => c.hover(t as never, (o ?? {}) as never),
  },
  'browser.drag': {
    permission: 'browser.input',
    write: true,
    run: (c, [s, t, o]) => c.drag(s as never, t as never, (o ?? {}) as never),
  },
  'browser.fill': {
    permission: 'browser.input',
    write: true,
    run: (c, [t, v, o]) => c.fill(t as never, text(v), (o ?? {}) as never),
  },
  'browser.selectOption': {
    permission: 'browser.input',
    write: true,
    run: (c, [t, v, o]) => c.selectOption(t as never, v as never, (o ?? {}) as never),
  },
  'browser.focus': {
    permission: 'browser.input',
    write: true,
    run: (c, [t, o]) => c.focus(t as never, (o ?? {}) as never),
  },
  'browser.press': { permission: 'browser.input', write: true, run: (c, [k]) => c.press(text(k) as never) },
  'browser.setInputFiles': {
    permission: 'browser.input',
    write: true,
    run: (c, [t, paths]) => c.setInputFiles(t as never, paths as never),
  },

  // ── 写：弹框 ────────────────────────────────────────────────────
  'browser.acceptDialog': {
    permission: 'browser.input',
    write: true,
    run: (c, [prompt]) => c.acceptDialog(prompt === undefined ? undefined : text(prompt)),
  },
  'browser.dismissDialog': { permission: 'browser.input', write: true, run: (c) => c.dismissDialog() },
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

export function createHandlers(deps: HostApiDeps): Record<string, HostHandler> {
  const env = (): string => {
    const id = deps.currentEnvironmentId();
    if (!id) {
      throw Object.assign(new Error('这个命令没有绑定环境，不能操作浏览器'), {
        code: 'PLUGIN_NO_ENVIRONMENT',
      });
    }
    return id;
  };

  const write = <T>(fn: (leaseId: string) => Promise<T>): Promise<T> => deps.withLease(env(), fn);

  /** 由 `BROWSER_CAPABILITIES` 表生成，不逐条手写 —— 见那张表上方的说明。 */
  const browserHandlers = (): Record<string, HostHandler> => {
    const out: Record<string, HostHandler> = {};
    for (const [path, capability] of Object.entries(BROWSER_CAPABILITIES)) {
      out[path] = (...args) => {
        deps.require(capability.permission);
        // 保持原顺序：写操作先过 lease 再碰 controller
        if (!capability.write) return capability.run(deps.manager.controllerFor(env()), args);
        return write(async (leaseId) => {
          deps.manager.assertWritable(env(), leaseId);
          return capability.run(deps.manager.controllerFor(env()), args);
        });
      };
    }
    return out;
  };

  return {
    // ── 日志 / 事件 / 信号 ────────────────────────────────────────────
    'log.debug': (...args) => deps.log('debug', args.map(text).join(' ')),
    'log.info': (...args) => deps.log('info', args.map(text).join(' ')),
    'log.warn': (...args) => deps.log('warn', args.map(text).join(' ')),
    'log.error': (...args) => deps.log('error', args.map(text).join(' ')),
    'events.emit': (type, message) => {
      deps.record(text(type), text(message));
      return { ok: true };
    },
    'ui.notify': (message) => {
      deps.record('plugin.notify', text(message));
      return { ok: true };
    },
    'signal.publish': (channel, payload) => {
      deps.signal(text(channel), payload ?? null);
      return { ok: true };
    },

    // ── 环境 ────────────────────────────────────────────────────────
    'environment.list': () => {
      deps.require('environment.read');
      return deps.manager.list().map(toPluginEnvironment);
    },
    'environment.get': (id) => {
      deps.require('environment.read');
      const env = deps.manager.get(text(id));
      return env ? toPluginEnvironment(env) : env;
    },
    /*
     * 改环境配置 / 启停环境。
     *
     * 为什么插件需要它：绑定一个代理实例 = 把 `env.proxy` 指向 `127.0.0.1:<port>`，
     * 而 `proxy` 只在 `start()` 时生效，所以「绑上就生效」必须能重启环境。
     * 这两件事都碰不到页面内容，和 `env.update` 一样**不挂 lease**——
     * 它们改的是环境的配置，不是「谁在控制这个页面」。
     */
    'environment.update': async (input) => {
      deps.require('environment.write');
      const patch = (input ?? {}) as { id?: unknown; proxy?: unknown; trustedCa?: unknown };
      const id = text(patch.id);
      if (!id) throw Object.assign(new Error('environment.update 需要 id'), { code: 'BAD_REQUEST' });
      return deps.manager.update(id, {
        // null / '' 都是「清掉」：解绑代理要能表达
        ...(patch.proxy === null || patch.proxy === '' ? { proxy: null } : {}),
        ...(typeof patch.proxy === 'string' && patch.proxy ? { proxy: patch.proxy } : {}),
        ...(patch.trustedCa === null || patch.trustedCa === '' ? { trustedCa: null } : {}),
        ...(typeof patch.trustedCa === 'string' && patch.trustedCa ? { trustedCa: patch.trustedCa } : {}),
      });
    },
    'environment.start': async (id) => {
      deps.require('environment.write');
      return deps.manager.start(text(id));
    },
    'environment.stop': (id) => {
      deps.require('environment.write');
      deps.manager.stop(text(id));
      return { ok: true };
    },

    /*
     * Cookie 受控通道：**只搬运不返回**（设计见 docs/PLUGIN-CAPABILITY-DESIGN.md §9）。
     * 值只在主进程内部流动，这里回的一律是名字 / 域 / 过期 / 标志和计数。
     * 写操作照旧惰性取 lease：人正持着控制权时不该被插件改登录态。
     * 宽形状的 `storage.cookie.read` / `write` 仍然在 denied 层，声明了也不给。
     */
    'cookie.names': (options) => {
      deps.require('storage.cookie.port');
      const url =
        typeof (options as { url?: unknown })?.url === 'string' ? text((options as { url: string }).url) : undefined;
      return deps.manager.cookieNames(env(), url);
    },
    'cookie.copy': (input) => {
      deps.require('storage.cookie.port');
      const params = (input ?? {}) as {
        from?: unknown;
        to?: unknown;
        domain?: unknown;
        name?: unknown;
      };
      const from = text(params.from);
      const to = text(params.to) || env();
      if (!from) throw Object.assign(new Error('cookie.copy 需要 from'), { code: 'BAD_REQUEST' });
      return deps.withLease(to, () =>
        deps.manager.cookieCopy(from, to, {
          domain: typeof params.domain === 'string' ? params.domain : undefined,
          name: typeof params.name === 'string' ? params.name : undefined,
        }),
      );
    },
    'cookie.import': (input) => {
      deps.require('storage.cookie.port');
      const cookies = (input as { cookies?: unknown })?.cookies;
      return deps.withLease(env(), () => deps.manager.cookieImport(env(), cookies as never));
    },
    'cookie.clear': (input) => {
      deps.require('storage.cookie.port');
      const params = (input ?? {}) as { domain?: unknown; name?: unknown };
      return deps.withLease(env(), () =>
        deps.manager.cookieClear(env(), {
          domain: typeof params.domain === 'string' ? params.domain : undefined,
          name: typeof params.name === 'string' ? params.name : undefined,
        }),
      );
    },

    // ── 浏览器 ──────────────────────────────────────────────────────
    ...browserHandlers(),
    /*
     * 开新标签。**不进 `BROWSER_CAPABILITIES` 那张表**：表里的 `run` 只拿得到 controller，
     * 而开标签是 TabManager 的事（和 `tab.new` RPC 是同一条路）。
     *
     * 用途：插件要把自己的界面（比如 whistle 的 Web UI）开在**这个环境的标签里**，
     * 而不是甩到系统浏览器。见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §4。
     */
    'browser.openTab': (url) => {
      deps.require('browser.navigate');
      const target = text(url);
      if (!target) throw Object.assign(new Error('openTab 需要 url'), { code: 'BAD_REQUEST' });
      return write(async (leaseId) => {
        deps.manager.assertWritable(env(), leaseId);
        return deps.manager.newTab(env(), target, {}, 'agent');
      });
    },
    /*
     * 这两条**不进表**：它们的数据来自 Telemetry，不是 controller 上的方法。
     * 放这里是为了让 browser.* 前缀在读者眼里仍然是完整的一组。
     */
    'browser.console': () => {
      deps.require('browser.dom.read');
      return deps.manager.consoleEntries(env());
    },
    'browser.network': () => {
      deps.require('network.observe');
      return deps.manager.networkEntries(env());
    },

    // ── Vault ───────────────────────────────────────────────────────
    'vault.listRefs': (provider) => {
      deps.require('environment.read');
      return deps.vault.list().filter((item) => !provider || item.provider === text(provider));
    },
    /**
     * 只把秘密填进页面字段，绝不返回明文。
     *
     * 和 RPC 的 `vault.fill` 共用同一段实现（`browser/fill-secret.ts`）：
     * 域名名单、后台输入准备、finally 摘除都只有一份。
     */
    'vault.fill': (ref, target, field) => {
      deps.require('vault.fill');
      deps.require('browser.input');
      return write(async (leaseId) => {
        deps.manager.assertWritable(env(), leaseId);
        const secret = deps.vault.reveal(text(ref));
        const key = (text(field) || 'password') as 'username' | 'password' | 'token' | 'totp';
        const value = secret[key];
        if (!value)
          throw Object.assign(new Error(`${ref} 没有 ${key}`), {
            code: 'CREDENTIAL_FIELD_MISSING',
          });
        await fillSecretInto(
          {
            manager: deps.manager,
            environmentId: env(),
            space: 'agent',
            controller: deps.manager.controllerFor(env(), undefined, 'agent'),
          },
          target,
          value,
        );
        return { filled: true, field: key };
      });
    },
    /**
     * 受控的「填一个秘密」通道：调用方自己持有值（账号插件的明文库），
     * 只把值送进页面字段，**不回传、不记日志、不进事件**。
     *
     * 权限挂 `vault.fill`（confirm 层）：语义就是「允许把秘密填进页面」，
     * 所以不再额外要 `browser.input` —— 再加一道只会让清单更长，不会更安全。
     *
     * 环境由调用方显式给（`environmentId`），这样插件可以为「不是当前上下文的那个环境」填；
     * 不给就退回到调用级上下文里的环境。
     */
    'browser.fillSecret': async (environmentId, target, value) => {
      deps.require('vault.fill');
      const id = text(environmentId) || env();
      const secret = text(value);
      if (!secret) throw Object.assign(new Error('fillSecret 需要非空的 value'), { code: 'PLUGIN_BAD_REQUEST' });
      return write(async (leaseId) => {
        deps.manager.assertWritable(id, leaseId);
        await fillSecretInto(
          {
            manager: deps.manager,
            environmentId: id,
            space: 'agent',
            controller: deps.manager.controllerFor(id, undefined, 'agent'),
          },
          target,
          secret,
        );
        // 只报「填了」，不带值
        return { filled: true };
      });
    },
    /**
     * 与 Vault 同一个打码规则（首字符 + 域名）。
     *
     * 存在的理由：sandbox 插件不能 import 主进程模块，但「打码规则」只能有一份。
     * 它只对调用方自己传进来的字符串做变换，不读任何存储，所以不要权限。
     */
    'vault.maskHint': (username) => maskHint(text(username)),

    // ── 存储 ────────────────────────────────────────────────────────
    'storage.kv.get': (key) => deps.storage.get(text(key)),
    'storage.kv.set': async (key, value) => {
      deps.require('storage.write');
      await deps.storage.set(text(key), value);
      return { ok: true };
    },
    'storage.kv.delete': async (key) => {
      deps.require('storage.write');
      return { deleted: await deps.storage.delete(text(key)) };
    },
    'storage.kv.list': (prefix) => deps.storage.list(prefix ? text(prefix) : ''),
    'storage.sql.exec': (sql) => {
      deps.require('storage.write');
      deps.storage.db().exec(text(sql));
      return { ok: true };
    },
    'storage.sql.run': (sql, params) => {
      deps.require('storage.write');
      const statement = deps.storage.db().prepare(text(sql));
      return statement.run(...(Array.isArray(params) ? (params as never[]) : []));
    },
    'storage.sql.query': (sql, params) => {
      const statement = deps.storage.db().prepare(text(sql));
      return statement.all(...(Array.isArray(params) ? (params as never[]) : []));
    },
    'storage.sql.migrate': (statements) => {
      deps.require('storage.write');
      if (!Array.isArray(statements)) {
        throw Object.assign(new Error('migrate 需要字符串数组'), { code: 'PLUGIN_BAD_REQUEST' });
      }
      return { applied: deps.storage.migrate(statements.map(text)) };
    },

    // ── 设置 ────────────────────────────────────────────────────────
    'settings.get': () => deps.settings.get(deps.descriptors),
  };
}

/** 把 `a.b.c` 形状的处理器表变成嵌套对象，给 sandbox 运行时用。 */
export function buildHostApi(handlers: Record<string, HostHandler>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, handler] of Object.entries(handlers)) {
    const parts = path.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const next = (node[part] ??= {}) as Record<string, unknown>;
      node = next;
    }
    node[parts[parts.length - 1]] = handler;
  }
  return root;
}

/** 子进程来的调用：按路径查表。 */
export async function dispatchHostCall(
  handlers: Record<string, HostHandler>,
  path: string,
  args: unknown[],
): Promise<unknown> {
  const handler = handlers[path];
  if (!handler) {
    throw Object.assign(new Error(`未知的 host API: ${path}`), { code: 'PLUGIN_HOST_API_UNKNOWN' });
  }
  return handler(...(Array.isArray(args) ? args : []));
}
