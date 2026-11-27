/**
 * Whistle 代理插件后端入口（`runtime: "host"`）。
 * 所有领域实现拆于 `lib/*.mjs`；命令与前端 RPC 共享同一份 `COMMANDS` 派发表，确保永不漂移。
 */
import { SCENARIOS } from './presets.mjs';
import {
  bindEnvironment,
  forkInstance,
  listInstances,
  openBound,
  reconcileInstances,
  removeInstance,
  startInstance,
  stopInstance,
  unbindEnvironment,
} from './lib/instances.mjs';
import {
  applyPreset,
  clearDnsCache,
  clearIntents,
  clearProfile,
  deletePreset,
  ensurePresetSchema,
  exportPreset,
  getPreset,
  getProfile,
  importPreset,
  injectFault,
  listPresets,
  mapLocal,
  previewPreset,
  quickMock,
  removeRule,
  ruleDiff,
  ruleTest,
  ruleValidate,
  savePreset,
  setRule,
  toggleRule,
  valueGet,
  valueList,
  valueRemove,
  valueRename,
  valueSet,
} from './lib/rules-presets.mjs';
import { RULE_NAME, readInstances, requireInstance } from './lib/shared.mjs';
import {
  agent,
  agentStatus,
  captureLink,
  compose,
  doctor,
  exportData,
  replay,
  toCurl,
  traffic,
} from './lib/traffic.mjs';
import { readFrames, readRule, resolveW2, rulesView, runW2, statusOf, whistleEnv } from './lib/w2-client.mjs';
import { fail } from './lib/shared.mjs';

const withFallbackEnv = (ctx, input) => ({
  ...input,
  environmentId: (input && input.environmentId) || ctx.environmentId,
});

/** 仅 UI 通道允许关闭流量脱敏；Agent 通道强制脱敏以守住凭据与 Cookie 边界。 */
const sanitizeTrafficInput = (ctx, input) => {
  if (ctx?.caller === 'ui') return input;
  if (!input || typeof input !== 'object') return input;
  if (!input.includeSensitive) return input;
  return { ...input, includeSensitive: false };
};

const managedStorages = new Set();
let activeHost = null;

