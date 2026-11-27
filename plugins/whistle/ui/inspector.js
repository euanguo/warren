/**
 * 右侧工作台随页代理与实时抓包重放侧边栏（inspectorTab）。
 */
export function createInspectorViews(ctx) {
  const {
    h,
    React,
    rpc,
    Badge,
    Button,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    Icon,
    IconButton,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    StatusDot,
    Switch,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    cardSurfaceClass,
    cn,
    TRAFFIC_TYPES,
    notifySuccess,
    notifyError,
    notifyInfo,
    copyText,
    statusToneClass,
    formatMs,
    shortUrlPath,
    activeIntentGroups,
    useSignalTick,
    useInstances,
    useAgentControls,
    NewInstanceFormButton,
    RuleMatchResultView,
    ReplayDiffView,
    QuickMockForm,
    QuickFaultForm,
  } = ctx;
  const { useEffect, useState } = React;
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
            h(NewInstanceFormButton, {
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
                  className: 'border-border/80 bg-surface-fog px-3 font-medium',
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

  return { WhistleInspectorTab };
}
