/**
 * 导入/导出弹窗与全屏三区主从分栏工作台（railPage）。
 */
export function createWorkbenchViews(ctx, views) {
  const {
    h,
    React,
    rpc,
    host,
    shell,
    useSignal,
    Alert,
    AlertDescription,
    AlertTitle,
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    Badge,
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Empty,
    EmptyContent,
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
    ListRowLabel,
    ListRowLabelText,
    ListRowMain,
    ListRowMeta,
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
    ScrollArea,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    cardSurfaceClass,
    cn,
    SORT_OPTIONS,
    IMPORT_FORMAT_OPTIONS,
    IMPORT_STRATEGY_OPTIONS,
    hostOf,
    tagsOf,
    copyText,
    sortLabelOf,
    PlaintextWarning,
  } = ctx;
  const { useCallback, useEffect, useMemo, useRef, useState } = React;
  const { AccountDetailView, AccountEditorView } = views;
  function ImportDialog({ open, onOpenChange, onImported }) {
    const [format, setFormat] = useState('auto');
    const [strategy, setStrategy] = useState('skip');
    const [content, setContent] = useState('');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const fileInputRef = useRef(null);

    useEffect(() => {
      if (!open) return;
      setResult(null);
    }, [open]);

    const onFileChange = (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        setContent(String(reader.result || ''));
        if (file.name.toLowerCase().endsWith('.json')) setFormat('json');
        else if (file.name.toLowerCase().endsWith('.csv')) setFormat('csv');
      };
      reader.readAsText(file);
    };

    const runImport = async () => {
      if (!content.trim()) {
        shell.notify('error', '请先粘贴导入文本或选择本地文件');
        return;
      }
      setBusy(true);
      try {
        const res = await rpc.call('importAccounts', { format, strategy, content });
        setResult(res);
        shell.notify(
          'success',
          '批量导入完成',
          `新增 ${res.imported} · 更新 ${res.updated} · 跳过 ${res.skipped} · 失败 ${res.failed}`,
        );
        onImported();
      } catch (err) {
        shell.notify('error', '导入失败', String((err && err.message) || err));
      } finally {
        setBusy(false);
      }
    };

    return h(
      Dialog,
      { open, onOpenChange },
      h(
        DialogContent,
        { className: 'sm:max-w-[540px]' },
        h(
          'div',
          { className: 'flex flex-col gap-3' },
          h(
            DialogHeader,
            null,
            h(DialogTitle, null, '批量导入账号'),
            h(DialogDescription, null, '支持 Warren 导出 JSON、通用 CSV 与 Chrome 密码导出 CSV。'),
          ),
          h(
            'div',
            { className: 'grid gap-3 sm:grid-cols-2' },
            h(
              Field,
              null,
              h(FieldLabel, null, '数据格式'),
              h(
                Select,
                { value: format, onValueChange: (v) => setFormat(String(v || 'auto')) },
                h(
                  SelectTrigger,
                  null,
                  h(SelectValue, null, IMPORT_FORMAT_OPTIONS.find((o) => o.value === format)?.label || format),
                ),
                h(
                  SelectContent,
                  null,
                  ...IMPORT_FORMAT_OPTIONS.map((opt) => h(SelectItem, { key: opt.value, value: opt.value }, opt.label)),
                ),
              ),
            ),
            h(
              Field,
              null,
              h(FieldLabel, null, '去重策略'),
              h(
                Select,
                { value: strategy, onValueChange: (v) => setStrategy(String(v || 'skip')) },
                h(
                  SelectTrigger,
                  null,
                  h(SelectValue, null, IMPORT_STRATEGY_OPTIONS.find((o) => o.value === strategy)?.label || strategy),
                ),
                h(
                  SelectContent,
                  null,
                  ...IMPORT_STRATEGY_OPTIONS.map((opt) =>
                    h(SelectItem, { key: opt.value, value: opt.value }, opt.label),
                  ),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'flex items-center justify-between gap-2' },
            h('span', { className: 'text-xs text-muted-foreground' }, '选择文件或直接粘贴内容'),
            h(
              React.Fragment,
              null,
              h('input', {
                ref: fileInputRef,
                type: 'file',
                accept: '.json,.csv,.txt',
                className: 'hidden',
                onChange: onFileChange,
              }),
              h(
                Button,
                { size: 'xs', variant: 'secondary', onClick: () => fileInputRef.current?.click() },
                h(Icon, { name: 'FolderOpen', className: 'size-3.5' }),
                '选择本地文件',
              ),
            ),
          ),
          h(Textarea, {
            value: content,
            className: 'min-h-36 font-mono text-xs',
            placeholder: '粘贴 JSON（{"accounts":[...]} 或 [...]）或 CSV（name,url,username,password,...）',
            onChange: (event) => setContent(event.target.value),
          }),
          result
            ? h(
                'div',
                { className: cn(cardSurfaceClass, 'flex flex-col gap-1.5 bg-surface-fog text-xs') },
                h(
                  'div',
                  { className: 'flex flex-wrap gap-3 font-medium text-foreground' },
                  h('span', { className: 'text-[var(--success)]' }, `新增 ${result.imported}`),
                  h('span', { className: 'text-[var(--info)]' }, `更新 ${result.updated}`),
                  h('span', { className: 'text-muted-foreground' }, `跳过 ${result.skipped}`),
                  result.failed > 0 ? h('span', { className: 'text-destructive' }, `失败 ${result.failed}`) : null,
                ),
                Array.isArray(result.errors) && result.errors.length > 0
                  ? h(
                      'div',
                      { className: 'max-h-24 overflow-y-auto text-[11px] text-destructive' },
                      ...result.errors.map((e, i) =>
                        h('div', { key: i }, `#${e.index + 1} ${e.name || ''}: ${e.message}`),
                      ),
                    )
                  : null,
              )
            : null,
          h(
            DialogFooter,
            null,
            h(Button, { variant: 'ghost', onClick: () => onOpenChange(false) }, '关闭'),
            h(
              Button,
              { disabled: busy || !content.trim(), onClick: () => void runImport() },
              busy ? '导入中…' : '开始导入',
            ),
          ),
        ),
      ),
    );
  }

  function ExportDialog({ open, onOpenChange }) {
    const [includeDeleted, setIncludeDeleted] = useState(false);
    const [busy, setBusy] = useState(false);
    const [exportedJson, setExportedJson] = useState('');

    useEffect(() => {
      if (!open) return;
      setExportedJson('');
    }, [open]);

    const runExport = async () => {
      setBusy(true);
      try {
        const res = await rpc.call('export', { confirm: 'plaintext', includeDeleted });
        setExportedJson(JSON.stringify(res, null, 2));
        shell.notify('info', '已生成明文备份 JSON', '请妥善保管导出文件，勿提交到版本库');
      } catch (err) {
        shell.notify('error', '导出失败', String((err && err.message) || err));
      } finally {
        setBusy(false);
      }
    };

    const downloadJson = () => {
      if (!exportedJson) return;
      const blob = new Blob([exportedJson], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `warren-accounts-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    return h(
      Dialog,
      { open, onOpenChange },
      h(
        DialogContent,
        { className: 'sm:max-w-[540px]' },
        h(
          'div',
          { className: 'flex flex-col gap-3' },
          h(
            DialogHeader,
            null,
            h(DialogTitle, null, '导出全部账号（明文 JSON）'),
            h(DialogDescription, null, '导出内容包含全部密码、TOTP 密钥与扩展字段的明文，仅供人工离线备份。'),
          ),
          h(
            Alert,
            { className: 'border-[var(--warning)]/35 bg-[var(--warning)]/10 text-[var(--warning)]' },
            h(Icon, { name: 'AlertTriangle', className: 'size-4' }),
            h(AlertTitle, null, '安全提醒'),
            h(AlertDescription, null, '导出文件不加密。完成后请存放在安全位置，切勿分享或放入公共仓库。'),
          ),
          h(
            'label',
            { className: 'flex cursor-pointer items-center gap-2 text-xs text-foreground select-none' },
            h(Checkbox, { checked: includeDeleted, onCheckedChange: (next) => setIncludeDeleted(Boolean(next)) }),
            h('span', null, '同时包含回收站中的已删除账号'),
          ),
          exportedJson
            ? h(Textarea, {
                readOnly: true,
                value: exportedJson,
                className: 'min-h-40 font-mono text-[11px]',
              })
            : null,
          h(
            DialogFooter,
            null,
            h(Button, { variant: 'ghost', onClick: () => onOpenChange(false) }, '关闭'),
            exportedJson
              ? h(
                  React.Fragment,
                  null,
                  h(
                    Button,
                    { variant: 'secondary', onClick: () => void copyText(exportedJson, '明文备份 JSON') },
                    h(Icon, { name: 'Copy', className: 'size-3.5' }),
                    '复制 JSON',
                  ),
                  h(
                    Button,
                    { onClick: downloadJson },
                    h(Icon, { name: 'Download', className: 'size-3.5' }),
                    '下载 .json 文件',
                  ),
                )
              : h(
                  Button,
                  { variant: 'destructive', disabled: busy, onClick: () => void runExport() },
                  busy ? '导出中…' : '确认导出明文',
                ),
          ),
        ),
      ),
    );
  }

  function AccountsPage({ environmentId, space = 'person' }) {
    const [allAccounts, setAllAccounts] = useState([]);
    const [filterMode, setFilterMode] = useState('all'); // all | pinned | totp | trash
    const [selectedTag, setSelectedTag] = useState('');
    const [query, setQuery] = useState('');
    const [sortBy, setSortBy] = useState('updated');
    const [selectedId, setSelectedId] = useState(null);
    const [mode, setMode] = useState('view'); // view | edit | create
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [importOpen, setImportOpen] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const [purgingTarget, setPurgingTarget] = useState(null); // { all: true } | account
    const [tick, setTick] = useState(0);

    useSignal(
      'changed',
      useCallback(() => setTick((n) => n + 1), []),
    );

    const loadAll = useCallback(async () => {
      try {
        const res = await rpc.call('list', {
          includeDeleted: true,
          pinnedFirst: true,
          sortBy,
        });
        const list = Array.isArray(res?.accounts) ? res.accounts : [];
        setAllAccounts(list);
        setError('');
      } catch (err) {
        setError(String((err && err.message) || err));
      }
    }, [sortBy]);

    useEffect(() => {
      void loadAll();
    }, [loadAll, tick]);

    const activeAccounts = useMemo(() => allAccounts.filter((a) => !a.deletedAt), [allAccounts]);
    const trashedAccounts = useMemo(() => allAccounts.filter((a) => Boolean(a.deletedAt)), [allAccounts]);
    const pinnedCount = useMemo(() => activeAccounts.filter((a) => a.pinned).length, [activeAccounts]);
    const totpCount = useMemo(() => activeAccounts.filter((a) => a.hasTotp).length, [activeAccounts]);

    const tagStats = useMemo(() => {
      const map = new Map();
      for (const acc of activeAccounts) {
        for (const t of tagsOf(acc.tags)) {
          map.set(t, (map.get(t) || 0) + 1);
        }
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    }, [activeAccounts]);

    const visibleAccounts = useMemo(() => {
      const base =
        filterMode === 'trash'
          ? trashedAccounts
          : filterMode === 'pinned'
            ? activeAccounts.filter((a) => a.pinned)
            : filterMode === 'totp'
              ? activeAccounts.filter((a) => a.hasTotp)
              : activeAccounts;

      const byTag =
        filterMode !== 'trash' && selectedTag ? base.filter((a) => tagsOf(a.tags).includes(selectedTag)) : base;

      const q = query.trim().toLowerCase();
      if (!q) return byTag;
      return byTag.filter((a) => {
        const hay = [a.name, a.url, ...(a.urls || []), ...(a.displayAliases || []), a.username, a.note, a.tags]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    }, [filterMode, selectedTag, query, activeAccounts, trashedAccounts]);

    useEffect(() => {
      if (mode === 'create') return;
      if (visibleAccounts.length === 0) {
        if (mode === 'view') setSelectedId(null);
        return;
      }
      if (!selectedId || !visibleAccounts.some((a) => a.id === selectedId)) {
        setSelectedId(visibleAccounts[0].id);
      }
    }, [visibleAccounts, selectedId, mode]);

    const selectedAccount = useMemo(
      () => allAccounts.find((a) => a.id === selectedId) || null,
      [allAccounts, selectedId],
    );

    const runAction = useCallback(async (work, failureTitle) => {
      setBusy(true);
      try {
        const res = await work();
        setTick((n) => n + 1);
        return res;
      } catch (err) {
        shell.notify('error', failureTitle, String((err && err.message) || err));
        return null;
      } finally {
        setBusy(false);
      }
    }, []);

    const handleSave = async (payload) => {
      const isEdit = Boolean(payload.id);
      const res = await runAction(
        () => rpc.call(isEdit ? 'update' : 'create', payload),
        isEdit ? '保存账号失败' : '新建账号失败',
      );
      if (!res) return;
      shell.notify('success', isEdit ? `已保存「${payload.name}」` : `已新建「${payload.name}」`);
      if (res.id) setSelectedId(res.id);
      setMode('view');
    };

    const handleTogglePin = async (account) => {
      const res = await runAction(
        () => rpc.call('togglePin', { id: account.id, pinned: !account.pinned }),
        '置顶操作失败',
      );
      if (res) shell.notify('success', !account.pinned ? `已置顶「${account.name}」` : `已取消置顶「${account.name}」`);
    };

    const handleTrash = async (account) => {
      const res = await runAction(() => rpc.call('trash', { id: account.id }), '移入回收站失败');
      if (res) {
        shell.notify('success', `已将「${account.name}」移入回收站`);
        setMode('view');
      }
    };

    const handleRestore = async (account) => {
      const res = await runAction(() => rpc.call('restore', { id: account.id }), '恢复账号失败');
      if (res) shell.notify('success', `已恢复「${account.name}」`);
    };

    const handlePurgeConfirm = async () => {
      if (!purgingTarget) return;
      if (purgingTarget.all) {
        const res = await runAction(() => rpc.call('purge', { all: true }), '清空回收站失败');
        if (res) {
          shell.notify('success', `已清空回收站（共 ${res.purgedCount ?? 0} 条）`);
          setPurgingTarget(null);
        }
        return;
      }
      const res = await runAction(() => rpc.call('purge', { id: purgingTarget.id }), '彻底删除失败');
      if (res) {
        shell.notify('success', `已彻底删除「${purgingTarget.name}」`);
        setPurgingTarget(null);
      }
    };

    const handleOpenAndFill = async (account) => {
      if (!account.url) return;
      let targetEnvId = environmentId;
      if (!targetEnvId) {
        try {
          const envs = await host.environment.list();
          const running = envs.find((e) => e.status === 'running') || envs[0];
          targetEnvId = running?.id || '';
        } catch {
          targetEnvId = '';
        }
      }
      if (!targetEnvId) {
        shell.notify('info', '没有可用环境', '请先在左侧栏新建一个 Warren 环境');
        return;
      }
      const targetSpace = space || 'person';
      setBusy(true);
      try {
        await shell.openTab(targetEnvId, account.url, targetSpace);
        const targetHost = hostOf(account.url);
        // 轮询等待新标签就绪并探测到登录框后尝试自动填充
        let filled = false;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await new Promise((r) => window.setTimeout(r, 550));
          try {
            const det = await rpc.call('detectFields', { environmentId: targetEnvId, space: targetSpace });
            const detHost = hostOf(det?.url);
            const hasFields = det?.fields && (det.fields.username || det.fields.password || det.fields.totp);
            if (hasFields && (!targetHost || detHost === targetHost || detHost.endsWith(`.${targetHost}`))) {
              const res = await rpc.call('autoFill', {
                id: account.id,
                environmentId: targetEnvId,
                space: targetSpace,
                submit: false,
              });
              const fieldsText = Array.isArray(res?.filled) ? res.filled.join(' / ') : '凭据';
              shell.notify('success', `已打开并填充「${account.name}」`, `已填入：${fieldsText}`);
              if (res?.manualVerificationHint) {
                shell.notify('info', '需人工验证配合', res.manualVerificationHint);
              }
              filled = true;
              break;
            }
          } catch {
            // 页面尚在加载，继续等待下一轮
          }
        }
        if (!filled) {
          shell.notify('info', '已在环境中打开站点', '页面加载完成后可用 ⇧⌘L 或右侧工作台一键填充');
        }
      } catch (err) {
        shell.notify('error', '打开并登录失败', String((err && err.message) || err));
      } finally {
        setBusy(false);
      }
    };

    const handleFillCurrent = async (account) => {
      if (!environmentId) return;
      setBusy(true);
      try {
        const res = await rpc.call('autoFill', {
          id: account.id,
          environmentId,
          space: space || 'person',
          submit: false,
        });
        shell.notify('success', `已填充「${account.name}」`, `已填入：${res?.filled?.join(' / ') || '凭据'}`);
      } catch (err) {
        shell.notify('error', '填充失败', String((err && err.message) || err));
      } finally {
        setBusy(false);
      }
    };

    const navItems = [
      { id: 'all', label: '全部账号', count: activeAccounts.length, icon: 'User' },
      { id: 'pinned', label: '已置顶', count: pinnedCount, icon: 'Zap' },
      { id: 'totp', label: '含 2FA 动态码', count: totpCount, icon: 'Key' },
      { id: 'trash', label: '回收站', count: trashedAccounts.length, icon: 'Trash' },
    ];

    return h(
      'div',
      {
        className: 'flex h-full min-h-0 flex-col overflow-hidden bg-background',
        'data-slot': 'account-manager-page',
      },
      // 顶部固定条
      h(
        'div',
        { className: 'flex shrink-0 flex-col gap-2.5 border-b border-divider px-5 py-3' },
        h(
          'div',
          { className: 'flex flex-wrap items-center gap-2' },
          h(
            'span',
            {
              'aria-hidden': true,
              style: { '--brand-hue': 36 },
              className:
                'plugin-brand-chip flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
            },
            h(Icon, { name: 'User', className: 'size-3.5' }),
          ),
          h('span', { className: 'text-sm font-semibold text-foreground' }, '账号管理'),
          h(
            'span',
            { className: 'text-xs text-muted-foreground' },
            `${activeAccounts.length} 条可用 · ${trashedAccounts.length} 条在回收站`,
          ),
          h(
            'div',
            { className: 'ml-auto flex items-center gap-1.5' },
            h(
              Button,
              { size: 'sm', variant: 'secondary', onClick: () => setImportOpen(true) },
              h(Icon, { name: 'FolderOpen', className: 'size-3.5' }),
              '导入',
            ),
            h(
              Button,
              { size: 'sm', variant: 'secondary', onClick: () => setExportOpen(true) },
              h(Icon, { name: 'Download', className: 'size-3.5' }),
              '导出明文',
            ),
            h(
              Button,
              {
                size: 'sm',
                onClick: () => {
                  setSelectedId(null);
                  setMode('create');
                },
              },
              h(Icon, { name: 'Plus', className: 'size-3.5' }),
              '新建账号',
            ),
          ),
        ),
        h(PlaintextWarning),
      ),

      // 3 区主从分栏工作台
      h(
        'div',
        { className: 'flex min-h-0 flex-1 overflow-hidden' },
        // 左栏：筛选与标签导航
        h(
          'div',
          { className: 'flex w-48 shrink-0 flex-col border-r border-divider bg-surface-drawer' },
          h(
            ScrollArea,
            { className: 'min-h-0 flex-1' },
            h(
              'div',
              { className: 'flex flex-col gap-3 p-2.5' },
              h(
                'div',
                { className: 'flex flex-col gap-0.5' },
                h('span', { className: 'px-2 py-1 text-[11px] font-medium text-muted-foreground' }, '视图'),
                ...navItems.map((nav) => {
                  const selected = filterMode === nav.id && (!selectedTag || nav.id === 'trash');
                  return h(
                    ListRow,
                    { key: nav.id, selected },
                    h(
                      ListRowMain,
                      {
                        onClick: () => {
                          setFilterMode(nav.id);
                          if (nav.id === 'trash') setSelectedTag('');
                          setMode('view');
                        },
                      },
                      h(Icon, { name: nav.icon, className: 'size-3.5 shrink-0 text-muted-foreground' }),
                      h(ListRowLabel, null, h(ListRowLabelText, null, nav.label)),
                      h(ListRowMeta, null, String(nav.count)),
                    ),
                  );
                }),
              ),
              tagStats.length > 0
                ? h(
                    'div',
                    { className: 'flex flex-col gap-0.5' },
                    h(
                      'div',
                      { className: 'flex items-center justify-between px-2 py-1' },
                      h('span', { className: 'text-[11px] font-medium text-muted-foreground' }, '标签筛选'),
                      selectedTag
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'text-[11px] text-[var(--theme-accent)] hover:underline',
                              onClick: () => setSelectedTag(''),
                            },
                            '清除',
                          )
                        : null,
                    ),
                    ...tagStats.map(([tagName, count]) =>
                      h(
                        ListRow,
                        { key: tagName, selected: filterMode !== 'trash' && selectedTag === tagName },
                        h(
                          ListRowMain,
                          {
                            onClick: () => {
                              if (filterMode === 'trash') setFilterMode('all');
                              setSelectedTag((prev) => (prev === tagName ? '' : tagName));
                              setMode('view');
                            },
                          },
                          h(ListRowLabel, null, h(ListRowLabelText, null, `# ${tagName}`)),
                          h(ListRowMeta, null, String(count)),
                        ),
                      ),
                    ),
                  )
                : null,
            ),
          ),
        ),

        // 中栏 + 右栏可调分栏
        h(
          ResizablePanelGroup,
          { orientation: 'horizontal', className: 'min-h-0 min-w-0 flex-1' },
          h(
            ResizablePanel,
            { defaultSize: 336, minSize: 250, maxSize: 480, className: 'flex min-h-0 flex-col' },
            // 搜索与排序工具条
            h(
              'div',
              { className: 'flex shrink-0 flex-col gap-2 border-b border-divider p-2.5' },
              h(
                'div',
                { className: 'flex items-center gap-1.5' },
                h(
                  'div',
                  { className: 'relative min-w-0 flex-1' },
                  h(Icon, {
                    name: 'Search',
                    className:
                      'pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground',
                  }),
                  h(Input, {
                    value: query,
                    placeholder: '搜索站点、账号、备注…',
                    className: 'pl-8 text-xs',
                    onChange: (event) => setQuery(event.target.value),
                  }),
                ),
                h(
                  Select,
                  { value: sortBy, onValueChange: (val) => setSortBy(String(val || 'updated')) },
                  h(
                    SelectTrigger,
                    { size: 'sm', className: 'w-28 shrink-0 text-xs' },
                    h(SelectValue, null, sortLabelOf(sortBy)),
                  ),
                  h(
                    SelectContent,
                    null,
                    ...SORT_OPTIONS.map((opt) => h(SelectItem, { key: opt.value, value: opt.value }, opt.label)),
                  ),
                ),
              ),
              filterMode === 'trash'
                ? h(
                    'div',
                    { className: 'flex items-center justify-between gap-2 text-[11px] text-muted-foreground' },
                    h('span', null, `回收站共 ${trashedAccounts.length} 条`),
                    trashedAccounts.length > 0
                      ? h(
                          Button,
                          {
                            size: 'xs',
                            variant: 'destructive',
                            onClick: () => setPurgingTarget({ all: true }),
                          },
                          '清空回收站',
                        )
                      : null,
                  )
                : null,
            ),
            error ? h('p', { className: 'px-3 pt-2 text-xs text-destructive' }, error) : null,
            // 账号列表
            h(
              ScrollArea,
              { className: 'min-h-0 flex-1' },
              visibleAccounts.length === 0
                ? h(
                    'div',
                    { className: 'flex flex-col items-center justify-center gap-2 px-4 py-14 text-center' },
                    h(Icon, {
                      name: filterMode === 'trash' ? 'Trash' : 'User',
                      className: 'size-6 text-muted-foreground',
                    }),
                    h(
                      'p',
                      { className: 'text-xs font-medium text-foreground' },
                      filterMode === 'trash' ? '回收站是空的' : '没有符合条件的账号',
                    ),
                    filterMode !== 'trash'
                      ? h(
                          Button,
                          {
                            size: 'xs',
                            variant: 'secondary',
                            onClick: () => {
                              setSelectedId(null);
                              setMode('create');
                            },
                          },
                          '新建账号',
                        )
                      : null,
                  )
                : h(
                    'div',
                    { className: 'flex flex-col gap-1.5 p-2', 'data-slot': 'account-list' },
                    ...visibleAccounts.map((account) => {
                      const selected = mode !== 'create' && selectedId === account.id;
                      const accTags = tagsOf(account.tags);
                      return h(
                        'div',
                        {
                          key: account.id,
                          'data-slot': 'account-card',
                          'data-id': String(account.id),
                          'data-selected': selected ? 'true' : undefined,
                          className: cn(
                            'flex w-full items-start gap-1 rounded-[var(--control-radius)] border transition-colors',
                            selected
                              ? 'border-border bg-surface-selected'
                              : 'border-transparent hover:bg-surface-hover',
                          ),
                        },
                        h(
                          'button',
                          {
                            type: 'button',
                            onClick: () => {
                              setSelectedId(account.id);
                              setMode('view');
                            },
                            className:
                              'flex min-w-0 flex-1 flex-col gap-1 rounded-[var(--control-radius)] px-2.5 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring',
                          },
                          h(
                            'div',
                            { className: 'flex w-full items-center gap-1.5' },
                            account.pinned
                              ? h(Icon, { name: 'Zap', className: 'size-3 shrink-0 text-[var(--warning)]' })
                              : null,
                            h(
                              'span',
                              { className: 'min-w-0 flex-1 truncate text-xs font-medium text-foreground' },
                              account.name,
                            ),
                            account.hasTotp
                              ? h(
                                  Badge,
                                  {
                                    variant: 'outline',
                                    className:
                                      'h-4 shrink-0 bg-[var(--theme-accent)]/12 px-1 text-[length:var(--font-size-micro)] text-[var(--theme-accent)]',
                                  },
                                  '2FA',
                                )
                              : null,
                          ),
                          h(
                            'div',
                            { className: 'flex w-full items-center gap-1.5 text-[11px] text-muted-foreground' },
                            h('span', { className: 'min-w-0 flex-1 truncate font-mono' }, account.username || '—'),
                            account.useCount > 0
                              ? h('span', { className: 'shrink-0 tabular-nums' }, `${account.useCount}次`)
                              : null,
                          ),
                          accTags.length > 0
                            ? h(
                                'div',
                                { className: 'flex flex-wrap gap-1 pt-0.5' },
                                ...accTags.slice(0, 2).map((t) =>
                                  h(
                                    Badge,
                                    {
                                      key: t,
                                      variant: 'outline',
                                      className: 'h-4 px-1 text-[length:var(--font-size-micro)]',
                                    },
                                    t,
                                  ),
                                ),
                                accTags.length > 2
                                  ? h(
                                      'span',
                                      { className: 'text-[length:var(--font-size-micro)] text-muted-foreground' },
                                      `+${accTags.length - 2}`,
                                    )
                                  : null,
                              )
                            : null,
                        ),
                        filterMode === 'trash'
                          ? h(
                              'div',
                              { className: 'flex shrink-0 items-center gap-0.5 pr-1.5 pt-1.5' },
                              h(
                                IconButton,
                                {
                                  size: 'icon-xs',
                                  title: '恢复',
                                  'aria-label': '恢复',
                                  onClick: () => void handleRestore(account),
                                },
                                h(Icon, { name: 'RotateClockwise', className: 'size-3.5' }),
                              ),
                              h(
                                IconButton,
                                {
                                  size: 'icon-xs',
                                  className: 'text-destructive hover:text-destructive',
                                  title: '彻底删除',
                                  'aria-label': '彻底删除',
                                  onClick: () => setPurgingTarget(account),
                                },
                                h(Icon, { name: 'Trash', className: 'size-3.5' }),
                              ),
                            )
                          : null,
                      );
                    }),
                  ),
            ),
          ),

          h(ResizableHandle),

          // 右栏：详情 / 编辑工作台
          h(
            ResizablePanel,
            { minSize: 320, className: 'flex min-h-0 min-w-0 flex-col' },
            mode === 'create'
              ? h(AccountEditorView, {
                  editing: null,
                  environmentId,
                  space,
                  busy,
                  onSave: handleSave,
                  onCancel: () => setMode('view'),
                })
              : mode === 'edit' && selectedAccount
                ? h(AccountEditorView, {
                    editing: selectedAccount,
                    environmentId,
                    space,
                    busy,
                    onSave: handleSave,
                    onCancel: () => setMode('view'),
                  })
                : selectedAccount
                  ? h(AccountDetailView, {
                      account: selectedAccount,
                      environmentId,
                      busy,
                      onEdit: () => setMode('edit'),
                      onTogglePin: (acc) => void handleTogglePin(acc),
                      onTrash: (acc) => void handleTrash(acc),
                      onRestore: (acc) => void handleRestore(acc),
                      onPurge: (acc) => setPurgingTarget(acc),
                      onOpenAndFill: handleOpenAndFill,
                      onFillCurrent: handleFillCurrent,
                    })
                  : h(
                      'div',
                      { className: 'flex h-full items-center justify-center p-6' },
                      h(
                        Empty,
                        null,
                        h(
                          EmptyHeader,
                          null,
                          h(EmptyMedia, { variant: 'icon' }, h(Icon, { name: 'Key' })),
                          h(EmptyTitle, null, '选择或新建一个账号'),
                          h(
                            EmptyDescription,
                            null,
                            '支持零手写选择器自动填充、实时 TOTP 动态码、域名白名单与批量导入导出。',
                          ),
                        ),
                        h(
                          EmptyContent,
                          null,
                          h(
                            'div',
                            { className: 'flex gap-2' },
                            h(
                              Button,
                              {
                                size: 'sm',
                                onClick: () => {
                                  setSelectedId(null);
                                  setMode('create');
                                },
                              },
                              h(Icon, { name: 'Plus', className: 'size-3.5' }),
                              '新建账号',
                            ),
                            h(
                              Button,
                              { size: 'sm', variant: 'secondary', onClick: () => setImportOpen(true) },
                              h(Icon, { name: 'FolderOpen', className: 'size-3.5' }),
                              '批量导入',
                            ),
                          ),
                        ),
                      ),
                    ),
          ),
        ),
      ),

      // 导入导出弹窗
      h(ImportDialog, {
        open: importOpen,
        onOpenChange: setImportOpen,
        onImported: () => setTick((n) => n + 1),
      }),
      h(ExportDialog, {
        open: exportOpen,
        onOpenChange: setExportOpen,
      }),

      // 彻底删除确认框
      h(
        AlertDialog,
        { open: Boolean(purgingTarget), onOpenChange: (open) => !open && setPurgingTarget(null) },
        h(
          AlertDialogContent,
          null,
          h(
            AlertDialogHeader,
            null,
            h(
              AlertDialogTitle,
              null,
              purgingTarget?.all ? '清空回收站？' : `彻底删除「${purgingTarget?.name ?? ''}」？`,
            ),
            h(
              AlertDialogDescription,
              null,
              purgingTarget?.all
                ? '回收站内的所有账号、密码和 TOTP 密钥将被永久清除，无法恢复。'
                : '彻底删除后该账号、密码和 TOTP 密钥将无法恢复。',
            ),
          ),
          h(
            AlertDialogFooter,
            null,
            h(AlertDialogCancel, null, '取消'),
            h(AlertDialogAction, { disabled: busy, onClick: () => void handlePurgeConfirm() }, '确认彻底删除'),
          ),
        ),
      ),
    );
  }

  return { AccountsPage };
}
