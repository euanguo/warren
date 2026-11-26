/**
 * Whistle 代理插件前端（whistle@2.10.15 多面协同专业工作台）。
 *
 * 无构建步骤：普通 ESM，由主进程经 `warren-plugin://com.warren.whistle/app.js` 供给。
 * React 与组件库全部由宿主注入（`app.React` / `app.h` / `app.ui`）。
 *
 * 协同 5 个 UI 面：
 * 1. statusBadge (`proxy-badge`)：地址栏代理运行微标
 * 2. popover (`quick-proxy`)：地址栏代理快捷控制浮窗
 * 3. inspectorTab (`env-proxy`)：右侧工作台随页代理与实时抓包重放侧栏
 * 4. railPage (`proxy`)：全屏主从分栏代理工作台（规则 / Values / 预设 / 抓包与重放 / 诊断与意图）
 * 5. settingsSection (`about`)：Whistle 使用说明
 */
export default function register(app) {
  const { h, React, ui, rpc, shell, useSignal } = app;
  const { useCallback, useEffect, useState } = React;
  const {
    Alert,
    AlertDescription,
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertTitle,
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Checkbox,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
    Field,
    FieldLabel,
    Icon,
    IconButton,
    Input,
    ListRow,
    ListRowActionButton,
    ListRowActions,
    ListRowLabel,
    ListRowLabelText,
    ListRowMain,
    ListRowMeta,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Separator,
    StatusDot,
    Switch,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    Textarea,
    cardSurfaceClass,
    cn,
  } = ui;

  const CONTROLLED_GROUPS = ['warren-mock', 'warren-fault', 'warren-local'];
  const SCENARIO_LIST = [
    { id: 'online', label: '线上验证', desc: '仅启用预发布 CDN，不叠加测试后端或本地资源' },
    { id: 'test', label: '测试环境', desc: '启用后端与预发布 CDN 层' },
    { id: 'local', label: '本地验证', desc: '启用后端、预发布 CDN 与本地静态资源映射' },
    { id: 'preview', label: '预览验证', desc: '预发布 CDN，明确关闭本地资源替换' },
  ];
  const TRAFFIC_TYPES = ['ALL', 'JSON', 'HTML', 'JS', 'CSS', 'WS', 'SSE', 'Mock', 'Rules', 'Error', 'captureError'];
  const TRAFFIC_METHODS = ['ALL', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];

  function errorMessage(err) {
    return String((err && err.message) || err || '未知错误');
  }

  function notifySuccess(title, description) {
    shell.notify('success', title, description);
  }

  function notifyError(title, err) {
    shell.notify('error', title, errorMessage(err));
  }

  function notifyInfo(title, description) {
    shell.notify('info', title, description);
  }

  async function copyText(text, label) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(String(text));
      notifySuccess(`已复制${label}`);
    } catch (err) {
      notifyError(`复制${label}失败`, err);
    }
  }

  function suggestPatternFromUrl(rawUrl) {
    const text = String(rawUrl || '').trim();
    if (!text) return 'https://api.example.com/v1/';
    try {
      const parsed = new URL(text);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return `${parsed.origin}/api/`;
      }
      return parsed.host || 'https://api.example.com/v1/';
    } catch {
      return 'https://api.example.com/v1/';
    }
  }

  function suggestHostFromUrl(rawUrl) {
    const text = String(rawUrl || '').trim();
    if (!text) return 'app.example.com/static/';
    try {
      const parsed = new URL(text);
      return parsed.host ? `${parsed.host}/static/` : 'app.example.com/static/';
    } catch {
      return 'app.example.com/static/';
    }
  }

  function statusToneClass(code) {
    const num = Number(code);
    if (!num) return 'text-muted-foreground';
    if (num >= 200 && num < 300) return 'text-[var(--success)]';
    if (num >= 300 && num < 400) return 'text-[var(--info)]';
    if (num >= 400 && num < 500) return 'text-[var(--warning)]';
    return 'text-destructive';
  }

  function formatMs(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
    return `${Math.round(Number(ms))} ms`;
  }

  function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (!Number.isFinite(n) || n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(1)} KB`;
  }

  function formatJsonSafe(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function shortUrlPath(rawUrl) {
    try {
      const u = new URL(String(rawUrl));
      return `${u.host}${u.pathname}${u.search}`;
    } catch {
      return String(rawUrl || '');
    }
  }

  function controlledTag(name) {
    if (name === 'warren-mock') return 'Mock';
    if (name === 'warren-fault') return 'Fault';
    if (name === 'warren-local') return 'Local';
    return null;
  }

  function activeIntentGroups(rules) {
    if (!Array.isArray(rules)) return [];
    return rules.filter(
      (grp) => CONTROLLED_GROUPS.includes(grp.name) && (grp.selected || String(grp.data || '').trim().length > 0),
    );
  }

  function useSignalTick() {
    const [tick, setTick] = useState(0);
    useSignal('changed', () => setTick((t) => t + 1));
    return tick;
  }

  function useInstances(signalTick) {
    const [data, setData] = useState({ instances: [], stale: [], environments: [], w2: '' });
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [refreshCount, setRefreshCount] = useState(0);

    const reload = useCallback(() => {
      setRefreshCount((c) => c + 1);
    }, []);

    useEffect(() => {
      let cancelled = false;
      rpc
        .call('list')
        .then((next) => {
          if (cancelled) return;
          if (next && Array.isArray(next.instances)) setData(next);
          setError(null);
        })
        .catch((err) => {
          if (!cancelled) setError(errorMessage(err));
        });
      return () => {
        cancelled = true;
      };
    }, [signalTick, refreshCount]);

    const run = useCallback(async (work, failureTitle, successTitle, successDesc) => {
      setBusy(true);
      try {
        const result = await work();
        if (result && Array.isArray(result.instances)) setData(result);
        setError(null);
        if (successTitle) notifySuccess(successTitle, successDesc);
        return result;
      } catch (err) {
        notifyError(failureTitle, err);
        return null;
      } finally {
        setBusy(false);
      }
    }, []);

    return { ...data, error, busy, reload, run };
  }

  function useAgentControls(storage, alive, signalTick) {
    const [status, setStatus] = useState(null);
    const [toggling, setToggling] = useState(false);
    const [nonce, setNonce] = useState(0);

    useEffect(() => {
      if (!storage || !alive) return;
      let cancelled = false;
      rpc
        .call('agentStatus', { storage })
        .then((res) => {
          if (!cancelled) setStatus(res);
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
      return () => {
        cancelled = true;
      };
    }, [storage, alive, signalTick, nonce]);

    const liveStatus = storage && alive ? status : null;
    const httpsEnabled = Boolean(liveStatus?.https);
    const rulesEnabled = liveStatus?.rules ? liveStatus.rules.disabled !== true : true;

    const toggleHttps = async (next) => {
      if (!storage || !alive) return;
      setToggling(true);
      try {
        await rpc.call('agent', { storage, method: 'setEnableHTTPS', args: [Boolean(next)] });
        setNonce((n) => n + 1);
        notifySuccess(next ? '已开启 HTTPS 解密' : '已关闭 HTTPS 解密');
      } catch (err) {
        notifyError('切换 HTTPS 解密失败', err);
      } finally {
        setToggling(false);
      }
    };

    const toggleAllRules = async (next) => {
      if (!storage || !alive) return;
      setToggling(true);
      try {
        await rpc.call('agent', { storage, method: next ? 'rules.turnOn' : 'rules.turnOff', args: [] });
        setNonce((n) => n + 1);
        notifySuccess(next ? '已启用全局规则' : '已暂停全局规则');
      } catch (err) {
        notifyError('切换全局规则开关失败', err);
      } finally {
        setToggling(false);
      }
    };

    const refreshStatus = useCallback(() => setNonce((n) => n + 1), []);

    return {
      agentStatus: liveStatus,
      httpsEnabled,
      rulesEnabled,
      toggling,
      toggleHttps,
      toggleAllRules,
      refreshStatus,
    };
  }

  function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel = '确认',
    destructive = true,
    busy,
    onConfirm,
  }) {
    return h(
      AlertDialog,
      { open, onOpenChange },
      h(
        AlertDialogContent,
        null,
        h(
          AlertDialogHeader,
          null,
          h(AlertDialogTitle, null, title),
          description ? h(AlertDialogDescription, null, description) : null,
        ),
        h(
          AlertDialogFooter,
          null,
          h(AlertDialogCancel, { disabled: busy }, '取消'),
          h(
            AlertDialogAction,
            {
              variant: destructive ? 'destructive' : 'default',
              disabled: busy,
              onClick: async () => {
                await onConfirm();
                onOpenChange(false);
              },
            },
            confirmLabel,
          ),
        ),
      ),
    );
  }

  function NewInstanceDialog({
    environments,
    busy,
    run,
    defaultBindEnvId = '',
    compact = false,
    variant = 'default',
    triggerLabel = '新建实例',
    onCreated,
  }) {
    const [open, setOpen] = useState(false);
    const [storage, setStorage] = useState('');
    const [hostPattern, setHostPattern] = useState('');
    const [targetPort, setTargetPort] = useState('');
    const [bindTo, setBindTo] = useState(defaultBindEnvId);

    const handleOpenChange = (next) => {
      setOpen(next);
      if (next) {
        setStorage('');
        setHostPattern('');
        setTargetPort('');
        setBindTo(defaultBindEnvId || '');
      }
    };

    const create = async () => {
      const result = await run(
        () =>
          rpc.call('fork', {
            storage: storage.trim(),
            hostPattern: hostPattern.trim(),
            targetPort: Number(targetPort) || 0,
          }),
        '新建实例失败',
      );
      if (!result) return;
      const created = result.created;
      if (bindTo) {
        await run(() => rpc.call('bind', { storage: created.storage, environmentId: bindTo }), '绑定环境失败');
      }
      notifySuccess(`实例 ${created.storage} 已创建`, `端口 :${created.port}`);
      setOpen(false);
      onCreated?.(created);
    };

    return h(
      React.Fragment,
      null,
      h(
        Button,
        { size: compact ? 'xs' : 'sm', variant, onClick: () => handleOpenChange(true) },
        h(Icon, { name: 'Plus', className: 'size-3.5' }),
        triggerLabel,
      ),
      h(
        Dialog,
        { open, onOpenChange: handleOpenChange },
        h(
          DialogContent,
          null,
          h(
            'div',
            { 'data-slot': 'whistle-new', className: 'flex flex-col gap-4' },
            h(
              DialogHeader,
              null,
              h(DialogTitle, null, '新建 Whistle 代理实例'),
              h(DialogDescription, null, '一个实例 = 一个独立 whistle@2.10.15 进程：独立端口、规则、Values 与抓包。'),
            ),
            h(
              'div',
              { className: 'flex flex-col gap-3' },
              h(
                Field,
                null,
                h(FieldLabel, { htmlFor: 'whistle-storage' }, '实例名（storage）'),
                h(Input, {
                  id: 'whistle-storage',
                  value: storage,
                  onChange: (event) => setStorage(event.target.value),
                  placeholder: '例如 feat-a（留空自动起名）',
                }),
              ),
              h(
                Field,
                null,
                h(FieldLabel, { htmlFor: 'whistle-host' }, '初始映射域名/路径（可选）'),
                h(Input, {
                  id: 'whistle-host',
                  value: hostPattern,
                  onChange: (event) => setHostPattern(event.target.value),
                  placeholder: '例如 app.example.com/static/',
                }),
              ),
              h(
                Field,
                null,
                h(FieldLabel, { htmlFor: 'whistle-port' }, '本地服务端口（可选）'),
                h(Input, {
                  id: 'whistle-port',
                  value: targetPort,
                  onChange: (event) => setTargetPort(event.target.value),
                  placeholder: '例如 5173（搭配上方地址自动生成规则）',
                }),
              ),
              h(
                Field,
                null,
                h(FieldLabel, null, '创建后绑定到环境'),
                h(
                  Select,
                  { value: bindTo, onValueChange: (value) => setBindTo(value) },
                  h(
                    SelectTrigger,
                    null,
                    h(SelectValue, { placeholder: '先不绑定' }, (value) =>
                      value ? (environments.find((env) => env.id === value)?.name ?? String(value)) : '先不绑定',
                    ),
                  ),
                  h(
                    SelectContent,
                    null,
                    h(SelectItem, { value: '' }, '先不绑定'),
                    ...environments.map((env) => h(SelectItem, { key: env.id, value: env.id }, env.name)),
                  ),
                ),
              ),
            ),
            h(
              DialogFooter,
              null,
              h(Button, { variant: 'ghost', onClick: () => setOpen(false) }, '取消'),
              h(Button, { disabled: busy, onClick: create }, '创建实例'),
            ),
          ),
        ),
      ),
    );
  }

  function RuleMatchResultView({ result }) {
    if (!result) return null;
    const matched = Array.isArray(result.matched) ? result.matched : [];
    const effective = result.effectiveRules || { hosts: [], urls: [], protocols: {} };
    const protocolEntries = Object.entries(effective.protocols || {});
    return h(
      'div',
      {
        className: cn(cardSurfaceClass, 'flex min-w-0 flex-col gap-2 overflow-hidden text-xs'),
        'data-slot': 'whistle-rule-test-result',
      },
      h(
        'div',
        { className: 'flex items-center justify-between gap-2' },
        h('span', { className: 'font-medium text-foreground' }, `命中 ${matched.length} 条规则`),
        h('span', { className: 'font-mono text-[11px] text-muted-foreground' }, result.method || 'GET'),
      ),
      matched.length === 0
        ? h('p', { className: 'text-muted-foreground' }, '当前启用规则组未命中该 URL（将走直连或上游代理）。')
        : h(
            'div',
            { className: 'flex min-w-0 flex-col gap-1' },
            ...matched.map((item) =>
              h(
                'div',
                {
                  key: `${item.group}-${item.lineNumber}-${item.line}`,
                  className: 'flex min-w-0 flex-col gap-0.5 rounded-[var(--radius-sm)] bg-muted/40 px-2 py-1',
                },
                h(
                  'div',
                  { className: 'flex items-center gap-1.5' },
                  h(Badge, { variant: item.selected ? 'secondary' : 'outline' }, `${item.group}#L${item.lineNumber}`),
                  !item.selected
                    ? h('span', { className: 'text-[length:var(--font-size-micro)] text-[var(--warning)]' }, '未启用')
                    : null,
                ),
                h(
                  'code',
                  { className: 'break-words [overflow-wrap:anywhere] font-mono text-[11px] text-foreground' },
                  item.line,
                ),
              ),
            ),
          ),
      effective.hosts?.length || effective.urls?.length || protocolEntries.length
        ? h(
            'div',
            {
              className:
                'flex min-w-0 flex-wrap gap-1.5 border-t border-border pt-1.5 text-[11px] text-muted-foreground',
            },
            ...(effective.hosts || []).map((hostTarget) =>
              h(
                Badge,
                {
                  key: `h-${hostTarget}`,
                  variant: 'outline',
                  className: 'max-w-full justify-start',
                  title: `Host → ${hostTarget}`,
                },
                h('span', { className: 'min-w-0 truncate' }, `Host → ${hostTarget}`),
              ),
            ),
            ...(effective.urls || []).map((urlTarget) =>
              h(
                Badge,
                {
                  key: `u-${urlTarget}`,
                  variant: 'outline',
                  className: 'max-w-full justify-start',
                  title: `URL → ${urlTarget}`,
                },
                h('span', { className: 'min-w-0 truncate' }, `URL → ${urlTarget}`),
              ),
            ),
            ...protocolEntries.map(([proto, val]) =>
              h(
                Badge,
                {
                  key: `p-${proto}`,
                  variant: 'outline',
                  className: 'max-w-full justify-start font-mono',
                  title: `${proto}://${val}`,
                },
                h('span', { className: 'min-w-0 truncate' }, `${proto}://${val}`),
              ),
            ),
          )
        : null,
    );
  }

  function ReplayDiffView({ replayRes }) {
    if (!replayRes) return null;
    const orig = replayRes.original || {};
    const rep = replayRes.replayed || {};
    const diff = replayRes.diff;
    const jsonDiff = diff?.jsonDiff;
    const headersDiff = diff?.headersDiff;
    const addedHeaders = Object.entries(headersDiff?.added || {});
    const removedHeaders = Object.entries(headersDiff?.removed || {});
    const changedHeaders = Object.entries(headersDiff?.changed || {});

    return h(
      'div',
      { className: cn(cardSurfaceClass, 'flex flex-col gap-2 text-xs'), 'data-slot': 'whistle-replay-diff' },
      h(
        'div',
        { className: 'flex flex-wrap items-center gap-2' },
        h('span', { className: 'font-medium text-foreground' }, '重放结果对比'),
        h('span', { className: cn('font-mono', statusToneClass(orig.status)) }, `原 ${orig.status ?? '—'}`),
        h('span', { className: 'text-muted-foreground' }, '→'),
        h('span', { className: cn('font-mono font-medium', statusToneClass(rep.status)) }, `新 ${rep.status ?? '—'}`),
        diff
          ? h(
              Badge,
              { variant: diff.changed ? 'secondary' : 'outline', className: 'ml-auto' },
              diff.changed ? '响应存在差异' : '响应一致',
            )
          : null,
      ),
      addedHeaders.length || removedHeaders.length || changedHeaders.length
        ? h(
            'div',
            { className: 'flex flex-col gap-0.5 border-t border-border pt-1.5 font-mono text-[11px]' },
            h('span', { className: 'font-sans text-[11px] font-medium text-muted-foreground' }, '响应头差异：'),
            ...addedHeaders.map(([k, v]) =>
              h('div', { key: `ha-${k}`, className: 'text-[var(--success)]' }, `+ ${k}: ${v}`),
            ),
            ...removedHeaders.map(([k, v]) =>
              h('div', { key: `hr-${k}`, className: 'text-destructive' }, `- ${k}: ${v}`),
            ),
            ...changedHeaders.map(([k, v]) =>
              h('div', { key: `hc-${k}`, className: 'text-[var(--warning)]' }, `~ ${k}: ${v.from} → ${v.to}`),
            ),
          )
        : null,
      jsonDiff
        ? h(
            'div',
            { className: 'flex flex-col gap-0.5 border-t border-border pt-1.5 font-mono text-[11px]' },
            h('span', { className: 'font-sans text-[11px] font-medium text-muted-foreground' }, 'JSON 字段差异：'),
            jsonDiff.added.length === 0 && jsonDiff.removed.length === 0 && jsonDiff.changed.length === 0
              ? h('span', { className: 'font-sans text-muted-foreground' }, 'JSON 结构完全一致')
              : null,
            ...jsonDiff.added
              .slice(0, 12)
              .map((item) =>
                h(
                  'div',
                  { key: `ja-${item.path}`, className: 'break-all text-[var(--success)]' },
                  `+ ${item.path}: ${JSON.stringify(item.value)}`,
                ),
              ),
            ...jsonDiff.removed
              .slice(0, 12)
              .map((item) =>
                h(
                  'div',
                  { key: `jr-${item.path}`, className: 'break-all text-destructive' },
                  `- ${item.path}: ${JSON.stringify(item.value)}`,
                ),
              ),
            ...jsonDiff.changed
              .slice(0, 12)
              .map((item) =>
                h(
                  'div',
                  { key: `jc-${item.path}`, className: 'break-all text-[var(--warning)]' },
                  `~ ${item.path}: ${JSON.stringify(item.from)} → ${JSON.stringify(item.to)}`,
                ),
              ),
          )
        : rep.body !== undefined
          ? h(
              'pre',
              {
                className:
                  'max-h-36 overflow-auto rounded-[var(--radius-sm)] bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground',
              },
              formatJsonSafe(rep.json ?? rep.body),
            )
          : null,
    );
  }

  function QuickMockForm({ storage, defaultUrl, compact = false, onDone }) {
    const [pattern, setPattern] = useState(() => suggestPatternFromUrl(defaultUrl));
    const [statusCode, setStatusCode] = useState('200');
    const [delayMs, setDelayMs] = useState('0');
    const [cors, setCors] = useState(true);
    const [bodyText, setBodyText] = useState('{\n  "ok": true,\n  "mocked": true\n}');
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
      if (!storage || submitting) return;
      setSubmitting(true);
      try {
        let parsedBody = bodyText;
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          // 非 JSON 按纯文本下发
        }
        const res = await rpc.call('quickMock', {
          storage,
          pattern: pattern.trim(),
          body: parsedBody,
          statusCode: Number(statusCode) || 200,
          delayMs: Number(delayMs) || 0,
          cors,
        });
        notifySuccess('已写入并启用 Mock', res.ruleLine);
        onDone?.(res);
      } catch (err) {
        notifyError('写入 Mock 失败', err);
      } finally {
        setSubmitting(false);
      }
    };

    return h(
      'div',
      { className: 'flex flex-1 flex-col gap-2 text-xs' },
      h(
        Field,
        null,
        h(FieldLabel, null, '匹配 Pattern'),
        h(Input, {
          value: pattern,
          onChange: (e) => setPattern(e.target.value),
          placeholder: 'https://api.example.com/v1/user',
          className: 'font-mono text-xs',
        }),
      ),
      h(
        'div',
        { className: 'grid grid-cols-2 gap-2' },
        h(
          Field,
          null,
          h(FieldLabel, null, '状态码'),
          h(Input, {
            value: statusCode,
            onChange: (e) => setStatusCode(e.target.value),
            className: 'font-mono text-xs',
          }),
        ),
        h(
          Field,
          null,
          h(FieldLabel, null, '延迟 (ms)'),
          h(Input, { value: delayMs, onChange: (e) => setDelayMs(e.target.value), className: 'font-mono text-xs' }),
        ),
      ),
      h(
        Field,
        null,
        h(FieldLabel, null, '响应内容（JSON 或文本）'),
        h(Textarea, {
          value: bodyText,
          onChange: (e) => setBodyText(e.target.value),
          className: cn('font-mono text-xs', compact ? 'min-h-20' : 'min-h-28'),
        }),
      ),
      h(
        'div',
        { className: 'mt-auto flex items-center justify-between gap-2 pt-2' },
        h(
          'label',
          { className: 'flex items-center gap-1.5 text-xs text-muted-foreground' },
          h(Switch, { checked: cors, onCheckedChange: setCors }),
          h('span', null, '允许跨域 (resCors://*)'),
        ),
        h(
          Button,
          { size: compact ? 'xs' : 'sm', disabled: submitting || !pattern.trim(), onClick: submit },
          submitting ? '应用中…' : '应用 Mock',
        ),
      ),
    );
  }

  function QuickFaultForm({ storage, defaultUrl, compact = false, onDone }) {
    const [pattern, setPattern] = useState(() => suggestPatternFromUrl(defaultUrl));
    const [delayMs, setDelayMs] = useState('1500');
    const [reqDelayMs, setReqDelayMs] = useState('');
    const [speedKbps, setSpeedKbps] = useState('');
    const [statusCode, setStatusCode] = useState('');
    const [disableCache, setDisableCache] = useState(true);
    const [disableEncoding, setDisableEncoding] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
      if (!storage || submitting) return;
      setSubmitting(true);
      try {
        const res = await rpc.call('injectFault', {
          storage,
          pattern: pattern.trim(),
          ...(delayMs.trim() ? { delayMs: Number(delayMs) } : {}),
          ...(reqDelayMs.trim() ? { reqDelayMs: Number(reqDelayMs) } : {}),
          ...(speedKbps.trim() ? { speedKbps: Number(speedKbps) } : {}),
          ...(statusCode.trim() ? { statusCode: Number(statusCode) } : {}),
          disableCache,
          disableEncoding,
        });
        notifySuccess('已注入故障规则', res.ruleLine);
        onDone?.(res);
      } catch (err) {
        notifyError('注入故障失败', err);
      } finally {
        setSubmitting(false);
      }
    };

    return h(
      'div',
      { className: 'flex flex-1 flex-col gap-2 text-xs' },
      h(
        Field,
        null,
        h(FieldLabel, null, '匹配 Pattern'),
        h(Input, {
          value: pattern,
          onChange: (e) => setPattern(e.target.value),
          placeholder: 'api.example.com/',
          className: 'font-mono text-xs',
        }),
      ),
      h(
        'div',
        { className: 'grid grid-cols-2 gap-2' },
        h(
          Field,
          null,
          h(FieldLabel, null, '响应延迟 (ms)'),
          h(Input, {
            value: delayMs,
            onChange: (e) => setDelayMs(e.target.value),
            placeholder: '1500',
            className: 'font-mono text-xs',
          }),
        ),
        h(
          Field,
          null,
          h(FieldLabel, null, '限速 (KB/s)'),
          h(Input, {
            value: speedKbps,
            onChange: (e) => setSpeedKbps(e.target.value),
            placeholder: '如 32',
            className: 'font-mono text-xs',
          }),
        ),
      ),
      !compact
        ? h(
            'div',
            { className: 'grid grid-cols-2 gap-2' },
            h(
              Field,
              null,
              h(FieldLabel, null, '请求延迟 (ms)'),
              h(Input, {
                value: reqDelayMs,
                onChange: (e) => setReqDelayMs(e.target.value),
                placeholder: '可选',
                className: 'font-mono text-xs',
              }),
            ),
            h(
              Field,
              null,
              h(FieldLabel, null, '强制状态码'),
              h(Input, {
                value: statusCode,
                onChange: (e) => setStatusCode(e.target.value),
                placeholder: '如 502',
                className: 'font-mono text-xs',
              }),
            ),
          )
        : h(
            Field,
            null,
            h(FieldLabel, null, '强制状态码（可选）'),
            h(Input, {
              value: statusCode,
              onChange: (e) => setStatusCode(e.target.value),
              placeholder: '如 500 / 502',
              className: 'font-mono text-xs',
            }),
          ),
      h(
        'div',
        { className: 'mt-auto flex flex-wrap items-center justify-between gap-2 pt-2' },
        h(
          'div',
          { className: 'flex flex-wrap items-center gap-3' },
          h(
            'label',
            { className: 'flex items-center gap-1.5 text-xs text-muted-foreground' },
            h(Checkbox, { checked: disableCache, onCheckedChange: (v) => setDisableCache(Boolean(v)) }),
            h('span', null, 'disable://cache'),
          ),
          h(
            'label',
            { className: 'flex items-center gap-1.5 text-xs text-muted-foreground' },
            h(Checkbox, { checked: disableEncoding, onCheckedChange: (v) => setDisableEncoding(Boolean(v)) }),
            h('span', null, 'disable://encoding'),
          ),
        ),
        h(
          Button,
          { size: compact ? 'xs' : 'sm', disabled: submitting || !pattern.trim(), onClick: submit },
          submitting ? '注入中…' : '注入故障',
        ),
      ),
    );
  }

  function MapLocalForm({ storage, defaultUrl, onDone }) {
    const [pattern, setPattern] = useState(() => suggestHostFromUrl(defaultUrl));
    const [mode, setMode] = useState('port');
    const [targetHost, setTargetHost] = useState('127.0.0.1');
    const [targetPort, setTargetPort] = useState('5173');
    const [targetUrl, setTargetUrl] = useState('');
    const [localDir, setLocalDir] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
      if (!storage || submitting) return;
      setSubmitting(true);
      try {
        const payload = { storage, pattern: pattern.trim() };
        if (mode === 'port') {
          payload.targetHost = targetHost.trim() || '127.0.0.1';
          payload.targetPort = Number(targetPort);
        } else if (mode === 'url') {
          payload.targetUrl = targetUrl.trim();
        } else {
          payload.localDir = localDir.trim();
        }
        const res = await rpc.call('mapLocal', payload);
        notifySuccess('已启用本地映射', res.ruleLine);
        onDone?.(res);
      } catch (err) {
        notifyError('本地映射失败', err);
      } finally {
        setSubmitting(false);
      }
    };

    return h(
      'div',
      { className: 'flex flex-1 flex-col gap-2 text-xs' },
      h(
        Field,
        null,
        h(FieldLabel, null, '线上 Pattern'),
        h(Input, {
          value: pattern,
          onChange: (e) => setPattern(e.target.value),
          placeholder: 'app.example.com/static/',
          className: 'font-mono text-xs',
        }),
      ),
      h(
        Field,
        null,
        h(FieldLabel, null, '映射方式'),
        h(
          Select,
          { value: mode, onValueChange: setMode },
          h(
            SelectTrigger,
            null,
            h(SelectValue, null, (v) =>
              v === 'port' ? '本地端口 (127.0.0.1:port)' : v === 'url' ? '目标 URL' : '本地目录 (file://)',
            ),
          ),
          h(
            SelectContent,
            null,
            h(SelectItem, { value: 'port' }, '本地端口 (127.0.0.1:port)'),
            h(SelectItem, { value: 'url' }, '目标 URL'),
            h(SelectItem, { value: 'dir' }, '本地目录 (file://)'),
          ),
        ),
      ),
      mode === 'port'
        ? h(
            'div',
            { className: 'grid grid-cols-2 gap-2' },
            h(
              Field,
              null,
              h(FieldLabel, null, 'Host'),
              h(Input, {
                value: targetHost,
                onChange: (e) => setTargetHost(e.target.value),
                className: 'font-mono text-xs',
              }),
            ),
            h(
              Field,
              null,
              h(FieldLabel, null, '端口'),
              h(Input, {
                value: targetPort,
                onChange: (e) => setTargetPort(e.target.value),
                className: 'font-mono text-xs',
              }),
            ),
          )
        : mode === 'url'
          ? h(
              Field,
              null,
              h(FieldLabel, null, '目标 URL'),
              h(Input, {
                value: targetUrl,
                onChange: (e) => setTargetUrl(e.target.value),
                placeholder: 'http://127.0.0.1:5173/assets/',
                className: 'font-mono text-xs',
              }),
            )
          : h(
              Field,
              null,
              h(FieldLabel, null, '本地绝对目录路径'),
              h(Input, {
                value: localDir,
                onChange: (e) => setLocalDir(e.target.value),
                placeholder: '/Users/.../dist/',
                className: 'font-mono text-xs',
              }),
            ),
      h(
        'div',
        { className: 'mt-auto flex justify-end pt-2' },
        h(
          Button,
          { size: 'sm', disabled: submitting || !pattern.trim(), onClick: submit },
          submitting ? '映射中…' : '应用映射',
        ),
      ),
    );
  }

  // ── 1. 地址栏微标 statusBadge（严禁放 <button>）────────────────────────────
  function ProxyStatusBadge({ environmentId }) {
    const signalTick = useSignalTick();
    const { instances } = useInstances(signalTick);
    const bound = environmentId ? instances.find((item) => item.environmentId === environmentId) : null;

    return h(
      'span',
      {
        className: 'inline-flex items-center gap-1.5',
        'data-slot': 'whistle-status-badge',
      },
      h(Icon, {
        name: 'Globe',
        style: { '--brand-hue': 192 },
        className: cn('plugin-brand-icon size-3.5 shrink-0', !bound && 'opacity-75'),
      }),
      bound
        ? h(
            React.Fragment,
            null,
            h(StatusDot, { tone: bound.alive ? 'success' : 'warning' }),
            h(
              'span',
              {
                className: cn(
                  'font-mono text-[11px] leading-none tabular-nums',
                  bound.alive ? 'text-foreground' : 'text-muted-foreground',
                ),
              },
              `:${bound.port}`,
            ),
          )
        : null,
    );
  }

  // ── 2. 地址栏快捷切换浮窗 popover ────────────────────────────────────────
  function QuickProxyPopover({ environmentId, url, closePopover, openPluginPage, openInspectorTab }) {
    const signalTick = useSignalTick();
    const { instances, environments, busy, reload, run } = useInstances(signalTick);
    const [rulesView, setRulesView] = useState(null);
    const [presets, setPresets] = useState([]);
    const [profile, setProfile] = useState(null);
    const [debugOpen, setDebugOpen] = useState(false);
    const [debugTab, setDebugTab] = useState('mock');

    const bound = environmentId ? instances.find((item) => item.environmentId === environmentId) : null;
    const { httpsEnabled, rulesEnabled, toggling, toggleHttps, toggleAllRules } = useAgentControls(
      bound?.storage,
      Boolean(bound?.alive),
      signalTick,
    );

    useEffect(() => {
      let cancelled = false;
      rpc
        .call('presetList')
        .then((res) => {
          if (!cancelled) setPresets(res?.presets ?? []);
        })
        .catch(() => {
          if (!cancelled) setPresets([]);
        });
      return () => {
        cancelled = true;
      };
    }, [signalTick]);

    useEffect(() => {
      if (!bound?.storage) return;
      let cancelled = false;
      if (bound.alive) {
        rpc
          .call('rules', { storage: bound.storage })
          .then((res) => {
            if (!cancelled) setRulesView(res);
          })
          .catch(() => {
            if (!cancelled) setRulesView(null);
          });
      }
      rpc
        .call('profileGet', { storage: bound.storage })
        .then((res) => {
          if (!cancelled) setProfile(res?.profile ?? null);
        })
        .catch(() => {
          if (!cancelled) setProfile(null);
        });
      return () => {
        cancelled = true;
      };
    }, [bound?.storage, bound?.alive, signalTick]);

    const groups = bound?.alive && Array.isArray(rulesView?.rules) ? rulesView.rules : [];
    const activeIntents = activeIntentGroups(groups);
    const activePresetId =
      presets.find((p) => p.id === profile?.presetId)?.id ?? (presets.length > 0 ? presets[0].id : '');

    const applyScenario = async (scenarioId) => {
      if (!bound?.storage || !activePresetId) return;
      await run(
        async () => {
          const preview = await rpc.call('presetPreview', {
            storage: bound.storage,
            id: activePresetId,
            scenario: scenarioId,
          });
          return rpc.call('presetApply', {
            storage: bound.storage,
            id: activePresetId,
            scenario: scenarioId,
            expectedHash: preview.hash,
            allowWarnings: true,
          });
        },
        '切换场景预设失败',
        `已切至「${SCENARIO_LIST.find((s) => s.id === scenarioId)?.label || scenarioId}」`,
      );
    };

    const bindInstance = async (inst) => {
      if (!environmentId) return;
      if (!inst.alive) {
        const started = await run(() => rpc.call('start', { storage: inst.storage }), '启动实例失败');
        if (!started) return;
      }
      await run(
        () => rpc.call('bind', { storage: inst.storage, environmentId }),
        '绑定环境失败',
        `已绑定 ${inst.storage}`,
        `代理 :${inst.port}`,
      );
    };

    return h(
      'div',
      {
        className: 'flex h-full min-h-0 flex-col gap-2.5 overflow-y-auto p-3 text-xs',
        'data-slot': 'whistle-quick-popover',
      },
      !environmentId
        ? h(
            'div',
            { className: cn(cardSurfaceClass, 'flex flex-col gap-2 p-3 text-muted-foreground') },
            h('span', null, '当前没有选中的环境，请先在主窗选择或启动环境。'),
            h(
              Button,
              {
                size: 'xs',
                variant: 'outline',
                onClick: () => {
                  openPluginPage?.('proxy');
                  closePopover?.();
                },
              },
              '打开 Whistle 全局工作台',
            ),
          )
        : !bound
          ? h(
              'div',
              { className: 'flex flex-col gap-2.5' },
              h(
                'div',
                { className: cn(cardSurfaceClass, 'flex flex-col gap-2 p-2.5') },
                h(
                  'div',
                  { className: 'flex items-center justify-between gap-2' },
                  h(
                    'div',
                    { className: 'flex items-center gap-1.5 font-medium text-foreground' },
                    h(StatusDot, { tone: 'idle' }),
                    h('span', null, '当前环境未绑定代理实例'),
                  ),
                  h(NewInstanceDialog, {
                    environments,
                    busy,
                    run,
                    defaultBindEnvId: environmentId,
                    compact: true,
                    triggerLabel: '新建并绑定',
                  }),
                ),
                h(
                  'p',
                  { className: 'text-[11px] text-muted-foreground' },
                  '绑定后自动配置代理并信任根证书，仅对该环境生效。',
                ),
              ),
              instances.length > 0
                ? h(
                    'div',
                    { className: 'flex flex-col gap-1' },
                    h('span', { className: 'text-[11px] font-medium text-muted-foreground' }, '选择已有实例绑定：'),
                    ...instances.map((inst) =>
                      h(
                        'div',
                        {
                          key: inst.storage,
                          className: cn(cardSurfaceClass, 'flex items-center justify-between gap-2 py-1.5 px-2.5'),
                        },
                        h(
                          'div',
                          { className: 'flex min-w-0 items-center gap-1.5' },
                          h(StatusDot, { tone: inst.alive ? 'success' : 'warning' }),
                          h('span', { className: 'truncate font-medium' }, inst.storage),
                          h('span', { className: 'font-mono text-[11px] text-muted-foreground' }, `:${inst.port}`),
                        ),
                        h(
                          Button,
                          { size: 'xs', variant: 'outline', disabled: busy, onClick: () => void bindInstance(inst) },
                          inst.alive ? '绑定' : '启动并绑定',
                        ),
                      ),
                    ),
                  )
                : null,
            )
          : h(
              React.Fragment,
              null,
              // 绑定状态头卡
              h(
                'div',
                { className: cn(cardSurfaceClass, 'flex flex-col gap-2 p-2.5') },
                h(
                  'div',
                  { className: 'flex items-center gap-1.5' },
                  h(StatusDot, { tone: bound.alive ? 'success' : 'warning' }),
                  h('span', { className: 'truncate font-medium text-foreground' }, bound.storage),
                  h('span', { className: 'font-mono text-muted-foreground' }, `:${bound.port}`),
                  bound.version ? h(Badge, { variant: 'outline', className: 'ml-auto' }, `v${bound.version}`) : null,
                  !bound.version
                    ? h(Badge, { variant: 'outline', className: 'ml-auto' }, bound.alive ? '运行中' : '已停止')
                    : null,
                ),
                h(
                  'div',
                  { className: 'flex flex-wrap items-center gap-1.5' },
                  bound.alive
                    ? h(
                        React.Fragment,
                        null,
                        h(
                          Button,
                          {
                            size: 'xs',
                            variant: 'outline',
                            className: 'not-italic',
                            disabled: busy,
                            onClick: () =>
                              void run(() => rpc.call('open', { environmentId }), '打开 Whistle Web UI 失败').then(
                                (r) => r && closePopover?.(),
                              ),
                          },
                          h(Icon, { name: 'ExternalLink', className: 'size-3' }),
                          'Web UI',
                        ),
                        h(
                          Button,
                          {
                            size: 'xs',
                            variant: 'outline',
                            disabled: busy,
                            onClick: () =>
                              void run(
                                () => rpc.call('clearDnsCache', { storage: bound.storage }),
                                '清理 DNS 缓存失败',
                                'DNS 与本地地址缓存已清理',
                              ),
                          },
                          h(Icon, { name: 'Refresh', className: 'size-3' }),
                          '清 DNS',
                        ),
                      )
                    : h(
                        Button,
                        {
                          size: 'xs',
                          disabled: busy,
                          onClick: () =>
                            void run(
                              () => rpc.call('start', { storage: bound.storage }),
                              '启动实例失败',
                              `实例 ${bound.storage} 已启动`,
                            ),
                        },
                        h(Icon, { name: 'Play', className: 'size-3' }),
                        '启动',
                      ),
                  h(
                    Button,
                    {
                      size: 'xs',
                      variant: 'outline',
                      disabled: busy,
                      onClick: () =>
                        void run(() => rpc.call('unbind', { environmentId }), '解绑失败', '已解除代理绑定'),
                    },
                    '解绑',
                  ),
                ),
              ),

              // 快捷开关条
              bound.alive
                ? h(
                    'div',
                    { className: cn(cardSurfaceClass, 'flex items-center justify-between gap-2 px-2.5 py-2') },
                    h(
                      'label',
                      { className: 'flex items-center gap-1.5 text-xs' },
                      h(Switch, {
                        checked: httpsEnabled,
                        disabled: toggling,
                        onCheckedChange: (checked) => void toggleHttps(checked),
                      }),
                      h('span', null, 'HTTPS 解密'),
                    ),
                    h(
                      'label',
                      { className: 'flex items-center gap-1.5 text-xs' },
                      h(Switch, {
                        checked: rulesEnabled,
                        disabled: toggling,
                        onCheckedChange: (checked) => void toggleAllRules(checked),
                      }),
                      h('span', null, '全局规则'),
                    ),
                  )
                : null,

              // 受控调试意图区
              bound.alive
                ? h(
                    'div',
                    { className: 'flex flex-col gap-1.5' },
                    activeIntents.length > 0
                      ? h(
                          Alert,
                          { className: 'border-[var(--warning)]/35 bg-[var(--warning)]/10 px-2.5 py-2' },
                          h(Icon, { name: 'Zap', className: 'size-3.5 text-[var(--warning)]' }),
                          h(
                            AlertTitle,
                            { className: 'text-xs text-foreground' },
                            `临时调试生效中：${activeIntents.map((g) => g.name).join('、')}`,
                          ),
                          h(
                            AlertDescription,
                            { className: 'mt-1.5' },
                            h(
                              Button,
                              {
                                size: 'xs',
                                variant: 'outline',
                                className:
                                  'border-border bg-background/90 text-foreground hover:border-destructive hover:bg-destructive hover:text-destructive-foreground',
                                disabled: busy,
                                onClick: () =>
                                  void run(
                                    () => rpc.call('clearIntents', { storage: bound.storage, removeValues: true }),
                                    '清空临时调试规则失败',
                                    '已清空所有临时调试规则',
                                  ),
                              },
                              h(Icon, { name: 'Trash', className: 'size-3 text-destructive' }),
                              '一键清空所有临时调试规则',
                            ),
                          ),
                        )
                      : null,
                    h(
                      Collapsible,
                      { open: debugOpen, onOpenChange: setDebugOpen },
                      h(
                        CollapsibleTrigger,
                        {
                          render: h(Button, {
                            variant: 'outline',
                            size: 'xs',
                            className: 'w-full justify-between',
                          }),
                        },
                        h(
                          'span',
                          { className: 'flex items-center gap-1.5' },
                          h(Icon, { name: 'Zap', className: 'size-3' }),
                          '快捷 Mock / 故障注入',
                        ),
                        h(Icon, { name: debugOpen ? 'ChevronDown' : 'ChevronRight', className: 'size-3.5' }),
                      ),
                      h(
                        CollapsibleContent,
                        { className: 'pt-2' },
                        h(
                          'div',
                          { className: cn(cardSurfaceClass, 'flex flex-col gap-2 p-2.5') },
                          h(
                            Tabs,
                            { value: debugTab, onValueChange: setDebugTab },
                            h(
                              TabsList,
                              { className: 'w-full' },
                              h(TabsTrigger, { value: 'mock', className: 'text-xs' }, '快速 Mock'),
                              h(TabsTrigger, { value: 'fault', className: 'text-xs' }, '延迟 / 限速'),
                            ),
                            h(
                              TabsContent,
                              { value: 'mock', className: 'pt-2' },
                              h(QuickMockForm, {
                                storage: bound.storage,
                                defaultUrl: url,
                                compact: true,
                                onDone: reload,
                              }),
                            ),
                            h(
                              TabsContent,
                              { value: 'fault', className: 'pt-2' },
                              h(QuickFaultForm, {
                                storage: bound.storage,
                                defaultUrl: url,
                                compact: true,
                                onDone: reload,
                              }),
                            ),
                          ),
                        ),
                      ),
                    ),
                  )
                : null,

              // 场景预设快捷切换
              bound.alive
                ? h(
                    'div',
                    { className: cn(cardSurfaceClass, 'flex flex-col gap-1.5 p-2.5') },
                    h(
                      'div',
                      { className: 'flex items-center justify-between gap-2' },
                      h('span', { className: 'text-[11px] font-medium text-muted-foreground' }, '场景预设快捷切换'),
                      profile
                        ? h(
                            'span',
                            {
                              className:
                                'truncate font-mono text-[length:var(--font-size-micro)] text-muted-foreground',
                            },
                            profile.presetId,
                          )
                        : null,
                    ),
                    presets.length > 0
                      ? h(
                          'div',
                          { className: 'grid grid-cols-2 gap-1.5' },
                          ...SCENARIO_LIST.map((sc) =>
                            h(
                              Button,
                              {
                                key: sc.id,
                                size: 'xs',
                                variant: 'outline',
                                disabled: busy,
                                onClick: () => void applyScenario(sc.id),
                              },
                              sc.label,
                            ),
                          ),
                        )
                      : h(
                          'div',
                          { className: 'flex items-center justify-between gap-2 text-[11px] text-muted-foreground' },
                          h('span', null, '暂无已导入预设'),
                          h(
                            Button,
                            {
                              size: 'xs',
                              variant: 'outline',
                              onClick: () => {
                                openPluginPage?.('proxy');
                                closePopover?.();
                              },
                            },
                            '去工作台导入',
                          ),
                        ),
                  )
                : null,

              // 规则组列表
              bound.alive
                ? h(
                    'div',
                    { className: 'flex flex-col gap-1 pb-3' },
                    h(
                      'span',
                      { className: 'text-[11px] font-medium text-muted-foreground' },
                      `规则组（${groups.length}）`,
                    ),
                    groups.length === 0
                      ? h('p', { className: 'text-[11px] text-muted-foreground' }, '暂无规则组。')
                      : h(
                          'div',
                          { className: 'flex flex-col gap-1' },
                          ...groups.map((grp) =>
                            h(
                              'div',
                              {
                                key: grp.name,
                                className: cn(
                                  cardSurfaceClass,
                                  'flex items-center justify-between gap-2 px-2.5 py-1.5',
                                ),
                              },
                              h(
                                'div',
                                { className: 'flex min-w-0 items-center gap-1.5' },
                                h('span', { className: 'truncate font-mono text-[11px]' }, grp.name),
                                controlledTag(grp.name)
                                  ? h(
                                      Badge,
                                      { variant: 'outline', className: 'text-[length:var(--font-size-micro)]' },
                                      controlledTag(grp.name),
                                    )
                                  : null,
                              ),
                              h(Switch, {
                                checked: Boolean(grp.selected),
                                disabled: busy,
                                'aria-label': `切换规则组 ${grp.name}`,
                                onCheckedChange: (checked) =>
                                  void run(
                                    () =>
                                      rpc.call('ruleToggle', {
                                        storage: bound.storage,
                                        name: grp.name,
                                        enabled: Boolean(checked),
                                      }),
                                    '切换规则组失败',
                                  ),
                              }),
                            ),
                          ),
                        ),
                  )
                : null,
            ),

      // 底部工作台跳转条
      h(
        'div',
        { className: 'mt-auto flex items-center justify-between gap-2 border-t border-border pt-2' },
        h(
          Button,
          {
            size: 'xs',
            variant: 'ghost',
            onClick: () => {
              openInspectorTab?.('env-proxy');
              closePopover?.();
            },
          },
          h(Icon, { name: 'Activity', className: 'size-3' }),
          '随页抓包',
        ),
        h(
          Button,
          {
            size: 'xs',
            variant: 'ghost',
            onClick: () => {
              openPluginPage?.('proxy');
              closePopover?.();
            },
          },
          h(Icon, { name: 'Sliders', className: 'size-3' }),
          '完整代理工作台',
        ),
      ),
    );
  }

  // ── 3. 右侧随页抓包与规则侧边栏 inspectorTab ──────────────────────────────
  function WhistleInspectorTab({ environmentId, url, openPluginPage }) {
    const signalTick = useSignalTick();
    const { instances, environments, busy, reload, run } = useInstances(signalTick);
    const [rulesView, setRulesView] = useState(null);
    const [debugOpen, setDebugOpen] = useState(false);
    const [debugTab, setDebugTab] = useState('mock');
    const [subUrl, setSubUrl] = useState('');
    const [trafficType, setTrafficType] = useState('ALL');
    const [entries, setEntries] = useState([]);
    const [trafficNonce, setTrafficNonce] = useState(0);
    const [expandedId, setExpandedId] = useState(null);
    const [replayMap, setReplayMap] = useState({});
    const [replayingId, setReplayingId] = useState(null);
    const [testUrl, setTestUrl] = useState('');
    const [testResult, setTestResult] = useState(null);

    const bound = environmentId ? instances.find((item) => item.environmentId === environmentId) : null;
    const { httpsEnabled, rulesEnabled, toggling, toggleHttps, toggleAllRules } = useAgentControls(
      bound?.storage,
      Boolean(bound?.alive),
      signalTick,
    );

    useEffect(() => {
      if (!bound?.storage || !bound?.alive) return;
      let cancelled = false;
      rpc
        .call('rules', { storage: bound.storage })
        .then((res) => {
          if (!cancelled) setRulesView(res);
        })
        .catch(() => {
          if (!cancelled) setRulesView(null);
        });
      return () => {
        cancelled = true;
      };
    }, [bound?.storage, bound?.alive, signalTick]);

    useEffect(() => {
      if (!bound?.storage || !bound?.alive) return;
      let cancelled = false;
      rpc
        .call('traffic', {
          storage: bound.storage,
          latest: true,
          count: 30,
          ...(subUrl.trim() ? { subUrl: subUrl.trim() } : {}),
          ...(trafficType !== 'ALL' ? { type: trafficType } : {}),
        })
        .then((res) => {
          if (!cancelled) setEntries(Array.isArray(res?.entries) ? [...res.entries].reverse() : []);
        })
        .catch(() => {
          if (!cancelled) setEntries([]);
        });
      return () => {
        cancelled = true;
      };
    }, [bound?.storage, bound?.alive, subUrl, trafficType, trafficNonce, signalTick]);

    const groups = bound?.alive && Array.isArray(rulesView?.rules) ? rulesView.rules : [];
    const activeIntents = activeIntentGroups(groups);
    const liveEntries = bound?.alive ? entries : [];

    const bindInstance = async (inst) => {
      if (!environmentId) return;
      if (!inst.alive) {
        const started = await run(() => rpc.call('start', { storage: inst.storage }), '启动实例失败');
        if (!started) return;
      }
      await run(
        () => rpc.call('bind', { storage: inst.storage, environmentId }),
        '绑定环境失败',
        `已绑定 ${inst.storage}`,
      );
    };

    const doReplay = async (entry) => {
      if (!bound?.storage || replayingId) return;
      setReplayingId(entry.entryId);
      setExpandedId(entry.entryId);
      try {
        const res = await rpc.call('replay', {
          storage: bound.storage,
          reqId: entry.entryId,
          diff: true,
        });
        setReplayMap((prev) => ({ ...prev, [entry.entryId]: res }));
        notifySuccess('重放完成', `原 ${res.original?.status ?? '—'} → 新 ${res.replayed?.status ?? '—'}`);
      } catch (err) {
        notifyError('重放请求失败', err);
      } finally {
        setReplayingId(null);
      }
    };

    const doCopyCurl = async (entry) => {
      if (!bound?.storage) return;
      try {
        const res = await rpc.call('toCurl', { storage: bound.storage, reqId: entry.entryId });
        await copyText(res.curl, '脱敏 cURL');
      } catch (err) {
        notifyError('生成 cURL 失败', err);
      }
    };

    const doCaptureLink = async () => {
      if (!bound?.storage) return;
      const res = await run(
        () =>
          rpc.call('captureLink', {
            storage: bound.storage,
            environmentId,
            open: true,
            ...(subUrl.trim() ? { subUrl: subUrl.trim() } : {}),
            ...(trafficType !== 'ALL' ? { type: trafficType } : {}),
          }),
        '生成排障链接失败',
      );
      if (res?.url) {
        await copyText(res.url, '排障直达链接');
      }
    };

    const doRuleTest = async () => {
      if (!bound?.storage) return;
      const target = testUrl.trim() || url;
      if (!target) {
        notifyInfo('请先输入要测试的 URL');
        return;
      }
      try {
        const res = await rpc.call('ruleTest', { storage: bound.storage, url: target });
        setTestResult(res);
      } catch (err) {
        notifyError('规则命中测试失败', err);
      }
    };

    if (!environmentId) {
      return h('p', { className: 'p-3 text-xs text-muted-foreground' }, '先选择一个环境。');
    }

    if (!bound) {
      return h(
        'div',
        { className: 'flex flex-col gap-2.5 text-xs', 'data-slot': 'whistle-inspector' },
        h(
          'div',
          { className: cn(cardSurfaceClass, 'flex flex-col gap-2 p-3') },
          h(
            'div',
            { className: 'flex items-center gap-1.5 font-medium text-foreground' },
            h(Icon, { name: 'Globe', className: 'size-3.5 text-muted-foreground' }),
            h('span', null, '当前环境未绑定 Whistle 实例'),
          ),
          h(
            'p',
            { className: 'text-[11px] leading-relaxed text-muted-foreground' },
            '绑定后即可在此查看实时抓包、重放 Diff 与规则命中诊断。',
          ),
          h(
            'div',
            { className: 'flex flex-wrap items-center gap-1.5' },
            h(NewInstanceDialog, {
              environments,
              busy,
              run,
              defaultBindEnvId: environmentId,
              compact: true,
              triggerLabel: '新建并绑定',
            }),
            h(Button, { size: 'xs', variant: 'outline', onClick: () => openPluginPage?.('proxy') }, '打开代理工作台'),
          ),
        ),
        instances.length > 0
          ? h(
              'div',
              { className: 'flex flex-col gap-1.5' },
              h('span', { className: 'text-[11px] text-muted-foreground' }, '快捷绑定已有实例：'),
              ...instances.slice(0, 6).map((inst) =>
                h(
                  'div',
                  {
                    key: inst.storage,
                    className: cn(cardSurfaceClass, 'flex items-center justify-between gap-2 px-2.5 py-1.5'),
                  },
                  h(
                    'div',
                    { className: 'flex min-w-0 items-center gap-1.5' },
                    h(StatusDot, { tone: inst.alive ? 'success' : 'warning' }),
                    h('span', { className: 'truncate font-mono' }, `${inst.storage} :${inst.port}`),
                  ),
                  h(
                    Button,
                    { size: 'xs', variant: 'outline', disabled: busy, onClick: () => void bindInstance(inst) },
                    inst.alive ? '绑定' : '启动并绑定',
                  ),
                ),
              ),
            )
          : null,
      );
    }

    return h(
      'div',
      { className: 'flex flex-col gap-3 pb-12 text-xs', 'data-slot': 'whistle-inspector' },
      // 顶部状态卡
      h(
        'div',
        { className: cn(cardSurfaceClass, 'flex flex-col gap-2 p-2.5') },
        h(
          'div',
          { className: 'flex items-center gap-1.5' },
          h(StatusDot, { tone: bound.alive ? 'success' : 'warning' }),
          h('span', { className: 'truncate font-medium text-foreground' }, bound.storage),
          h('span', { className: 'font-mono text-muted-foreground' }, `:${bound.port}`),
          h(
            Badge,
            { variant: bound.alive ? 'secondary' : 'outline', className: 'shrink-0' },
            bound.alive ? '运行中' : '已停止',
          ),
          h(
            Button,
            {
              size: 'xs',
              variant: 'outline',
              className: 'ml-auto shrink-0',
              onClick: () => openPluginPage?.('proxy'),
            },
            h(Icon, { name: 'ExternalLink', className: 'size-3' }),
            '工作台',
          ),
        ),
        bound.alive
          ? h(
              'div',
              { className: 'flex items-center justify-between gap-2 border-t border-border pt-2' },
              h(
                'label',
                { className: 'flex items-center gap-1.5 text-[11px]' },
                h(Switch, { checked: httpsEnabled, disabled: toggling, onCheckedChange: (v) => void toggleHttps(v) }),
                h('span', null, 'HTTPS 解密'),
              ),
              h(
                'label',
                { className: 'flex items-center gap-1.5 text-[11px]' },
                h(Switch, {
                  checked: rulesEnabled,
                  disabled: toggling,
                  onCheckedChange: (v) => void toggleAllRules(v),
                }),
                h('span', null, '全局规则'),
              ),
            )
          : null,
        h(
          'div',
          { className: 'grid grid-cols-3 gap-1.5' },
          bound.alive
            ? h(
                React.Fragment,
                null,
                h(
                  Button,
                  {
                    size: 'xs',
                    variant: 'outline',
                    className: 'w-full not-italic',
                    disabled: busy,
                    onClick: () => void run(() => rpc.call('open', { environmentId }), '打开 Web UI 失败'),
                  },
                  h(Icon, { name: 'ExternalLink', className: 'size-3' }),
                  'Web UI',
                ),
                h(
                  Button,
                  {
                    size: 'xs',
                    variant: 'outline',
                    className: 'w-full',
                    disabled: busy,
                    onClick: () =>
                      void run(
                        () => rpc.call('clearDnsCache', { storage: bound.storage }),
                        '清理 DNS 缓存失败',
                        'DNS 缓存已清理',
                      ),
                  },
                  '清 DNS',
                ),
                h(
                  Button,
                  {
                    size: 'xs',
                    variant: 'outline',
                    className: 'w-full',
                    disabled: busy,
                    onClick: () =>
                      void run(() => rpc.call('stop', { storage: bound.storage }), '停止实例失败', '实例已停止'),
                  },
                  '停止',
                ),
              )
            : h(
                Button,
                {
                  size: 'xs',
                  className: 'col-span-3 w-full',
                  disabled: busy,
                  onClick: () =>
                    void run(() => rpc.call('start', { storage: bound.storage }), '启动实例失败', '实例已启动'),
                },
                h(Icon, { name: 'Play', className: 'size-3' }),
                '启动实例',
              ),
        ),
        activeIntents.length > 0
          ? h(
              'div',
              {
                className:
                  'flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--warning)]/35 bg-[var(--warning)]/10 px-2 py-1.5 text-[11px]',
              },
              h(
                'span',
                { className: 'min-w-0 truncate text-foreground' },
                `临时调试 (${activeIntents.length})：${activeIntents.map((g) => g.name).join('、')}`,
              ),
              h(
                Button,
                {
                  size: 'xs',
                  variant: 'outline',
                  className: 'shrink-0 border-destructive/50 text-destructive hover:bg-destructive/15',
                  disabled: busy,
                  onClick: () =>
                    void run(
                      () => rpc.call('clearIntents', { storage: bound.storage, removeValues: true }),
                      '清空临时调试规则失败',
                      '已清空临时调试规则',
                    ),
                },
                '一键清空',
              ),
            )
          : null,
      ),

      // 快捷 Mock / 故障注入折叠条
      bound.alive
        ? h(
            Collapsible,
            { open: debugOpen, onOpenChange: setDebugOpen },
            h(
              CollapsibleTrigger,
              { render: h(Button, { size: 'xs', variant: 'outline', className: 'w-full justify-between' }) },
              h(
                'span',
                { className: 'flex items-center gap-1.5' },
                h(Icon, { name: 'Zap', className: 'size-3' }),
                '快捷 Mock / 故障注入',
              ),
              h(Icon, { name: debugOpen ? 'ChevronDown' : 'ChevronRight', className: 'size-3.5' }),
            ),
            h(
              CollapsibleContent,
              { className: 'pt-2' },
              h(
                'div',
                { className: cn(cardSurfaceClass, 'flex flex-col gap-2 p-2.5') },
                h(
                  Tabs,
                  { value: debugTab, onValueChange: setDebugTab },
                  h(
                    TabsList,
                    { className: 'w-full' },
                    h(TabsTrigger, { value: 'mock', className: 'text-xs' }, '快速 Mock'),
                    h(TabsTrigger, { value: 'fault', className: 'text-xs' }, '故障注入'),
                  ),
                  h(
                    TabsContent,
                    { value: 'mock', className: 'pt-2' },
                    h(QuickMockForm, { storage: bound.storage, defaultUrl: url, compact: true, onDone: reload }),
                  ),
                  h(
                    TabsContent,
                    { value: 'fault', className: 'pt-2' },
                    h(QuickFaultForm, { storage: bound.storage, defaultUrl: url, compact: true, onDone: reload }),
                  ),
                ),
              ),
            ),
          )
        : null,

      // 最近抓包请求流
      bound.alive
        ? h(
            'div',
            { className: 'flex flex-col gap-2' },
            h(
              'div',
              { className: 'flex items-center justify-between gap-1.5' },
              h(
                'span',
                { className: 'text-[11px] font-medium text-muted-foreground' },
                `最近抓包（${liveEntries.length}）`,
              ),
              h(
                'div',
                { className: 'flex items-center gap-1' },
                h(
                  Button,
                  {
                    size: 'xs',
                    variant: 'outline',
                    disabled: busy || liveEntries.length === 0,
                    onClick: () => void doCaptureLink(),
                  },
                  '生成排障链接',
                ),
                h(
                  IconButton,
                  { size: 'icon-xs', title: '刷新抓包', onClick: () => setTrafficNonce((n) => n + 1) },
                  h(Icon, { name: 'Refresh', className: 'size-3.5' }),
                ),
              ),
            ),
            h(
              'div',
              { className: 'flex items-center gap-1.5' },
              h(Input, {
                value: subUrl,
                onChange: (e) => setSubUrl(e.target.value),
                placeholder: '过滤 URL / 路径…',
                className: 'min-w-0 flex-1 text-xs',
              }),
              h(
                Select,
                { value: trafficType, onValueChange: setTrafficType },
                h(
                  SelectTrigger,
                  { className: 'w-24 shrink-0' },
                  h(SelectValue, null, (v) => (v === 'ALL' ? '全部' : v)),
                ),
                h(
                  SelectContent,
                  null,
                  ...TRAFFIC_TYPES.map((tp) => h(SelectItem, { key: tp, value: tp }, tp === 'ALL' ? '全部' : tp)),
                ),
              ),
            ),
            liveEntries.length === 0
              ? h(
                  'p',
                  { className: 'py-2 text-[11px] text-muted-foreground' },
                  '暂无匹配抓包记录，浏览页面后点刷新查看。',
                )
              : h(
                  'div',
                  { className: 'flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-0.5' },
                  ...liveEntries.map((entry) => {
                    const isOpen = expandedId === entry.entryId;
                    const matchedCount = Array.isArray(entry.matchedRules) ? entry.matchedRules.length : 0;
                    const replayRes = replayMap[entry.entryId];
                    return h(
                      'div',
                      { key: entry.entryId, className: cn(cardSurfaceClass, 'flex flex-col gap-1.5 p-2') },
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: () => setExpandedId(isOpen ? null : entry.entryId),
                          className: 'flex w-full items-center gap-1.5 text-left',
                        },
                        h(
                          'span',
                          {
                            className: cn(
                              'w-8 shrink-0 font-mono text-[11px] font-medium',
                              statusToneClass(entry.status),
                            ),
                          },
                          entry.status ?? '—',
                        ),
                        h(
                          'span',
                          {
                            className: 'shrink-0 font-mono text-[length:var(--font-size-micro)] text-muted-foreground',
                          },
                          entry.method || 'GET',
                        ),
                        h(
                          'span',
                          {
                            className: 'min-w-0 flex-1 truncate font-mono text-[11px] text-foreground',
                            title: entry.url,
                          },
                          shortUrlPath(entry.url),
                        ),
                        matchedCount > 0
                          ? h(
                              Badge,
                              { variant: 'secondary', className: 'shrink-0 text-[length:var(--font-size-micro)]' },
                              `${matchedCount} 规则`,
                            )
                          : null,
                        h(
                          'span',
                          {
                            className: 'shrink-0 font-mono text-[length:var(--font-size-micro)] text-muted-foreground',
                          },
                          formatMs(entry.timings?.total),
                        ),
                      ),
                      isOpen
                        ? h(
                            'div',
                            { className: 'flex flex-col gap-2 border-t border-border pt-1.5' },
                            h(
                              'div',
                              {
                                className:
                                  'break-all font-mono text-[length:var(--font-size-micro)] text-muted-foreground',
                              },
                              entry.url,
                            ),
                            matchedCount > 0
                              ? h(
                                  'div',
                                  { className: 'flex flex-wrap gap-1' },
                                  ...entry.matchedRules.map((mr, i) =>
                                    h(
                                      Badge,
                                      {
                                        key: `${entry.entryId}-mr-${i}-${mr.protocol}`,
                                        variant: 'outline',
                                        className: 'max-w-full justify-start text-[length:var(--font-size-micro)]',
                                        title: `${mr.protocol} · ${mr.matcher || mr.raw}`,
                                      },
                                      h(
                                        'span',
                                        { className: 'min-w-0 truncate' },
                                        `${mr.protocol} · ${mr.matcher || mr.raw}`,
                                      ),
                                    ),
                                  ),
                                )
                              : null,
                            h(
                              'div',
                              { className: 'flex flex-wrap items-center gap-1.5' },
                              h(
                                Button,
                                {
                                  size: 'xs',
                                  variant: 'outline',
                                  disabled: replayingId === entry.entryId,
                                  onClick: () => void doReplay(entry),
                                },
                                h(Icon, { name: 'RotateClockwise', className: 'size-3' }),
                                replayingId === entry.entryId ? '重放中…' : '重放并 Diff',
                              ),
                              h(
                                Button,
                                { size: 'xs', variant: 'ghost', onClick: () => void doCopyCurl(entry) },
                                h(Icon, { name: 'Copy', className: 'size-3' }),
                                '复制脱敏 cURL',
                              ),
                            ),
                            replayRes ? h(ReplayDiffView, { replayRes }) : null,
                          )
                        : null,
                    );
                  }),
                ),
          )
        : null,

      // 快捷规则命中测试
      bound.alive
        ? h(
            'div',
            { className: cn(cardSurfaceClass, 'flex flex-col gap-2 p-2.5') },
            h(
              'div',
              { className: 'flex items-center justify-between gap-2' },
              h('span', { className: 'text-[11px] font-medium text-muted-foreground' }, '快捷规则命中测试'),
              url ? h(Button, { size: 'xs', variant: 'ghost', onClick: () => setTestUrl(url) }, '填入当前页') : null,
            ),
            h(
              'div',
              { className: 'flex items-center gap-1.5' },
              h(Input, {
                value: testUrl,
                onChange: (e) => setTestUrl(e.target.value),
                placeholder: url || 'https://api.example.com/v1/user',
                className: 'min-w-0 flex-1 font-mono text-xs',
              }),
              h(
                Button,
                {
                  size: 'xs',
                  variant: 'outline',
                  className: 'h-7 border-border/80 bg-surface-fog px-3 font-medium',
                  onClick: () => void doRuleTest(),
                },
                '测试',
              ),
            ),
            testResult ? h(RuleMatchResultView, { result: testResult }) : null,
          )
        : null,
    );
  }

  // ── 4. 全屏工作台各 Sub-Tab ───────────────────────────────────────────────
  function RulesTab({ instance, busy, run, signalTick }) {
    const [rulesView, setRulesView] = useState(null);
    const [selectedName, setSelectedName] = useState('');
    const [draftMap, setDraftMap] = useState({});
    const [validation, setValidation] = useState(null);
    const [diffResult, setDiffResult] = useState(null);
    const [newGroupOpen, setNewGroupOpen] = useState(false);
    const [newGroupName, setNewGroupName] = useState('');
    const [newGroupBody, setNewGroupBody] = useState('');
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [ruleTestOpen, setRuleTestOpen] = useState(false);
    const [testUrl, setTestUrl] = useState('https://api.example.com/v1/user');
    const [testMethod, setTestMethod] = useState('GET');
    const [includeDisabled, setIncludeDisabled] = useState(false);
    const [testResult, setTestResult] = useState(null);

    useEffect(() => {
      if (!instance?.storage || !instance?.alive) return;
      let cancelled = false;
      rpc
        .call('rules', { storage: instance.storage })
        .then((res) => {
          if (cancelled) return;
          setRulesView(res);
        })
        .catch(() => {
          if (!cancelled) setRulesView(null);
        });
      return () => {
        cancelled = true;
      };
    }, [instance?.storage, instance?.alive, signalTick]);

    const groups = instance?.alive && Array.isArray(rulesView?.rules) ? rulesView.rules : [];
    const activeGroup = groups.find((g) => g.name === selectedName) ?? groups[0] ?? null;
    const editorText = activeGroup
      ? draftMap[activeGroup.name] !== undefined
        ? draftMap[activeGroup.name]
        : activeGroup.data
      : '';
    const isDirty = activeGroup
      ? draftMap[activeGroup.name] !== undefined && draftMap[activeGroup.name] !== activeGroup.data
      : false;

    const validateCurrent = async (textToCheck) => {
      try {
        const res = await rpc.call('ruleValidate', { rules: textToCheck });
        setValidation(res);
        return res;
      } catch (err) {
        notifyError('规则语法校验失败', err);
        return null;
      }
    };

    const diffCurrent = async () => {
      if (!activeGroup) return;
      try {
        const res = await rpc.call('ruleDiff', {
          storage: instance.storage,
          name: activeGroup.name,
          rules: editorText,
        });
        setDiffResult(res);
      } catch (err) {
        notifyError('生成规则 Diff 失败', err);
      }
    };

    const saveCurrent = async () => {
      if (!activeGroup) return;
      const res = await run(
        () =>
          rpc.call('ruleSet', {
            storage: instance.storage,
            name: activeGroup.name,
            rules: editorText,
            allowErrors: true,
          }),
        '保存规则失败',
        `规则组 ${activeGroup.name} 已保存并启用`,
      );
      if (res && Array.isArray(res.rules)) {
        setRulesView(res);
        setDraftMap((prev) => {
          const next = { ...prev };
          delete next[activeGroup.name];
          return next;
        });
        setDiffResult(null);
      }
    };

    const createGroup = async () => {
      const name = newGroupName.trim();
      if (!name) return;
      const res = await run(
        () =>
          rpc.call('ruleSet', {
            storage: instance.storage,
            name,
            rules: newGroupBody,
            allowErrors: true,
          }),
        '新建规则组失败',
        `已创建并启用规则组 ${name}`,
      );
      if (res && Array.isArray(res.rules)) {
        setRulesView(res);
        setSelectedName(name);
        setNewGroupOpen(false);
      }
    };

    if (!instance.alive) {
      return h(
        'div',
        { className: 'p-4' },
        h(
          Empty,
          null,
          h(
            EmptyHeader,
            null,
            h(EmptyMedia, { variant: 'icon' }, h(Icon, { name: 'Code' })),
            h(EmptyTitle, null, '实例已停止'),
            h(EmptyDescription, null, '请先在左侧栏启动该 Whistle 实例，再读取与编辑规则组。'),
          ),
        ),
      );
    }

    return h(
      'div',
      { className: 'flex h-full min-h-0 overflow-hidden', 'data-slot': 'whistle-rules' },
      // 左栏：规则组列表
      h(
        'div',
        { className: 'flex w-56 shrink-0 flex-col border-r border-border min-h-0' },
        h(
          'div',
          { className: 'flex items-center justify-between gap-1.5 border-b border-border px-3 py-2' },
          h('span', { className: 'text-xs font-medium' }, `规则组 (${groups.length})`),
          h(
            Button,
            {
              size: 'xs',
              variant: 'outline',
              onClick: () => {
                setNewGroupName('');
                setNewGroupBody('');
                setNewGroupOpen(true);
              },
            },
            h(Icon, { name: 'Plus', className: 'size-3' }),
            '新建组',
          ),
        ),
        h(
          'div',
          { className: 'flex-1 min-h-0 overflow-y-auto p-1.5 flex flex-col gap-1' },
          groups.length === 0
            ? h('p', { className: 'p-2 text-xs text-muted-foreground' }, '暂无规则组')
            : groups.map((grp) => {
                const tag = controlledTag(grp.name);
                return h(
                  ListRow,
                  { key: grp.name, selected: activeGroup?.name === grp.name },
                  h(
                    ListRowMain,
                    {
                      onClick: () => {
                        setSelectedName(grp.name);
                        setValidation(null);
                        setDiffResult(null);
                      },
                    },
                    h(ListRowLabel, null, h(ListRowLabelText, { className: 'font-mono text-xs' }, grp.name)),
                    tag ? h(ListRowMeta, null, tag) : null,
                  ),
                  h(
                    ListRowActions,
                    { alwaysVisible: true, className: 'gap-1' },
                    h(Switch, {
                      checked: Boolean(grp.selected),
                      disabled: busy,
                      'aria-label': `切换 ${grp.name}`,
                      onCheckedChange: (checked) =>
                        void run(
                          () =>
                            rpc.call('ruleToggle', {
                              storage: instance.storage,
                              name: grp.name,
                              enabled: Boolean(checked),
                            }),
                          '开关规则失败',
                        ).then((res) => res && Array.isArray(res.rules) && setRulesView(res)),
                    }),
                    h(
                      ListRowActionButton,
                      {
                        tone: 'destructive',
                        title: `删除 ${grp.name}`,
                        onClick: () => setDeleteTarget(grp.name),
                      },
                      h(Icon, { name: 'Trash' }),
                    ),
                  ),
                );
              }),
        ),
      ),

      // 右栏：规则编辑器 + 实时校验 + Diff + 命中诊断
      h(
        'div',
        { className: 'flex min-w-0 flex-1 flex-col min-h-0 overflow-hidden' },
        activeGroup
          ? h(
              'div',
              { className: 'flex min-h-0 flex-1 flex-col gap-2.5 p-3 overflow-y-auto' },
              h(
                'div',
                { className: 'flex flex-wrap items-center gap-2' },
                h('span', { className: 'font-mono text-sm font-medium' }, activeGroup.name),
                activeGroup.selected
                  ? h(Badge, { variant: 'secondary' }, '已启用')
                  : h(Badge, { variant: 'outline' }, '未启用'),
                isDirty ? h(Badge, { variant: 'outline', className: 'text-[var(--warning)]' }, '未保存') : null,
                h(
                  'div',
                  { className: 'ml-auto flex flex-wrap items-center gap-1.5' },
                  h(
                    Button,
                    { size: 'xs', variant: 'outline', onClick: () => void validateCurrent(editorText) },
                    '校验语法',
                  ),
                  h(Button, { size: 'xs', variant: 'outline', onClick: () => void diffCurrent() }, '对比 Diff'),
                  h(
                    Button,
                    { size: 'xs', disabled: busy || !isDirty, onClick: () => void saveCurrent() },
                    h(Icon, { name: 'Save', className: 'size-3' }),
                    '保存并启用',
                  ),
                ),
              ),
              h(Textarea, {
                value: editorText,
                onChange: (e) => {
                  const val = e.target.value;
                  setDraftMap((prev) => ({ ...prev, [activeGroup.name]: val }));
                },
                placeholder:
                  '# 在此编写 Whistle 规则，例如：\n# app.example.com/api/ 127.0.0.1:8080\n# https://api.example.com/v1/user resBody://{mock.json}',
                className: 'min-h-[220px] flex-1 resize-none font-mono text-xs leading-relaxed',
              }),
              validation
                ? h(
                    'div',
                    { className: cn(cardSurfaceClass, 'flex flex-col gap-1 p-2.5 text-xs') },
                    h(
                      'div',
                      { className: 'flex items-center gap-2' },
                      h(
                        'span',
                        {
                          className: validation.ok
                            ? 'font-medium text-[var(--success)]'
                            : 'font-medium text-destructive',
                        },
                        validation.ok ? '语法校验通过' : `发现 ${validation.errors.length} 个错误`,
                      ),
                      h(
                        'span',
                        { className: 'text-muted-foreground' },
                        `${validation.lineCount} 行 · ${validation.charCount} 字符`,
                      ),
                    ),
                    ...(validation.errors || []).map((item, idx) =>
                      h(
                        'p',
                        { key: `ve-${idx}-${item.message}`, className: 'text-destructive' },
                        `错误：${item.message}`,
                      ),
                    ),
                    ...(validation.warnings || []).map((item, idx) =>
                      h(
                        'p',
                        { key: `vw-${idx}-${item.message}`, className: 'text-[var(--warning)]' },
                        `提示：${item.message}`,
                      ),
                    ),
                  )
                : null,
              diffResult
                ? h(
                    'div',
                    { className: cn(cardSurfaceClass, 'flex flex-col gap-1 p-2.5 font-mono text-[11px]') },
                    h(
                      'div',
                      { className: 'flex items-center justify-between font-sans text-xs' },
                      h('span', { className: 'font-medium' }, diffResult.same ? '与当前生效规则一致' : '变更对比预览'),
                      h(
                        'span',
                        { className: 'text-muted-foreground' },
                        `+${diffResult.added.length} / -${diffResult.removed.length}`,
                      ),
                    ),
                    ...diffResult.added.map((line, i) =>
                      h('div', { key: `da-${i}-${line}`, className: 'text-[var(--success)]' }, `+ ${line}`),
                    ),
                    ...diffResult.removed.map((line, i) =>
                      h('div', { key: `dr-${i}-${line}`, className: 'text-destructive' }, `- ${line}`),
                    ),
                  )
                : null,

              // 底部折叠规则命中诊断
              h(
                Collapsible,
                { open: ruleTestOpen, onOpenChange: setRuleTestOpen, className: 'border-t border-border pt-2' },
                h(
                  CollapsibleTrigger,
                  { render: h(Button, { size: 'xs', variant: 'outline', className: 'w-full justify-between' }) },
                  h(
                    'span',
                    { className: 'flex items-center gap-1.5' },
                    h(Icon, { name: 'Search', className: 'size-3' }),
                    '规则命中诊断（ruleTest）',
                  ),
                  h(Icon, { name: ruleTestOpen ? 'ChevronDown' : 'ChevronRight', className: 'size-3.5' }),
                ),
                h(
                  CollapsibleContent,
                  { className: 'pt-2' },
                  h(
                    'div',
                    { className: 'flex flex-col gap-2' },
                    h(
                      'div',
                      { className: 'flex flex-wrap items-center gap-2' },
                      h(
                        Select,
                        { value: testMethod, onValueChange: setTestMethod },
                        h(
                          SelectTrigger,
                          { className: 'w-24' },
                          h(SelectValue, null, (v) => v),
                        ),
                        h(
                          SelectContent,
                          null,
                          ...['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((m) =>
                            h(SelectItem, { key: m, value: m }, m),
                          ),
                        ),
                      ),
                      h(Input, {
                        value: testUrl,
                        onChange: (e) => setTestUrl(e.target.value),
                        placeholder: 'https://api.example.com/v1/user',
                        className: 'min-w-[200px] flex-1 font-mono text-xs',
                      }),
                      h(
                        'label',
                        { className: 'flex items-center gap-1.5 text-xs text-muted-foreground' },
                        h(Checkbox, {
                          checked: includeDisabled,
                          onCheckedChange: (v) => setIncludeDisabled(Boolean(v)),
                        }),
                        h('span', null, '含未启用组'),
                      ),
                      h(
                        Button,
                        {
                          size: 'xs',
                          onClick: () =>
                            void rpc
                              .call('ruleTest', {
                                storage: instance.storage,
                                url: testUrl.trim(),
                                method: testMethod,
                                includeDisabled,
                              })
                              .then(setTestResult)
                              .catch((err) => notifyError('规则命中测试失败', err)),
                        },
                        '诊断命中',
                      ),
                    ),
                    testResult ? h(RuleMatchResultView, { result: testResult }) : null,
                  ),
                ),
              ),
            )
          : h(
              'div',
              { className: 'flex flex-1 items-center justify-center p-4 text-xs text-muted-foreground' },
              '在左侧选择或新建一个规则组开始编辑。',
            ),
      ),

      // 新建规则组弹窗
      h(
        Dialog,
        { open: newGroupOpen, onOpenChange: setNewGroupOpen },
        h(
          DialogContent,
          null,
          h(
            DialogHeader,
            null,
            h(DialogTitle, null, '新建规则组'),
            h(DialogDescription, null, '创建后将自动写入并设为启用状态（已开启 Whistle 多选规则）。'),
          ),
          h(
            'div',
            { className: 'flex flex-col gap-3' },
            h(
              Field,
              null,
              h(FieldLabel, null, '规则组名'),
              h(Input, {
                value: newGroupName,
                onChange: (e) => setNewGroupName(e.target.value),
                placeholder: '例如 api-dev',
              }),
            ),
            h(
              Field,
              null,
              h(FieldLabel, null, '初始规则内容'),
              h(Textarea, {
                value: newGroupBody,
                onChange: (e) => setNewGroupBody(e.target.value),
                placeholder: '例如：api.example.com 127.0.0.1:8080',
                className: 'min-h-28 font-mono text-xs',
              }),
            ),
          ),
          h(
            DialogFooter,
            null,
            h(Button, { variant: 'ghost', onClick: () => setNewGroupOpen(false) }, '取消'),
            h(Button, { disabled: busy || !newGroupName.trim(), onClick: () => void createGroup() }, '创建并启用'),
          ),
        ),
      ),

      h(ConfirmDialog, {
        open: Boolean(deleteTarget),
        onOpenChange: (open) => {
          if (!open) setDeleteTarget(null);
        },
        title: `删除规则组「${deleteTarget || ''}」`,
        description: '删除后该组内的规则将从当前 Whistle 实例移除。',
        confirmLabel: '删除',
        busy,
        onConfirm: async () => {
          if (!deleteTarget) return;
          const res = await run(
            () => rpc.call('ruleRemove', { storage: instance.storage, name: deleteTarget }),
            '删除规则组失败',
            `已删除规则组 ${deleteTarget}`,
          );
          if (res && Array.isArray(res.rules)) setRulesView(res);
          setDeleteTarget(null);
        },
      }),
    );
  }

  function ValuesTab({ instance, busy, run, signalTick }) {
    const [query, setQuery] = useState('');
    const [values, setValues] = useState([]);
    const [selectedName, setSelectedName] = useState('');
    const [editorValue, setEditorValue] = useState('');
    const [loadedValue, setLoadedValue] = useState('');
    const [newOpen, setNewOpen] = useState(false);
    const [newName, setNewName] = useState('');
    const [newBody, setNewBody] = useState('{\n  "ok": true\n}');
    const [renameOpen, setRenameOpen] = useState(false);
    const [renameTarget, setRenameTarget] = useState('');
    const [deleteTarget, setDeleteTarget] = useState(null);

    useEffect(() => {
      if (!instance?.storage || !instance?.alive) return;
      let cancelled = false;
      rpc
        .call('valueList', { storage: instance.storage, query: query.trim() || undefined })
        .then((res) => {
          if (!cancelled) setValues(Array.isArray(res?.values) ? res.values : []);
        })
        .catch(() => {
          if (!cancelled) setValues([]);
        });
      return () => {
        cancelled = true;
      };
    }, [instance?.storage, instance?.alive, query, signalTick]);

    const activeName = values.some((v) => v.name === selectedName) ? selectedName : (values[0]?.name ?? '');

    useEffect(() => {
      if (!instance?.storage || !instance?.alive || !activeName) return;
      let cancelled = false;
      rpc
        .call('valueGet', { storage: instance.storage, name: activeName })
        .then((res) => {
          if (cancelled) return;
          const text = String(res?.value ?? '');
          setLoadedValue(text);
          setEditorValue(text);
        })
        .catch((err) => {
          if (!cancelled) notifyError(`读取 Value ${activeName} 失败`, err);
        });
      return () => {
        cancelled = true;
      };
    }, [instance?.storage, instance?.alive, activeName, signalTick]);

    if (!instance.alive) {
      return h(
        'div',
        { className: 'p-4' },
        h(
          Empty,
          null,
          h(
            EmptyHeader,
            null,
            h(EmptyMedia, { variant: 'icon' }, h(Icon, { name: 'Package' })),
            h(EmptyTitle, null, '实例已停止'),
            h(EmptyDescription, null, '启动 Whistle 实例后即可管理 `{mock.json}` 等 Values 数据区条目。'),
          ),
        ),
      );
    }

    const activeItem = values.find((v) => v.name === activeName);
    const isDirty = Boolean(activeName) && editorValue !== loadedValue;

    const formatJson = () => {
      try {
        const parsed = JSON.parse(editorValue);
        setEditorValue(JSON.stringify(parsed, null, 2));
      } catch (err) {
        notifyError('正文不是合法 JSON', err);
      }
    };

    return h(
      'div',
      { className: 'flex h-full min-h-0 overflow-hidden', 'data-slot': 'whistle-values' },
      // 左栏：Value 列表
      h(
        'div',
        { className: 'flex w-60 shrink-0 flex-col border-r border-border min-h-0' },
        h(
          'div',
          { className: 'flex flex-col gap-2 border-b border-border p-2.5' },
          h(
            'div',
            { className: 'flex items-center justify-between gap-1.5' },
            h('span', { className: 'text-xs font-medium' }, `Values (${values.length})`),
            h(
              Button,
              {
                size: 'xs',
                variant: 'outline',
                onClick: () => {
                  setNewName('');
                  setNewBody('{\n  "ok": true\n}');
                  setNewOpen(true);
                },
              },
              h(Icon, { name: 'Plus', className: 'size-3' }),
              '新建 Value',
            ),
          ),
          h(Input, {
            value: query,
            onChange: (e) => setQuery(e.target.value),
            placeholder: '搜索 Value 名称…',
            className: 'text-xs',
          }),
        ),
        h(
          'div',
          { className: 'flex-1 min-h-0 overflow-y-auto p-1.5 flex flex-col gap-1' },
          values.length === 0
            ? h('p', { className: 'p-2 text-xs text-muted-foreground' }, '暂无 Value')
            : values.map((item) =>
                h(
                  ListRow,
                  { key: item.name, selected: activeName === item.name },
                  h(
                    ListRowMain,
                    { onClick: () => setSelectedName(item.name) },
                    h(
                      ListRowLabel,
                      { className: 'min-w-0 flex-1' },
                      h(ListRowLabelText, { className: 'font-mono text-xs' }, item.name),
                    ),
                    h(ListRowMeta, { className: 'shrink-0 whitespace-nowrap tabular-nums' }, formatBytes(item.size)),
                  ),
                ),
              ),
        ),
      ),

      // 右栏：Value 编辑器
      h(
        'div',
        { className: 'flex min-w-0 flex-1 flex-col min-h-0 p-3 gap-2.5 overflow-hidden' },
        activeName
          ? h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'flex flex-wrap items-center gap-1.5' },
                h('span', { className: 'font-mono text-sm font-medium' }, activeName),
                activeItem ? h(Badge, { variant: 'outline' }, formatBytes(activeItem.size)) : null,
                isDirty ? h(Badge, { variant: 'outline', className: 'text-[var(--warning)]' }, '未保存') : null,
                h(
                  'div',
                  { className: 'ml-auto flex flex-wrap items-center gap-1.5' },
                  h(
                    Button,
                    { size: 'xs', variant: 'outline', onClick: () => void copyText(`{${activeName}}`, '规则引用语法') },
                    h(Icon, { name: 'Copy', className: 'size-3' }),
                    `复制 {${activeName}}`,
                  ),
                  h(Button, { size: 'xs', variant: 'outline', onClick: formatJson }, 'JSON 格式化'),
                  h(
                    Button,
                    {
                      size: 'xs',
                      variant: 'outline',
                      onClick: () => {
                        setRenameTarget(activeName);
                        setRenameOpen(true);
                      },
                    },
                    h(Icon, { name: 'Pencil', className: 'size-3' }),
                    '重命名',
                  ),
                  h(
                    Button,
                    { size: 'xs', variant: 'ghost', onClick: () => setDeleteTarget(activeName) },
                    h(Icon, { name: 'Trash', className: 'size-3 text-destructive' }),
                  ),
                  h(
                    Button,
                    {
                      size: 'xs',
                      disabled: busy || !isDirty,
                      onClick: () =>
                        void run(
                          () =>
                            rpc.call('valueSet', { storage: instance.storage, name: activeName, value: editorValue }),
                          '保存 Value 失败',
                          `Value ${activeName} 已保存`,
                        ).then((res) => res && setLoadedValue(editorValue)),
                    },
                    h(Icon, { name: 'Save', className: 'size-3' }),
                    '保存',
                  ),
                ),
              ),
              h(Textarea, {
                value: editorValue,
                onChange: (e) => setEditorValue(e.target.value),
                className: 'min-h-[240px] flex-1 resize-none font-mono text-xs leading-relaxed',
              }),
            )
          : h(
              'div',
              { className: 'flex flex-1 items-center justify-center text-xs text-muted-foreground' },
              '在左侧选择或新建 Value（可在规则中以 `resBody://{name}` 引用）。',
            ),
      ),

      // 新建 Value 弹窗
      h(
        Dialog,
        { open: newOpen, onOpenChange: setNewOpen },
        h(
          DialogContent,
          null,
          h(
            DialogHeader,
            null,
            h(DialogTitle, null, '新建 Value'),
            h(DialogDescription, null, '在 Whistle 规则里可通过 `{名称}` 引用该正文。'),
          ),
          h(
            'div',
            { className: 'flex flex-col gap-3' },
            h(
              Field,
              null,
              h(FieldLabel, null, '名称'),
              h(Input, {
                value: newName,
                onChange: (e) => setNewName(e.target.value),
                placeholder: '例如 mock-user.json',
                className: 'font-mono text-xs',
              }),
            ),
            h(
              Field,
              null,
              h(FieldLabel, null, '正文内容'),
              h(Textarea, {
                value: newBody,
                onChange: (e) => setNewBody(e.target.value),
                className: 'min-h-32 font-mono text-xs',
              }),
            ),
          ),
          h(
            DialogFooter,
            null,
            h(Button, { variant: 'ghost', onClick: () => setNewOpen(false) }, '取消'),
            h(
              Button,
              {
                disabled: busy || !newName.trim(),
                onClick: () =>
                  void run(
                    () => rpc.call('valueSet', { storage: instance.storage, name: newName.trim(), value: newBody }),
                    '创建 Value 失败',
                    `已创建 ${newName.trim()}`,
                  ).then((res) => {
                    if (res) {
                      setSelectedName(newName.trim());
                      setNewOpen(false);
                    }
                  }),
              },
              '创建',
            ),
          ),
        ),
      ),

      // 重命名弹窗
      h(
        Dialog,
        { open: renameOpen, onOpenChange: setRenameOpen },
        h(
          DialogContent,
          null,
          h(DialogHeader, null, h(DialogTitle, null, `重命名 ${activeName}`)),
          h(
            Field,
            null,
            h(FieldLabel, null, '新名称'),
            h(Input, {
              value: renameTarget,
              onChange: (e) => setRenameTarget(e.target.value),
              className: 'font-mono text-xs',
            }),
          ),
          h(
            DialogFooter,
            null,
            h(Button, { variant: 'ghost', onClick: () => setRenameOpen(false) }, '取消'),
            h(
              Button,
              {
                disabled: busy || !renameTarget.trim() || renameTarget.trim() === activeName,
                onClick: () =>
                  void run(
                    () =>
                      rpc.call('valueRename', {
                        storage: instance.storage,
                        name: activeName,
                        newName: renameTarget.trim(),
                      }),
                    '重命名 Value 失败',
                    `已重命名为 ${renameTarget.trim()}`,
                  ).then((res) => {
                    if (res) {
                      setSelectedName(renameTarget.trim());
                      setRenameOpen(false);
                    }
                  }),
              },
              '确认重命名',
            ),
          ),
        ),
      ),

      h(ConfirmDialog, {
        open: Boolean(deleteTarget),
        onOpenChange: (open) => {
          if (!open) setDeleteTarget(null);
        },
        title: `删除 Value「${deleteTarget || ''}」`,
        description: '删除后引用该 Value 的规则将不再返回此正文。',
        confirmLabel: '删除',
        busy,
        onConfirm: async () => {
          if (!deleteTarget) return;
          await run(
            () => rpc.call('valueRemove', { storage: instance.storage, name: deleteTarget }),
            '删除 Value 失败',
            `已删除 ${deleteTarget}`,
          );
          setDeleteTarget(null);
        },
      }),
    );
  }

  function PresetsTab({ instance, busy, run, signalTick }) {
    const [presets, setPresets] = useState([]);
    const [profile, setProfile] = useState(null);
    const [selectedId, setSelectedId] = useState('');
    const [definition, setDefinition] = useState(null);
    const [revision, setRevision] = useState(null);
    const [variables, setVariables] = useState({});
    const [layers, setLayers] = useState({});
    const [localUrl, setLocalUrl] = useState('');
    const [preview, setPreview] = useState(null);
    const [importOpen, setImportOpen] = useState(false);
    const [importId, setImportId] = useState('');
    const [importTitle, setImportTitle] = useState('');
    const [importText, setImportText] = useState('');
    const [exportText, setExportText] = useState(null);
    const [deleteTarget, setDeleteTarget] = useState(null);

    useEffect(() => {
      let cancelled = false;
      rpc
        .call('presetList')
        .then((res) => {
          if (!cancelled) setPresets(Array.isArray(res?.presets) ? res.presets : []);
        })
        .catch(() => {
          if (!cancelled) setPresets([]);
        });
      return () => {
        cancelled = true;
      };
    }, [signalTick]);

    useEffect(() => {
      if (!instance?.storage) return;
      let cancelled = false;
      rpc
        .call('profileGet', { storage: instance.storage })
        .then((res) => {
          if (!cancelled) setProfile(res?.profile ?? null);
        })
        .catch(() => {
          if (!cancelled) setProfile(null);
        });
      return () => {
        cancelled = true;
      };
    }, [instance?.storage, signalTick]);

    const activePresetId = presets.some((p) => p.id === selectedId)
      ? selectedId
      : (presets.find((p) => p.id === profile?.presetId)?.id ?? presets[0]?.id ?? '');

    useEffect(() => {
      if (!activePresetId) return;
      let cancelled = false;
      rpc
        .call('presetGet', { id: activePresetId })
        .then((res) => {
          if (cancelled) return;
          const def = res.definition;
          setDefinition(def);
          setRevision(res.revision);
          const nextVars = {};
          for (const [k, d] of Object.entries(def?.variables ?? {})) {
            nextVars[k] = d.default ?? '';
          }
          setVariables(nextVars);
          const nextLayers = {};
          for (const layer of def?.layers ?? []) {
            nextLayers[layer.id] = layer.enabled !== false;
          }
          setLayers(nextLayers);
          setPreview(null);
        })
        .catch(() => {
          if (!cancelled) setDefinition(null);
        });
      return () => {
        cancelled = true;
      };
    }, [activePresetId]);

    const doPreview = async (scenarioOverride) => {
      if (!activePresetId) return null;
      try {
        const res = await rpc.call('presetPreview', {
          storage: instance.storage,
          id: activePresetId,
          variables,
          ...(localUrl.trim() ? { localUrl: localUrl.trim() } : {}),
          ...(scenarioOverride ? { scenario: scenarioOverride } : { layers }),
        });
        setPreview(res);
        return res;
      } catch (err) {
        notifyError('预设预览失败', err);
        return null;
      }
    };

    const doApply = async (scenarioOverride) => {
      if (!instance.alive) {
        notifyError('无法应用预设', '请先启动实例');
        return;
      }
      let currentPreview = preview;
      if (!currentPreview || scenarioOverride) {
        currentPreview = await doPreview(scenarioOverride);
      }
      if (!currentPreview || (currentPreview.errors?.length ?? 0) > 0) return;
      await run(
        () =>
          rpc.call('presetApply', {
            storage: instance.storage,
            id: activePresetId,
            revision,
            variables,
            ...(localUrl.trim() ? { localUrl: localUrl.trim() } : {}),
            ...(scenarioOverride ? { scenario: scenarioOverride } : { layers }),
            expectedHash: currentPreview.hash,
            allowWarnings: true,
          }),
        '应用预设失败',
        '预设已应用到实例',
        `${currentPreview.lineCount} 行 · ${currentPreview.hash.slice(0, 10)}`,
      );
    };

    const doImportSave = async () => {
      if (!importText.trim()) return;
      const res = await run(async () => {
        const imported = await rpc.call('presetImport', {
          text: importText,
          id: importId.trim() || undefined,
          title: importTitle.trim() || undefined,
        });
        if (!imported.ok) {
          throw new Error(imported.errors?.map((e) => e.message).join('; ') || '导入失败');
        }
        const def = { ...imported.draft };
        delete def.draft;
        return rpc.call('presetSave', { definition: def });
      }, '导入规则为预设失败');
      if (res?.presetId) {
        setSelectedId(res.presetId);
        setImportOpen(false);
        notifySuccess('已保存为预设', `${res.presetId} · r${res.revision}`);
      }
    };

    const doImportFromCurrentRule = async () => {
      try {
        const res = await rpc.call('ruleGet', { storage: instance.storage, name: 'warren' });
        if (res?.rule?.data) {
          setImportText(res.rule.data);
          notifyInfo('已读取当前实例 warren 规则组');
        } else {
          notifyInfo('当前实例暂无 warren 规则组');
        }
      } catch (err) {
        notifyError('读取当前规则失败', err);
      }
    };

    return h(
      'div',
      { className: 'flex h-full min-h-0 flex-col overflow-hidden', 'data-slot': 'whistle-presets' },
      // 顶部场景切换条 + Profile 状态
      h(
        'div',
        { className: 'flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 text-xs' },
        h(
          'div',
          { className: 'flex flex-wrap items-center gap-1.5' },
          h('span', { className: 'font-medium text-muted-foreground' }, '场景切换：'),
          ...SCENARIO_LIST.map((sc) =>
            h(
              Button,
              {
                key: sc.id,
                size: 'xs',
                variant: 'outline',
                disabled: busy || !instance.alive || !activePresetId,
                title: sc.desc,
                onClick: () => void doApply(sc.id),
              },
              sc.label,
            ),
          ),
        ),
        profile
          ? h(
              'div',
              { className: 'ml-auto flex items-center gap-2' },
              h(
                Badge,
                { variant: 'secondary', className: 'font-mono text-[11px]' },
                `已应用 ${profile.presetId} r${profile.revision}`,
              ),
              h(
                Button,
                {
                  size: 'xs',
                  variant: 'ghost',
                  disabled: busy,
                  onClick: () =>
                    void run(
                      () => rpc.call('profileClear', { storage: instance.storage }),
                      '清除 Profile 记录失败',
                      '已清除预设应用记录',
                    ),
                },
                '清除记录',
              ),
            )
          : null,
        h(
          Button,
          {
            size: 'xs',
            className: profile ? '' : 'ml-auto',
            onClick: () => {
              setImportId('');
              setImportTitle('');
              setImportText('');
              setImportOpen(true);
            },
          },
          h(Icon, { name: 'Plus', className: 'size-3' }),
          '导入规则为预设',
        ),
      ),

      // 主体左右分栏
      presets.length === 0
        ? h(
            'div',
            { className: 'flex flex-1 items-center justify-center p-4' },
            h(
              Empty,
              null,
              h(
                EmptyHeader,
                null,
                h(EmptyMedia, { variant: 'icon' }, h(Icon, { name: 'Sliders' })),
                h(EmptyTitle, null, '还没有已保存的预设'),
                h(
                  EmptyDescription,
                  null,
                  '点击上方「导入规则为预设」，把现有 Whistle 规则导入为可按场景切换的结构化预设。',
                ),
              ),
            ),
          )
        : h(
            'div',
            { className: 'flex min-h-0 flex-1 overflow-hidden' },
            // 左预设列表
            h(
              'div',
              { className: 'flex w-56 shrink-0 flex-col border-r border-border min-h-0 overflow-y-auto p-1.5 gap-1' },
              ...presets.map((preset) =>
                h(
                  ListRow,
                  { key: preset.id, selected: activePresetId === preset.id },
                  h(
                    ListRowMain,
                    { onClick: () => setSelectedId(preset.id) },
                    h(ListRowLabel, null, h(ListRowLabelText, null, preset.name)),
                    h(ListRowMeta, null, `r${preset.revision}`),
                  ),
                  h(
                    ListRowActions,
                    { alwaysVisible: false },
                    h(
                      ListRowActionButton,
                      {
                        title: '导出 JSON',
                        onClick: () =>
                          void rpc
                            .call('presetExport', { id: preset.id })
                            .then((res) => setExportText(JSON.stringify(res.definition, null, 2)))
                            .catch((err) => notifyError('导出预设失败', err)),
                      },
                      h(Icon, { name: 'Download' }),
                    ),
                    h(
                      ListRowActionButton,
                      {
                        tone: 'destructive',
                        title: '删除预设',
                        onClick: () => setDeleteTarget(preset.id),
                      },
                      h(Icon, { name: 'Trash' }),
                    ),
                  ),
                ),
              ),
            ),
            // 右预设合成与预览工作台
            h(
              'div',
              { className: 'min-w-0 flex-1 overflow-y-auto p-4 flex flex-col gap-3 text-xs' },
              definition
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'flex flex-wrap items-center gap-2' },
                      h('span', { className: 'text-sm font-medium' }, definition.name),
                      h(Badge, { variant: 'outline', className: 'font-mono' }, `${definition.id} · r${revision}`),
                      h(
                        'div',
                        { className: 'ml-auto flex items-center gap-1.5' },
                        h(Button, { size: 'xs', variant: 'outline', onClick: () => void doPreview() }, '预览合成'),
                        h(
                          Button,
                          { size: 'xs', disabled: busy || !instance.alive, onClick: () => void doApply() },
                          '应用到当前实例',
                        ),
                      ),
                    ),
                    h(
                      Field,
                      null,
                      h(FieldLabel, null, '本地服务地址（可选，自动提取端口）'),
                      h(Input, {
                        value: localUrl,
                        onChange: (e) => {
                          setLocalUrl(e.target.value);
                          setPreview(null);
                        },
                        placeholder: 'http://127.0.0.1:5173',
                        className: 'font-mono text-xs',
                      }),
                    ),
                    Object.keys(definition.variables || {}).length > 0
                      ? h(
                          'div',
                          { className: 'grid grid-cols-2 gap-2' },
                          ...Object.entries(definition.variables).map(([key, desc]) =>
                            h(
                              Field,
                              { key },
                              h(FieldLabel, null, `${desc.label || key}${desc.required ? ' *' : ''}`),
                              h(Input, {
                                value: String(variables[key] ?? ''),
                                onChange: (e) => {
                                  setVariables({ ...variables, [key]: e.target.value });
                                  setPreview(null);
                                },
                                className: 'font-mono text-xs',
                              }),
                            ),
                          ),
                        )
                      : null,
                    h(
                      'div',
                      { className: cn(cardSurfaceClass, 'flex flex-col gap-2 p-3') },
                      h(
                        'span',
                        { className: 'font-medium text-muted-foreground' },
                        `规则层 (${(definition.layers || []).length})`,
                      ),
                      h(
                        'div',
                        { className: 'grid grid-cols-2 gap-2' },
                        ...(definition.layers || []).map((layer) =>
                          h(
                            'label',
                            { key: layer.id, className: 'flex items-center gap-2 text-xs' },
                            h(Switch, {
                              checked: Boolean(layers[layer.id]),
                              onCheckedChange: (checked) => {
                                setLayers({ ...layers, [layer.id]: Boolean(checked) });
                                setPreview(null);
                              },
                            }),
                            h('span', { className: 'truncate font-mono' }, `${layer.id} (${layer.kind})`),
                          ),
                        ),
                      ),
                    ),
                    preview
                      ? h(
                          'div',
                          { className: cn(cardSurfaceClass, 'flex flex-col gap-2 p-3') },
                          h(
                            'div',
                            { className: 'flex items-center justify-between' },
                            h(
                              'span',
                              { className: 'font-medium' },
                              `预览结果：${preview.lineCount} 行 · ${preview.charCount} 字符`,
                            ),
                            h(
                              'span',
                              { className: 'font-mono text-[11px] text-muted-foreground' },
                              preview.hash.slice(0, 12),
                            ),
                          ),
                          ...(preview.errors || []).map((e, i) =>
                            h('p', { key: `pe-${i}-${e.message}`, className: 'text-destructive' }, e.message),
                          ),
                          ...(preview.warnings || []).map((w, i) =>
                            h('p', { key: `pw-${i}-${w.message}`, className: 'text-[var(--warning)]' }, w.message),
                          ),
                          h(
                            'pre',
                            {
                              className:
                                'max-h-56 overflow-auto rounded-[var(--radius-sm)] bg-muted/40 p-2 font-mono text-[11px] text-foreground',
                            },
                            preview.rules || '# (空规则)',
                          ),
                        )
                      : null,
                  )
                : null,
            ),
          ),

      // 导入规则为预设弹窗
      h(
        Dialog,
        { open: importOpen, onOpenChange: setImportOpen },
        h(
          DialogContent,
          null,
          h(
            DialogHeader,
            null,
            h(DialogTitle, null, '导入规则为预设'),
            h(
              DialogDescription,
              null,
              '支持粘贴 Whistle 规则文本或从当前实例 warren 组读取，自动分层保存为可切换预设。',
            ),
          ),
          h(
            'div',
            { className: 'flex flex-col gap-3' },
            h(
              'div',
              { className: 'grid grid-cols-2 gap-2' },
              h(
                Field,
                null,
                h(FieldLabel, null, '预设 ID（可选）'),
                h(Input, { value: importId, onChange: (e) => setImportId(e.target.value), placeholder: 'my-project' }),
              ),
              h(
                Field,
                null,
                h(FieldLabel, null, '预设名称（可选）'),
                h(Input, {
                  value: importTitle,
                  onChange: (e) => setImportTitle(e.target.value),
                  placeholder: '项目代理预设',
                }),
              ),
            ),
            h(
              Field,
              null,
              h(
                'div',
                { className: 'flex items-center justify-between' },
                h(FieldLabel, null, '规则文本'),
                instance.alive
                  ? h(
                      Button,
                      { size: 'xs', variant: 'ghost', onClick: () => void doImportFromCurrentRule() },
                      '读取 warren 规则组',
                    )
                  : null,
              ),
              h(Textarea, {
                value: importText,
                onChange: (e) => setImportText(e.target.value),
                placeholder: '粘贴 Whistle 规则文本…',
                className: 'min-h-36 font-mono text-xs',
              }),
            ),
          ),
          h(
            DialogFooter,
            null,
            h(Button, { variant: 'ghost', onClick: () => setImportOpen(false) }, '取消'),
            h(Button, { disabled: busy || !importText.trim(), onClick: () => void doImportSave() }, '导入并保存'),
          ),
        ),
      ),

      // 导出 JSON 查看弹窗
      h(
        Dialog,
        { open: Boolean(exportText), onOpenChange: (o) => !o && setExportText(null) },
        h(
          DialogContent,
          null,
          h(DialogHeader, null, h(DialogTitle, null, '预设 JSON 定义')),
          h(
            'pre',
            { className: 'max-h-72 overflow-auto rounded-[var(--radius-sm)] bg-muted/40 p-3 font-mono text-[11px]' },
            exportText || '',
          ),
          h(
            DialogFooter,
            null,
            h(Button, { variant: 'outline', onClick: () => void copyText(exportText || '', '预设 JSON') }, '复制 JSON'),
            h(Button, { onClick: () => setExportText(null) }, '关闭'),
          ),
        ),
      ),

      h(ConfirmDialog, {
        open: Boolean(deleteTarget),
        onOpenChange: (o) => !o && setDeleteTarget(null),
        title: `删除预设「${deleteTarget || ''}」`,
        description: '删除后不可恢复，已写入实例的规则文本不会自动删改。',
        confirmLabel: '删除',
        busy,
        onConfirm: async () => {
          if (!deleteTarget) return;
          await run(() => rpc.call('presetDelete', { id: deleteTarget }), '删除预设失败', `已删除预设 ${deleteTarget}`);
          setDeleteTarget(null);
        },
      }),
    );
  }

  function TrafficTab({ instance, busy, run, signalTick }) {
    const [subUrl, setSubUrl] = useState('');
    const [typeFilter, setTypeFilter] = useState('ALL');
    const [methodFilter, setMethodFilter] = useState('ALL');
    const [statusFilter, setStatusFilter] = useState('');
    const [entries, setEntries] = useState([]);
    const [selectedId, setSelectedId] = useState('');
    const [nonce, setNonce] = useState(0);
    const [detailTab, setDetailTab] = useState('inspect');
    const [replayUrl, setReplayUrl] = useState('');
    const [replayMethod, setReplayMethod] = useState('GET');
    const [replayHeaders, setReplayHeaders] = useState('{}');
    const [replayBody, setReplayBody] = useState('');
    const [replayRules, setReplayRules] = useState('');
    const [replayTimes, setReplayTimes] = useState('1');
    const [replayRes, setReplayRes] = useState(null);
    const [replaying, setReplaying] = useState(false);
    const [framesData, setFramesData] = useState(null);
    const [exportOpen, setExportOpen] = useState(false);
    const [exportDir, setExportDir] = useState('/tmp');

    useEffect(() => {
      if (!instance?.storage || !instance?.alive) return;
      let cancelled = false;
      const statusNums = statusFilter
        .split(/[,\s]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 100);
      rpc
        .call('traffic', {
          storage: instance.storage,
          latest: true,
          count: 80,
          ...(subUrl.trim() ? { subUrl: subUrl.trim() } : {}),
          ...(typeFilter !== 'ALL' ? { type: typeFilter } : {}),
          ...(methodFilter !== 'ALL' ? { method: methodFilter } : {}),
          ...(statusNums.length === 1
            ? { statusCode: statusNums[0] }
            : statusNums.length > 1
              ? { statusCode: statusNums }
              : {}),
        })
        .then((res) => {
          if (!cancelled) setEntries(Array.isArray(res?.entries) ? [...res.entries].reverse() : []);
        })
        .catch(() => {
          if (!cancelled) setEntries([]);
        });
      return () => {
        cancelled = true;
      };
    }, [instance?.storage, instance?.alive, subUrl, typeFilter, methodFilter, statusFilter, nonce, signalTick]);

    const liveEntries = instance?.alive ? entries : [];
    const selected = liveEntries.find((e) => e.entryId === selectedId) ?? liveEntries[0] ?? null;

    const selectEntry = (entry) => {
      setSelectedId(entry.entryId);
      setReplayUrl(entry.url || '');
      setReplayMethod(entry.method || 'GET');
      setReplayHeaders(JSON.stringify(entry.requestHeaders || {}, null, 2));
      setReplayBody(formatJsonSafe(entry.requestBody));
      setReplayRules('');
      setReplayTimes('1');
      setReplayRes(null);
      setFramesData(null);
    };

    const doReplay = async () => {
      if (!selected || replaying) return;
      setReplaying(true);
      try {
        let headersObj;
        if (replayHeaders.trim()) {
          headersObj = JSON.parse(replayHeaders);
        }
        const res = await rpc.call('replay', {
          storage: instance.storage,
          reqId: selected.entryId,
          url: replayUrl.trim() || selected.url,
          method: replayMethod.trim() || selected.method,
          ...(headersObj ? { headers: headersObj } : {}),
          ...(replayBody !== '' ? { body: replayBody } : {}),
          ...(replayRules.trim() ? { rules: replayRules.trim() } : {}),
          times: Math.max(1, Number(replayTimes) || 1),
          diff: true,
        });
        setReplayRes(res);
        notifySuccess('重放完成', `原 ${res.original?.status ?? '—'} → 新 ${res.replayed?.status ?? '—'}`);
      } catch (err) {
        notifyError('重放请求失败', err);
      } finally {
        setReplaying(false);
      }
    };

    const doCaptureLink = async () => {
      const res = await run(
        () =>
          rpc.call('captureLink', {
            storage: instance.storage,
            ...(instance.environmentId ? { environmentId: instance.environmentId, open: true } : {}),
            ...(subUrl.trim() ? { subUrl: subUrl.trim() } : {}),
            ...(typeFilter !== 'ALL' ? { type: typeFilter } : {}),
            ...(methodFilter !== 'ALL' ? { method: methodFilter } : {}),
          }),
        '生成排障链接失败',
      );
      if (res?.url) await copyText(res.url, '排障直达链接');
    };

    const doExportHar = async () => {
      if (!exportDir.trim()) return;
      const res = await run(
        () =>
          rpc.call('export', {
            storage: instance.storage,
            type: 'har',
            directory: exportDir.trim(),
            ...(subUrl.trim() ? { urls: [subUrl.trim()] } : {}),
            ...(methodFilter !== 'ALL' ? { methods: [methodFilter] } : {}),
          }),
        '导出 HAR 失败',
      );
      if (res?.file) {
        setExportOpen(false);
        notifySuccess('HAR 导出成功', res.file);
      }
    };

    if (!instance.alive) {
      return h(
        'div',
        { className: 'p-4' },
        h(
          Empty,
          null,
          h(
            EmptyHeader,
            null,
            h(EmptyMedia, { variant: 'icon' }, h(Icon, { name: 'Activity' })),
            h(EmptyTitle, null, '实例已停止'),
            h(EmptyDescription, null, '启动 Whistle 实例后即可查看实时抓包流、分阶段耗时与改参重放。'),
          ),
        ),
      );
    }

    return h(
      'div',
      { className: 'flex h-full min-h-0 flex-col overflow-hidden', 'data-slot': 'whistle-traffic' },
      // 过滤工具栏
      h(
        'div',
        { className: 'flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs' },
        h(Input, {
          value: subUrl,
          onChange: (e) => setSubUrl(e.target.value),
          placeholder: '搜索 subUrl…',
          className: 'w-44 text-xs',
        }),
        h(
          Select,
          { value: typeFilter, onValueChange: setTypeFilter },
          h(
            SelectTrigger,
            { className: 'w-24' },
            h(SelectValue, null, (v) => (v === 'ALL' ? '全部类型' : v)),
          ),
          h(
            SelectContent,
            null,
            ...TRAFFIC_TYPES.map((tp) => h(SelectItem, { key: tp, value: tp }, tp === 'ALL' ? '全部类型' : tp)),
          ),
        ),
        h(
          Select,
          { value: methodFilter, onValueChange: setMethodFilter },
          h(
            SelectTrigger,
            { className: 'w-24' },
            h(SelectValue, null, (v) => (v === 'ALL' ? '全部方法' : v)),
          ),
          h(
            SelectContent,
            null,
            ...TRAFFIC_METHODS.map((m) => h(SelectItem, { key: m, value: m }, m === 'ALL' ? '全部方法' : m)),
          ),
        ),
        h(Input, {
          value: statusFilter,
          onChange: (e) => setStatusFilter(e.target.value),
          placeholder: '状态码 (如 500)',
          className: 'w-32 font-mono text-xs',
        }),
        h(
          'div',
          { className: 'ml-auto flex items-center gap-1.5' },
          h(
            Button,
            { size: 'xs', variant: 'outline', onClick: () => setNonce((n) => n + 1) },
            h(Icon, { name: 'Refresh', className: 'size-3' }),
            '刷新',
          ),
          h(
            Button,
            {
              size: 'xs',
              variant: 'outline',
              disabled: busy || liveEntries.length === 0,
              onClick: () => setExportOpen(true),
            },
            h(Icon, { name: 'Download', className: 'size-3' }),
            '导出 HAR',
          ),
          h(
            Button,
            {
              size: 'xs',
              variant: 'outline',
              disabled: busy || liveEntries.length === 0,
              onClick: () => void doCaptureLink(),
            },
            h(Icon, { name: 'ExternalLink', className: 'size-3' }),
            '生成排障链接',
          ),
        ),
      ),

      // 主从抓包分栏
      h(
        'div',
        { className: 'flex min-h-0 flex-1 overflow-hidden' },
        // 左请求表
        h(
          'div',
          { className: 'flex w-[44%] min-w-[260px] shrink-0 flex-col border-r border-border min-h-0 overflow-y-auto' },
          liveEntries.length === 0
            ? h('p', { className: 'p-4 text-xs text-muted-foreground' }, '暂无匹配的抓包请求。')
            : liveEntries.map((entry) => {
                const isSelected = selected?.entryId === entry.entryId;
                const ruleCount = Array.isArray(entry.matchedRules) ? entry.matchedRules.length : 0;
                return h(
                  'button',
                  {
                    key: entry.entryId,
                    type: 'button',
                    onClick: () => selectEntry(entry),
                    className: cn(
                      'flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left text-xs transition-colors hover:bg-surface-hover',
                      isSelected && 'bg-surface-selected',
                    ),
                  },
                  h(
                    'span',
                    { className: cn('w-9 shrink-0 font-mono font-medium', statusToneClass(entry.status)) },
                    entry.status ?? '—',
                  ),
                  h(
                    'span',
                    { className: 'w-11 shrink-0 font-mono text-[11px] text-muted-foreground' },
                    entry.method || 'GET',
                  ),
                  h(
                    'span',
                    { className: 'min-w-0 flex-1 truncate font-mono text-[11px] text-foreground', title: entry.url },
                    shortUrlPath(entry.url),
                  ),
                  ruleCount > 0
                    ? h(
                        Badge,
                        { variant: 'secondary', className: 'shrink-0 text-[length:var(--font-size-micro)]' },
                        `${ruleCount}`,
                      )
                    : null,
                  h(
                    'span',
                    { className: 'w-14 shrink-0 text-right font-mono text-[11px] text-muted-foreground' },
                    formatMs(entry.timings?.total),
                  ),
                );
              }),
        ),

        // 右详情与重放面板
        h(
          'div',
          { className: 'min-w-0 flex-1 overflow-y-auto p-3 text-xs' },
          selected
            ? h(
                'div',
                { className: 'flex flex-col gap-3' },
                h(
                  'div',
                  { className: cn(cardSurfaceClass, 'flex flex-col gap-2 p-3') },
                  h(
                    'div',
                    { className: 'flex flex-wrap items-center gap-2' },
                    h(
                      'span',
                      { className: cn('font-mono text-sm font-semibold', statusToneClass(selected.status)) },
                      selected.status ?? '—',
                    ),
                    h(Badge, { variant: 'outline', className: 'font-mono' }, selected.method || 'GET'),
                    selected.requestId
                      ? h(
                          Badge,
                          { variant: 'secondary', className: 'font-mono text-[length:var(--font-size-micro)]' },
                          `RequestId: ${selected.requestId}`,
                        )
                      : null,
                    h(
                      'div',
                      { className: 'ml-auto flex items-center gap-1.5' },
                      h(
                        Button,
                        {
                          size: 'xs',
                          variant: 'outline',
                          onClick: () =>
                            void rpc
                              .call('toCurl', { storage: instance.storage, reqId: selected.entryId })
                              .then((res) => copyText(res.curl, '脱敏 cURL'))
                              .catch((err) => notifyError('生成 cURL 失败', err)),
                        },
                        h(Icon, { name: 'Copy', className: 'size-3' }),
                        '复制脱敏 cURL',
                      ),
                      h(
                        Button,
                        {
                          size: 'xs',
                          variant: 'outline',
                          onClick: () =>
                            void rpc
                              .call('frames', { storage: instance.storage, reqId: selected.entryId })
                              .then(setFramesData)
                              .catch((err) => notifyError('读取 Frames 失败', err)),
                        },
                        '查看帧 (WS/流)',
                      ),
                    ),
                  ),
                  h('div', { className: 'break-all font-mono text-[11px] text-muted-foreground' }, selected.url),
                  // 分阶段 timings
                  h(
                    'div',
                    { className: 'grid grid-cols-5 gap-1.5 border-t border-border pt-2 font-mono text-[11px]' },
                    h(
                      'div',
                      null,
                      h('span', { className: 'text-muted-foreground' }, 'DNS: '),
                      formatMs(selected.timings?.dns),
                    ),
                    h(
                      'div',
                      null,
                      h('span', { className: 'text-muted-foreground' }, 'Connect: '),
                      formatMs(selected.timings?.connect),
                    ),
                    h(
                      'div',
                      null,
                      h('span', { className: 'text-muted-foreground' }, 'TTFB: '),
                      formatMs(selected.timings?.ttfb),
                    ),
                    h(
                      'div',
                      null,
                      h('span', { className: 'text-muted-foreground' }, 'Download: '),
                      formatMs(selected.timings?.download),
                    ),
                    h(
                      'div',
                      null,
                      h('span', { className: 'text-muted-foreground' }, 'Total: '),
                      formatMs(selected.timings?.total),
                    ),
                  ),
                  selected.matchedRules?.length
                    ? h(
                        'div',
                        { className: 'flex flex-wrap gap-1 border-t border-border pt-2' },
                        ...selected.matchedRules.map((mr, i) =>
                          h(
                            Badge,
                            {
                              key: `dmr-${i}-${mr.protocol}`,
                              variant: 'outline',
                              className: 'font-mono text-[length:var(--font-size-micro)]',
                            },
                            `${mr.protocol} · ${mr.matcher || mr.raw}`,
                          ),
                        ),
                      )
                    : null,
                ),

                h(
                  Tabs,
                  { value: detailTab, onValueChange: setDetailTab },
                  h(
                    TabsList,
                    null,
                    h(TabsTrigger, { value: 'inspect', className: 'text-xs' }, '请求 / 响应预览（脱敏）'),
                    h(TabsTrigger, { value: 'replay', className: 'text-xs' }, '编辑并重放（带 Diff）'),
                  ),
                  h(
                    TabsContent,
                    { value: 'inspect', className: 'flex flex-col gap-2.5 pt-2' },
                    h(
                      'div',
                      { className: cn(cardSurfaceClass, 'flex flex-col gap-1 p-2.5') },
                      h('span', { className: 'font-medium text-muted-foreground' }, 'Request Headers'),
                      h(
                        'pre',
                        { className: 'max-h-36 overflow-auto font-mono text-[11px]' },
                        formatJsonSafe(selected.requestHeaders),
                      ),
                    ),
                    selected.requestBody
                      ? h(
                          'div',
                          { className: cn(cardSurfaceClass, 'flex flex-col gap-1 p-2.5') },
                          h('span', { className: 'font-medium text-muted-foreground' }, 'Request Body'),
                          h(
                            'pre',
                            { className: 'max-h-40 overflow-auto font-mono text-[11px]' },
                            formatJsonSafe(selected.requestBody),
                          ),
                        )
                      : null,
                    h(
                      'div',
                      { className: cn(cardSurfaceClass, 'flex flex-col gap-1 p-2.5') },
                      h('span', { className: 'font-medium text-muted-foreground' }, 'Response Headers'),
                      h(
                        'pre',
                        { className: 'max-h-36 overflow-auto font-mono text-[11px]' },
                        formatJsonSafe(selected.responseHeaders),
                      ),
                    ),
                    h(
                      'div',
                      { className: cn(cardSurfaceClass, 'flex flex-col gap-1 p-2.5') },
                      h('span', { className: 'font-medium text-muted-foreground' }, 'Response Body'),
                      h(
                        'pre',
                        { className: 'max-h-56 overflow-auto font-mono text-[11px]' },
                        formatJsonSafe(selected.responseBody) || '(空)',
                      ),
                    ),
                  ),
                  h(
                    TabsContent,
                    { value: 'replay', className: 'flex flex-col gap-2.5 pt-2' },
                    h(
                      'div',
                      { className: 'flex items-center gap-2' },
                      h(Input, {
                        value: replayMethod,
                        onChange: (e) => setReplayMethod(e.target.value),
                        className: 'w-24 font-mono text-xs',
                      }),
                      h(Input, {
                        value: replayUrl,
                        onChange: (e) => setReplayUrl(e.target.value),
                        className: 'min-w-0 flex-1 font-mono text-xs',
                      }),
                      h(Input, {
                        value: replayTimes,
                        onChange: (e) => setReplayTimes(e.target.value),
                        placeholder: '次数',
                        className: 'w-16 font-mono text-xs',
                      }),
                    ),
                    h(
                      Field,
                      null,
                      h(FieldLabel, null, '覆写 Headers (JSON)'),
                      h(Textarea, {
                        value: replayHeaders,
                        onChange: (e) => setReplayHeaders(e.target.value),
                        className: 'min-h-24 font-mono text-xs',
                      }),
                    ),
                    h(
                      Field,
                      null,
                      h(FieldLabel, null, '覆写 Body（留空沿用原请求体）'),
                      h(Textarea, {
                        value: replayBody,
                        onChange: (e) => setReplayBody(e.target.value),
                        className: 'min-h-24 font-mono text-xs',
                      }),
                    ),
                    h(
                      Field,
                      null,
                      h(FieldLabel, null, '临时附加规则（可选）'),
                      h(Input, {
                        value: replayRules,
                        onChange: (e) => setReplayRules(e.target.value),
                        placeholder: '例如 api.example.com resDelay://500',
                        className: 'font-mono text-xs',
                      }),
                    ),
                    h(
                      'div',
                      { className: 'flex justify-end' },
                      h(
                        Button,
                        { size: 'sm', disabled: replaying, onClick: () => void doReplay() },
                        h(Icon, { name: 'RotateClockwise', className: 'size-3.5' }),
                        replaying ? '重放中…' : '执行重放并对比',
                      ),
                    ),
                    replayRes ? h(ReplayDiffView, { replayRes }) : null,
                  ),
                ),

                framesData
                  ? h(
                      'div',
                      { className: cn(cardSurfaceClass, 'flex flex-col gap-1 p-2.5') },
                      h('span', { className: 'font-medium text-muted-foreground' }, 'WebSocket / 流式帧'),
                      h(
                        'pre',
                        { className: 'max-h-40 overflow-auto font-mono text-[11px]' },
                        formatJsonSafe(framesData),
                      ),
                    )
                  : null,
              )
            : h(
                'div',
                { className: 'flex h-full items-center justify-center text-muted-foreground' },
                '从左侧选择一条抓包请求以查看详情、耗时、命中规则与改参重放。',
              ),
        ),
      ),

      // 导出 HAR 弹窗
      h(
        Dialog,
        { open: exportOpen, onOpenChange: setExportOpen },
        h(
          DialogContent,
          null,
          h(
            DialogHeader,
            null,
            h(DialogTitle, null, '导出 HAR 抓包文件'),
            h(DialogDescription, null, '将当前过滤后的抓包记录导出为标准 HAR 文件。'),
          ),
          h(
            Field,
            null,
            h(FieldLabel, null, '保存目录（绝对路径）'),
            h(Input, {
              value: exportDir,
              onChange: (e) => setExportDir(e.target.value),
              className: 'font-mono text-xs',
            }),
          ),
          h(
            DialogFooter,
            null,
            h(Button, { variant: 'ghost', onClick: () => setExportOpen(false) }, '取消'),
            h(Button, { disabled: busy || !exportDir.trim(), onClick: () => void doExportHar() }, '导出 HAR'),
          ),
        ),
      ),
    );
  }

  function DoctorTab({ instance, busy, run, signalTick }) {
    const [doctorRes, setDoctorRes] = useState(null);
    const [agentRes, setAgentRes] = useState(null);
    const [nonce, setNonce] = useState(0);
    const [removeValuesOnClear, setRemoveValuesOnClear] = useState(true);

    useEffect(() => {
      if (!instance?.storage) return;
      let cancelled = false;
      rpc
        .call('doctor', { storage: instance.storage })
        .then((res) => {
          if (!cancelled) setDoctorRes(res);
        })
        .catch(() => {
          if (!cancelled) setDoctorRes(null);
        });
      if (instance.alive) {
        rpc
          .call('agentStatus', { storage: instance.storage })
          .then((res) => {
            if (!cancelled) setAgentRes(res);
          })
          .catch(() => {
            if (!cancelled) setAgentRes(null);
          });
      }
      return () => {
        cancelled = true;
      };
    }, [instance?.storage, instance?.alive, nonce, signalTick]);

    const repairAction = async (method, args, label) => {
      await run(() => rpc.call('agent', { storage: instance.storage, method, args }), `${label}失败`, `${label}成功`);
      setNonce((n) => n + 1);
    };

    const liveAgentRes = instance?.alive ? agentRes : null;

    return h(
      'div',
      { className: 'h-full overflow-y-auto p-4 flex flex-col gap-4 text-xs', 'data-slot': 'whistle-doctor' },
      // 上半区：3 张快捷意图操作卡
      h(
        'div',
        { className: 'flex flex-col gap-2.5' },
        h(
          'div',
          { className: 'flex items-center justify-between gap-2' },
          h('span', { className: 'text-sm font-medium' }, '快捷调试意图（写入受控调试组，不伤主规则）'),
          h(
            'div',
            { className: 'flex items-center gap-2' },
            h(
              'label',
              { className: 'flex items-center gap-1.5 text-xs text-muted-foreground' },
              h(Checkbox, { checked: removeValuesOnClear, onCheckedChange: (v) => setRemoveValuesOnClear(Boolean(v)) }),
              h('span', null, '同步清理 Mock Value'),
            ),
            h(
              Button,
              {
                size: 'xs',
                variant: 'destructive',
                disabled: busy || !instance.alive,
                onClick: () =>
                  void run(
                    () => rpc.call('clearIntents', { storage: instance.storage, removeValues: removeValuesOnClear }),
                    '清空临时调试规则失败',
                    '已停用并清空临时调试组',
                  ),
              },
              '一键清空临时调试组',
            ),
          ),
        ),
        !instance.alive
          ? h('p', { className: 'text-muted-foreground' }, '实例停止时不可执行意图写入，请先启动实例。')
          : h(
              'div',
              { className: 'grid grid-cols-1 gap-3 lg:grid-cols-3' },
              h(
                Card,
                { className: 'flex flex-col gap-3 py-3' },
                h(
                  CardHeader,
                  { className: 'px-4 pb-0' },
                  h(CardTitle, { className: 'text-sm' }, '快速 Mock 接口'),
                  h(CardDescription, { className: 'text-xs' }, '写入 Value 并启用 warren-mock 组'),
                ),
                h(
                  CardContent,
                  { className: 'flex flex-1 flex-col px-4' },
                  h(QuickMockForm, { storage: instance.storage, defaultUrl: '' }),
                ),
              ),
              h(
                Card,
                { className: 'flex flex-col gap-3 py-3' },
                h(
                  CardHeader,
                  { className: 'px-4 pb-0' },
                  h(CardTitle, { className: 'text-sm' }, '故障与限速注入'),
                  h(CardDescription, { className: 'text-xs' }, '延迟 / 限速 / disable://encoding|cache → warren-fault'),
                ),
                h(
                  CardContent,
                  { className: 'flex flex-1 flex-col px-4' },
                  h(QuickFaultForm, { storage: instance.storage, defaultUrl: '' }),
                ),
              ),
              h(
                Card,
                { className: 'flex flex-col gap-3 py-3' },
                h(
                  CardHeader,
                  { className: 'px-4 pb-0' },
                  h(CardTitle, { className: 'text-sm' }, '本地端口 / 目录映射'),
                  h(CardDescription, { className: 'text-xs' }, '线上地址映射本地服务 → warren-local'),
                ),
                h(
                  CardContent,
                  { className: 'flex flex-1 flex-col px-4' },
                  h(MapLocalForm, { storage: instance.storage, defaultUrl: '' }),
                ),
              ),
            ),
      ),

      h(Separator),

      // 下半区：Doctor 健康体检
      h(
        'div',
        { className: 'flex flex-col gap-2.5' },
        h(
          'div',
          { className: 'flex flex-wrap items-center gap-2' },
          h('span', { className: 'text-sm font-medium' }, 'Doctor 健康体检与 Agent API 状态'),
          doctorRes
            ? h(
                Badge,
                { variant: doctorRes.ok ? 'secondary' : 'destructive' },
                doctorRes.ok ? '全部健康' : '存在异常项',
              )
            : null,
          h(
            'div',
            { className: 'ml-auto flex flex-wrap items-center gap-1.5' },
            instance.alive && doctorRes && !doctorRes.httpsCapture
              ? h(
                  Button,
                  {
                    size: 'xs',
                    variant: 'outline',
                    onClick: () => void repairAction('setEnableHTTPS', [true], '开启 HTTPS 解密'),
                  },
                  '修复：开启 HTTPS 解密',
                )
              : null,
            instance.alive && doctorRes && !doctorRes.allowMultipleChoice
              ? h(
                  Button,
                  {
                    size: 'xs',
                    variant: 'outline',
                    onClick: () => void repairAction('rules.setMultiSelect', [true], '开启多选规则'),
                  },
                  '修复：开启多选规则',
                )
              : null,
            instance.alive && liveAgentRes?.rules?.disabled
              ? h(
                  Button,
                  {
                    size: 'xs',
                    variant: 'outline',
                    onClick: () => void repairAction('rules.turnOn', [], '启用全局规则'),
                  },
                  '修复：启用全局规则',
                )
              : null,
            h(
              Button,
              { size: 'xs', variant: 'outline', onClick: () => setNonce((n) => n + 1) },
              h(Icon, { name: 'Refresh', className: 'size-3' }),
              '重新体检',
            ),
          ),
        ),
        doctorRes
          ? h(
              'div',
              { className: 'grid grid-cols-2 gap-2 lg:grid-cols-4' },
              ...(doctorRes.checks || []).map((chk) =>
                h(
                  'div',
                  { key: chk.name, className: cn(cardSurfaceClass, 'flex items-center justify-between gap-2 p-2.5') },
                  h(
                    'div',
                    { className: 'flex items-center gap-1.5' },
                    h(StatusDot, { tone: chk.ok ? 'success' : 'error' }),
                    h('span', { className: 'font-mono font-medium' }, chk.name),
                  ),
                  h(Badge, { variant: chk.ok ? 'secondary' : 'destructive' }, chk.ok ? '正常' : '异常'),
                ),
              ),
            )
          : h('p', { className: 'text-muted-foreground' }, '正在体检…'),
        liveAgentRes
          ? h(
              'div',
              { className: cn(cardSurfaceClass, 'flex flex-wrap items-center gap-3 p-3 text-xs') },
              h('span', { className: 'font-medium text-foreground' }, 'Agent API 状态：'),
              h(
                'span',
                { className: 'font-mono text-muted-foreground' },
                `version: ${liveAgentRes.status?.version || '—'}`,
              ),
              h(
                'span',
                { className: 'font-mono text-muted-foreground' },
                `HTTPS: ${liveAgentRes.https ? 'on' : 'off'}`,
              ),
              h(
                'span',
                { className: 'font-mono text-muted-foreground' },
                `Rules: ${liveAgentRes.rules?.disabled ? 'disabled' : 'enabled'}`,
              ),
              h(
                'span',
                { className: 'font-mono text-muted-foreground' },
                `MultiSelect: ${liveAgentRes.rules?.multiSelect ? 'on' : 'off'}`,
              ),
              h(
                'span',
                { className: 'font-mono text-muted-foreground' },
                `Plugins: ${liveAgentRes.plugins?.disabled ? 'disabled' : 'enabled'}`,
              ),
            )
          : null,
      ),
    );
  }

  // ── 5. 全屏主从分栏工作台 railPage ─────────────────────────────────────────
  function ProxyPage() {
    const signalTick = useSignalTick();
    const { instances, environments, w2, error, busy, reload, run } = useInstances(signalTick);
    const [selectedStorage, setSelectedStorage] = useState('');
    const [activeTab, setActiveTab] = useState('rules');
    const [bindEnvId, setBindEnvId] = useState('');
    const [deleteTarget, setDeleteTarget] = useState(null);

    const current = instances.find((item) => item.storage === selectedStorage) ?? instances[0] ?? null;
    const { httpsEnabled, rulesEnabled, toggling, toggleHttps, toggleAllRules } = useAgentControls(
      current?.storage,
      Boolean(current?.alive),
      signalTick,
    );

    const effectiveBindEnv = bindEnvId || current?.environmentId || '';
    const alreadyBoundCurrent = Boolean(effectiveBindEnv && current?.environmentId === effectiveBindEnv);

    return h(
      'div',
      {
        className: 'flex h-full min-h-0 overflow-hidden bg-background text-foreground',
        'data-slot': 'whistle-proxy-page',
      },
      // 左侧实例栏
      h(
        'aside',
        { className: 'flex w-[256px] shrink-0 flex-col border-r border-border bg-surface-drawer min-h-0' },
        h(
          'div',
          { className: 'flex items-center justify-between gap-1.5 border-b border-border px-3 py-2.5' },
          h(
            'div',
            { className: 'flex min-w-0 items-center gap-2' },
            h(
              'span',
              {
                'aria-hidden': true,
                style: { '--brand-hue': 192 },
                className:
                  'plugin-brand-chip flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
              },
              h(Icon, { name: 'Globe', className: 'size-3.5' }),
            ),
            h('span', { className: 'truncate text-sm font-medium' }, 'Whistle 代理'),
          ),
          h(
            'div',
            { className: 'flex shrink-0 items-center gap-1' },
            h(
              IconButton,
              { size: 'icon-sm', title: '刷新实例列表', onClick: reload },
              h(Icon, { name: 'Refresh', className: 'size-3.5' }),
            ),
            h(NewInstanceDialog, {
              environments,
              busy,
              run,
              compact: true,
              variant: 'outline',
              triggerLabel: '新建',
              onCreated: (created) => created?.storage && setSelectedStorage(created.storage),
            }),
          ),
        ),
        error ? h('p', { className: 'px-3 pt-2 text-xs text-destructive' }, error) : null,
        h(
          'div',
          { className: 'flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1' },
          instances.length === 0
            ? h('p', { className: 'p-2 text-xs text-muted-foreground' }, '还没有代理实例，点右上角「新建」。')
            : instances.map((inst) => {
                const isSelected = current?.storage === inst.storage;
                return h(
                  ListRow,
                  {
                    key: inst.storage,
                    selected: isSelected,
                    'data-slot': 'whistle-instance',
                    'data-storage': inst.storage,
                    'data-alive': String(inst.alive),
                  },
                  h(
                    ListRowMain,
                    {
                      onClick: () => {
                        setSelectedStorage(inst.storage);
                        setBindEnvId(inst.environmentId || '');
                      },
                    },
                    h(StatusDot, { tone: inst.alive ? 'success' : 'warning' }),
                    h(ListRowLabel, null, h(ListRowLabelText, { className: 'text-xs font-medium' }, inst.storage)),
                    h(ListRowMeta, null, `:${inst.port}${inst.environmentName ? ` · ${inst.environmentName}` : ''}`),
                  ),
                  h(
                    ListRowActions,
                    { alwaysVisible: isSelected },
                    !inst.alive
                      ? h(
                          ListRowActionButton,
                          {
                            tone: 'success',
                            title: '启动实例',
                            onClick: () =>
                              void run(
                                () => rpc.call('start', { storage: inst.storage }),
                                '启动实例失败',
                                `实例 ${inst.storage} 已启动`,
                              ),
                          },
                          h(Icon, { name: 'Play' }),
                        )
                      : h(
                          ListRowActionButton,
                          {
                            title: '停止实例',
                            onClick: () =>
                              void run(
                                () => rpc.call('stop', { storage: inst.storage }),
                                '停止实例失败',
                                `实例 ${inst.storage} 已停止`,
                              ),
                          },
                          h(Icon, { name: 'Stop' }),
                        ),
                    h(
                      ListRowActionButton,
                      {
                        tone: 'destructive',
                        title: '删除实例',
                        onClick: () => setDeleteTarget(inst.storage),
                      },
                      h(Icon, { name: 'Trash' }),
                    ),
                  ),
                );
              }),
        ),

        // 底部快捷绑定管理
        current
          ? h(
              'div',
              { className: 'flex flex-col gap-2 border-t border-border p-3 text-xs' },
              h(
                'div',
                { className: 'flex items-center justify-between' },
                h('span', { className: 'font-medium text-muted-foreground' }, `绑定管理 · ${current.storage}`),
                current.environmentName
                  ? h(
                      Badge,
                      { variant: 'secondary', className: 'text-[length:var(--font-size-micro)]' },
                      current.environmentName,
                    )
                  : null,
              ),
              h(
                Select,
                { value: effectiveBindEnv, onValueChange: setBindEnvId },
                h(
                  SelectTrigger,
                  null,
                  h(SelectValue, { placeholder: '选择绑定环境' }, (v) =>
                    v ? (environments.find((e) => e.id === v)?.name ?? String(v)) : '选择绑定环境',
                  ),
                ),
                h(
                  SelectContent,
                  null,
                  h(SelectItem, { value: '' }, '不绑定环境'),
                  ...environments.map((env) => h(SelectItem, { key: env.id, value: env.id }, env.name)),
                ),
              ),
              h(
                'div',
                { className: 'flex items-center gap-1.5' },
                h(
                  Button,
                  {
                    size: 'xs',
                    variant: alreadyBoundCurrent ? 'secondary' : 'default',
                    className: 'flex-1',
                    disabled: busy || !effectiveBindEnv || !current.alive || alreadyBoundCurrent,
                    onClick: () =>
                      void run(
                        () => rpc.call('bind', { storage: current.storage, environmentId: effectiveBindEnv }),
                        '绑定环境失败',
                        `已绑定到环境`,
                      ),
                  },
                  alreadyBoundCurrent ? '已绑定当前环境' : '绑定环境',
                ),
                current.environmentId
                  ? h(
                      Button,
                      {
                        size: 'xs',
                        variant: 'outline',
                        disabled: busy,
                        onClick: () =>
                          void run(
                            () => rpc.call('unbind', { environmentId: current.environmentId }),
                            '解绑失败',
                            '已解除环境代理绑定',
                          ).then((r) => r && setBindEnvId('')),
                      },
                      '解绑',
                    )
                  : null,
              ),
              h(
                'span',
                { className: 'truncate text-[length:var(--font-size-micro)] text-muted-foreground', title: w2 },
                w2,
              ),
            )
          : null,
      ),

      // 右侧多 Tab 详情区
      h(
        'main',
        { className: 'flex min-w-0 flex-1 flex-col min-h-0 overflow-hidden' },
        !current
          ? h(
              'div',
              { className: 'flex flex-1 items-center justify-center p-6' },
              h(
                Empty,
                null,
                h(
                  EmptyHeader,
                  null,
                  h(EmptyMedia, { variant: 'icon' }, h(Icon, { name: 'Globe' })),
                  h(EmptyTitle, null, '还没有 Whistle 代理实例'),
                  h(
                    EmptyDescription,
                    null,
                    '点击左侧「新建」创建一个独立的 Whistle 2.10.15 实例，即可配置规则、Values、预设与抓包。',
                  ),
                ),
              ),
            )
          : h(
              React.Fragment,
              null,
              // 实例头部概览栏
              h(
                'div',
                {
                  className: 'flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border px-4 py-2.5 text-xs',
                },
                h(StatusDot, { tone: current.alive ? 'success' : 'warning' }),
                h('span', { className: 'text-sm font-medium' }, current.storage),
                h('span', { className: 'font-mono text-muted-foreground' }, `:${current.port}`),
                h(Badge, { variant: current.alive ? 'secondary' : 'outline' }, current.alive ? '运行中' : '已停止'),
                current.version
                  ? h(Badge, { variant: 'outline', className: 'font-mono' }, `v${current.version}`)
                  : null,
                current.environmentName
                  ? h(Badge, { variant: 'secondary' }, `已绑定：${current.environmentName}`)
                  : h(Badge, { variant: 'outline' }, '未绑定环境'),
                h(
                  'div',
                  { className: 'ml-auto flex flex-wrap items-center gap-2' },
                  current.alive
                    ? h(
                        React.Fragment,
                        null,
                        h(
                          'label',
                          { className: 'flex items-center gap-1.5 text-xs' },
                          h(Switch, {
                            checked: httpsEnabled,
                            disabled: toggling,
                            onCheckedChange: (v) => void toggleHttps(v),
                          }),
                          h('span', null, 'HTTPS 解密'),
                        ),
                        h(
                          'label',
                          { className: 'flex items-center gap-1.5 text-xs' },
                          h(Switch, {
                            checked: rulesEnabled,
                            disabled: toggling,
                            onCheckedChange: (v) => void toggleAllRules(v),
                          }),
                          h('span', null, '全局规则'),
                        ),
                        h(
                          Button,
                          {
                            size: 'xs',
                            variant: 'outline',
                            disabled: busy,
                            onClick: () =>
                              void run(
                                () => rpc.call('clearDnsCache', { storage: current.storage }),
                                '清理 DNS 缓存失败',
                                'DNS 与本地地址缓存已清理',
                              ),
                          },
                          h(Icon, { name: 'Refresh', className: 'size-3' }),
                          '清 DNS 缓存',
                        ),
                        activeIntentGroups(current.rules).length > 0
                          ? h(
                              Button,
                              {
                                size: 'xs',
                                variant: 'destructive',
                                disabled: busy,
                                onClick: () =>
                                  void run(
                                    () => rpc.call('clearIntents', { storage: current.storage, removeValues: true }),
                                    '清空临时调试规则失败',
                                    '已清空临时调试规则',
                                  ),
                              },
                              '清空临时调试',
                            )
                          : null,
                        current.environmentId
                          ? h(
                              Button,
                              {
                                size: 'xs',
                                variant: 'outline',
                                disabled: busy,
                                onClick: () =>
                                  void run(
                                    () => rpc.call('open', { environmentId: current.environmentId }),
                                    '打开 Web UI 失败',
                                  ),
                              },
                              h(Icon, { name: 'ExternalLink', className: 'size-3' }),
                              '打开 Web UI',
                            )
                          : null,
                        h(
                          Button,
                          {
                            size: 'xs',
                            variant: 'outline',
                            disabled: busy,
                            onClick: () =>
                              void run(
                                () => rpc.call('stop', { storage: current.storage }),
                                '停止实例失败',
                                `实例 ${current.storage} 已停止`,
                              ),
                          },
                          '停止',
                        ),
                      )
                    : h(
                        Button,
                        {
                          size: 'xs',
                          disabled: busy,
                          onClick: () =>
                            void run(
                              () => rpc.call('start', { storage: current.storage }),
                              '启动实例失败',
                              `实例 ${current.storage} 已启动`,
                            ),
                        },
                        h(Icon, { name: 'Play', className: 'size-3' }),
                        '启动实例',
                      ),
                ),
              ),

              // 5 个专业子 Tab
              h(
                Tabs,
                {
                  value: activeTab,
                  onValueChange: setActiveTab,
                  className: 'flex min-h-0 flex-1 flex-col overflow-hidden gap-0',
                },
                h(
                  'div',
                  { className: 'shrink-0 border-b border-border px-4 py-1.5' },
                  h(
                    TabsList,
                    null,
                    h(TabsTrigger, { value: 'rules', className: 'text-xs' }, '规则'),
                    h(TabsTrigger, { value: 'values', className: 'text-xs' }, 'Values'),
                    h(TabsTrigger, { value: 'presets', className: 'text-xs' }, '预设与场景'),
                    h(TabsTrigger, { value: 'traffic', className: 'text-xs' }, '抓包与重放'),
                    h(TabsTrigger, { value: 'doctor', className: 'text-xs' }, '诊断与意图'),
                  ),
                ),
                h(
                  TabsContent,
                  { value: 'rules', className: 'min-h-0 flex-1 overflow-hidden' },
                  h(RulesTab, { instance: current, busy, run, signalTick }),
                ),
                h(
                  TabsContent,
                  { value: 'values', className: 'min-h-0 flex-1 overflow-hidden' },
                  h(ValuesTab, { instance: current, busy, run, signalTick }),
                ),
                h(
                  TabsContent,
                  { value: 'presets', className: 'min-h-0 flex-1 overflow-hidden' },
                  h(PresetsTab, { instance: current, busy, run, signalTick }),
                ),
                h(
                  TabsContent,
                  { value: 'traffic', className: 'min-h-0 flex-1 overflow-hidden' },
                  h(TrafficTab, { instance: current, busy, run, signalTick }),
                ),
                h(
                  TabsContent,
                  { value: 'doctor', className: 'min-h-0 flex-1 overflow-hidden' },
                  h(DoctorTab, { instance: current, busy, run, signalTick }),
                ),
              ),
            ),
      ),

      h(ConfirmDialog, {
        open: Boolean(deleteTarget),
        onOpenChange: (o) => !o && setDeleteTarget(null),
        title: `移除代理实例「${deleteTarget || ''}」`,
        description: '将停止该实例并从 Warren 登记表中移除（磁盘上的 Whistle 规则文件保留）。',
        confirmLabel: '移除',
        busy,
        onConfirm: async () => {
          if (!deleteTarget) return;
          await run(() => rpc.call('remove', { storage: deleteTarget }), '删除实例失败', `已移除实例 ${deleteTarget}`);
          setDeleteTarget(null);
        },
      }),
    );
  }

  // ── 6. 设置分节 settingsSection ───────────────────────────────────────────
  function AboutSection() {
    return h(
      'div',
      { className: 'flex flex-col gap-3 text-xs leading-relaxed text-muted-foreground' },
      h(
        'div',
        { className: cn(cardSurfaceClass, 'flex flex-col gap-1.5 p-3') },
        h('span', { className: 'font-medium text-foreground' }, '核心架构：whistle@2.10.15 多实例隔离托管'),
        h(
          'p',
          null,
          '每个实例是一个独立的 Whistle 进程，拥有自己的端口、规则组、Values 数据区与抓包缓存；同一套根证书由所有环境按需独立信任，绝不修改系统钥匙串。',
        ),
      ),
      h(
        'div',
        { className: cn(cardSurfaceClass, 'flex flex-col gap-1.5 p-3') },
        h('span', { className: 'font-medium text-foreground' }, '多面协同工作流'),
        h(
          'p',
          null,
          '• 地址栏微标 & 快捷浮窗：一眼看清绑定端口与运行态，秒切 HTTPS 解密、全局规则、场景预设（online / test / local / preview）与临时 Mock。',
        ),
        h(
          'p',
          null,
          '• 右侧工作台随页侧栏：按关键字与类型过滤实时抓包、改参重放对比 Diff、复制脱敏 cURL、测试 URL 规则命中与生成排障直达链接。',
        ),
        h(
          'p',
          null,
          '• 全屏主从分栏工作台：完整管理实例启停与绑定、规则语法校验/Diff/命中诊断、Values 数据区编辑、预设导入导出与 Doctor 健康体检。',
        ),
      ),
      h(
        'div',
        { className: cn(cardSurfaceClass, 'flex flex-col gap-1.5 p-3') },
        h('span', { className: 'font-medium text-foreground' }, 'AI 调试意图原语与 Skill 自动注入'),
        h(
          'p',
          null,
          'quickMock / injectFault / mapLocal 写入受控调试组（warren-mock / warren-fault / warren-local），绝不覆盖用户主规则，可一键清空；启用本插件时，plugins/whistle/SKILL.md 会自动注入到 Warren Agent Skill 索引。',
        ),
      ),
    );
  }

  app.surfaces.railPage({ id: 'proxy', title: '代理', icon: 'Globe', path: 'proxy', component: ProxyPage });
  app.surfaces.inspectorTab({ id: 'env-proxy', title: '代理', component: WhistleInspectorTab });
  app.surfaces.settingsSection({ id: 'about', title: 'Whistle 使用说明', component: AboutSection });
  app.surfaces.popover({
    id: 'quick-proxy',
    title: 'Whistle 代理快捷控制',
    icon: 'Globe',
    width: 380,
    height: 492,
    component: QuickProxyPopover,
  });
  app.surfaces.statusBadge({
    id: 'proxy-badge',
    title: '代理运行状态',
    icon: 'Globe',
    component: ProxyStatusBadge,
  });
}
