/**
 * 全屏主从分栏工作台（railPage）与 Whistle 使用说明设置分节（settingsSection）。
 */
export function createProxyPageViews(ctx, tabs) {
  const {
    h,
    React,
    rpc,
    Badge,
    Button,
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
    Icon,
    IconButton,
    PluginBrandGlyph,
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
    StatusDot,
    Switch,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    cardSurfaceClass,
    cn,
    activeIntentGroups,
    useSignalTick,
    useInstances,
    useAgentControls,
    ConfirmDialog,
    NewInstanceFormButton,
  } = ctx;
  const { useState } = React;
  const { RulesTab, ValuesTab, PresetsTab, TrafficTab, DoctorTab } = tabs;
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
            { className: 'flex min-w-0 items-center gap-2', 'data-kubai-trigger': '' },
            PluginBrandGlyph
              ? h(PluginBrandGlyph, { pluginId: 'com.warren.whistle', icon: 'Globe', variant: 'chip', size: 24 })
              : h(
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
            h(NewInstanceFormButton, {
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

  return { ProxyPage, AboutSection };
}
