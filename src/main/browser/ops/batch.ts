import type { NetworkEntry, SiteNote, SnapshotResult, TargetInput } from '../../../shared/types.ts';
import { targetFromBy, type InspectProp, type InspectState } from './inspector.ts';
import { diffSnapshots, type SnapshotDiffResult } from './diff.ts';
import { readPage } from './reader.ts';
import { formatCompactSnapshot } from './snapshot-compact.ts';

export type BatchStep =
  | { cmd: 'goto' | 'open'; url: string }
  | { cmd: 'back' | 'forward' | 'reload' }
  | { cmd: 'click' | 'dblclick' | 'hover' | 'focus' | 'check' | 'uncheck' | 'scrollintoview'; target: TargetInput }
  | { cmd: 'fill' | 'type'; target: TargetInput; value: string; submit?: boolean }
  | { cmd: 'press'; target?: TargetInput; key: string }
  | { cmd: 'select'; target: TargetInput; value: string }
  | { cmd: 'scroll'; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; target?: TargetInput }
  | {
      cmd: 'wait';
      ms?: number;
      selector?: string;
      text?: string;
      url?: string;
      loadState?: 'load' | 'domcontentloaded' | 'networkidle';
    }
  | { cmd: 'dialog'; action: 'accept' | 'dismiss'; prompt?: string }
  | { cmd: 'upload'; target: TargetInput; files: string[] }
  | { cmd: 'find'; by: string; spec: string; action: string; value?: string; name?: string; attr?: string }
  | { cmd: 'frame'; target: string }
  | { cmd: 'eval'; expr: string }
  | { cmd: 'screenshot'; path?: string; fullPage?: boolean; annotate?: boolean }
  | { cmd: 'snapshot'; interactive?: boolean; urls?: boolean; filter?: string; maxDepth?: number }
  | {
      cmd: 'read';
      selector?: string;
      data?: boolean;
      links?: boolean | string;
      scroll?: boolean;
      outline?: boolean;
      filter?: string;
    }
  | { cmd: 'get'; prop: InspectProp; target?: TargetInput; attr?: string }
  | { cmd: 'is'; state: InspectState; target: TargetInput }
  | { cmd: 'note'; action: 'get' | 'set' | 'append'; site: string; text?: string };

