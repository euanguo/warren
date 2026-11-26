/**
 * 全屏工作台子标签：Rules 规则组、Values 数据区、Presets 预设编排。
 */
export function createRulesValuesPresetsTabs(ctx) {
  const {
    h,
    React,
    rpc,
    Badge,
    Button,
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
    Switch,
    Textarea,
    cardSurfaceClass,
    cn,
    SCENARIO_LIST,
    notifySuccess,
    notifyError,
    notifyInfo,
    copyText,
    formatBytes,
    controlledTag,
    ConfirmDialog,
    RuleMatchResultView,
  } = ctx;
  const { useEffect, useState } = React;
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

  return { RulesTab, ValuesTab, PresetsTab };
}
