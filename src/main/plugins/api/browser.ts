/**
 * 插件浏览器域 host API。
 */
import { fillSecretInto } from '../../browser/fill-secret.ts';
import type { BrowserController } from '../../browser/controller.ts';
import type { SpaceId } from '../../../shared/types.ts';
import type { CapabilityContext, CapabilitySpec } from './index.ts';

function optionSpaceOf(raw: unknown): SpaceId | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = (raw as { space?: unknown }).space;
  return s === 'person' || s === 'agent' ? s : undefined;
}

/**
 * 权威解析插件浏览器调用的目标 Space：
 * - `caller === 'agent'`：严格锁定 `'agent'`，显式传 `'person'` 直接拒绝（`SPACE_FORBIDDEN`）；
 * - `caller === 'ui'`：允许 `'person'` 或 `'agent'`，省略时跟随该环境当前激活 Space（默认 `'person'`）。
 */
function resolvePluginSpace(ctx: CapabilityContext, envId: string, requested?: SpaceId): SpaceId {
  if (ctx.caller() !== 'ui') {
    if (requested === 'person') {
      throw Object.assign(new Error('agent 通道禁止操作 Person Space'), { code: 'SPACE_FORBIDDEN' });
    }
    return 'agent';
  }
  if (requested) return requested;
  const current = ctx.deps.manager.get?.(envId)?.activeSpaceId;
  return current === 'agent' ? 'agent' : 'person';
}

function allowedDomainsOf(raw: unknown): string[] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const list = (raw as { allowedDomains?: unknown }).allowedDomains;
  if (!Array.isArray(list)) return undefined;
  const cleaned = list.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return cleaned.length ? cleaned : undefined;
}

function cdpRead(
  permission: 'browser.dom.read' | 'browser.screenshot',
  run: (c: BrowserController, args: unknown[]) => unknown,
  validate?: CapabilitySpec['validate'],
): CapabilitySpec {
  return {
    permission,
    validate,
    handler: ({ deps, env }, ...args) => run(deps.manager.controllerFor(env()), args),
  };
}

function cdpWrite(
  permission: 'browser.navigate' | 'browser.input',
  run: (c: BrowserController, args: unknown[]) => unknown,
): CapabilitySpec {
  return {
    permission,
    needsLease: true,
    handler: ({ deps, env }, ...args) => run(deps.manager.controllerFor(env()), args),
  };
}