export interface BatchStepResult {
  step: number;
  cmd: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface BatchDeltaReceipt {
  urlChanged: boolean;
  titleChanged: boolean;
  url: string;
  title: string;
  events: unknown[];
  networkSummary: string[];
  interactiveDelta: SnapshotDiffResult;
}

export interface BatchClient {
  currentUrl(): string;
  title(): Promise<string>;
  navigate(url: string): Promise<unknown>;
  goBack(): void;
  goForward(): void;
  reload(): Promise<unknown>;
  click(target: TargetInput): Promise<unknown>;
  dblclick(target: TargetInput): Promise<unknown>;
  hover(target: TargetInput): Promise<unknown>;
  focus(target: TargetInput): Promise<unknown>;
  fill(target: TargetInput, value: string, opts?: { submit?: boolean }): Promise<unknown>;
  selectOption(target: TargetInput, value: string): Promise<unknown>;
  press(target: string | TargetInput, chord?: string): Promise<unknown>;
  check?(target: TargetInput): Promise<unknown>;
  uncheck?(target: TargetInput): Promise<unknown>;
  setInputFiles?(target: TargetInput, files: string | string[]): Promise<unknown>;
  acceptDialog?(prompt?: string): Promise<unknown>;
  dismissDialog?(): Promise<unknown>;
  mouseWheel?(deltaX: number, deltaY: number): Promise<unknown>;
  scrollIntoView?(target: TargetInput): Promise<unknown>;
  selectFrame?(ref: string): Promise<unknown>;
  screenshot?(opts?: { path?: string; fullPage?: boolean; annotate?: boolean }): Promise<unknown>;
  waitFor?(predicate: {
    text?: string;
    selector?: string;
    url?: string;
    loadState?: 'load' | 'domcontentloaded' | 'networkidle';
  }): Promise<void>;
  waitForLoadState?(state: 'load' | 'domcontentloaded' | 'networkidle', opts?: { timeoutMs?: number }): Promise<void>;
  smartSettle?(opts?: { maxWaitMs?: number; quietMs?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  snapshot(opts?: { interactiveOnly?: boolean; urls?: boolean; maxDepth?: number }): Promise<SnapshotResult['nodes']>;
  snapshotWithRefs(opts?: {
    interactiveOnly?: boolean;
    urls?: boolean;
    maxDepth?: number;
  }): Promise<SnapshotResult['nodes']>;
  events(): Promise<unknown[]>;
  evaluate(fn: string, arg?: unknown): Promise<unknown>;
  getProp(prop: InspectProp, target?: TargetInput, attr?: string): Promise<unknown>;
  checkState(state: InspectState, target: TargetInput): Promise<boolean>;
}

export interface BatchNoteStore {
  getSiteNote(site: string): SiteNote | undefined;
  setSiteNote(site: string, content: string, updatedBy?: string): SiteNote;
  appendSiteNote(site: string, text: string, updatedBy?: string): SiteNote;
  matchSiteNotesForUrl(url: string): SiteNote[];
}

const WRITE_VERBS = new Set([
  'goto',
  'open',
  'back',
  'forward',
  'reload',
  'click',
  'dblclick',
  'hover',
  'focus',
  'fill',
  'type',
  'press',
  'select',
  'check',
  'uncheck',
  'scroll',
  'scrollintoview',
  'dialog',
  'upload',
  'eval',
  'frame',
]);

const READ_FIND_ACTIONS = new Set(['text', 'html', 'value', 'attr', 'box', 'visible', 'enabled', 'checked']);

/** 拆分单行 shell 风格参数（支持双引号、单引号与反斜杠转义）。 */
function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of line) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** 将纯文本多行批处理指令（每行一条）解析为结构化 `BatchStep[]`。 */
export function parseBatchLines(text: string): BatchStep[] {
  const steps: BatchStep[] = [];
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const tokens = tokenizeLine(trimmed);
    if (tokens.length === 0) continue;
    const cmd = tokens[0]!.toLowerCase();
    const rest = tokens.slice(1);
    switch (cmd) {
      case 'goto':
      case 'open':
        if (!rest[0]) throw Object.assign(new Error(`${cmd} 缺少 url`), { code: 'BAD_REQUEST' });
        steps.push({ cmd, url: rest[0] });
        break;
      case 'back':
      case 'forward':
      case 'reload':
        steps.push({ cmd });
        break;
      case 'click':
      case 'dblclick':
      case 'hover':
      case 'focus':
      case 'check':
      case 'uncheck':
      case 'scrollintoview':
        if (!rest[0]) throw Object.assign(new Error(`${cmd} 缺少 target`), { code: 'BAD_REQUEST' });
        steps.push({ cmd, target: rest[0] });
        break;
      case 'fill':
      case 'type': {
        const submit = rest.includes('--submit');
        const pos = rest.filter((t) => t !== '--submit');
        if (!pos[0] || pos[1] === undefined) {
          throw Object.assign(new Error(`${cmd} 需要 target 与 value`), { code: 'BAD_REQUEST' });
        }
        steps.push({ cmd, target: pos[0], value: pos[1], ...(submit ? { submit: true } : {}) });
        break;
      }
      case 'press':
        if (rest.length >= 2) steps.push({ cmd, target: rest[0], key: rest[1]! });
        else if (rest[0]) steps.push({ cmd, key: rest[0] });
        else throw Object.assign(new Error('press 需要 key'), { code: 'BAD_REQUEST' });
        break;
      case 'select':
        if (!rest[0] || rest[1] === undefined) {
          throw Object.assign(new Error('select 需要 target 与 value'), { code: 'BAD_REQUEST' });
        }
        steps.push({ cmd, target: rest[0], value: rest[1] });
        break;
      case 'scroll': {
        const dir = (rest[0] ?? 'down').toLowerCase();
        const isDir = dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right';
        const amount = Number(isDir ? (rest[1] ?? 500) : (rest[0] ?? 500));
        steps.push({
          cmd,
          direction: isDir ? dir : 'down',
          amount: Number.isFinite(amount) ? amount : 500,
        });
        break;
      }
      case 'wait': {
        const first = rest[0];
        if (!first) {
          steps.push({ cmd, ms: 200 });
        } else if (/^\d+$/.test(first)) {
          steps.push({ cmd, ms: Math.max(0, Number(first)) });
        } else if (first === '--text' && rest[1]) {
          steps.push({ cmd, text: rest[1] });
        } else if (first === '--url' && rest[1]) {
          steps.push({ cmd, url: rest[1] });
        } else if (first === '--load' || first === 'load' || first === 'domcontentloaded' || first === 'networkidle') {
          const state = first === '--load' ? (rest[1] ?? 'load') : first;
          steps.push({ cmd, loadState: state as 'load' | 'domcontentloaded' | 'networkidle' });
        } else {
          steps.push({ cmd, selector: first });
        }
        break;
      }
      case 'dialog': {
        const action = (rest[0] ?? 'accept').toLowerCase();
        if (action !== 'accept' && action !== 'dismiss') {
          throw Object.assign(new Error('dialog 仅支持 accept | dismiss'), { code: 'BAD_REQUEST' });
        }
        steps.push({ cmd, action, prompt: rest[1] });
        break;
      }
      case 'upload': {
        if (!rest[0] || rest.length < 2) {
          throw Object.assign(new Error('upload 需要 target 与至少一个文件路径'), { code: 'BAD_REQUEST' });
        }
        steps.push({ cmd, target: rest[0], files: rest.slice(1) });
        break;
      }
      case 'find': {
        if (!rest[0] || !rest[1] || !rest[2]) {
          throw Object.assign(new Error('find 需要 <by> <spec> <action> [value]'), { code: 'BAD_REQUEST' });
        }
        steps.push({ cmd, by: rest[0], spec: rest[1], action: rest[2], value: rest[3] });
        break;
      }
      case 'frame': {
        if (!rest[0]) throw Object.assign(new Error('frame 需要 main 或 frameId/序号'), { code: 'BAD_REQUEST' });
        steps.push({ cmd, target: rest[0] });
        break;
      }
      case 'eval': {
        const expr = rest.join(' ');
        if (!expr) throw Object.assign(new Error('eval 需要表达式'), { code: 'BAD_REQUEST' });
        steps.push({ cmd, expr });
        break;
      }
      case 'screenshot': {
        const fullPage = rest.includes('--full-page');
        const annotate = rest.includes('--annotate');
        const outPath = rest.find((t) => !t.startsWith('-'));
        steps.push({
          cmd,
          ...(outPath ? { path: outPath } : {}),
          ...(fullPage ? { fullPage: true } : {}),
          ...(annotate ? { annotate: true } : {}),
        });
        break;
      }
      case 'snapshot': {
        const filterIdx = rest.indexOf('--filter');
        const filter = filterIdx >= 0 ? rest[filterIdx + 1] : undefined;
        steps.push({
          cmd,
          interactive: rest.includes('-i') || rest.includes('--interactive'),
          urls: rest.includes('-u') || rest.includes('--urls'),
          ...(filter ? { filter } : {}),
        });
        break;
      }
      case 'read':
        steps.push({
          cmd,
          selector: rest.find((t) => !t.startsWith('-')),
          data: rest.includes('--data'),
          links: rest.includes('--links'),
          scroll: rest.includes('--scroll'),
          outline: rest.includes('--outline'),
        });
        break;
      case 'get':
        if (!rest[0]) throw Object.assign(new Error('get 需要属性名'), { code: 'BAD_REQUEST' });
        steps.push({ cmd, prop: rest[0] as InspectProp, target: rest[1], attr: rest[2] });
        break;
      case 'is':
        if (!rest[0] || !rest[1]) throw Object.assign(new Error('is 需要状态名与 target'), { code: 'BAD_REQUEST' });
        steps.push({ cmd, state: rest[0] as InspectState, target: rest[1] });
        break;
      case 'note': {
        const action = (rest[0] ?? 'get') as 'get' | 'set' | 'append';
        const site = rest[1] ?? '';
        const noteText = rest.slice(2).join(' ');
        if (!site) throw Object.assign(new Error('note 需要 site'), { code: 'BAD_REQUEST' });
        steps.push({ cmd, action, site, text: noteText });
        break;
      }
      default:
        throw Object.assign(new Error(`未知 batch 指令：${tokens[0]}`), { code: 'BAD_REQUEST' });
    }
  }
  return steps;
}

export function hasWriteSteps(steps: BatchStep[]): boolean {
  return steps.some((step) => {
    if (step.cmd === 'find') return !READ_FIND_ACTIONS.has(step.action);
    return WRITE_VERBS.has(step.cmd);
  });
}

/**
 * 计算本次批处理期间新增的网络请求摘要：
 * 优先按单调自增 SQLite `id > beforeLastId` 截取，彻底修复 300 条上限满后 `slice(300)` 恒空 bug；
 * 老测试桩不带 `id` 时安全回退到长度差值。
 */
export function summarizeNetworkDelta(before: NetworkEntry[], after: NetworkEntry[]): string[] {
  let added: NetworkEntry[];
  const lastBeforeId = before.length > 0 ? before[before.length - 1]!.id : undefined;
  const hasIds = after.some((e) => typeof e.id === 'number');
  if (hasIds) {
    const cursor = typeof lastBeforeId === 'number' ? lastBeforeId : 0;
    added = after.filter((e) => typeof e.id === 'number' && e.id > cursor);
  } else {
    const start = Math.min(before.length, after.length);
    added = after.slice(start);
  }
  return added.slice(-20).map((entry) => {
    let shortUrl = entry.url;
    try {
      const u = new URL(entry.url);
      shortUrl = `${u.pathname}${u.search}`;
    } catch {
      // 保留原始串
    }
    return `${entry.method} ${shortUrl} -> ${entry.status || (entry.error ?? 'ERR')}`;
  });
}

/**
 * 批量顺序执行多个浏览器/笔记步骤；支持 `--bail` 遇错立即中止，
 * 使用事件驱动 `smartSettle` 收敛后以 `snapshotWithRefs` 产出自带 `@N` 的 Delta Receipt。
 */
export async function executeBatch(options: {
  steps: BatchStep[];
  bail?: boolean;
  noChanges?: boolean;
  controller: BatchClient;
  store?: BatchNoteStore;
  networkEntries?: () => NetworkEntry[];
  networkEntriesSince?: (afterId: number) => NetworkEntry[];
  prepareInput?: <T>(fn: () => Promise<T>) => Promise<T>;
  settleMs?: number;
}): Promise<{ ok: boolean; abortedAt?: number; results: BatchStepResult[]; delta: BatchDeltaReceipt }> {
  const bail = Boolean(options.bail);
  const runInput = options.prepareInput ?? ((fn) => fn());
  const netBefore = options.networkEntries ? options.networkEntries() : [];
  const beforeLastNetId =
    netBefore.length > 0 && typeof netBefore[netBefore.length - 1]!.id === 'number'
      ? netBefore[netBefore.length - 1]!.id!
      : 0;
  const beforeUrl = options.controller.currentUrl();
  const beforeTitle = await options.controller.title().catch(() => '');
  const beforeNodes = options.noChanges
    ? []
    : await options.controller.snapshot({ interactiveOnly: true }).catch(() => []);
  const beforeSnap: SnapshotResult = { url: beforeUrl, title: beforeTitle, nodes: beforeNodes };

  const results: BatchStepResult[] = [];
  let ok = true;
  let abortedAt: number | undefined;

  for (let i = 0; i < options.steps.length; i += 1) {
    const step = options.steps[i]!;
    try {
      let out: unknown;
      switch (step.cmd) {
        case 'goto':
        case 'open':
          out = await options.controller.navigate(step.url);
          break;
        case 'back':
          options.controller.goBack();
          if (options.controller.waitForLoadState) {
            await options.controller.waitForLoadState('domcontentloaded', { timeoutMs: 3000 }).catch(() => {});
          }
          out = { url: options.controller.currentUrl() };
          break;
        case 'forward':
          options.controller.goForward();
          if (options.controller.waitForLoadState) {
            await options.controller.waitForLoadState('domcontentloaded', { timeoutMs: 3000 }).catch(() => {});
          }
          out = { url: options.controller.currentUrl() };
          break;
        case 'reload':
          out = await options.controller.reload();
          break;
        case 'click':
          out = await runInput(() => options.controller.click(step.target));
          break;
        case 'dblclick':
          out = await runInput(() => options.controller.dblclick(step.target));
          break;
        case 'hover':
          out = await runInput(() => options.controller.hover(step.target));
          break;
        case 'focus':
          out = await runInput(() => options.controller.focus(step.target));
          break;
        case 'check':
          if (!options.controller.check) throw Object.assign(new Error('check 不可用'), { code: 'INTERNAL' });
          out = await runInput(() => options.controller.check!(step.target));
          break;
        case 'uncheck':
          if (!options.controller.uncheck) throw Object.assign(new Error('uncheck 不可用'), { code: 'INTERNAL' });
          out = await runInput(() => options.controller.uncheck!(step.target));
          break;
        case 'scrollintoview':
          if (options.controller.scrollIntoView) {
            out = await runInput(() => options.controller.scrollIntoView!(step.target));
          } else {
            out = await runInput(() => options.controller.hover(step.target));
          }
          break;
        case 'scroll': {
          const amt = step.amount ?? 500;
          const dx = step.direction === 'left' ? -amt : step.direction === 'right' ? amt : 0;
          const dy = step.direction === 'up' ? -amt : step.direction === 'down' || !step.direction ? amt : 0;
          if (options.controller.mouseWheel) {
            out = await runInput(() => options.controller.mouseWheel!(dx, dy));
          } else {
            out = await options.controller.evaluate(
              `() => { window.scrollBy(${dx}, ${dy}); return { x: window.scrollX, y: window.scrollY }; }`,
            );
          }
          break;
        }
        case 'fill':
        case 'type':
          out = await runInput(() =>
            options.controller.fill(step.target, step.value, step.submit ? { submit: true } : undefined),
          );
          break;
        case 'press':
          out = await runInput(() =>
            step.target !== undefined
              ? options.controller.press(step.target, step.key)
              : options.controller.press(step.key),
          );
          break;
        case 'select':
          out = await runInput(() => options.controller.selectOption(step.target, step.value));
          break;
        case 'wait':
          if (step.ms !== undefined) {
            await options.controller.waitForTimeout(step.ms);
            out = { waitedMs: step.ms };
          } else if (options.controller.waitFor) {
            await options.controller.waitFor({
              ...(step.selector ? { selector: step.selector } : {}),
              ...(step.text ? { text: step.text } : {}),
              ...(step.url ? { url: step.url } : {}),
              ...(step.loadState ? { loadState: step.loadState } : {}),
            });
            out = { ok: true };
          } else {
            out = { ok: true };
          }
          break;
        case 'dialog':
          if (step.action === 'accept' && options.controller.acceptDialog) {
            out = await options.controller.acceptDialog(step.prompt);
          } else if (step.action === 'dismiss' && options.controller.dismissDialog) {
            out = await options.controller.dismissDialog();
          } else {
            throw Object.assign(new Error('dialog 控制不可用'), { code: 'INTERNAL' });
          }
          break;
        case 'upload':
          if (!options.controller.setInputFiles) throw Object.assign(new Error('upload 不可用'), { code: 'INTERNAL' });
          out = await runInput(() => options.controller.setInputFiles!(step.target, step.files));
          break;
        case 'find': {
          const target = targetFromBy(step.by, step.spec, step.name);
          if (
            step.action === 'text' ||
            step.action === 'html' ||
            step.action === 'value' ||
            step.action === 'attr' ||
            step.action === 'box'
          ) {
            out = await options.controller.getProp(step.action as InspectProp, target, step.attr ?? step.value);
          } else if (step.action === 'visible' || step.action === 'enabled' || step.action === 'checked') {
            out = { ok: await options.controller.checkState(step.action as InspectState, target) };
          } else if (step.action === 'click') out = await runInput(() => options.controller.click(target));
          else if (step.action === 'dblclick') out = await runInput(() => options.controller.dblclick(target));
          else if (step.action === 'hover') out = await runInput(() => options.controller.hover(target));
          else if (step.action === 'focus') out = await runInput(() => options.controller.focus(target));
          else if (step.action === 'fill')
            out = await runInput(() => options.controller.fill(target, step.value ?? ''));
          else if (step.action === 'press')
            out = await runInput(() => options.controller.press(target, step.value ?? 'Enter'));
          else if (step.action === 'select')
            out = await runInput(() => options.controller.selectOption(target, step.value ?? ''));
          else if (step.action === 'check' && options.controller.check)
            out = await runInput(() => options.controller.check!(target));
          else if (step.action === 'uncheck' && options.controller.uncheck)
            out = await runInput(() => options.controller.uncheck!(target));
          else throw Object.assign(new Error(`未知 find 动作：${step.action}`), { code: 'BAD_REQUEST' });
          break;
        }
        case 'frame':
          if (!options.controller.selectFrame) throw Object.assign(new Error('frame 切换不可用'), { code: 'INTERNAL' });
          out = await options.controller.selectFrame(step.target);
          break;
        case 'eval':
          out = await options.controller.evaluate(`() => (${step.expr})`);
          break;
        case 'screenshot':
          if (!options.controller.screenshot) throw Object.assign(new Error('screenshot 不可用'), { code: 'INTERNAL' });
          out = await options.controller.screenshot({
            path: step.path,
            fullPage: step.fullPage,
            annotate: step.annotate,
          });
          break;
        case 'snapshot': {
          const nodes = await options.controller.snapshotWithRefs({
            interactiveOnly: step.interactive,
            urls: step.urls,
            maxDepth: step.maxDepth,
          });
          const url = options.controller.currentUrl();
          const title = await options.controller.title();
          const siteNotes = options.store?.matchSiteNotesForUrl(url);
          out = step.interactive
            ? formatCompactSnapshot({
                url,
                title,
                nodes,
                siteNotes,
                interactiveOnly: true,
                urls: step.urls,
                filter: step.filter,
                maxDepth: step.maxDepth,
              })
            : { url, title, nodes };
          break;
        }
        case 'read': {
          const url = options.controller.currentUrl();
          out = await readPage(options.controller, {
            selector: step.selector,
            data: step.data,
            links: step.links,
            scroll: step.scroll,
            outline: step.outline,
            filter: step.filter,
            siteNotes: options.store?.matchSiteNotesForUrl(url),
          });
          break;
        }
        case 'get':
          out = await options.controller.getProp(step.prop, step.target, step.attr);
          break;
        case 'is':
          out = await options.controller.checkState(step.state, step.target);
          break;
        case 'note':
          if (!options.store) throw Object.assign(new Error('store 不可用'), { code: 'INTERNAL' });
          if (step.action === 'set') out = options.store.setSiteNote(step.site, step.text ?? '', 'agent');
          else if (step.action === 'append') out = options.store.appendSiteNote(step.site, step.text ?? '', 'agent');
          else out = options.store.getSiteNote(step.site) ?? null;
          break;
      }
      results.push({ step: i + 1, cmd: step.cmd, ok: true, result: out });
    } catch (error) {
      ok = false;
      const errObj = error as { code?: string; message?: string; details?: unknown };
      results.push({
        step: i + 1,
        cmd: step.cmd,
        ok: false,
        error: {
          code: errObj.code ?? 'ERROR',
          message: errObj.message ?? String(error),
          ...(errObj.details ? { details: errObj.details } : {}),
        },
      });
      if (bail) {
        abortedAt = i + 1;
        break;
      }
    }
  }

  // 事件驱动收敛（若单测传 settleMs === 0 则跳过等待）
  if (options.settleMs !== 0) {
    if (options.controller.smartSettle) {
      await options.controller.smartSettle({ maxWaitMs: 3000, quietMs: options.settleMs ?? 180 }).catch(() => {});
    } else {
      const ms = options.settleMs ?? 150;
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  const afterUrl = options.controller.currentUrl();
  const afterTitle = await options.controller.title().catch(() => '');
  // 关键升级：末尾调用 `snapshotWithRefs` 让 Delta Receipt 中新增交互元素自带可立刻消费的 `@N`！
  const afterNodes = options.noChanges
    ? []
    : await options.controller.snapshotWithRefs({ interactiveOnly: true }).catch(() => []);
  const afterEvents = await options.controller.events().catch(() => []);
  const netDelta =
    options.networkEntriesSince && beforeLastNetId > 0
      ? summarizeNetworkDelta([], options.networkEntriesSince(beforeLastNetId))
      : summarizeNetworkDelta(netBefore, options.networkEntries ? options.networkEntries() : []);

  const interactiveDelta = options.noChanges
    ? diffSnapshots({ url: beforeUrl, title: beforeTitle, nodes: [] }, { url: afterUrl, title: afterTitle, nodes: [] })
    : diffSnapshots(beforeSnap, {
        url: afterUrl,
        title: afterTitle,
        nodes: afterNodes,
      });

  return {
    ok,
    ...(abortedAt !== undefined ? { abortedAt } : {}),
    results,
    delta: {
      urlChanged: beforeUrl !== afterUrl,
      titleChanged: beforeTitle !== afterTitle,
      url: afterUrl,
      title: afterTitle,
      events: afterEvents,
      networkSummary: netDelta,
      interactiveDelta,
    },
  };
}
