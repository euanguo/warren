/**
 * 浏览器观测、导航、动作、等待、差异对比与批处理 CLI 命令组。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { usageOf } from '../commands.mjs';
import { formatActionResultText, formatBatchResultText } from '../delta-formatter.mjs';
import {
  emitUntrustedText,
  formatFrameLine,
  formatScreenshotLine,
  parseJsonArg,
  parseKvFlags,
  print,
} from '../formatters.mjs';
import { createOutputBuffer, isHardStopError } from '../output-buffer.mjs';
import { toCsv } from '../output-guard.mjs';

export async function runBatchCommand({ args, flags, asJson, call, readStdin, withLease }) {
  const environmentId = args[1] ?? process.env.WARREN_ENV;
  if (!environmentId) {
    console.error(
      "用法: warren batch <env> [--bail] [--no-changes] [--no-text] [--auto-dialog=accept|dismiss] [--json] <<'EOF' ... EOF",
    );
    return 1;
  }
  const raw = (await readStdin()).trim();
  if (!raw) {
    console.error('BAD_REQUEST: batch 需要从 stdin 传入步骤列表（逐行命令或 JSON 数组）');
    return 1;
  }
  const params = raw.startsWith('[') ? { steps: parseJsonArg(raw, 'batch steps') } : { script: raw };
  const result = await withLease(environmentId, flags, 'warren batch', (leaseId) =>
    call('browser.batch', {
      id: environmentId,
      leaseId,
      bail: Boolean(flags.bail),
      noChanges: Boolean(flags['no-changes']),
      noText: Boolean(flags['no-text']),
      ...(typeof flags['auto-dialog'] === 'string' ? { autoDialog: flags['auto-dialog'] } : {}),
      ...params,
    }),
  );
  if (asJson) {
    print(result, true);
  } else if (result?.hardStop && isHardStopError(result.hardStop.code)) {
    const buf = createOutputBuffer();
    buf.markHardStop(result.hardStop, { completedSteps: result.hardStop.completedSteps });
    emitUntrustedText(buf.render(), flags, { source: 'batch-hard-stop', url: result.delta?.url });
  } else {
    emitUntrustedText(formatBatchResultText(result), flags, { source: 'batch', url: result?.delta?.url });
  }
  return result && result.ok === false ? 1 : 0;
}

export async function runBrowserCommand({ args, flags, asJson, call, readStdin, withLease }) {
  const sub = args[1];
  const environmentId = args[2] ?? process.env.WARREN_ENV;
  const autoDialogOpt = typeof flags['auto-dialog'] === 'string' ? { autoDialog: flags['auto-dialog'] } : {};
  const commonTimeout = typeof flags.timeout === 'string' ? { timeoutMs: Number(flags.timeout) } : {};
  const deltaOpt = {
    includeDelta: !flags['no-changes'],
    includeText: !flags['no-text'],
  };
  const emitAction = (label, res) => {
    if (asJson) {
      print(res, true);
      return;
    }
    emitUntrustedText(formatActionResultText(label, res), flags, {
      source: 'action',
      url: res?.delta?.url ?? res?.url,
    });
  };
  const emitObserved = (source, value) => {
    if (asJson) {
      print(value, true);
      return;
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    emitUntrustedText(text, flags, { source });
  };

  switch (sub) {
    case 'open': {
      const navRes = await withLease(environmentId, flags, 'warren browser open', (leaseId) =>
        call('browser.navigate', {
          id: environmentId,
          leaseId,
          url: args[3],
          waitUntil: typeof flags['wait-until'] === 'string' ? flags['wait-until'] : undefined,
          ...(flags.read ? {} : deltaOpt),
          ...commonTimeout,
        }),
      );
      if (flags.read) {
        const readRes = await call('browser.read', {
          id: environmentId,
          selector: typeof flags.selector === 'string' ? flags.selector : undefined,
          outline: Boolean(flags.outline),
          filter: typeof flags.filter === 'string' ? flags.filter : undefined,
        });
        if (asJson) print({ navigation: navRes, read: readRes }, true);
        else emitUntrustedText(readRes.text ?? '', flags, { source: 'read', url: readRes.url });
      } else {
        emitAction(`open ${args[3] ?? ''}`.trim(), navRes);
      }
      return 0;
    }
    case 'back':
      emitAction(
        'back',
        await withLease(environmentId, flags, 'warren browser back', (leaseId) =>
          call('browser.goBack', { id: environmentId, leaseId, ...deltaOpt }),
        ),
      );
      return 0;
    case 'forward':
      emitAction(
        'forward',
        await withLease(environmentId, flags, 'warren browser forward', (leaseId) =>
          call('browser.goForward', { id: environmentId, leaseId, ...deltaOpt }),
        ),
      );
      return 0;
    case 'reload':
      emitAction(
        'reload',
        await withLease(environmentId, flags, 'warren browser reload', (leaseId) =>
          call('browser.reload', {
            id: environmentId,
            leaseId,
            waitUntil: typeof flags['wait-until'] === 'string' ? flags['wait-until'] : undefined,
            ...deltaOpt,
            ...commonTimeout,
          }),
        ),
      );
      return 0;
    case 'click': {
      const target = args[3];
      if (!target) {
        console.error('用法: warren browser click <env> <target> [--new-tab] [--humanize] [--no-wait] [--no-changes]');
        return 1;
      }
      emitAction(
        `click ${target}`,
        await withLease(environmentId, flags, 'warren browser click', (leaseId) =>
          call('browser.click', {
            id: environmentId,
            leaseId,
            target,
            button: typeof flags.button === 'string' ? flags.button : undefined,
            newTab: Boolean(flags['new-tab']),
            humanize: flags.humanize ? true : undefined,
            noWaitAfter: Boolean(flags['no-wait']),
            ...deltaOpt,
            ...autoDialogOpt,
            ...commonTimeout,
          }),
        ),
      );
      return 0;
    }
    case 'dblclick': {
      const target = args[3];
      if (!target) {
        console.error('用法: warren browser dblclick <env> <target>');
        return 1;
      }
      emitAction(
        `dblclick ${target}`,
        await withLease(environmentId, flags, 'warren browser dblclick', (leaseId) =>
          call('browser.dblclick', {
            id: environmentId,
            leaseId,
            target,
            humanize: flags.humanize ? true : undefined,
            noWaitAfter: Boolean(flags['no-wait']),
            ...deltaOpt,
            ...autoDialogOpt,
            ...commonTimeout,
          }),
        ),
      );
      return 0;
    }
    case 'hover': {
      const target = args[3];
      if (!target) {
        console.error('用法: warren browser hover <env> <target>');
        return 1;
      }
      emitAction(
        `hover ${target}`,
        await withLease(environmentId, flags, 'warren browser hover', (leaseId) =>
          call('browser.hover', {
            id: environmentId,
            leaseId,
            target,
            humanize: flags.humanize ? true : undefined,
            ...deltaOpt,
            ...autoDialogOpt,
            ...commonTimeout,
          }),
        ),
      );
      return 0;
    }
    case 'focus': {
      const target = args[3];
      if (!target) {
        console.error('用法: warren browser focus <env> <target>');
        return 1;
      }
      emitAction(
        `focus ${target}`,
        await withLease(environmentId, flags, 'warren browser focus', (leaseId) =>
          call('browser.focus', {
            id: environmentId,
            leaseId,
            target,
            ...deltaOpt,
            ...autoDialogOpt,
            ...commonTimeout,
          }),
        ),
      );
      return 0;
    }
    case 'fill': {
      const target = args[3];
      const value = args[4];
      if (!target || value === undefined) {
        console.error('用法: warren browser fill <env> <target> <value> [--submit] [--clear=false]');
        return 1;
      }
      emitAction(
        `fill ${target}`,
        await withLease(environmentId, flags, 'warren browser fill', (leaseId) =>
          call('browser.fill', {
            id: environmentId,
            leaseId,
            target,
            value,
            submit: Boolean(flags.submit),
            clearFirst: flags.clear === 'false' ? false : undefined,
            ...deltaOpt,
            ...autoDialogOpt,
            ...commonTimeout,
          }),
        ),
      );
      return 0;
    }
    case 'type': {
      const target = args[3];
      const text = args[4];
      if (!target || text === undefined) {
        console.error('用法: warren browser type <env> <target> <text> [--delay=30]');
        return 1;
      }
      emitAction(
        `type ${target}`,
        await withLease(environmentId, flags, 'warren browser type', async (leaseId) => {
          await call('browser.focus', { id: environmentId, leaseId, target, ...autoDialogOpt, ...commonTimeout });
          return call('browser.keyboardType', {
            id: environmentId,
            leaseId,
            text,
            delay: typeof flags.delay === 'string' ? Number(flags.delay) : undefined,
            ...autoDialogOpt,
          });
        }),
      );
      return 0;
    }
    case 'press': {
      const hasTarget = args.length >= 5;
      const target = hasTarget ? args[3] : undefined;
      const key = hasTarget ? args[4] : args[3];
      if (!key) {
        console.error('用法: warren browser press <env> [target] <chord>');
        return 1;
      }
      emitAction(
        `press ${key}`,
        await withLease(environmentId, flags, 'warren browser press', (leaseId) =>
          call('browser.press', {
            id: environmentId,
            leaseId,
            ...(target ? { target, chord: key } : { key }),
            delay: typeof flags.delay === 'string' ? Number(flags.delay) : undefined,
            ...deltaOpt,
            ...autoDialogOpt,
            ...commonTimeout,
          }),
        ),
      );
      return 0;
    }
    case 'check':
    case 'uncheck': {
      const target = args[3];
      if (!target) {
        console.error(`用法: warren browser ${sub} <env> <target>`);
        return 1;
      }
      emitAction(
        `${sub} ${target}`,
        await withLease(environmentId, flags, `warren browser ${sub}`, (leaseId) =>
          call(`browser.${sub}`, {
            id: environmentId,
            leaseId,
            target,
            ...deltaOpt,
            ...autoDialogOpt,
            ...commonTimeout,
          }),
        ),
      );
      return 0;
    }
    case 'select': {
      const target = args[3];
      const values = args.slice(4);
      if (!target || values.length === 0) {
        console.error('用法: warren browser select <env> <target> <value...> [--by=auto|value|label|index]');
        return 1;
      }
      const value = values.length === 1 ? values[0] : values;
      emitAction(
        `select ${target}`,
        await withLease(environmentId, flags, 'warren browser select', (leaseId) =>
          call('browser.selectOption', {
            id: environmentId,
            leaseId,
            target,
            value,
            by: typeof flags.by === 'string' ? flags.by : undefined,
            ...deltaOpt,
            ...autoDialogOpt,
            ...commonTimeout,
          }),
        ),
      );
      return 0;
    }
    case 'drag': {
      const source = args[3];
      const target = args[4];
      if (!source || !target) {
        console.error('用法: warren browser drag <env> <source> <target> [--placement=center|before|after]');
        return 1;
      }
      emitAction(
        `drag ${source} -> ${target}`,
        await withLease(environmentId, flags, 'warren browser drag', (leaseId) =>
          call('browser.drag', {
            id: environmentId,
            leaseId,
            source,
            target,
            placement: typeof flags.placement === 'string' ? flags.placement : undefined,
            steps: typeof flags.steps === 'string' ? Number(flags.steps) : undefined,
            ...deltaOpt,
            ...autoDialogOpt,
            ...commonTimeout,
          }),
        ),
      );
      return 0;
    }
    case 'drop': {
      const target = args[3];
      const files = args.slice(4).map((p) => path.resolve(p));
      if (!target || files.length === 0) {
        console.error('用法: warren browser drop <env> <target> <file...>');
        return 1;
      }
      emitAction(
        `drop ${target}`,
        await withLease(environmentId, flags, 'warren browser drop', (leaseId) =>
          call('browser.drop', {
            id: environmentId,
            leaseId,
            target,
            paths: files,
            ...deltaOpt,
            ...autoDialogOpt,
            ...commonTimeout,
          }),
        ),
      );
      return 0;
    }
    case 'scroll': {
      const dirRaw = (args[3] ?? 'down').toLowerCase();
      const isDir = dirRaw === 'up' || dirRaw === 'down' || dirRaw === 'left' || dirRaw === 'right';
      const amount = Number(isDir ? (args[4] ?? 500) : (args[3] ?? 500));
      const px = Number.isFinite(amount) ? amount : 500;
      const deltaX = dirRaw === 'left' ? -px : dirRaw === 'right' ? px : 0;
      const deltaY = dirRaw === 'up' ? -px : dirRaw === 'down' || !isDir ? px : 0;
      print(
        await withLease(environmentId, flags, 'warren browser scroll', (leaseId) =>
          call('browser.mouseWheel', { id: environmentId, leaseId, deltaX, deltaY, ...autoDialogOpt }),
        ),
        asJson,
      );
      return 0;
    }
    case 'scrollintoview': {
      const target = args[3];
      if (!target) {
        console.error('用法: warren browser scrollintoview <env> <target>');
        return 1;
      }
      print(
        await withLease(environmentId, flags, 'warren browser scrollintoview', (leaseId) =>
          call('browser.scrollIntoView', { id: environmentId, leaseId, target, ...autoDialogOpt }),
        ),
        asJson,
      );
      return 0;
    }
    case 'upload': {
      const target = args[3];
      const files = args.slice(4).map((p) => path.resolve(p));
      if (!target || files.length === 0) {
        console.error('用法: warren browser upload <env> <target> <file...>');
        return 1;
      }
      emitAction(
        `upload ${target}`,
        await withLease(environmentId, flags, 'warren browser upload', (leaseId) =>
          call('browser.setInputFiles', {
            id: environmentId,
            leaseId,
            target,
            paths: files,
            ...deltaOpt,
            ...autoDialogOpt,
          }),
        ),
      );
      return 0;
    }
    case 'download': {
      const action = args[3];
      const downloadId = args[4];
      if (!action || !downloadId) {
        console.error('用法: warren browser download <env> <status|save|cancel> <downloadId> [destPath]');
        return 1;
      }
      if (action === 'status') {
        print(await call('browser.downloadStatus', { id: environmentId, downloadId }), asJson);
        return 0;
      }
      if (action === 'save') {
        const dest = args[5] ? path.resolve(args[5]) : undefined;
        if (!dest) {
          console.error('用法: warren browser download <env> save <downloadId> <destPath>');
          return 1;
        }
        print(
          await withLease(environmentId, flags, 'warren browser download save', (leaseId) =>
            call('browser.downloadSaveAs', { id: environmentId, leaseId, downloadId, path: dest }),
          ),
          asJson,
        );
        return 0;
      }
      if (action === 'cancel') {
        print(
          await withLease(environmentId, flags, 'warren browser download cancel', (leaseId) =>
            call('browser.downloadCancel', { id: environmentId, leaseId, downloadId }),
          ),
          asJson,
        );
        return 0;
      }
      console.error('用法: warren browser download <env> <status|save|cancel> <downloadId> [destPath]');
      return 1;
    }
    case 'wait': {
      const arg3 = args[3];
      if (typeof flags.text === 'string') {
        print(
          await call('browser.waitFor', { id: environmentId, predicate: { text: flags.text }, ...commonTimeout }),
          asJson,
        );
      } else if (typeof flags.url === 'string') {
        print(await call('browser.waitForURL', { id: environmentId, matcher: flags.url, ...commonTimeout }), asJson);
      } else if (typeof flags.load === 'string') {
        print(
          await call('browser.waitForLoadState', { id: environmentId, state: flags.load, ...commonTimeout }),
          asJson,
        );
      } else if (typeof flags.fn === 'string') {
        print(await call('browser.waitForFunction', { id: environmentId, fn: flags.fn, ...commonTimeout }), asJson);
      } else if (typeof flags.event === 'string') {
        print(await call('browser.waitForEvent', { id: environmentId, kind: flags.event, ...commonTimeout }), asJson);
      } else if (arg3 && /^\d+$/.test(arg3)) {
        print(await call('browser.waitForTimeout', { id: environmentId, ms: Number(arg3) }), asJson);
      } else if (arg3) {
        print(
          await call('browser.waitForSelector', {
            id: environmentId,
            target: arg3,
            state: typeof flags.state === 'string' ? flags.state : undefined,
            ...commonTimeout,
          }),
          asJson,
        );
      } else {
        console.error(
          '用法: warren browser wait <env> <ms|selector> [--state=visible] [--text=...] [--url=...] [--load=networkidle] [--fn=...] [--event=download]',
        );
        return 1;
      }
      return 0;
    }
    case 'dialog': {
      const action = args[3];
      if (action === 'accept') {
        emitAction(
          'dialog accept',
          await withLease(environmentId, flags, 'warren browser dialog accept', (leaseId) =>
            call('browser.acceptDialog', { id: environmentId, leaseId, prompt: args[4], ...deltaOpt }),
          ),
        );
        return 0;
      }
      if (action === 'dismiss') {
        emitAction(
          'dialog dismiss',
          await withLease(environmentId, flags, 'warren browser dialog dismiss', (leaseId) =>
            call('browser.dismissDialog', { id: environmentId, leaseId, ...deltaOpt }),
          ),
        );
        return 0;
      }
      if (action === 'policy') {
        print(
          await withLease(environmentId, flags, 'warren browser dialog policy', (leaseId) =>
            call('browser.dialogPolicy', { id: environmentId, leaseId, policy: args[4] ?? 'none' }),
          ),
          asJson,
        );
        return 0;
      }
      console.error('用法: warren browser dialog <env> <accept [prompt]|dismiss|policy <none|accept|dismiss>>');
      return 1;
    }
    case 'eval': {
      const expr = args.slice(3).join(' ') || (await readStdin()).trim();
      if (!expr) {
        console.error('用法: warren browser eval <env> <jsExpr>');
        return 1;
      }
      const fn = /^\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function\b)/.test(expr) ? expr : `() => (${expr})`;
      emitObserved(
        'eval',
        await withLease(environmentId, flags, 'warren browser eval', (leaseId) =>
          call('browser.evaluate', { id: environmentId, leaseId, fn, ...commonTimeout }),
        ),
      );
      return 0;
    }
    case 'frame': {
      const action = args[3] ?? 'list';
      if (action === 'list') {
        print(await call('browser.frame.list', { id: environmentId }), asJson, formatFrameLine);
        return 0;
      }
      const target = action === 'select' ? args[4] : action;
      if (!target) {
        console.error('用法: warren browser frame <env> <list|main|index|frameId|urlSubstr>');
        return 1;
      }
      print(
        await withLease(environmentId, flags, 'warren browser frame', (leaseId) =>
          call('browser.frame.select', { id: environmentId, leaseId, target }),
        ),
        asJson,
      );
      return 0;
    }
    case 'pdf': {
      const outPath = args[3] ?? (typeof flags.output === 'string' ? flags.output : undefined);
      if (!outPath) {
        console.error('用法: warren browser pdf <env> <output.pdf> [--landscape] [--no-background] [--scale=1]');
        return 1;
      }
      print(
        await withLease(environmentId, flags, 'warren browser pdf', (leaseId) =>
          call('browser.pdf', {
            id: environmentId,
            leaseId,
            path: path.resolve(outPath),
            landscape: Boolean(flags.landscape),
            printBackground: !flags['no-background'],
            scale: typeof flags.scale === 'string' ? Number(flags.scale) : undefined,
          }),
        ),
        asJson,
      );
      return 0;
    }
    case 'set': {
      const kind = args[3];
      let setting;
      if (kind === 'viewport') {
        setting = {
          kind: 'viewport',
          width: Number(args[4]),
          height: Number(args[5]),
          dpr: typeof flags.dpr === 'string' ? Number(flags.dpr) : undefined,
          mobile: Boolean(flags.mobile),
        };
      } else if (kind === 'device') {
        setting = { kind: 'device', device: args[4] ?? '' };
      } else if (kind === 'geo') {
        setting = {
          kind: 'geo',
          latitude: Number(args[4]),
          longitude: Number(args[5]),
          accuracy: args[6] ? Number(args[6]) : undefined,
        };
      } else if (kind === 'offline') {
        setting = { kind: 'offline', offline: args[4] !== 'off' && args[4] !== 'false' };
      } else if (kind === 'headers') {
        setting = { kind: 'headers', headers: parseJsonArg(args[4] ?? '{}', 'headers json') };
      } else if (kind === 'media') {
        const val = (args[4] ?? '').toLowerCase();
        setting = {
          kind: 'media',
          ...(val === 'dark' || val === 'light' || val === 'no-preference' ? { colorScheme: val } : {}),
          ...(val === 'reduced-motion' || val === 'reduce' ? { reducedMotion: 'reduce' } : {}),
        };
      } else if (kind === 'tz') {
        setting = { kind: 'tz', timezoneId: args[4] ?? '' };
      } else if (kind === 'locale') {
        setting = { kind: 'locale', locale: args[4] ?? '' };
      } else if (kind === 'reset') {
        setting = { kind: 'reset' };
      } else {
        console.error(
          '用法: warren browser set <env> <viewport <w> <h>|device <name>|geo <lat> <lng>|offline <on|off>|headers <json>|media <dark|light|reduced-motion>|tz <iana>|locale <tag>|reset>',
        );
        return 1;
      }
      print(
        await withLease(environmentId, flags, `warren browser set ${kind}`, (leaseId) =>
          call('browser.set', { id: environmentId, leaseId, setting }),
        ),
        asJson,
      );
      return 0;
    }
    case 'webmcp': {
      const action = args[3] ?? 'list';
      if (action === 'list') {
        print(await call('browser.webmcp.list', { id: environmentId }), asJson);
        return 0;
      }
      if (action === 'call') {
        const tool = args[4];
        if (!tool) {
          console.error("用法: warren browser webmcp <env> call <tool> [--args='{}']");
          return 1;
        }
        const toolArgs = typeof flags.args === 'string' ? parseJsonArg(flags.args, '--args') : {};
        print(
          await withLease(environmentId, flags, `warren browser webmcp call ${tool}`, (leaseId) =>
            call('browser.webmcp.call', { id: environmentId, leaseId, tool, args: toolArgs }),
          ),
          asJson,
        );
        return 0;
      }
      console.error("用法: warren browser webmcp <env> <list|call <tool> [--args='{}']>");
      return 1;
    }
    case 'vitals':
      emitObserved('vitals', await call('browser.vitals', { id: environmentId }));
      return 0;
    case 'a11y':
      emitObserved('a11y', await call('browser.a11y', { id: environmentId }));
      return 0;
    case 'react':
      emitObserved(
        'react',
        await call('browser.react', {
          id: environmentId,
          maxNodes: typeof flags['max-nodes'] === 'string' ? Number(flags['max-nodes']) : undefined,
        }),
      );
      return 0;
    case 'snapshot': {
      const compact = Boolean(flags.interactive || flags.compact) && !asJson;
      const scope =
        typeof flags.scope === 'string'
          ? flags.scope
          : flags.viewport
            ? 'viewport'
            : flags['full-page']
              ? 'full_page'
              : undefined;
      const res = await call('browser.snapshot', {
        id: environmentId,
        scope,
        limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
        maxDepth: typeof flags.depth === 'string' ? Number(flags.depth) : undefined,
        maxTokens: typeof flags['max-tokens'] === 'string' ? Number(flags['max-tokens']) : undefined,
        compact: Boolean(flags.interactive || flags.compact),
        includeNodes: asJson ? true : undefined,
        urls: Boolean(flags.urls),
        boxes: Boolean(flags.boxes),
        includeCursor: flags.cursor ? true : undefined,
        filter: typeof flags.filter === 'string' ? flags.filter : undefined,
        noFold: Boolean(flags['no-fold']),
        includeActionMarks: Boolean(flags['action-marks']),
        includeStableLocator: Boolean(flags.locator),
        interactiveOnly: Boolean(flags.interactive),
        selector: typeof flags.selector === 'string' ? flags.selector : undefined,
      });
      if (compact && typeof res.compact === 'string')
        emitUntrustedText(res.compact, flags, { source: 'snapshot', url: res.url });
      else print(res, asJson);
      return 0;
    }
    case 'read': {
      const extraUrls = args.slice(3).filter((u) => /^https?:\/\//i.test(u));
      if (flags.stdin) {
        const stdinText = await readStdin();
        for (const line of stdinText.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (/^https?:\/\//i.test(trimmed)) extraUrls.push(trimmed);
        }
      }
      const fields =
        typeof flags.fields === 'string'
          ? flags.fields
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
      const where = flags.where ? parseKvFlags(flags.where) : undefined;
      const readOpts = {
        selector: typeof flags.selector === 'string' ? flags.selector : undefined,
        data: Boolean(flags.data),
        links: flags.links,
        scroll: Boolean(flags.scroll),
        match: typeof flags.match === 'string' ? flags.match : undefined,
        outline: Boolean(flags.outline),
        filter: typeof flags.filter === 'string' ? flags.filter : undefined,
        llms: typeof flags.llms === 'string' ? flags.llms : undefined,
        block: typeof flags.block === 'string' ? flags.block : undefined,
        fields,
        where: where && Object.keys(where).length > 0 ? where : undefined,
        limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
      };

      const emitBatchRead = (batch) => {
        const items = Array.isArray(batch?.items) ? batch.items : [];
        if (typeof flags.out === 'string' && flags.out.trim()) {
          const dest = path.resolve(flags.out.trim());
          mkdirSync(path.dirname(dest), { recursive: true });
          const body = dest.endsWith('.csv')
            ? toCsv(
                items.map((r) => ({
                  url: r.url,
                  ok: r.ok,
                  title: r.title ?? '',
                  text: r.text ?? '',
                  error: r.error ?? '',
                })),
              )
            : JSON.stringify(batch, null, 2);
          writeFileSync(dest, body + '\n', 'utf8');
          print(
            { out: dest, total: batch.total, ok: batch.ok, failed: batch.failed, durationMs: batch.durationMs },
            asJson,
          );
        } else if (asJson) {
          print(batch, true);
        } else {
          const blocks = [
            `read-batch: ${batch.ok}/${batch.total} ok (concurrency=${batch.concurrency}, ${batch.durationMs}ms)`,
            ...items.map((it) =>
              it.ok
                ? `\n=== ${it.title || it.url} (${it.url}) ===\n${it.text ?? ''}`
                : `\n=== [FAILED] ${it.url} ===\n${it.error ?? 'unknown error'}`,
            ),
          ];
          emitUntrustedText(blocks.join('\n'), flags, { source: 'read-batch' });
        }
      };

      const batchParams = {
        concurrency: typeof flags.concurrency === 'string' ? Number(flags.concurrency) : undefined,
        ...commonTimeout,
        selector: readOpts.selector,
        data: readOpts.data,
        links: readOpts.links,
        outline: readOpts.outline,
        filter: readOpts.filter,
        block: readOpts.block,
        fields: readOpts.fields,
        where: readOpts.where,
        limit: readOpts.limit,
      };

      if (extraUrls.length > 0) {
        const batch = await call('browser.readBatch', {
          id: environmentId,
          urls: extraUrls,
          ...batchParams,
        });
        emitBatchRead(batch);
        return 0;
      }

      const res = readOpts.scroll
        ? await withLease(environmentId, flags, 'warren browser read --scroll', (leaseId) =>
            call('browser.read', { id: environmentId, leaseId, ...readOpts }),
          )
        : await call('browser.read', { id: environmentId, ...readOpts });

      if (
        typeof flags.links === 'string' &&
        flags.links.trim() &&
        !flags.list &&
        Array.isArray(res.links) &&
        res.links.length > 0
      ) {
        const urls = res.links
          .map((l) => l.href)
          .filter((u) => /^https?:\/\//i.test(u))
          .slice(0, 20);
        if (urls.length > 0) {
          const batch = await call('browser.readBatch', {
            id: environmentId,
            urls,
            ...batchParams,
            links: undefined,
          });
          emitBatchRead(batch);
          return 0;
        }
      }

      const textOut =
        res.siteNotes?.length && !asJson
          ? `# site-notes\n${res.siteNotes.map((n) => `- [${n.site}] ${n.content}`).join('\n')}\n\n${res.text}`
          : res.text;
      if (typeof flags.out === 'string' && flags.out.trim()) {
        const dest = path.resolve(flags.out.trim());
        mkdirSync(path.dirname(dest), { recursive: true });
        const body = dest.endsWith('.csv')
          ? toCsv(
              Array.isArray(res.dataSlice?.rows)
                ? res.dataSlice.rows
                : Array.isArray(res.links)
                  ? res.links
                  : Array.isArray(res.outline)
                    ? res.outline
                    : [{ url: res.url, title: res.title, text: res.text }],
            )
          : asJson || flags.data || flags.links || res.dataSlice
            ? JSON.stringify(res, null, 2)
            : textOut;
        writeFileSync(dest, body + '\n', 'utf8');
        print({ out: dest, bytes: Buffer.byteLength(body), url: res.url, title: res.title }, asJson);
      } else if (asJson) {
        print(res, true);
      } else if (res.dataSlice) {
        emitUntrustedText(JSON.stringify(res.dataSlice, null, 2), flags, { source: 'read-data', url: res.url });
      } else if (flags.data && res.dataSummary) {
        emitUntrustedText(
          JSON.stringify(
            {
              url: res.url,
              blocks: res.dataSummary,
              hint: '加 --block=<idx|source> --fields=... --where=k=v 切片读取',
            },
            null,
            2,
          ),
          flags,
          { source: 'read-data', url: res.url },
        );
      } else if (flags.data || flags.links) {
        emitUntrustedText(JSON.stringify(res, null, 2), flags, { source: 'read', url: res.url });
      } else {
        emitUntrustedText(textOut, flags, { source: 'read', url: res.url });
      }
      return 0;
    }
    case 'find': {
      const [, , , by, spec, action, val] = args;
      if (!by || !spec || !action) {
        console.error('用法: warren browser find <env> <by> <spec> <action> [value] [--name=...]');
        return 1;
      }
      const readActions = new Set(['text', 'html', 'value', 'attr', 'box', 'visible', 'enabled', 'checked']);
      const execFind = (leaseId) =>
        call('browser.find', {
          id: environmentId,
          leaseId,
          by,
          spec,
          action,
          value: val,
          name: typeof flags.name === 'string' ? flags.name : undefined,
          attr: typeof flags.attr === 'string' ? flags.attr : val,
          ...autoDialogOpt,
        });
      const out = readActions.has(action)
        ? await execFind(undefined)
        : await withLease(environmentId, flags, `warren browser find ${action}`, execFind);
      emitObserved('find', out);
      return 0;
    }
    case 'get': {
      const prop = args[3];
      if (!prop) {
        console.error('用法: warren browser get <env> <url|title|text|html|value|attr|box> [target] [--attr=name]');
        return 1;
      }
      emitObserved(
        'get',
        await call('browser.get', {
          id: environmentId,
          prop,
          target: args[4],
          attr: typeof flags.attr === 'string' ? flags.attr : args[5],
        }),
      );
      return 0;
    }
    case 'is': {
      const stateName = args[3];
      const target = args[4];
      if (!stateName || !target) {
        console.error('用法: warren browser is <env> <visible|enabled|checked> <target>');
        return 1;
      }
      print(await call('browser.is', { id: environmentId, state: stateName, target }), asJson);
      return 0;
    }
    case 'diff': {
      const kind = args[3] || 'snapshot';
      if (kind === 'screenshot') {
        const a = args[4];
        const b = args[5];
        if (!a || !b) {
          console.error(
            '用法: warren browser diff <env> screenshot <a.png> <b.png> [--threshold=0.05] [--output=diff.png]',
          );
          return 1;
        }
        const res = await call('browser.diff', {
          id: environmentId,
          kind: 'screenshot',
          a: path.resolve(a),
          b: path.resolve(b),
          threshold: typeof flags.threshold === 'string' ? Number(flags.threshold) : undefined,
          outputPath: typeof flags.output === 'string' ? path.resolve(flags.output) : undefined,
        });
        print(res, asJson);
        return res.match ? 0 : 1;
      }
      if (kind === 'urls') {
        const a = args[4];
        const b = args[5];
        if (!a || !b) {
          console.error('用法: warren browser diff <env> urls <urlA> <urlB> [-i]');
          return 1;
        }
        print(
          await withLease(environmentId, flags, 'warren browser diff urls', (leaseId) =>
            call('browser.diffUrls', {
              id: environmentId,
              leaseId,
              a,
              b,
              interactiveOnly: Boolean(flags.interactive),
            }),
          ),
          asJson,
        );
        return 0;
      }
      emitObserved(
        'diff',
        await call('browser.diff', {
          id: environmentId,
          kind: 'snapshot',
          interactiveOnly: Boolean(flags.interactive),
        }),
      );
      return 0;
    }
    case 'info':
      print(await call('browser.info', { id: environmentId }), asJson);
      return 0;
    case 'events':
      emitObserved('events', await call('browser.events', { id: environmentId }));
      return 0;
    case 'console':
      emitObserved('console', await call('browser.console', { id: environmentId }));
      return 0;
    case 'network':
      emitObserved('network', await call('browser.network', { id: environmentId }));
      return 0;
    case 'screenshot':
      print(
        await call('browser.screenshot', {
          id: environmentId,
          path: typeof flags.output === 'string' ? path.resolve(flags.output) : undefined,
          format: typeof flags.format === 'string' ? flags.format : undefined,
          fullPage: Boolean(flags['full-page']),
          encoding: flags.base64 === true ? 'base64' : undefined,
          annotate: Boolean(flags.annotate),
        }),
        asJson,
        formatScreenshotLine,
      );
      return 0;
    case 'highlight': {
      const target = args[3] ? { kind: 'selector', selector: args[3] } : undefined;
      print(await call('browser.highlight', { id: environmentId, target }), asJson);
      return 0;
    }
    case 'detect-login':
      print(await call('browser.detectLoginFields', { id: environmentId, space: flags.space }), asJson);
      return 0;
    default:
      console.error(usageOf('browser'));
      return 1;
  }
}
