/**
 * Whistle 预设的纯逻辑层。
 *
 * 这个文件**不碰 Electron、不碰网络、不碰文件**，所以 tests 可以直接加载：
 * - composePreset: 变量替换 + 层合成 + 冲突检查
 * - importRulesText: 把现有 Whistle 文本分类成可编辑的 draft
 * - validateRulesText: 给人看的规则文本校验
 * - diffRules: 当前规则 vs 目标规则
 *
 * 规则的事实来源仍然是 Whistle 自己；这里只负责“生成、校验、解释”，
 * 不负责真正写入实例。
 */
import { createHash } from 'node:crypto';

export const PRESET_SCHEMA_VERSION = 1;

const LAYER_ORDER = {
  envOperator: 10,
  bypass: 20,
  direct: 30,
  hostRewrite: 40,
  backendMap: 50,
  cdnMap: 60,
  cdnPreview: 70,
  cdnPin: 80,
  localAssets: 90,
  localStaticOnly: 95,
  mock: 100,
  raw: 110,
};

const VARIABLE_TYPES = new Set(['string', 'number', 'boolean', 'enum', 'ip', 'host', 'port', 'url']);
const STORAGE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

export function splitRuleLines(text) {
  return normalizeText(text)
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line) => line.length > 0);
}

export function isComment(line) {
  return /^\s*#/.test(line);
}

export function stripComments(text) {
  return normalizeText(text)
    .split('\n')
    .filter((line) => line.trim() && !isComment(line))
    .join('\n');
}

function issue(errors, warnings, level, message, line) {
  const item = { level, message, ...(line === undefined ? {} : { line }) };
  if (level === 'error') errors.push(item);
  else warnings.push(item);
}

function hostLooksValid(host) {
  return (
    typeof host === 'string' && host.length > 0 && host.length <= 253 && !/[\s/\\]/.test(host) && !host.includes('://')
  );
}

function sourcePatternLooksValid(value) {
  return typeof value === 'string' && value.length > 0 && !/\s|\\/.test(value);
}

function targetLooksValid(value) {
  if (typeof value !== 'string' || !value || /\s/.test(value)) return false;
  if (ipLooksValid(value)) return true;
  return hostLooksValid(value.replace(/:\d+$/, ''));
}

function ipLooksValid(value) {
  const text = String(value);
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?$/.exec(text);
  return Boolean(match && match.slice(1, 5).every((part) => Number(part) >= 0 && Number(part) <= 255));
}

function validateVariableValue(descriptor, value) {
  const type = descriptor?.type ?? 'string';
  if (!VARIABLE_TYPES.has(type)) return `未知变量类型 ${type}`;
  if (value === undefined || value === null || value === '') {
    return descriptor?.required ? '不能为空' : null;
  }
  if (type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return '必须是数字';
    if (descriptor.min !== undefined && n < descriptor.min) return `不能小于 ${descriptor.min}`;
    if (descriptor.max !== undefined && n > descriptor.max) return `不能大于 ${descriptor.max}`;
  }
  if (type === 'port') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return '必须是 1..65535 的整数';
  }
  if (type === 'boolean' && !['true', 'false', true, false].includes(value)) return '必须是 true/false';
  if (type === 'ip' && !ipLooksValid(value)) return '必须是 IPv4 或 IPv4:端口';
  if (type === 'host' && !hostLooksValid(String(value))) return '必须是 host（不能带 scheme/path）';
  if (type === 'url') {
    try {
      const url = new URL(String(value));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '只允许 http/https';
    } catch {
      return 'URL 非法';
    }
  }
  if (type === 'enum' && Array.isArray(descriptor.options) && !descriptor.options.includes(String(value))) {
    return `必须属于 ${descriptor.options.join(' / ')}`;
  }
  if (type === 'string' && /[\r\n]/.test(String(value))) return '不能包含换行（会注入新规则）';
  return null;
}

