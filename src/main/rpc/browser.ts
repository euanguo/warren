/**
 * 浏览器观测、导航、输入动作、等待、批处理与诊断域 RPC 端点。
 */
import {
  keyboardDown,
  keyboardInsert,
  keyboardPaste,
  keyboardPress,
  keyboardType,
  keyboardUp,
  mouseClick,
  mouseDown,
  mouseMove,
  mouseUp,
  mouseWheel,
} from '../browser/keymouse.ts';
import {
  executeBatch,
  executeFindAction,
  hasWriteSteps,
  inspectPropOnClient,
  inspectStateOnClient,
  parseBatchLines,
  type BatchStep,
} from '../browser/ops/batch.ts';
import { auditAccessibility, collectVitals, inspectReactTree, printPdf } from '../browser/ops/diagnostics.ts';
import { diffScreenshots, diffSnapshots, getLastSnapshot, rememberSnapshot } from '../browser/ops/diff.ts';
import { applyEmulationSetting } from '../browser/ops/emulation.ts';
import { targetFromBy, type InspectProp, type InspectState } from '../browser/ops/inspector.ts';
import { callWebMcpTool, listWebMcpTools } from '../browser/ops/webmcp.ts';
import { readPage } from '../browser/ops/reader.ts';
import { formatCompactSnapshot } from '../browser/ops/snapshot-compact.ts';
import {
  asClickOptions,
  asEmulationSetting,
  asFetchOptions,
  asFillOptions,
  asFocusOptions,
  asLoadState,
  asMouseButton,
  asNavigateOptions,
  asOptionalTargetInput,
  asPasteContent,
  asScreenshotOptions,
  asSelectValue,
  asSelectorState,
  asSnapshotOptions,
  asStringArray,
  asStringOrList,
  asTargetInput,
  asUrlMatcher,
  asWaitEventKind,
  asWaitOptions,
  asWaitPredicate,
} from '../browser/parse-params.ts';
import { RpcError, type RpcDomainTable } from './types.ts';

function asArgsRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export const browserRpcEndpoints: RpcDomainTable = {
  // ── 导航与会话设置（write）────────────────────────────────────
  'browser.navigate': {
    kind: 'change',
    summary: '导航到指定 URL',
    params: ['id', 'url', 'leaseId', 'waitUntil?'],
    gate: 'write',
    wake: true,
    handler: (ctx) => ctx.controller().navigate(ctx.str('url'), asNavigateOptions(ctx.params)),
  },
  'browser.reload': {
    kind: 'change',
    summary: '刷新当前页',
    params: ['id', 'leaseId', 'waitUntil?'],
    gate: 'write',
    wake: true,
    handler: (ctx) => ctx.controller().reload(asNavigateOptions(ctx.params)),
  },
  'browser.goBack': {
    kind: 'change',
    summary: '后退',
    params: ['id', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => {
      const c = ctx.controller();
      c.goBack();
      return c.navigationState();
    },
  },
  'browser.goForward': {
    kind: 'change',
    summary: '前进',
    params: ['id', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => {
      const c = ctx.controller();
      c.goForward();
      return c.navigationState();
    },
  },
  'browser.set': {
    kind: 'change',
    summary: '设置设备仿真（viewport/device/geo/offline/headers/media/tz/locale/reset）',
    params: ['id', 'setting', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => applyEmulationSetting(ctx.controller().page, asEmulationSetting(ctx.params.setting)),
  },
  'browser.frame.select': {
    kind: 'change',
    summary: '切换当前定位与快照聚焦的 frame',
    params: ['id', 'target', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => ctx.controller().selectFrame(ctx.str('target')),
  },
  'browser.webmcp.call': {
    kind: 'change',
    summary: '调用页面声明的 WebMCP 工具',
    params: ['id', 'tool', 'args?', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => callWebMcpTool(ctx.controller().page, ctx.str('tool'), asArgsRecord(ctx.params.args)),
  },
  'browser.pdf': {
    kind: 'change',
    summary: '导出当前页为 PDF 文件',
    params: ['id', 'path', 'landscape?', 'printBackground?', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) =>
      printPdf(ctx.controller().page, {
        path: ctx.str('path'),
        landscape: Boolean(ctx.params.landscape),
        printBackground: ctx.params.printBackground !== false,
        scale: ctx.num('scale'),
      }),
  },
  'browser.diffUrls': {
    kind: 'change',
    summary: '依次打开两个 URL 并对比语义快照差异',
    params: ['id', 'a', 'b', 'interactiveOnly?', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: async (ctx) => {
      const urlA = ctx.str('a');
      const urlB = ctx.str('b');
      const interactiveOnly = Boolean(ctx.params.interactiveOnly);
      const c = ctx.controller();
      await c.navigate(urlA);
      const nodesA = await c.snapshot({ interactiveOnly });
      const snapA = { url: c.currentUrl(), title: await c.title(), nodes: nodesA };
      await c.navigate(urlB);
      const nodesB = await c.snapshot({ interactiveOnly });
      const snapB = { url: c.currentUrl(), title: await c.title(), nodes: nodesB };
      return diffSnapshots(snapA, snapB);
    },
  },
  'browser.downloadSaveAs': {
    kind: 'change',
    summary: '将指定下载另存到安全路径',
    params: ['id', 'downloadId', 'path', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => ctx.controller().downloadSaveAs(ctx.str('downloadId'), ctx.str('path')),
  },
  'browser.downloadCancel': {
    kind: 'change',
    summary: '取消指定进行中下载',
    params: ['id', 'downloadId', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => ctx.controller().downloadCancel(ctx.str('downloadId')),
  },
  'browser.evaluate': {
    kind: 'change',
    summary: '在主世界执行表达式或函数（逃生舱）',
    params: ['id', 'fn', 'arg?', 'timeoutMs?', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => ctx.controller().evaluate(ctx.str('fn'), ctx.params.arg, { timeoutMs: ctx.num('timeoutMs') }),
  },
  'browser.fetch': {
    kind: 'change',
    summary: '带环境身份上下文发起同站或页面 fetch（逃生舱）',
    params: ['id', 'url', 'method?', 'headers?', 'body?', 'cache?', 'credentials?', 'saveAs?', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => ctx.controller().fetch(ctx.str('url'), asFetchOptions(ctx.params)),
  },
  'browser.cdp': {
    kind: 'change',
    summary: '直接发送受策略门控的白名单 CDP 命令（逃生舱）',
    params: ['id', 'method', 'params?', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => ctx.controller().cdp(ctx.str('method'), asArgsRecord(ctx.params.params)),
  },
  'browser.clearDataForOrigin': {
    kind: 'change',
    summary: '清除单个 origin 的站点存储与 cookie',
    params: ['id', 'origin', 'types?', 'leaseId'],
    gate: 'write',
    wake: true,
    handler: (ctx) => ctx.controller().clearDataForOrigin(ctx.str('origin'), ctx.optStr('types')),
  },

  // ── 弹窗处理（dialog）──────────────────────────────────────────
  'browser.acceptDialog': {
    kind: 'change',
    summary: '确认当前 JS 对话框',
    params: ['id', 'prompt?', 'leaseId'],
    gate: 'dialog',
    wake: true,
    handler: (ctx) => ctx.controller().acceptDialog(ctx.optStr('prompt')),
  },
  'browser.dismissDialog': {
    kind: 'change',
    summary: '取消当前 JS 对话框',
    params: ['id', 'leaseId'],
    gate: 'dialog',
    wake: true,
    handler: (ctx) => ctx.controller().dismissDialog(),
  },
  'browser.dialogPolicy': {
    kind: 'change',
    summary: '设置自动弹窗处理策略（none/accept/dismiss）',
    params: ['id', 'policy', 'leaseId'],
    gate: 'dialog',
    wake: true,
    handler: (ctx) =>
      ctx
        .controller()
        .setDialogPolicy(
          ctx.params.policy === 'accept' || ctx.params.policy === 'dismiss' ? ctx.params.policy : 'none',
        ),
  },

  // ── 页面输入动作（input：租约 + 临时在屏挂接 + 弹窗保护）───────
  'browser.click': {
    kind: 'change',
    summary: '等待可用性并点击元素（支持 newTab/humanize）',
    params: ['id', 'target', 'leaseId', 'newTab?', 'humanize?'],
    gate: 'input',
    wake: true,
    handler: (ctx) => ctx.controller().click(asTargetInput(ctx.params.target), asClickOptions(ctx.params)),
  },
  'browser.dblclick': {
    kind: 'change',
    summary: '真实两连击状态机双击元素',
    params: ['id', 'target', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => ctx.controller().dblclick(asTargetInput(ctx.params.target), asClickOptions(ctx.params)),
  },
  'browser.hover': {
    kind: 'change',
    summary: '悬停元素',
    params: ['id', 'target', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => ctx.controller().hover(asTargetInput(ctx.params.target), asClickOptions(ctx.params)),
  },
  'browser.drag': {
    kind: 'change',
    summary: '拖拽元素（支持 before/after/center 与 HTML5 降级）',
    params: ['id', 'source', 'target', 'leaseId', 'placement?'],
    gate: 'input',
    wake: true,
    handler: (ctx) =>
      ctx
        .controller()
        .drag(asTargetInput(ctx.params.source), asTargetInput(ctx.params.target), asClickOptions(ctx.params)),
  },
  'browser.drop': {
    kind: 'change',
    summary: '向拖放区注入本地文件 DataTransfer',
    params: ['id', 'target', 'paths', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) =>
      ctx.controller().dropFiles(asTargetInput(ctx.params.target), asStringArray(ctx.params.paths), {
        timeoutMs: ctx.num('timeoutMs'),
      }),
  },
  'browser.fill': {
    kind: 'change',
    summary: '智能清空并填写表单/富文本（支持 --submit）',
    params: ['id', 'target', 'value', 'leaseId', 'submit?'],
    gate: 'input',
    wake: true,
    handler: (ctx) => {
      if (typeof ctx.params.value !== 'string') {
        throw Object.assign(new Error('missing string param: value'), { code: 'BAD_REQUEST' });
      }
      return ctx.controller().fill(asTargetInput(ctx.params.target), ctx.params.value, asFillOptions(ctx.params));
    },
  },
  'browser.selectOption': {
    kind: 'change',
    summary: '选择下拉选项（原生 select + ARIA combobox/listbox）',
    params: ['id', 'target', 'value', 'leaseId', 'by?'],
    gate: 'input',
    wake: true,
    handler: (ctx) =>
      ctx.controller().selectOption(asTargetInput(ctx.params.target), asSelectValue(ctx.params.value), {
        timeoutMs: ctx.num('timeoutMs'),
        by:
          ctx.params.by === 'value' ||
          ctx.params.by === 'label' ||
          ctx.params.by === 'index' ||
          ctx.params.by === 'auto'
            ? ctx.params.by
            : undefined,
      }),
  },
  'browser.check': {
    kind: 'change',
    summary: '幂等勾选 checkbox/radio/switch',
    params: ['id', 'target', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => ctx.controller().check(asTargetInput(ctx.params.target), { timeoutMs: ctx.num('timeoutMs') }),
  },
  'browser.uncheck': {
    kind: 'change',
    summary: '幂等取消勾选 checkbox/switch',
    params: ['id', 'target', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => ctx.controller().uncheck(asTargetInput(ctx.params.target), { timeoutMs: ctx.num('timeoutMs') }),
  },
  'browser.scrollIntoView': {
    kind: 'change',
    summary: '将元素居中滚动至视口内',
    params: ['id', 'target', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => ctx.controller().scrollIntoView(asTargetInput(ctx.params.target)),
  },
  'browser.focus': {
    kind: 'change',
    summary: '聚焦目标元素',
    params: ['id', 'target', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => ctx.controller().focus(asTargetInput(ctx.params.target), asFocusOptions(ctx.params)),
  },
  'browser.press': {
    kind: 'change',
    summary: '发送按键/组合键',
    params: ['id', 'target?', 'key|chord', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => {
      if (ctx.params.target === undefined) return ctx.controller().press(ctx.str('key'));
      return ctx.controller().press(asTargetInput(ctx.params.target), ctx.str('chord'), {
        delay: ctx.num('delay'),
        timeoutMs: ctx.num('timeoutMs'),
      });
    },
  },
  'browser.setInputFiles': {
    kind: 'change',
    summary: '向 file input 注入本地文件',
    params: ['id', 'target', 'paths', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) =>
      ctx.controller().setInputFiles(asTargetInput(ctx.params.target), asStringOrList(ctx.params.paths)),
  },
  'browser.mouseClick': {
    kind: 'change',
    summary: '按视口坐标触发鼠标点击',
    params: ['id', 'x', 'y', 'button?', 'clickCount?', 'delay?', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => mouseClick(ctx.controller().page, ctx.reqNum('x'), ctx.reqNum('y'), asClickOptions(ctx.params)),
  },
  'browser.mouseMove': {
    kind: 'change',
    summary: '移动鼠标指针到视口坐标',
    params: ['id', 'x', 'y', 'label?', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) =>
      mouseMove(ctx.controller().page, ctx.reqNum('x'), ctx.reqNum('y'), { label: ctx.optStr('label') }),
  },
  'browser.mouseDown': {
    kind: 'change',
    summary: '按下鼠标按键',
    params: ['id', 'button?', 'x?', 'y?', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) =>
      mouseDown(ctx.controller().page, { button: asMouseButton(ctx.params.button), x: ctx.num('x'), y: ctx.num('y') }),
  },
  'browser.mouseUp': {
    kind: 'change',
    summary: '释放鼠标按键',
    params: ['id', 'button?', 'x?', 'y?', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) =>
      mouseUp(ctx.controller().page, { button: asMouseButton(ctx.params.button), x: ctx.num('x'), y: ctx.num('y') }),
  },
  'browser.mouseWheel': {
    kind: 'change',
    summary: '触发鼠标滚轮滚动',
    params: ['id', 'deltaX?', 'deltaY?', 'label?', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) =>
      mouseWheel(ctx.controller().page, ctx.num('deltaX') ?? 0, ctx.num('deltaY') ?? 0, { label: ctx.optStr('label') }),
  },
  'browser.keyboardDown': {
    kind: 'change',
    summary: '按住指定键盘按键',
    params: ['id', 'key', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => keyboardDown(ctx.controller().page, ctx.str('key')),
  },
  'browser.keyboardUp': {
    kind: 'change',
    summary: '释放指定键盘按键',
    params: ['id', 'key', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => keyboardUp(ctx.controller().page, ctx.str('key')),
  },
  'browser.keyboardPress': {
    kind: 'change',
    summary: '按下并释放按键或组合键',
    params: ['id', 'chord', 'delay?', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => keyboardPress(ctx.controller().page, ctx.str('chord'), { delay: ctx.num('delay') }),
  },
  'browser.keyboardType': {
    kind: 'change',
    summary: '逐字符键入文本',
    params: ['id', 'text', 'delay?', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => keyboardType(ctx.controller().page, ctx.str('text'), { delay: ctx.num('delay') }),
  },
  'browser.keyboardInsert': {
    kind: 'change',
    summary: '直接向当前焦点插入文本（不走逐键仿真）',
    params: ['id', 'text', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => keyboardInsert(ctx.controller().page, ctx.str('text')),
  },
  'browser.keyboardPaste': {
    kind: 'change',
    summary: '将纯文本或 HTML 粘贴到当前焦点',
    params: ['id', 'content', 'leaseId'],
    gate: 'input',
    wake: true,
    handler: (ctx) => keyboardPaste(ctx.controller().page, asPasteContent(ctx.params.content)),
  },

  // ── 复合编排（custom：读免租约、写必须过租约与输入上下文）──────
  'browser.find': {
    kind: 'change',
    summary: '语义定位器一步定位并执行动作或读取状态',
    params: ['id', 'by', 'spec', 'action', 'value?', 'name?', 'attr?', 'leaseId?'],
    gate: 'custom',
    wake: true,
    handler: async (ctx) => {
      const id = ctx.str('id');
      const target = targetFromBy(ctx.str('by'), ctx.str('spec'), ctx.optStr('name'));
      const action = ctx.str('action');
      const value =
        action === 'fill' || action === 'press' || action === 'select' ? ctx.str('value') : ctx.optStr('value');
      return executeFindAction({
        controller: ctx.controller(id),
        target,
        action,
        value,
        attr: ctx.optStr('attr'),
        runInput: (fn) => {
          ctx.assertWritable(id);
          return ctx.runWithInput(id, () => fn());
        },
      });
    },
  },
  'browser.batch': {
    kind: 'change',
    summary: '多步原子批处理并返回带 @ref 的 Delta Receipt',
    params: ['id', 'steps|script', 'bail?', 'noChanges?', 'leaseId?'],
    gate: 'custom',
    wake: true,
    handler: async (ctx) => {
      const id = ctx.str('id');
      const steps: BatchStep[] = Array.isArray(ctx.params.steps)
        ? (ctx.params.steps as BatchStep[])
        : typeof ctx.params.script === 'string'
          ? parseBatchLines(ctx.params.script)
          : [];
      if (steps.length === 0) throw new RpcError('BAD_REQUEST', 'batch steps or script is empty');
      if (hasWriteSteps(steps)) ctx.assertWritable(id);
      const c = ctx.controller(id);
      return executeBatch({
        steps,
        bail: Boolean(ctx.params.bail),
        noChanges: Boolean(ctx.params.noChanges),
        controller: c,
        store: ctx.deps.store,
        networkEntries: () => ctx.deps.manager.networkEntries(id),
        networkEntriesSince:
          typeof ctx.deps.manager.networkEntriesSince === 'function'
            ? (afterId) => ctx.deps.manager.networkEntriesSince(id, afterId)
            : undefined,
        prepareInput: (fn) => ctx.runWithInput(id, () => fn()),
      });
    },
  },

  // ── 观察、等待与只读诊断（read）──────────────────────────────
  'browser.snapshot': {
    kind: 'read',
    summary: '读取层次可访问性树、分配稳定自愈 @N 并按需输出缩进紧凑视图',
    params: [
      'id',
      'scope?',
      'interactiveOnly?',
      'compact?',
      'urls?',
      'filter?',
      'maxDepth?',
      'maxTokens?',
      'selector?',
      'boxes?',
    ],
    gate: 'read',
    wake: true,
    handler: async (ctx) => {
      const id = ctx.str('id');
      const controller = ctx.controller(id);
      const opts = asSnapshotOptions(ctx.params);
      const nodes = await controller.snapshotWithRefs(opts);
      const url = controller.currentUrl();
      const title = await controller.title();
      const siteNotes = ctx.deps.store.matchSiteNotesForUrl?.(url) ?? [];
      const webmcp =
        ctx.params.compact && controller.page ? await listWebMcpTools(controller.page).catch(() => null) : null;
      const scopeKey = `${id}:${ctx.space}:${ctx.tab ?? 'active'}`;
      rememberSnapshot(scopeKey, { url, title, nodes });
      if (ctx.params.compact) {
        return {
          url,
          title,
          ...(siteNotes.length > 0 ? { siteNotes } : {}),
          ...(webmcp?.tools?.length ? { webmcpTools: webmcp.tools } : {}),
          compact: formatCompactSnapshot({
            url,
            title,
            nodes,
            siteNotes,
            webmcpTools: webmcp?.tools,
            interactiveOnly: opts.interactiveOnly,
            maxDepth: opts.maxDepth,
            maxNodes: opts.limit,
            maxTokens: opts.maxTokens,
            urls: opts.urls,
            filter: opts.filter,
          }),
          ...(ctx.params.includeNodes === true ? { nodes } : {}),
        };
      }
      return { url, title, ...(siteNotes.length > 0 ? { siteNotes } : {}), nodes };
    },
  },
  'browser.read': {
    kind: 'read',
    summary: '抽取页面干净正文、大纲、过滤行、结构化 JSON 与链接（支持 Shadow DOM 与 llms.txt）',
    params: ['id', 'selector?', 'data?', 'links?', 'scroll?', 'match?', 'outline?', 'filter?', 'llms?'],
    gate: 'custom',
    wake: true,
    handler: (ctx) => {
      const id = ctx.str('id');
      // --scroll 会修改页面滚动位置，属于写副作用，必须持有有效 lease
      if (ctx.params.scroll) ctx.assertWritable(id);
      const c = ctx.controller(id);
      const siteNotes = ctx.deps.store.matchSiteNotesForUrl?.(c.currentUrl()) ?? [];
      return readPage(c, {
        selector: ctx.optStr('selector'),
        data: Boolean(ctx.params.data),
        links:
          typeof ctx.params.links === 'boolean' || typeof ctx.params.links === 'string' ? ctx.params.links : undefined,
        scroll: Boolean(ctx.params.scroll),
        match: ctx.optStr('match'),
        maxScrolls: ctx.num('maxScrolls'),
        outline: Boolean(ctx.params.outline),
        filter: ctx.optStr('filter'),
        llms: ctx.params.llms === 'index' || ctx.params.llms === 'full' ? ctx.params.llms : undefined,
        siteNotes,
      });
    },
  },
  'browser.get': {
    kind: 'read',
    summary: '读取页面或元素的 url/title/text/html/value/attr/box',
    params: ['id', 'prop', 'target?', 'attr?'],
    gate: 'read',
    wake: true,
    handler: (ctx) =>
      inspectPropOnClient(
        ctx.controller(),
        ctx.str('prop') as InspectProp,
        asOptionalTargetInput(ctx.params.target),
        ctx.optStr('attr'),
      ),
  },
  'browser.is': {
    kind: 'read',
    summary: '检查元素 visible/enabled/checked 状态',
    params: ['id', 'state', 'target'],
    gate: 'read',
    wake: true,
    handler: async (ctx) => ({
      ok: await inspectStateOnClient(
        ctx.controller(),
        ctx.str('state') as InspectState,
        asTargetInput(ctx.params.target),
      ),
    }),
  },
  'browser.diff': {
    kind: 'read',
    summary: '比对前后两次快照（含行级统一 Diff）或两张截图逐像素差异',
    params: ['id', 'kind?', 'a?', 'b?', 'interactiveOnly?', 'threshold?', 'outputPath?'],
    gate: 'read',
    wake: true,
    handler: async (ctx) => {
      if (ctx.params.kind === 'screenshot') {
        return diffScreenshots(ctx.str('a'), ctx.str('b'), {
          threshold: ctx.num('threshold'),
          outputPath: ctx.optStr('outputPath'),
        });
      }
      const id = ctx.str('id');
      const scopeKey = `${id}:${ctx.space}:${ctx.tab ?? 'active'}`;
      const c = ctx.controller(id);
      const prev = getLastSnapshot(scopeKey) ?? { url: '', title: '', nodes: [] };
      const nodes = await c.snapshot({ interactiveOnly: Boolean(ctx.params.interactiveOnly) });
      const next = { url: c.currentUrl(), title: await c.title(), nodes };
      rememberSnapshot(scopeKey, next);
      return diffSnapshots(prev, next);
    },
  },
  'browser.screenshot': {
    kind: 'read',
    summary: '截图落盘并返回元数据（支持 --annotate 临时编号标注）',
    params: ['id', 'path?', 'fullPage?', 'format?', 'encoding?', 'annotate?'],
    gate: 'read',
    wake: true,
    handler: async (ctx) => {
      const id = ctx.str('id');
      const controller = ctx.controller(id);
      const temporary = ctx.deps.manager.ensureOperable(id, ctx.space);
      let emulatedViewport = false;
      try {
        await ctx.deps.manager.ensureRenderFocus(id, ctx.space);
        if (temporary) emulatedViewport = await ctx.deps.manager.prepareBackgroundInput(id, ctx.space);
        return await controller.screenshot(asScreenshotOptions(ctx.params));
      } finally {
        if (emulatedViewport) await ctx.deps.manager.clearBackgroundInput(id, ctx.space);
        if (temporary) ctx.deps.manager.detachOperable(id, ctx.space);
      }
    },
  },
  'browser.highlight': {
    kind: 'read',
    summary: '在页面绘制高亮边框',
    params: ['id', 'target?'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.controller().highlight(asOptionalTargetInput(ctx.params.target)),
  },
  'browser.frame.list': {
    kind: 'read',
    summary: '列出页面所有 frame（含 OOPIF）',
    params: ['id'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.controller().listFrames(),
  },
  'browser.webmcp.list': {
    kind: 'read',
    summary: '发现当前页面声明的 WebMCP 工具（untrusted）',
    params: ['id'],
    gate: 'read',
    wake: true,
    handler: (ctx) => listWebMcpTools(ctx.controller().page),
  },
  'browser.vitals': {
    kind: 'read',
    summary: '采集页面 Core Web Vitals 与性能指标',
    params: ['id'],
    gate: 'read',
    wake: true,
    handler: (ctx) => collectVitals(ctx.controller().page),
  },
  'browser.a11y': {
    kind: 'read',
    summary: '执行结构化无障碍审计（WCAG）',
    params: ['id'],
    gate: 'read',
    wake: true,
    handler: (ctx) => auditAccessibility(ctx.controller().page),
  },
  'browser.react': {
    kind: 'read',
    summary: '只读检视 React Fiber 组件树与脱敏 props 键',
    params: ['id', 'maxNodes?'],
    gate: 'read',
    wake: true,
    handler: (ctx) => inspectReactTree(ctx.controller().page, { maxNodes: ctx.num('maxNodes') }),
  },
  'browser.waitFor': {
    kind: 'read',
    summary: '等待页面满足谓词条件',
    params: ['id', 'predicate', 'timeoutMs?'],
    gate: 'read',
    wake: true,
    handler: async (ctx) => {
      await ctx.controller().waitFor(asWaitPredicate(ctx.params.predicate), { timeoutMs: ctx.num('timeoutMs') });
      return { ok: true };
    },
  },
  'browser.waitForURL': {
    kind: 'read',
    summary: '等待 URL 匹配指定规则',
    params: ['id', 'matcher', 'timeoutMs?'],
    gate: 'read',
    wake: true,
    handler: (ctx) =>
      ctx.controller().waitForURL(asUrlMatcher(ctx.params.matcher), { timeoutMs: ctx.num('timeoutMs') }),
  },
  'browser.waitForSelector': {
    kind: 'read',
    summary: '等待元素达到指定状态（attached/visible/enabled...）',
    params: ['id', 'target', 'state?', 'timeoutMs?'],
    gate: 'read',
    wake: true,
    handler: (ctx) =>
      ctx.controller().waitForSelector(asTargetInput(ctx.params.target), {
        state: asSelectorState(ctx.params.state),
        timeoutMs: ctx.num('timeoutMs'),
      }),
  },
  'browser.waitForFunction': {
    kind: 'read',
    summary: '轮询等待页面内 JS 函数返回真值',
    params: ['id', 'fn', 'arg?', 'timeoutMs?', 'polling?'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.controller().waitForFunction(ctx.str('fn'), ctx.params.arg, asWaitOptions(ctx.params)),
  },
  'browser.waitForLoadState': {
    kind: 'read',
    summary: '等待页面加载状态（commit/domcontentloaded/load/networkidle）',
    params: ['id', 'state?', 'timeoutMs?', 'idleMs?'],
    gate: 'read',
    wake: true,
    handler: async (ctx) => {
      await ctx.controller().waitForLoadState(asLoadState(ctx.params.state), {
        timeoutMs: ctx.num('timeoutMs'),
        idleMs: ctx.num('idleMs'),
      });
      return { ok: true };
    },
  },
  'browser.waitForTimeout': {
    kind: 'read',
    summary: '等待固定毫秒数',
    params: ['id', 'ms?'],
    gate: 'read',
    wake: true,
    handler: async (ctx) => {
      await ctx.controller().waitForTimeout(ctx.num('ms') ?? 0);
      return { ok: true };
    },
  },
  'browser.waitForEvent': {
    kind: 'read',
    summary: '等待 popup / download / dialog / fileChooser 事件',
    params: ['id', 'kind', 'timeoutMs?'],
    gate: 'read',
    wake: true,
    handler: (ctx) =>
      ctx.controller().waitForEvent(asWaitEventKind(ctx.params.kind), { timeoutMs: ctx.num('timeoutMs') }),
  },
  'browser.info': {
    kind: 'read',
    summary: '查看 URL/标题/加载态/弹窗',
    params: ['id'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.controller().info(),
  },
  'browser.detectLoginFields': {
    kind: 'read',
    summary: '隔离世界探测当前页登录输入框与提交按钮',
    params: ['id', 'space?'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.controller().detectLoginFields(),
  },
  'browser.events': {
    kind: 'read',
    summary: '读取并消费弹窗/弹出标签/下载队列',
    params: ['id'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.controller().events(),
  },
  'browser.downloadStatus': {
    kind: 'read',
    summary: '查询下载任务进度与保存路径',
    params: ['id', 'downloadId'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.controller().downloadStatus(ctx.str('downloadId')),
  },
  'browser.console': {
    kind: 'read',
    summary: '查看页面 Console 摘要',
    params: ['id'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.deps.manager.consoleEntries(ctx.str('id')),
  },
  'browser.network': {
    kind: 'read',
    summary: '查看页面网络请求摘要',
    params: ['id'],
    gate: 'read',
    wake: true,
    handler: (ctx) => ctx.deps.manager.networkEntries(ctx.str('id')),
  },
};
