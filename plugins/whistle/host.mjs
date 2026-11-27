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
import { readFrames, readRule, rulesView, statusOf } from './lib/w2-client.mjs';
import { fail } from './lib/shared.mjs';

const withFallbackEnv = (ctx, input) => ({
  ...input,
  environmentId: (input && input.environmentId) || ctx.environmentId,
});

const COMMANDS = {
  list: (host) => listInstances(host),
  fork: (host, input) => forkInstance(host, input),
  start: (host, input) => startInstance(host, input),
  stop: (host, input) => stopInstance(host, input),
  remove: (host, input) => removeInstance(host, input),
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
  traffic: (host, input) => traffic(host, input),
  compose: (host, input) => compose(host, input),
  replay: (host, input) => replay(host, input),
  toCurl: (host, input) => toCurl(host, input),
  captureLink: (host, input, ctx) => captureLink(host, withFallbackEnv(ctx, input)),
  doctor: (host, input) => doctor(host, input),
  agent: (host, input) => agent(host, input),
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
  export: (host, input) => exportData(host, input),
};

let reconcileController = null;

/** @type {Record<string, any> & { activate: (ctx: any) => Promise<void>; dispose: () => Promise<void>; rpc: Record<string, any> }} */
const plugin = {
  async activate(ctx) {
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
  async dispose() {
    reconcileController?.abort();
    reconcileController = null;
  },
  rpc: {},
};

for (const [name, handler] of Object.entries(COMMANDS)) {
  plugin[name] = (ctx) => handler(ctx.host, ctx.input, ctx);
  plugin.rpc[name] = (input, ctx) => handler(ctx.host, input, ctx);
}

export default plugin;