export const browserCapabilities: Record<string, CapabilitySpec> = {
  // ── 读：页面观察 ────────────────────────────────────────────────
  'browser.url': cdpRead('browser.dom.read', (c) => c.currentUrl()),
  'browser.title': cdpRead('browser.dom.read', (c) => c.title()),
  'browser.info': {
    permission: 'browser.dom.read',
    handler: (ctx, environmentId, options) => {
      const id = ctx.text(environmentId) || ctx.env();
      const space = resolvePluginSpace(ctx, id, optionSpaceOf(options));
      return ctx.deps.manager.controllerFor(id, undefined, space).info();
    },
  },
  'browser.detectLoginFields': {
    permission: 'browser.dom.read',
    handler: (ctx, environmentId, options) => {
      const id = ctx.text(environmentId) || ctx.env();
      const space = resolvePluginSpace(ctx, id, optionSpaceOf(options));
      return ctx.deps.manager.controllerFor(id, undefined, space).detectLoginFields();
    },
  },
  'browser.events': cdpRead('browser.dom.read', (c) => c.events()),
  'browser.snapshot': cdpRead('browser.dom.read', async (c) => ({
    url: c.currentUrl(),
    title: await c.title(),
    nodes: await c.snapshot(),
  })),
  'browser.highlight': cdpRead('browser.dom.read', (c, [target]) => c.highlight(target as never)),
  'browser.screenshot': cdpRead('browser.screenshot', async (c, [options]) => c.screenshot((options ?? {}) as never)),

  // ── 读：等待 ────────────────────────────────────────────────────
  'browser.waitFor': cdpRead('browser.dom.read', (c, [p, o]) => c.waitFor(p as never, (o ?? {}) as never)),
  'browser.waitForSelector': cdpRead('browser.dom.read', (c, [t, o]) =>
    c.waitForSelector(t as never, (o ?? {}) as never),
  ),
  'browser.waitForURL': cdpRead('browser.dom.read', (c, [m, o]) => c.waitForURL(m as never, (o ?? {}) as never)),
  'browser.waitForFunction': {
    permission: 'browser.dom.read',
    handler: ({ deps, env, text }, fn, arg, o) =>
      deps.manager.controllerFor(env()).waitForFunction(text(fn), arg, (o ?? {}) as never),
  },
  'browser.waitForLoadState': cdpRead('browser.dom.read', (c, [state, o]) =>
    c.waitForLoadState(state as never, (o ?? {}) as never),
  ),
  'browser.waitForTimeout': cdpRead(
    'browser.dom.read',
    (c, [ms]) => c.waitForTimeout(Number(ms)),
    (_ctx, [ms]) => {
      const value = Number(ms);
      if (!Number.isFinite(value) || value < 0) {
        throw Object.assign(new Error('browser.waitForTimeout 需要非负毫秒数'), { code: 'PLUGIN_BAD_REQUEST' });
      }
    },
  ),
  'browser.waitForEvent': cdpRead('browser.dom.read', (c, [kind, o]) =>
    c.waitForEvent(kind as never, (o ?? {}) as never),
  ),

  // ── 写：导航 ────────────────────────────────────────────────────
  'browser.navigate': {
    permission: 'browser.navigate',
    needsLease: true,
    handler: ({ deps, env, text }, url) => deps.manager.controllerFor(env()).navigate(text(url)),
  },
  'browser.reload': cdpWrite('browser.navigate', (c, [o]) => c.reload((o ?? {}) as never)),
  'browser.goBack': cdpWrite('browser.navigate', (c) => {
    c.goBack();
    return c.navigationState();
  }),
  'browser.goForward': cdpWrite('browser.navigate', (c) => {
    c.goForward();
    return c.navigationState();
  }),

  // ── 写：页面动作 ────────────────────────────────────────────────
  'browser.click': {
    permission: 'browser.input',
    needsLease: (ctx, [_target, options]) => {
      const opts =
        options && typeof options === 'object' ? (options as { environmentId?: unknown; space?: unknown }) : {};
      const id = ctx.text(opts.environmentId) || ctx.env();
      const space = resolvePluginSpace(ctx, id, optionSpaceOf(opts));
      return ctx.caller() === 'ui' && space === 'person' ? false : id;
    },
    handler: (ctx, target, options) => {
      const opts =
        options && typeof options === 'object' ? (options as { environmentId?: unknown; space?: unknown }) : {};
      const id = ctx.text(opts.environmentId) || ctx.env();
      const space = resolvePluginSpace(ctx, id, optionSpaceOf(opts));
      return ctx.deps.manager.controllerFor(id, undefined, space).click(target as never, (options ?? {}) as never);
    },
  },
  'browser.dblclick': cdpWrite('browser.input', (c, [t, o]) => c.dblclick(t as never, (o ?? {}) as never)),
  'browser.hover': cdpWrite('browser.input', (c, [t, o]) => c.hover(t as never, (o ?? {}) as never)),
  'browser.drag': cdpWrite('browser.input', (c, [s, t, o]) => c.drag(s as never, t as never, (o ?? {}) as never)),
  'browser.fill': {
    permission: 'browser.input',
    needsLease: true,
    handler: ({ deps, env, text }, t, v, o) =>
      deps.manager.controllerFor(env()).fill(t as never, text(v), (o ?? {}) as never),
  },
  'browser.selectOption': cdpWrite('browser.input', (c, [t, v, o]) =>
    c.selectOption(t as never, v as never, (o ?? {}) as never),
  ),
  'browser.focus': cdpWrite('browser.input', (c, [t, o]) => c.focus(t as never, (o ?? {}) as never)),
  'browser.press': {
    permission: 'browser.input',
    needsLease: true,
    handler: ({ deps, env, text }, k) => deps.manager.controllerFor(env()).press(text(k) as never),
  },
  'browser.setInputFiles': cdpWrite('browser.input', (c, [t, paths]) => c.setInputFiles(t as never, paths as never)),

  // ── 写：弹框 ────────────────────────────────────────────────────
  'browser.acceptDialog': {
    permission: 'browser.input',
    needsLease: true,
    handler: ({ deps, env, text }, prompt) =>
      deps.manager.controllerFor(env()).acceptDialog(prompt === undefined ? undefined : text(prompt)),
  },
  'browser.dismissDialog': cdpWrite('browser.input', (c) => c.dismissDialog()),

  // ── Tab / 遥测 / 受控秘密填充 ───────────────────────────────────
  'browser.openTab': {
    permission: 'browser.navigate',
    needsLease: (ctx, [_url, options]) => {
      const opts =
        options && typeof options === 'object' ? (options as { environmentId?: unknown; space?: unknown }) : {};
      const id = ctx.text(opts.environmentId) || ctx.env();
      const space = resolvePluginSpace(ctx, id, optionSpaceOf(opts));
      return ctx.caller() === 'ui' && space === 'person' ? false : id;
    },
    validate: ({ text }, [url]) => {
      if (!text(url)) throw Object.assign(new Error('openTab 需要 url'), { code: 'BAD_REQUEST' });
    },
    handler: (ctx, url, options) => {
      const opts =
        options && typeof options === 'object'
          ? (options as { environmentId?: unknown; space?: unknown; activate?: unknown })
          : {};
      const id = ctx.text(opts.environmentId) || ctx.env();
      const space = resolvePluginSpace(ctx, id, optionSpaceOf(opts));
      return ctx.deps.manager.newTab(id, ctx.text(url), { activate: opts.activate !== false }, space);
    },
  },
  'browser.console': {
    permission: 'browser.dom.read',
    handler: ({ deps, env }) => deps.manager.consoleEntries(env()),
  },
  'browser.fillSecret': {
    permission: 'vault.fill',
    needsLease: (ctx, [environmentId, _target, _value, options]) => {
      const id = ctx.text(environmentId) || ctx.env();
      const space = resolvePluginSpace(ctx, id, optionSpaceOf(options));
      // 仅当调用方是主进程认证的 ui 且目标为 Person Space 时免 Agent lease
      return ctx.caller() === 'ui' && space === 'person' ? false : id;
    },
    validate: ({ text }, [_environmentId, _target, value]) => {
      if (!text(value)) throw Object.assign(new Error('fillSecret 需要非空的 value'), { code: 'PLUGIN_BAD_REQUEST' });
    },
    handler: async (ctx, environmentId, target, value, options) => {
      const id = ctx.text(environmentId) || ctx.env();
      const space = resolvePluginSpace(ctx, id, optionSpaceOf(options));
      const secret = ctx.text(value);
      const allowedDomains = allowedDomainsOf(options);
      await fillSecretInto(
        {
          manager: ctx.deps.manager,
          environmentId: id,
          space,
          controller: ctx.deps.manager.controllerFor(id, undefined, space),
        },
        target,
        secret,
        {
          allowedDomains,
          onDenied: (host) => {
            ctx.deps.record('plugin.fillDenied', `凭据不允许填入 ${host || '当前页面'}`);
          },
        },
      );
      return { filled: true, space };
    },
  },
};