function resolveVariables(text, variables, unresolved) {
  return String(text ?? '').replace(/\{\{\s*([a-zA-Z][\w-]*)\s*\}\}/g, (whole, name) => {
    if (!(name in variables)) {
      unresolved.add(name);
      return whole;
    }
    const value = variables[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

function layerLines(layer, variables, unresolved) {
  const rendered = [];
  const rules = layer.rules;
  if (typeof rules === 'string') {
    rendered.push(...splitRuleLines(resolveVariables(rules, variables, unresolved)));
  } else if (Array.isArray(rules)) {
    for (const line of rules) rendered.push(...splitRuleLines(resolveVariables(line, variables, unresolved)));
  }
  if (['backendMap', 'cdnMap', 'cdnPreview'].includes(layer.kind) && Array.isArray(layer.hosts)) {
    const target = resolveVariables(layer.target ?? '', variables, unresolved);
    for (const host of layer.hosts) {
      const source = resolveVariables(host, variables, unresolved);
      rendered.push(`${target} ${source}`.trim());
    }
  }
  if (layer.kind === 'hostRewrite' && Array.isArray(layer.rewrites)) {
    for (const item of layer.rewrites) {
      if (typeof item === 'string') rendered.push(resolveVariables(item, variables, unresolved));
      else if (item && typeof item === 'object') {
        rendered.push(
          `${resolveVariables(item.to, variables, unresolved)} ${resolveVariables(item.from, variables, unresolved)}`.trim(),
        );
      }
    }
  }
  if (layer.kind === 'direct' && Array.isArray(layer.paths)) {
    const target = resolveVariables(layer.target ?? '', variables, unresolved);
    for (const path of layer.paths) {
      const source = resolveVariables(path, variables, unresolved);
      rendered.push(`${source} ${target}`.trim());
    }
  }
  return rendered;
}

function variableNamesInLayer(layer) {
  const names = new Set();
  const collect = (value) => {
    String(value ?? '').replace(/\{\{\s*([a-zA-Z][\w-]*)\s*\}\}/g, (_whole, name) => {
      names.add(name);
      return _whole;
    });
  };
  if (typeof layer.rules === 'string') collect(layer.rules);
  else if (Array.isArray(layer.rules)) layer.rules.forEach(collect);
  collect(layer.target);
  if (Array.isArray(layer.hosts)) layer.hosts.forEach(collect);
  if (Array.isArray(layer.paths)) layer.paths.forEach(collect);
  if (Array.isArray(layer.rewrites)) {
    for (const item of layer.rewrites) {
      if (typeof item === 'string') collect(item);
      else if (item && typeof item === 'object') {
        collect(item.from);
        collect(item.to);
      }
    }
  }
  return names;
}

/**
 * 场景不是另一份规则文本，而是对「哪些层启用」的显式选择。
 *
 * 把这张表放在预设逻辑层，CLI / UI / 测试读的是同一份事实，避免
 * 「线上验证要勾预发布、测试环境要再勾测试、预览要取消本地」靠人记忆。
 */
export const SCENARIOS = {
  online: {
    id: 'online',
    name: '线上验证',
    description: '正式环境；仅勾选预发布 CDN，不叠加测试后端或本地静态资源。',
    layers: {
      'cdn-preview': true,
      'corporate-proxy': false,
      backend: false,
      'local-console': false,
      'local-trtc-intl': false,
      'local-buy': false,
    },
  },
  test: {
    id: 'test',
    name: '测试环境',
    description: '只选择后端与预发布层；具体预设由用户导入并显式选择。',
    layers: {
      'cdn-preview': true,
      'corporate-proxy': false,
      backend: true,
      'local-console': false,
      'local-trtc-intl': false,
      'local-buy': false,
    },
  },
  local: {
    id: 'local',
    name: '本地验证',
    description: '后端、预发布 CDN 与本地静态资源都可选；真实预设由用户导入。',
    layers: {
      'cdn-preview': true,
      'corporate-proxy': false,
      backend: true,
      'local-console': false,
      'local-trtc-intl': false,
      'local-buy': false,
    },
  },
  preview: {
    id: 'preview',
    name: '预览验证',
    description: '预发布 CDN；明确关闭本地静态资源替换，避免预览被本地文件污染。',
    layers: {
      'cdn-preview': true,
      'corporate-proxy': false,
      backend: false,
      'local-console': false,
      'local-trtc-intl': false,
      'local-buy': false,
    },
  },
};

export function scenarioLayers(id) {
  const scenario = SCENARIOS[id];
  if (!scenario) throw new Error(`未知场景 ${id}`);
  return { ...scenario.layers };
}

export function scenarioPresetIds(id) {
  const scenario = SCENARIOS[id];
  if (!scenario) throw new Error(`未知场景 ${id}`);
  return [...(scenario.presetIds ?? [])];
}

/**
 * 静态资源扩展名白名单（小写，按构建产物实际写法）。
 *
 * **不含 `html` / `htm` / `json`**：document 请求与 XHR/POST 不在这张表里，
 * 所以它们天然落到测试后端。审计 thr_8dnz423kwq 的 `/order/check` 主表单 POST
 * 被本地端口接走成 502，根因就是「不分资源类型地整站映到本地」。
 */
export const STATIC_ASSET_EXTENSIONS = [
  'js',
  'mjs',
  'css',
  'map',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 生成 whistle 正则：`/^https?:\/\/<host>\/<path>\.(?:js|css|...)(?:[?#]|$)/`
 *
 * - 给了 host 就锚定该 host，避免把别的站点的静态资源也接到本地 dev server；
 * - 结尾允许 `?query` / `#hash`（审计里 `im-buy.zh.<hash>.js?max_age=...` 是真实形态）；
 * - 不锚定 `$` 到整串末尾，`.../app.js?x=1` 也算命中。
 */
export function staticAssetPattern(options = {}) {
  return `/${staticAssetBody(options)}/`;
}

function staticAssetBody(options = {}) {
  const host = typeof options.host === 'string' ? options.host.trim() : '';
  const kinds = [
    ...new Set((options.extensions ?? STATIC_ASSET_EXTENSIONS).map((item) => String(item).replace(/^\./, '').trim())),
  ].filter(Boolean);
  if (!kinds.length) throw new Error('local-static-only 的扩展名列表不能为空');
  const suffix = `\\.(?:${kinds.join('|')})(?:[?#]|$)`;
  return host ? `^https?:\\/\\/${escapeRegExp(host)}\\/[^?#]*${suffix}` : suffix;
}

/** 同一个 pattern 的 JS 视图：测试与文档用它对 URL 判定分流，避免另写一份匹配逻辑。 */
export function staticAssetMatcher(options = {}) {
  const regex = new RegExp(staticAssetBody(options));
  return (url) => regex.test(String(url));
}

/**
 * `local-static-only` 层：本地端口只承接静态资源。
 *
 * 默认关闭（只有显式传 `staticOnly` 才会被 appendStaticOnlyLayer 加进预设），
 * 这样老预设的行为不变。
 */
export function localStaticOnlyLayer(options = {}) {
  const localPort = Number(options.localPort);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error('local-static-only 需要 localPort（1..65535）');
  }
  const host = typeof options.host === 'string' ? options.host.trim() : '';
  return {
    id: String(options.id || 'local-static-only'),
    kind: 'localStaticOnly',
    enabled: options.enabled !== false,
    rules: [
      '# local-static-only: 只承接 js/css/字体/图片；document 与 POST 不命中，直达测试后端',
      `${staticAssetPattern({ host, extensions: options.extensions })} http://127.0.0.1:${localPort}`,
    ],
  };
}

/** 把静态资源层追加进预设定义；同 id 层替换而不是重复叠加。 */
export function appendStaticOnlyLayer(definition, options = {}) {
  const layer = localStaticOnlyLayer(options);
  const layers = Array.isArray(definition?.layers) ? [...definition.layers] : [];
  const index = layers.findIndex((item) => item && item.id === layer.id);
  if (index >= 0) layers[index] = layer;
  else layers.push(layer);
  return { ...definition, layers };
}

/**
 * 本地端口不能是预设常量：同一个预设会被不同 worktree / dev server 复用。
 * 这里只在调用方没有显式传 variables 时，从“目标 URL”里取 loopback 端口。
 * 不把线上控制台 URL 当成 dev server，也不按语言猜 8323/8324。
 */
export function variablesFromLocalUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return {};
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return {};
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) return {};
  const port = Number(parsed.port);
  return Number.isInteger(port) && port > 0 ? { localPort: port } : {};
}

export function resolvePresetVariables(definition, options = {}) {
  const definitions = Array.isArray(definition) ? definition : [definition];
  const fromUrl = variablesFromLocalUrl(options.localUrl);
  const merged = {};
  const portNames = [];
  for (const item of definitions) {
    for (const [name, descriptor] of Object.entries(item?.variables ?? {})) {
      // Runtime-resolved variables (ports, environment IPs) must not become
      // `undefined` keys: that bypasses the composer's "missing variable"
      // validation. Only materialize an actual default value.
      if (descriptor?.default !== undefined) merged[name] = descriptor.default;
      if (descriptor?.type === 'port') portNames.push(name);
    }
  }
  Object.assign(merged, options.variables ?? {});
  for (const name of portNames) {
    if (
      fromUrl.localPort !== undefined &&
      (merged[name] === undefined || merged[name] === null || merged[name] === '')
    ) {
      merged[name] = fromUrl.localPort;
    }
  }
  return merged;
}

function classifyRuleLine(line) {
  const raw = String(line);
  const text = raw.trim();
  if (!text) return 'empty';
  if (isComment(text)) return 'comment';
  if (/\b(?:file|resBody|reqBody|statusCode|ignore|excludeFilter|enable)::\/\//.test(text)) return 'operator';
  const parts = text.split(/\s+/);
  if (parts.length === 2 && targetLooksValid(parts[0]) && hostLooksValid(parts[1])) return 'hostMap';
  if (parts.length === 2 && sourcePatternLooksValid(parts[0]) && sourcePatternLooksValid(parts[1])) {
    return 'hostRewrite';
  }
  if (text.startsWith('/') || text.startsWith('//')) return 'urlRule';
  return 'raw';
}

function checkLayerConflicts(sections, errors, warnings) {
  const hostTargets = new Map();
  const localPorts = new Map();
  for (const section of sections) {
    for (const line of section.lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && targetLooksValid(parts[0]) && sourcePatternLooksValid(parts[1])) {
        const target = parts[0];
        const host = parts[1].split('/')[0];
        const previous = hostTargets.get(host);
        if (previous && previous !== target) {
          issue(errors, warnings, 'error', `host ${host} 同时映射到 ${previous} 和 ${target}`, section.id);
        } else {
          hostTargets.set(host, target);
        }
      }
      const local = /127\.0\.0\.1:(\d+)\s*$/.exec(line);
      if (local && section.kind === 'localAssets') {
        const previous = localPorts.get(section.id);
        if (previous && previous !== local[1]) {
          issue(errors, warnings, 'warning', `层 ${section.id} 同时指向多个本地端口：${previous} / ${local[1]}`);
        } else {
          localPorts.set(section.id, local[1]);
        }
      }
      if (/(?:^|\s)ignore:\/\/\*/.test(line)) {
        issue(errors, warnings, 'warning', `层 ${section.id} 含宽泛 ignore://*，可能吞掉订单/登录请求`);
      }
      if (/enable:\/\/proxyHost/.test(line)) {
        issue(errors, warnings, 'warning', `层 ${section.id} 会启用 proxyHost，请确认这是 iOA 场景`);
      }
      if (/file:\/\//.test(line) && !/file:\/\/\/.*(?:whistle|mocks?|warren)/i.test(line)) {
        issue(errors, warnings, 'warning', `层 ${section.id} 含外部 file:// 路径，需要显式确认`);
      }
    }
  }
}

/**
 * host 映射的确定性覆盖：同一 host 只保留最后一个目标。
 *
 * 场景组合（测试后端 + 预发布 CDN）会天然重叠，规则顺序已由 LAYER_ORDER
 * 固定；这里把后者覆盖前者显式落到文本里，避免 Whistle 匹配顺序变化导致
 * API 和静态资源随机走错环境。
 */
function preferLaterHostMaps(sections) {
  const seen = new Map();
  for (const section of sections) {
    section.lines = section.lines.map((line, index) => {
      const parts = line.split(/\s+/);
      if (parts.length < 2 || !targetLooksValid(parts[0]) || !sourcePatternLooksValid(parts[1])) return line;
      const host = parts[1].split('/')[0];
      const previous = seen.get(host);
      if (previous) previous.section.lines[previous.index] = null;
      seen.set(host, { section, index, target: parts[0] });
      return line;
    });
  }
  for (const section of sections) section.lines = section.lines.filter((line) => line !== null);
}

export function validatePreset(definition) {
  const errors = [];
  const warnings = [];
  const preset = definition && typeof definition === 'object' ? definition : {};
  if (preset.schemaVersion !== PRESET_SCHEMA_VERSION) {
    issue(errors, warnings, 'error', `schemaVersion 必须是 ${PRESET_SCHEMA_VERSION}`);
  }
  if (typeof preset.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(preset.id)) {
    issue(errors, warnings, 'error', 'id 必须是小写字母/数字/点/下划线/连字符');
  }
  if (!preset.name || typeof preset.name !== 'string') issue(errors, warnings, 'error', 'name 必填');
  if (!Array.isArray(preset.layers) || preset.layers.length === 0) {
    issue(errors, warnings, 'error', 'layers 必须是非空数组');
  }
  const variables = preset.variables && typeof preset.variables === 'object' ? preset.variables : {};
  for (const [name, descriptor] of Object.entries(variables)) {
    if (!/^[a-zA-Z][\w-]*$/.test(name)) issue(errors, warnings, 'error', `变量名非法: ${name}`);
    if (!descriptor || typeof descriptor !== 'object') {
      issue(errors, warnings, 'error', `变量 ${name} 的描述必须是对象`);
      continue;
    }
    if (!VARIABLE_TYPES.has(descriptor.type)) {
      issue(errors, warnings, 'error', `变量 ${name} 的 type 非法`);
    }
    // required 的运行时变量（例如本地端口）合理地没有默认值；
    // 真正的缺失在 composePreset 的变量校验里报错。
  }
  const ids = new Set();
  for (const layer of Array.isArray(preset.layers) ? preset.layers : []) {
    if (!layer || typeof layer !== 'object') {
      issue(errors, warnings, 'error', 'layer 必须是对象');
      continue;
    }
    if (!layer.id || ids.has(layer.id)) issue(errors, warnings, 'error', `layer id 缺失或重复: ${layer.id}`);
    ids.add(layer.id);
    if (!Object.hasOwn(LAYER_ORDER, layer.kind)) issue(errors, warnings, 'error', `未知 layer kind: ${layer.kind}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function composePreset(definition, options = {}) {
  const errors = [];
  const warnings = [];
  const unresolved = new Set();
  const validation = validatePreset(definition);
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);
  const variableDefinitions =
    definition?.variables && typeof definition.variables === 'object' ? definition.variables : {};
  const variables = {};
  for (const [name, descriptor] of Object.entries(variableDefinitions)) {
    if (descriptor && typeof descriptor === 'object' && descriptor.default !== undefined) {
      variables[name] = descriptor.default;
    }
  }
  Object.assign(variables, options.variables ?? {});
  const selected = options.layers && typeof options.layers === 'object' ? options.layers : {};
  const sections = [];
  const allLines = [];
  const enabledVariables = new Set();
  const layers = Array.isArray(definition?.layers) ? [...definition.layers] : [];
  layers.sort((a, b) => (a.order ?? LAYER_ORDER[a.kind] ?? 1000) - (b.order ?? LAYER_ORDER[b.kind] ?? 1000));
  for (const layer of layers) {
    const enabled = selected[layer.id] === undefined ? layer.enabled !== false : Boolean(selected[layer.id]);
    if (!enabled) continue;
    for (const name of variableNamesInLayer(layer)) enabledVariables.add(name);
    const lines = layerLines(layer, variables, unresolved);
    if (!lines.length) continue;
    const section = { id: layer.id, kind: layer.kind, lines };
    sections.push(section);
  }
  if (options.conflictPolicy === 'prefer-later') preferLaterHostMaps(sections);
  for (const section of sections) {
    if (!section.lines.length) continue;
    allLines.push(`# ==== layer: ${section.id} (${section.kind}) ====`, ...section.lines);
  }
  if (unresolved.size) {
    issue(errors, warnings, 'error', `未解析变量：${[...unresolved].join(', ')}`);
  }
  for (const [name, descriptor] of Object.entries(variableDefinitions)) {
    if (!enabledVariables.has(name)) continue;
    const problem = validateVariableValue(descriptor, variables[name]);
    if (problem) issue(errors, warnings, 'error', `变量 ${name}: ${problem}`);
  }
  checkLayerConflicts(sections, errors, warnings);
  const rules = allLines.join('\n') + (allLines.length ? '\n' : '');
  const hash = sha256(rules);
  return {
    rules,
    hash,
    lineCount: allLines.length,
    charCount: rules.length,
    sections: sections.map((section) => ({ id: section.id, kind: section.kind, lines: section.lines.length })),
    errors,
    warnings,
    unresolvedVariables: [...unresolved],
  };
}

/**
 * 组合多个预设：后一个的同 id 层覆盖前一个，变量和基础信息取最后一个。
 * 这不是字符串拼接；每层仍是结构化定义，最后由 composePreset 统一渲染。
 */
export function mergePresets(definitions, options = {}) {
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new Error('mergePresets 需要非空预设数组');
  }
  const layers = new Map();
  const variables = {};
  for (const definition of definitions) {
    Object.assign(variables, definition.variables ?? {});
    for (const layer of definition.layers ?? []) {
      layers.set(layer.id, { ...layer });
    }
  }
  const last = definitions[definitions.length - 1];
  return {
    ...last,
    id: String(options.id || definitions.map((item) => item.id).join('.'))
      .replace(/[^a-z0-9._-]/gi, '-')
      .toLowerCase(),
    name: String(options.name || definitions.map((item) => item.name).join(' + ')),
    variables,
    layers: [...layers.values()],
  };
}

export function validateRulesText(text) {
  const errors = [];
  const warnings = [];
  const lines = splitRuleLines(text);
  for (const [index, line] of lines.entries()) {
    if (line.includes('\r')) issue(errors, warnings, 'error', '规则不能包含 CR', index + 1);
    if (classifyRuleLine(line) === 'raw') {
      issue(warnings, warnings, 'warning', `第 ${index + 1} 行无法结构化校验`, index + 1);
    }
  }
  if (/\{\{[^}]+\}\}/.test(text)) issue(errors, warnings, 'error', '仍有未解析变量 {{...}}');
  if (lines.some((line) => /ignore:\/\/\*/.test(line))) issue(errors, warnings, 'warning', '含宽泛 ignore://*');
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    lineCount: lines.length,
    charCount: normalizeText(text).length,
    hash: sha256(text),
  };
}

