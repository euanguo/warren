/**
 * Whistle UI 共享常量、工具函数、状态 Hooks 与通用弹窗/Intent 表单组件。
 */
export function createWhistleUiContext(app) {
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
    PluginBrandGlyph,
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

  /** 「先不绑定」的哨兵值：表单 select 的选项值不允许空串。 */
  const BIND_NONE = 'none';

  function newInstanceFormRequest({ environments, defaultBindEnvId }) {
    const initialBind =
      defaultBindEnvId && environments.some((env) => env.id === defaultBindEnvId) ? defaultBindEnvId : BIND_NONE;
    return {
      title: '新建 Whistle 代理实例',
      description: '一个实例 = 一个独立 whistle@2.10.15 进程：独立端口、规则、Values 与抓包。',
      submitLabel: '创建实例',
      source: 'Whistle 代理',
      fields: [
        {
          type: 'text',
          key: 'storage',
          label: '实例名（storage）',
          placeholder: '例如 feat-a（留空自动起名）',
          maxLength: 40,
        },
        {
          type: 'text',
          key: 'hostPattern',
          label: '初始映射域名/路径（可选）',
          placeholder: '例如 app.example.com/static/',
          maxLength: 200,
        },
        {
          type: 'number',
          key: 'targetPort',
          label: '本地服务端口（可选）',
          placeholder: '例如 5173',
          min: 0,
          max: 65535,
        },
        {
          type: 'select',
          key: 'bindTo',
          label: '创建后绑定到环境',
          initial: initialBind,
          options: [
            { value: BIND_NONE, label: '先不绑定' },
            ...environments.map((env) => ({ value: env.id, label: env.name })),
          ],
        },
      ],
    };
  }

  /** 主窗面用宿主原生表单（覆盖原生网页视图之上）；独立浮窗仍用 NewInstanceDialog。 */
  function NewInstanceFormButton({
    environments,
    busy,
    run,
    defaultBindEnvId = '',
    compact = false,
    variant = 'default',
    triggerLabel = '新建实例',
    onCreated,
  }) {
    const [opening, setOpening] = useState(false);

    const openForm = async () => {
      if (opening || busy) return;
      setOpening(true);
      try {
        const values = await shell.openForm(newInstanceFormRequest({ environments, defaultBindEnvId }));
        if (!values) return;
        const bindTo = values.bindTo === BIND_NONE ? '' : String(values.bindTo || '');
        const result = await run(
          () =>
            rpc.call('fork', {
              storage: String(values.storage || '').trim(),
              hostPattern: String(values.hostPattern || '').trim(),
              targetPort: Number(values.targetPort) || 0,
            }),
          '新建实例失败',
        );
        if (!result) return;
        const created = result.created;
        if (bindTo) {
          await run(() => rpc.call('bind', { storage: created.storage, environmentId: bindTo }), '绑定环境失败');
        }
        notifySuccess(`实例 ${created.storage} 已创建`, `端口 :${created.port}`);
        onCreated?.(created);
      } catch (err) {
        notifyError('新建实例失败', err);
      } finally {
        setOpening(false);
      }
    };

    return h(
      Button,
      { size: compact ? 'xs' : 'sm', variant, disabled: busy || opening, onClick: () => void openForm() },
      h(Icon, { name: 'Plus', className: 'size-3.5' }),
      triggerLabel,
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
  return {
    app,
    h,
    React,
    ui,
    rpc,
    shell,
    useSignal,
    Button,
    IconButton,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
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
    PluginBrandGlyph,
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
    CONTROLLED_GROUPS,
    SCENARIO_LIST,
    TRAFFIC_TYPES,
    TRAFFIC_METHODS,
    errorMessage,
    notifySuccess,
    notifyError,
    notifyInfo,
    copyText,
    suggestPatternFromUrl,
    suggestHostFromUrl,
    statusToneClass,
    formatMs,
    formatBytes,
    formatJsonSafe,
    shortUrlPath,
    controlledTag,
    activeIntentGroups,
    useSignalTick,
    useInstances,
    useAgentControls,
    ConfirmDialog,
    NewInstanceDialog,
    NewInstanceFormButton,
    RuleMatchResultView,
    ReplayDiffView,
    QuickMockForm,
    QuickFaultForm,
    MapLocalForm,
  };
}
