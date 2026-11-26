/**
 * 全屏工作台子标签：Traffic 实时抓包重放与 Doctor 环境诊断。
 */
export function createTrafficDoctorTabs(ctx) {
  const {
    h,
    React,
    rpc,
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Checkbox,
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
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Separator,
    StatusDot,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    Textarea,
    cardSurfaceClass,
    cn,
    TRAFFIC_TYPES,
    TRAFFIC_METHODS,
    notifySuccess,
    notifyError,
    copyText,
    statusToneClass,
    formatMs,
    formatJsonSafe,
    shortUrlPath,
    ReplayDiffView,
    QuickMockForm,
    QuickFaultForm,
    MapLocalForm,
  } = ctx;
  const { useEffect, useRef, useState } = React;
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
    const replayOrigRef = useRef({ entryId: '', headers: {}, body: '' });

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
      const formattedBody = formatJsonSafe(entry.requestBody);
      replayOrigRef.current = {
        entryId: entry.entryId || '',
        headers: entry.requestHeaders && typeof entry.requestHeaders === 'object' ? { ...entry.requestHeaders } : {},
        body: formattedBody,
      };
      setSelectedId(entry.entryId);
      setReplayUrl(entry.url || '');
      setReplayMethod(entry.method || 'GET');
      setReplayHeaders(JSON.stringify(entry.requestHeaders || {}, null, 2));
      setReplayBody(formattedBody);
      setReplayRules('');
      setReplayTimes('1');
      setReplayRes(null);
      setFramesData(null);
    };

    const doReplay = async () => {
      if (!selected || replaying) return;
      setReplaying(true);
      try {
        const baseline =
          replayOrigRef.current && replayOrigRef.current.entryId === selected.entryId ? replayOrigRef.current : null;
        let headersDelta;
        if (replayHeaders.trim()) {
          const parsedHeaders = JSON.parse(replayHeaders);
          if (parsedHeaders && typeof parsedHeaders === 'object' && !Array.isArray(parsedHeaders)) {
            if (baseline) {
              const delta = {};
              for (const [k, v] of Object.entries(parsedHeaders)) {
                if (baseline.headers[k] !== v && !(v === '[REDACTED]' && Object.hasOwn(baseline.headers, k))) {
                  delta[k] = v;
                }
              }
              for (const k of Object.keys(baseline.headers)) {
                if (!Object.hasOwn(parsedHeaders, k)) delta[k] = null;
              }
              if (Object.keys(delta).length > 0) headersDelta = delta;
            } else {
              headersDelta = parsedHeaders;
            }
          }
        }
        const bodyChanged = baseline ? replayBody !== baseline.body : replayBody !== '';
        const res = await rpc.call('replay', {
          storage: instance.storage,
          reqId: selected.entryId,
          url: replayUrl.trim() || selected.url,
          method: replayMethod.trim() || selected.method,
          ...(headersDelta ? { headers: headersDelta } : {}),
          ...(bodyChanged ? { body: replayBody } : {}),
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

  return { TrafficTab, DoctorTab };
}
