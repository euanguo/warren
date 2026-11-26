import type { NetworkEntry, SiteNote, SnapshotResult, TargetInput } from '../../../shared/types.ts';
import type { InspectProp, InspectState } from './inspector.ts';
import { diffSnapshots, type SnapshotDiffResult } from './diff.ts';
import { readPage } from './reader.ts';
import { formatCompactSnapshot } from './snapshot-compact.ts';

export type BatchStep =
  | { cmd: 'goto' | 'open'; url: string }
  | { cmd: 'back' | 'forward' | 'reload' }
  | { cmd: 'click' | 'dblclick' | 'hover' | 'focus'; target: TargetInput }
  | { cmd: 'fill' | 'type'; target: TargetInput; value: string }
  | { cmd: 'press'; target?: TargetInput; key: string }
  | { cmd: 'select'; target: TargetInput; value: string }
  | { cmd: 'wait'; ms: number }
  | { cmd: 'snapshot'; interactive?: boolean }
  | { cmd: 'read'; selector?: string; data?: boolean; links?: boolean | string; scroll?: boolean }
  | { cmd: 'get'; prop: InspectProp; target?: TargetInput; attr?: string }
  | { cmd: 'is'; state: InspectState; target: TargetInput }
  | { cmd: 'note'; action: 'get' | 'set' | 'append'; site: string; text?: string };

export interface BatchStepResult {
  step: number;
  cmd: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
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
  fill(target: TargetInput, value: string): Promise<unknown>;
  selectOption(target: TargetInput, value: string): Promise<unknown>;
  press(target: string | TargetInput, chord?: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  snapshot(opts?: { interactiveOnly?: boolean }): Promise<SnapshotResult['nodes']>;
  snapshotWithRefs(opts?: { interactiveOnly?: boolean }): Promise<SnapshotResult['nodes']>;
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
]);

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
        if (!rest[0]) throw Object.assign(new Error(`${cmd} 缺少 target`), { code: 'BAD_REQUEST' });
        steps.push({ cmd, target: rest[0] });
        break;
      case 'fill':
      case 'type':
        if (!rest[0] || rest[1] === undefined) {
          throw Object.assign(new Error(`${cmd} 需要 target 与 value`), { code: 'BAD_REQUEST' });
        }
        steps.push({ cmd, target: rest[0], value: rest[1] });
        break;
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
      case 'wait':
        steps.push({ cmd, ms: Math.max(0, Number(rest[0] ?? 200)) });
        break;
      case 'snapshot':
        steps.push({ cmd, interactive: rest.includes('-i') || rest.includes('--interactive') });
        break;
      case 'read':
        steps.push({
          cmd,
          selector: rest.find((t) => !t.startsWith('-')),
          data: rest.includes('--data'),
          links: rest.includes('--links'),
          scroll: rest.includes('--scroll'),
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
  return steps.some((step) => WRITE_VERBS.has(step.cmd));
}

function summarizeNetworkDelta(before: NetworkEntry[], after: NetworkEntry[]): string[] {
  const start = Math.min(before.length, after.length);
  const added = after.slice(start);
  return added.slice(-20).map((entry) => {
    let shortUrl = entry.url;
    try {
      const u = new URL(entry.url);
      shortUrl = `${u.pathname}${u.search}`;
    } catch {
      // 保留原始串
    }
    return `${entry.method} ${shortUrl} -> ${entry.status || 'ERR'}`;
  });
}

/**
 * 批量顺序执行多个浏览器/笔记步骤；支持 `--bail` 遇错立即中止，
 * 并在短稳定窗口后返回带 URL/标题变化、弹窗、网络请求摘要与交互节点增删的 Delta Receipt。
 */
export async function executeBatch(options: {
  steps: BatchStep[];
  bail?: boolean;
  controller: BatchClient;
  store?: BatchNoteStore;
  networkEntries?: () => NetworkEntry[];
  prepareInput?: <T>(fn: () => Promise<T>) => Promise<T>;
  settleMs?: number;
}): Promise<{ ok: boolean; abortedAt?: number; results: BatchStepResult[]; delta: BatchDeltaReceipt }> {
  const bail = Boolean(options.bail);
  const runInput = options.prepareInput ?? ((fn) => fn());
  const netBefore = options.networkEntries ? options.networkEntries() : [];
  const beforeUrl = options.controller.currentUrl();
  const beforeTitle = await options.controller.title().catch(() => '');
  const beforeNodes = await options.controller.snapshot({ interactiveOnly: true }).catch(() => []);
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
          out = { url: options.controller.currentUrl() };
          break;
        case 'forward':
          options.controller.goForward();
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
        case 'fill':
        case 'type':
          out = await runInput(() => options.controller.fill(step.target, step.value));
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
          await options.controller.waitForTimeout(step.ms);
          out = { waitedMs: step.ms };
          break;
        case 'snapshot': {
          const nodes = await options.controller.snapshotWithRefs({ interactiveOnly: step.interactive });
          const url = options.controller.currentUrl();
          const title = await options.controller.title();
          const siteNotes = options.store?.matchSiteNotesForUrl(url);
          out = step.interactive
            ? formatCompactSnapshot({ url, title, nodes, siteNotes, interactiveOnly: true })
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
      const errObj = error as { code?: string; message?: string };
      results.push({
        step: i + 1,
        cmd: step.cmd,
        ok: false,
        error: { code: errObj.code ?? 'ERROR', message: errObj.message ?? String(error) },
      });
      if (bail) {
        abortedAt = i + 1;
        break;
      }
    }
  }

  const settleMs = options.settleMs ?? 150;
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));

  const afterUrl = options.controller.currentUrl();
  const afterTitle = await options.controller.title().catch(() => '');
  const afterNodes = await options.controller.snapshot({ interactiveOnly: true }).catch(() => []);
  const afterEvents = await options.controller.events().catch(() => []);
  const netAfter = options.networkEntries ? options.networkEntries() : [];

  const interactiveDelta = diffSnapshots(beforeSnap, {
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
      networkSummary: summarizeNetworkDelta(netBefore, netAfter),
      interactiveDelta,
    },
  };
}