const COMMANDS = {
  list: (host) => listInstances(host),
  fork: async (host, input) => {
    const res = await forkInstance(host, input);
    if (res?.created?.storage) managedStorages.add(res.created.storage);
    return res;
  },
  start: async (host, input) => {
    const res = await startInstance(host, input);
    if (res?.started?.storage && !res.started.alreadyRunning) managedStorages.add(res.started.storage);
    return res;
  },
  stop: async (host, input) => {
    const res = await stopInstance(host, input);
    if (input?.storage) managedStorages.delete(String(input.storage).trim());
    return res;
  },
  remove: async (host, input) => {
    const res = await removeInstance(host, input);
    if (input?.storage) managedStorages.delete(String(input.storage).trim());
    return res;
  },
  bind: (host, input, ctx) =>
    bindEnvironment(host, { ...input, environmentId: input?.environmentId ?? ctx.environmentId }),
  unbind: (host, input, ctx) => unbindEnvironment(host, { environmentId: ctx.environmentId, ...input }),
  open: (host, input, ctx) => openBound(host, input?.environmentId ?? ctx.environmentId),
  rules: (host, input) => rulesView(host, input),
  ruleSet: (host, input) => setRule(host, input),
  ruleToggle: (host, input) => toggleRule(host, input),
  ruleRemove: (host, input) => removeRule(host, input),
  presetList: async (host) => ({ presets: await listPresets(host), scenarios: Object.values(SCENARIOS) }),
  presetGet: (host, input) => getPreset(host, input),
  presetPreview: (host, input) => previewPreset(host, input),
  presetApply: (host, input) => applyPreset(host, input),
  presetSave: (host, input) => savePreset(host, input),
  presetDelete: (host, input) => deletePreset(host, input),
  presetImport: (host, input) => importPreset(host, input),
  presetExport: (host, input) => exportPreset(host, input),
  profileGet: (host, input) => getProfile(host, input),
  profileClear: (host, input) => clearProfile(host, input),
  ruleGet: async (host, input) => {
    const instance = await requireInstance(host, input && input.storage);
    const name = String((input && input.name) || RULE_NAME);
    return { rule: await readRule(instance.port, name) };
  },
  ruleValidate: (host, input) => ruleValidate(host, input),
  ruleDiff: (host, input) => ruleDiff(host, input),
  ruleTest: (host, input) => ruleTest(host, input),
  clearDnsCache: (host, input) => clearDnsCache(host, input),
  valueList: (host, input) => valueList(host, input),
  valueGet: (host, input) => valueGet(host, input),
  valueSet: (host, input) => valueSet(host, input),
  valueRemove: (host, input) => valueRemove(host, input),
  valueRename: (host, input) => valueRename(host, input),
  quickMock: (host, input) => quickMock(host, input),
  injectFault: (host, input) => injectFault(host, input),
  mapLocal: (host, input) => mapLocal(host, input),
  clearIntents: (host, input) => clearIntents(host, input),
  traffic: (host, input, ctx) => traffic(host, sanitizeTrafficInput(ctx, input)),
  compose: (host, input, ctx) => compose(host, sanitizeTrafficInput(ctx, input)),
  replay: (host, input, ctx) => replay(host, sanitizeTrafficInput(ctx, input)),
  toCurl: (host, input, ctx) => toCurl(host, sanitizeTrafficInput(ctx, input)),
  captureLink: (host, input, ctx) => captureLink(host, withFallbackEnv(ctx, input)),
  doctor: (host, input) => doctor(host, input),
  agent: (host, input, ctx) => agent(host, sanitizeTrafficInput(ctx, input), ctx),
  agentStatus: (host, input) => agentStatus(host, input),
  frames: async (host, input) => {
    const instance = await requireInstance(host, input && input.storage);
    if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
    return {
      storage: instance.storage,
      port: instance.port,
      ...(await readFrames(instance.port, input)),
    };
  },
  export: (host, input, ctx) => exportData(host, sanitizeTrafficInput(ctx, input)),
};

let reconcileController = null;

/** @type {Record<string, any> & { activate: (ctx: any) => Promise<void>; dispose: (ctx?: any) => Promise<void>; rpc: Record<string, any> }} */
const plugin = {
  async activate(ctx) {
    activeHost = ctx.host;
    await ensurePresetSchema(ctx.host);
    const instances = await readInstances(ctx.host);
    // 端口探活与多选规则补开下沉为后台异步对账，不阻塞 activate() 就绪与首次 RPC
    reconcileController?.abort();
    reconcileController = new AbortController();
    void reconcileInstances(ctx.host, {
      instances,
      signal: reconcileController.signal,
    }).catch(() => undefined);
    await ctx.host.log.info(`whistle 插件已就绪，登记了 ${instances.length} 个实例`);
  },
  async dispose(ctx) {
    reconcileController?.abort();
    reconcileController = null;
    const reason = ctx?.reason;
    // 热重载或插件升级时保留正在运行的 Whistle 代理实例，避免正在调试的环境连接中断
    if (reason === 'reload' || reason === 'update') {
      managedStorages.clear();
      activeHost = null;
      return;
    }
    const host = ctx?.host ?? activeHost;
    if (host && managedStorages.size > 0) {
      const storages = [...managedStorages];
      managedStorages.clear();
      try {
        const w2 = await resolveW2(host);
        const env = await whistleEnv(host);
        // 预算对齐宿主 DISPOSE_GRACE_MAX_MS（1500ms），避免强杀前未完成收尾
        await Promise.allSettled(storages.map((storage) => runW2(w2, ['stop', '-S', storage], env, 1200)));
      } catch {
        // 退出清理尽力而为，不阻塞进程退出
      }
    }
    activeHost = null;
  },
  rpc: {},
};

for (const [name, handler] of Object.entries(COMMANDS)) {
  plugin[name] = (ctx) => handler(ctx.host, ctx.input, ctx);
  plugin.rpc[name] = (input, ctx) => handler(ctx.host, input, ctx);
}

export default plugin;
