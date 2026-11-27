/**
 * 地址栏代理运行微标（statusBadge）与快捷控制浮窗（popover）。
 */
export function createPopoverViews(ctx) {
  const {
    h,
    React,
    rpc,
    Alert,
    AlertDescription,
    AlertTitle,
    Badge,
    Button,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    Icon,
    PluginBrandGlyph,
    StatusDot,
    Switch,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    cardSurfaceClass,
    cn,
    SCENARIO_LIST,
    controlledTag,
    activeIntentGroups,
    useSignalTick,
    useInstances,
    useAgentControls,
    NewInstanceDialog,
    QuickMockForm,
    QuickFaultForm,
  } = ctx;
  const { useEffect, useState } = React;
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
      PluginBrandGlyph
        ? h(PluginBrandGlyph, {
            pluginId: 'com.warren.whistle',
            icon: 'Globe',
            size: 16,
            className: cn(!bound && 'opacity-75'),
          })
        : h(Icon, {
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

  return { ProxyStatusBadge, QuickProxyPopover };
}