export function importRulesText(text, options = {}) {
  const lines = normalizeText(text).split('\n');
  const layers = [];
  const warnings = [];
  const errors = [];
  const buckets = new Map();
  for (const [index, raw] of lines.entries()) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const kind = classifyRuleLine(line);
    const target = kind === 'comment' || kind === 'empty' ? 'raw' : kind;
    if (!buckets.has(target)) buckets.set(target, []);
    buckets.get(target).push(line);
    if (kind === 'raw')
      warnings.push({ level: 'warning', message: `第 ${index + 1} 行无法分类，保留在 raw 层`, line: index + 1 });
  }
  const kindMap = {
    hostMap: 'backendMap',
    hostRewrite: 'hostRewrite',
    urlRule: 'raw',
    operator: 'raw',
    raw: 'raw',
  };
  for (const [kind, bucket] of buckets) {
    const mapped = kindMap[kind] ?? 'raw';
    layers.push({
      id: `${mapped}-${layers.length + 1}`,
      kind: mapped,
      enabled: true,
      rules: bucket,
    });
  }
  const id = String(options.id || 'imported')
    .replace(/[^a-z0-9._-]/gi, '-')
    .toLowerCase();
  const draft = {
    schemaVersion: PRESET_SCHEMA_VERSION,
    id,
    name: String(options.name || `导入的规则 ${new Date().toISOString().slice(0, 10)}`),
    category: String(options.category || '导入'),
    description: String(options.description || ''),
    builtin: false,
    draft: true,
    variables: {},
    layers,
  };
  return { ok: errors.length === 0, draft, errors, warnings, lineCount: lines.filter((line) => line.trim()).length };
}

export function diffRules(before, after) {
  const a = normalizeText(before).split('\n');
  const b = normalizeText(after).split('\n');
  const setA = new Map();
  const setB = new Map();
  for (const line of a) if (line.trim()) setA.set(line, (setA.get(line) ?? 0) + 1);
  for (const line of b) if (line.trim()) setB.set(line, (setB.get(line) ?? 0) + 1);
  const added = [];
  const removed = [];
  for (const [line, count] of setB) {
    const old = setA.get(line) ?? 0;
    for (let i = old; i < count; i += 1) added.push(line);
  }
  for (const [line, count] of setA) {
    const next = setB.get(line) ?? 0;
    for (let i = next; i < count; i += 1) removed.push(line);
  }
  return {
    same: sha256(before) === sha256(after),
    beforeHash: sha256(before),
    afterHash: sha256(after),
    added,
    removed,
  };
}

export function isValidStorage(storage) {
  return STORAGE_ID_RE.test(String(storage ?? ''));
}

export const PRESET_LAYER_ORDER = LAYER_ORDER;
