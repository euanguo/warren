/**
 * 全屏工作台详情视图（reveal / TOTP / 字段模板）与新建编辑表单。
 */
export function createDetailEditorViews(ctx) {
  const {
    h,
    React,
    rpc,
    shell,
    Badge,
    Button,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    Field,
    FieldDescription,
    FieldLabel,
    Icon,
    IconButton,
    Input,
    ScrollArea,
    Separator,
    Switch,
    Textarea,
    cardSurfaceClass,
    cn,
    FIELD_LABELS,
    tagsOf,
    splitListText,
    formatSelectorTarget,
    formatTime,
    copyText,
    parseSelectorInput,
    TotpLiveBar,
    PasswordGeneratorPanel,
  } = ctx;
  const { useEffect, useState } = React;
  const EMPTY_FORM = {
    name: '',
    url: '',
    username: '',
    password: '',
    totpSecret: '',
    tags: '',
    note: '',
    pinned: false,
    urlsText: '',
    allowedHostsText: '',
    displayAliasesText: '',
    envIdsText: '',
    appHintsText: '',
    manualVerificationHint: '',
    selUsername: '',
    selPassword: '',
    selTotp: '',
    selSubmit: '',
    extraRows: [],
  };

  function formFromAccount(account) {
    if (!account) return { ...EMPTY_FORM, extraRows: [] };
    const sel = account.selectors || {};
    const keys = Array.isArray(account.extraFieldKeys) ? account.extraFieldKeys : [];
    return {
      name: account.name || '',
      url: account.url || '',
      username: account.username || '',
      password: '',
      totpSecret: '',
      tags: account.tags || '',
      note: account.note || '',
      pinned: Boolean(account.pinned),
      urlsText: (account.urls || []).join('\n'),
      allowedHostsText: (account.allowedHosts || []).join(', '),
      displayAliasesText: (account.displayAliases || []).join(', '),
      envIdsText: (account.envIds || []).join(', '),
      appHintsText: (account.appHints || []).join(', '),
      manualVerificationHint: account.manualVerificationHint || '',
      selUsername: formatSelectorTarget(sel.username),
      selPassword: formatSelectorTarget(sel.password),
      selTotp: formatSelectorTarget(sel.totp),
      selSubmit: formatSelectorTarget(sel.submit),
      extraRows: keys.map((key) => ({ key, value: '', loaded: false })),
    };
  }

  function AccountDetailView({
    account,
    environmentId,
    busy,
    onEdit,
    onTogglePin,
    onTrash,
    onRestore,
    onPurge,
    onOpenAndFill,
    onFillCurrent,
  }) {
    const [pwRevealed, setPwRevealed] = useState(false);
    const [pwValue, setPwValue] = useState('');
    const [totpSecretShown, setTotpSecretShown] = useState(false);
    const [totpSecretVal, setTotpSecretVal] = useState('');
    const [extraSecrets, setExtraSecrets] = useState({});

    useEffect(() => {
      setPwRevealed(false);
      setPwValue('');
      setTotpSecretShown(false);
      setTotpSecretVal('');
      setExtraSecrets({});
    }, [account.id, account.updatedAt]);

    const revealField = async (field) => {
      const res = await rpc.call('reveal', { id: account.id, field });
      return String(res?.value ?? '');
    };

    const togglePassword = async () => {
      if (pwRevealed) {
        setPwRevealed(false);
        return;
      }
      try {
        const val = pwValue || (await revealField('password'));
        setPwValue(val);
        setPwRevealed(true);
      } catch (err) {
        shell.notify('error', '读取密码失败', String((err && err.message) || err));
      }
    };

    const copyPassword = async () => {
      try {
        const val = pwValue || (await revealField('password'));
        setPwValue(val);
        await copyText(val, '密码');
      } catch (err) {
        shell.notify('error', '复制密码失败', String((err && err.message) || err));
      }
    };

    const toggleTotpSecret = async () => {
      if (totpSecretShown) {
        setTotpSecretShown(false);
        return;
      }
      try {
        const val = totpSecretVal || (await revealField('totpSecret'));
        setTotpSecretVal(val);
        setTotpSecretShown(true);
      } catch (err) {
        shell.notify('error', '读取 TOTP 密钥失败', String((err && err.message) || err));
      }
    };

    const revealExtra = async (key, copyOnly = false) => {
      try {
        const existing = extraSecrets[key];
        const val = existing !== undefined ? existing : await revealField(`extra:${key}`);
        setExtraSecrets((prev) => ({ ...prev, [key]: val }));
        if (copyOnly) await copyText(val, key);
      } catch (err) {
        shell.notify('error', `读取字段 ${key} 失败`, String((err && err.message) || err));
      }
    };

    const isDeleted = Boolean(account.deletedAt);
    const tags = tagsOf(account.tags);
    const selectors = account.selectors || {};
    const selectorKeys = Object.keys(selectors);
    const extraKeys = Array.isArray(account.extraFieldKeys) ? account.extraFieldKeys : [];

    return h(
      'div',
      { className: 'flex h-full min-h-0 flex-col' },
      // 详情顶栏
      h(
        'div',
        { className: 'flex flex-wrap items-center justify-between gap-2 border-b border-divider px-5 py-3' },
        h(
          'div',
          { className: 'min-w-0 flex-1' },
          h(
            'div',
            { className: 'flex items-center gap-2' },
            account.pinned ? h(Icon, { name: 'Zap', className: 'size-4 shrink-0 text-[var(--warning)]' }) : null,
            h('h2', { className: 'truncate text-base font-semibold text-foreground' }, account.name),
            isDeleted ? h(Badge, { variant: 'destructive' }, '回收站') : null,
            account.hasTotp
              ? h(
                  Badge,
                  { variant: 'outline', className: 'bg-[var(--theme-accent)]/12 text-[var(--theme-accent)]' },
                  '2FA',
                )
              : null,
          ),
          account.url
            ? h('p', { className: 'mt-0.5 truncate font-mono text-xs text-muted-foreground' }, account.url)
            : null,
        ),
        h(
          'div',
          { className: 'flex shrink-0 flex-wrap items-center gap-1.5' },
          !isDeleted
            ? h(
                React.Fragment,
                null,
                h(
                  Button,
                  {
                    size: 'sm',
                    variant: account.pinned ? 'secondary' : 'ghost',
                    disabled: busy,
                    onClick: () => onTogglePin(account),
                  },
                  h(Icon, { name: 'Zap', className: cn('size-3.5', account.pinned && 'text-[var(--warning)]') }),
                  account.pinned ? '取消置顶' : '置顶',
                ),
                account.url
                  ? h(
                      Button,
                      {
                        size: 'sm',
                        variant: 'secondary',
                        disabled: busy,
                        onClick: () => void onOpenAndFill(account),
                      },
                      h(Icon, { name: 'ExternalLink', className: 'size-3.5' }),
                      '在当前环境打开并登录',
                    )
                  : null,
                environmentId
                  ? h(
                      Button,
                      {
                        size: 'sm',
                        variant: 'secondary',
                        disabled: busy,
                        onClick: () => void onFillCurrent(account),
                      },
                      h(Icon, { name: 'Key', className: 'size-3.5' }),
                      '填进当前页',
                    )
                  : null,
                h(
                  Button,
                  { size: 'sm', disabled: busy, onClick: onEdit },
                  h(Icon, { name: 'Pencil', className: 'size-3.5' }),
                  '编辑',
                ),
                h(
                  IconButton,
                  {
                    size: 'icon-sm',
                    title: '移入回收站',
                    'aria-label': '移入回收站',
                    disabled: busy,
                    onClick: () => onTrash(account),
                  },
                  h(Icon, { name: 'Trash' }),
                ),
              )
            : h(
                React.Fragment,
                null,
                h(
                  Button,
                  { size: 'sm', variant: 'secondary', disabled: busy, onClick: () => onRestore(account) },
                  h(Icon, { name: 'RotateClockwise', className: 'size-3.5' }),
                  '恢复账号',
                ),
                h(
                  Button,
                  { size: 'sm', variant: 'destructive', disabled: busy, onClick: () => onPurge(account) },
                  h(Icon, { name: 'Trash', className: 'size-3.5' }),
                  '彻底删除',
                ),
              ),
        ),
      ),

      // 详情内容滚动区
      h(
        ScrollArea,
        { className: 'min-h-0 flex-1' },
        h(
          'div',
          { className: 'flex flex-col gap-4 p-5' },
          // 核心凭据卡片
          h(
            'div',
            { className: cn(cardSurfaceClass, 'flex flex-col gap-3') },
            h('span', { className: 'text-xs font-medium text-muted-foreground' }, '核心凭据'),
            h(
              'div',
              { className: 'grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-y-2.5 text-xs' },
              h('span', { className: 'text-muted-foreground' }, '账号'),
              h(
                'div',
                { className: 'flex min-w-0 items-center gap-1.5' },
                h(
                  'span',
                  { className: 'min-w-0 flex-1 truncate font-mono text-sm text-foreground' },
                  account.username || '—',
                ),
                account.username
                  ? h(
                      Button,
                      { size: 'xs', variant: 'ghost', onClick: () => void copyText(account.username, '账号') },
                      h(Icon, { name: 'Copy', className: 'size-3' }),
                      '复制',
                    )
                  : null,
              ),
              h('span', { className: 'text-muted-foreground' }, '密码'),
              h(
                'div',
                { className: 'flex min-w-0 items-center gap-1.5' },
                h(
                  'span',
                  { className: 'min-w-0 flex-1 break-all font-mono text-sm text-foreground' },
                  !account.hasPassword ? '（未设置）' : pwRevealed ? pwValue || '—' : '••••••••••••',
                ),
                account.hasPassword
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        Button,
                        { size: 'xs', variant: 'ghost', onClick: () => void togglePassword() },
                        pwRevealed ? '隐藏' : '显示',
                      ),
                      h(
                        Button,
                        { size: 'xs', variant: 'ghost', onClick: () => void copyPassword() },
                        h(Icon, { name: 'Copy', className: 'size-3' }),
                        '复制',
                      ),
                    )
                  : null,
              ),
            ),
            account.hasTotp
              ? h(
                  'div',
                  { className: 'flex flex-col gap-2 border-t border-divider pt-2.5' },
                  h(TotpLiveBar, { accountId: account.id }),
                  h(
                    'div',
                    { className: 'flex items-center justify-between gap-2 text-[11px]' },
                    h(
                      'span',
                      { className: 'truncate font-mono text-muted-foreground' },
                      totpSecretShown ? totpSecretVal : 'TOTP 密钥已隐藏',
                    ),
                    h(
                      'div',
                      { className: 'flex shrink-0 items-center gap-1' },
                      h(
                        Button,
                        { size: 'xs', variant: 'ghost', onClick: () => void toggleTotpSecret() },
                        totpSecretShown ? '隐藏密钥' : '查看密钥',
                      ),
                      totpSecretShown && totpSecretVal
                        ? h(
                            Button,
                            { size: 'xs', variant: 'ghost', onClick: () => void copyText(totpSecretVal, 'TOTP 密钥') },
                            '复制密钥',
                          )
                        : null,
                    ),
                  ),
                )
              : null,
          ),

          // 站点与匹配规则卡片
          h(
            'div',
            { className: cn(cardSurfaceClass, 'flex flex-col gap-2.5 text-xs') },
            h('span', { className: 'font-medium text-muted-foreground' }, '站点与匹配规则'),
            h(
              'div',
              { className: 'grid grid-cols-[6rem_minmax(0,1fr)] gap-y-2' },
              h('span', { className: 'text-muted-foreground' }, '主网址'),
              h('span', { className: 'break-all font-mono text-foreground' }, account.url || '—'),
              h('span', { className: 'text-muted-foreground' }, '额外网址'),
              account.urls?.length
                ? h(
                    'div',
                    { className: 'flex flex-col gap-0.5 font-mono text-foreground' },
                    ...account.urls.map((u) => h('span', { key: u, className: 'break-all' }, u)),
                  )
                : h('span', { className: 'text-muted-foreground' }, '—'),
              h('span', { className: 'text-muted-foreground' }, '域名白名单'),
              account.allowedHosts?.length
                ? h(
                    'div',
                    { className: 'flex flex-wrap gap-1' },
                    ...account.allowedHosts.map((hostItem) =>
                      h(Badge, { key: hostItem, variant: 'outline', className: 'font-mono' }, hostItem),
                    ),
                  )
                : h('span', { className: 'text-muted-foreground' }, '自动由主网址与额外网址推导'),
              h('span', { className: 'text-muted-foreground' }, '显示别名'),
              account.displayAliases?.length
                ? h(
                    'div',
                    { className: 'flex flex-wrap gap-1' },
                    ...account.displayAliases.map((a) => h(Badge, { key: a, variant: 'secondary' }, a)),
                  )
                : h('span', { className: 'text-muted-foreground' }, '—'),
              h('span', { className: 'text-muted-foreground' }, '偏好环境'),
              account.envIds?.length
                ? h(
                    'div',
                    { className: 'flex flex-wrap gap-1' },
                    ...account.envIds.map((e) => h(Badge, { key: e, variant: 'outline', className: 'font-mono' }, e)),
                  )
                : h('span', { className: 'text-muted-foreground' }, '全部环境'),
              h('span', { className: 'text-muted-foreground' }, '标签'),
              tags.length
                ? h(
                    'div',
                    { className: 'flex flex-wrap gap-1' },
                    ...tags.map((t) => h(Badge, { key: t, variant: 'outline' }, t)),
                  )
                : h('span', { className: 'text-muted-foreground' }, '—'),
            ),
          ),

          // 自动化与扩展字段卡片
          h(
            'div',
            { className: cn(cardSurfaceClass, 'flex flex-col gap-2.5 text-xs') },
            h('span', { className: 'font-medium text-muted-foreground' }, '自动化与扩展配置'),
            h(
              'div',
              { className: 'grid grid-cols-[6rem_minmax(0,1fr)] gap-y-2' },
              h('span', { className: 'text-muted-foreground' }, '选择器模板'),
              selectorKeys.length
                ? h(
                    'div',
                    { className: 'flex flex-col gap-1' },
                    ...selectorKeys.map((k) => {
                      const val = formatSelectorTarget(selectors[k]);
                      return h(
                        'div',
                        {
                          key: k,
                          className: 'flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-surface-fog px-2 py-1',
                        },
                        h('span', { className: 'shrink-0 text-muted-foreground' }, FIELD_LABELS[k] || k),
                        h('span', { className: 'min-w-0 flex-1 truncate font-mono text-foreground', title: val }, val),
                        h(
                          IconButton,
                          { size: 'icon-xs', title: '复制选择器', onClick: () => void copyText(val, '选择器') },
                          h(Icon, { name: 'Copy' }),
                        ),
                      );
                    }),
                  )
                : h('span', { className: 'text-muted-foreground' }, '未绑定（填充时自动探测）'),
              account.appHints?.length
                ? h(
                    React.Fragment,
                    null,
                    h('span', { className: 'text-muted-foreground' }, '应用线索'),
                    h('span', { className: 'text-foreground' }, account.appHints.join(' / ')),
                  )
                : null,
              account.manualVerificationHint
                ? h(
                    React.Fragment,
                    null,
                    h('span', { className: 'text-muted-foreground' }, '人工验证提醒'),
                    h('span', { className: 'text-[var(--warning)]' }, account.manualVerificationHint),
                  )
                : null,
              h('span', { className: 'text-muted-foreground' }, '扩展字段'),
              extraKeys.length
                ? h(
                    'div',
                    { className: 'flex flex-col gap-1' },
                    ...extraKeys.map((k) => {
                      const shown = extraSecrets[k] !== undefined;
                      return h(
                        'div',
                        {
                          key: k,
                          className: 'flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-surface-fog px-2 py-1',
                        },
                        h('span', { className: 'shrink-0 font-mono text-foreground' }, k),
                        h(
                          'span',
                          { className: 'min-w-0 flex-1 truncate font-mono text-muted-foreground' },
                          shown ? extraSecrets[k] || '（空）' : '••••••',
                        ),
                        h(
                          Button,
                          {
                            size: 'xs',
                            variant: 'ghost',
                            onClick: () =>
                              shown
                                ? setExtraSecrets((prev) => {
                                    const next = { ...prev };
                                    delete next[k];
                                    return next;
                                  })
                                : void revealExtra(k, false),
                          },
                          shown ? '隐藏' : '查看',
                        ),
                        h(
                          IconButton,
                          { size: 'icon-xs', title: `复制 ${k}`, onClick: () => void revealExtra(k, true) },
                          h(Icon, { name: 'Copy' }),
                        ),
                      );
                    }),
                  )
                : h('span', { className: 'text-muted-foreground' }, '—'),
              h('span', { className: 'text-muted-foreground' }, '备注'),
              account.note
                ? h('p', { className: 'whitespace-pre-wrap leading-relaxed text-foreground' }, account.note)
                : h('span', { className: 'text-muted-foreground' }, '—'),
            ),
            h(Separator),
            h(
              'div',
              { className: 'flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground' },
              h('span', null, `使用次数：${account.useCount || 0}`),
              h('span', null, `最近使用：${formatTime(account.lastUsedAt)}`),
              h('span', null, `更新于：${formatTime(account.updatedAt)}`),
              h('span', null, `创建于：${formatTime(account.createdAt)}`),
            ),
          ),
        ),
      ),
    );
  }

  function AccountEditorView({ editing, environmentId, space, busy, onSave, onCancel }) {
    const [form, setForm] = useState(() => formFromAccount(editing));
    const [showPassword, setShowPassword] = useState(false);
    const [generatorOpen, setGeneratorOpen] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [passwordDirty, setPasswordDirty] = useState(false);
    const [totpDirty, setTotpDirty] = useState(false);
    const [extraDirty, setExtraDirty] = useState(false);
    const [detecting, setDetecting] = useState(false);

    useEffect(() => {
      setForm(formFromAccount(editing));
      setShowPassword(false);
      setGeneratorOpen(false);
      setPasswordDirty(false);
      setTotpDirty(false);
      setExtraDirty(false);

      if (!editing) return undefined;
      let cancelled = false;
      if (editing.hasPassword) {
        rpc
          .call('reveal', { id: editing.id, field: 'password' })
          .then((res) => {
            if (!cancelled) setForm((prev) => ({ ...prev, password: String(res?.value ?? '') }));
          })
          .catch(() => {});
      }
      if (editing.hasTotp) {
        rpc
          .call('reveal', { id: editing.id, field: 'totpSecret' })
          .then((res) => {
            if (!cancelled) setForm((prev) => ({ ...prev, totpSecret: String(res?.value ?? '') }));
          })
          .catch(() => {});
      }
      const extraKeys = Array.isArray(editing.extraFieldKeys) ? editing.extraFieldKeys : [];
      for (const k of extraKeys) {
        rpc
          .call('reveal', { id: editing.id, field: `extra:${k}` })
          .then((res) => {
            if (cancelled) return;
            setForm((prev) => ({
              ...prev,
              extraRows: prev.extraRows.map((row) =>
                row.key === k ? { ...row, value: String(res?.value ?? ''), loaded: true } : row,
              ),
            }));
          })
          .catch(() => {});
      }
      return () => {
        cancelled = true;
      };
    }, [editing]);

    const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

    const fillSelectorsFromPage = async () => {
      if (!environmentId) {
        shell.notify('error', '当前没有选中的环境');
        return;
      }
      setDetecting(true);
      try {
        const res = await rpc.call('detectFields', { environmentId, space });
        const f = res?.fields || {};
        setForm((prev) => ({
          ...prev,
          selUsername: formatSelectorTarget(f.username?.target ?? f.username?.selector) || prev.selUsername,
          selPassword: formatSelectorTarget(f.password?.target ?? f.password?.selector) || prev.selPassword,
          selTotp: formatSelectorTarget(f.totp?.target ?? f.totp?.selector) || prev.selTotp,
          selSubmit: formatSelectorTarget(f.submit?.target ?? f.submit?.selector) || prev.selSubmit,
        }));
        shell.notify('success', '已从当前页探测并填入选择器');
      } catch (err) {
        shell.notify('error', '探测页面登录框失败', String((err && err.message) || err));
      } finally {
        setDetecting(false);
      }
    };

    const submit = async (event) => {
      event.preventDefault();
      if (!form.name.trim()) {
        shell.notify('error', '站点名称不能为空');
        return;
      }

      const selectors = {};
      const selMap = [
        ['username', form.selUsername],
        ['password', form.selPassword],
        ['totp', form.selTotp],
        ['submit', form.selSubmit],
      ];
      for (const [k, rawVal] of selMap) {
        const parsed = parseSelectorInput(rawVal);
        if (parsed !== undefined) selectors[k] = parsed;
      }
      if (editing && editing.selectors) {
        for (const [k, v] of Object.entries(editing.selectors)) {
          if (!['username', 'password', 'totp', 'submit'].includes(k) && v) {
            selectors[k] = v;
          }
        }
      }

      const payload = {
        name: form.name.trim(),
        url: form.url.trim(),
        username: form.username.trim(),
        note: form.note.trim(),
        tags: form.tags.trim(),
        pinned: Boolean(form.pinned),
        urls: splitListText(form.urlsText),
        allowedHosts: splitListText(form.allowedHostsText),
        displayAliases: splitListText(form.displayAliasesText),
        envIds: splitListText(form.envIdsText),
        appHints: splitListText(form.appHintsText),
        manualVerificationHint: form.manualVerificationHint.trim(),
        selectors,
      };

      if (!editing) {
        payload.password = form.password;
        if (form.totpSecret.trim()) payload.totpSecret = form.totpSecret.trim();
      } else {
        payload.id = editing.id;
        if (passwordDirty || form.password) payload.password = form.password;
        if (totpDirty || form.totpSecret.trim()) payload.totpSecret = form.totpSecret.trim();
      }

      const allExtraLoaded = form.extraRows.every((row) => row.loaded);
      if (!editing || extraDirty || allExtraLoaded) {
        const extraFields = {};
        for (const row of form.extraRows) {
          const k = row.key.trim();
          if (k) extraFields[k] = row.value;
        }
        if (!editing) {
          if (Object.keys(extraFields).length > 0) payload.extraFields = extraFields;
        } else if (allExtraLoaded) {
          payload.extraFields = extraFields;
        }
      }

      await onSave(payload);
    };

    return h(
      'form',
      { onSubmit: submit, className: 'flex h-full min-h-0 flex-col', 'data-slot': 'account-editor' },
      h(
        'div',
        { className: 'flex items-center justify-between gap-2 border-b border-divider px-5 py-3' },
        h(
          'div',
          { className: 'flex items-center gap-2' },
          h(
            'h2',
            { className: 'text-base font-semibold text-foreground' },
            editing ? `编辑「${editing.name}」` : '新建账号',
          ),
          h(Badge, { variant: 'outline' }, '本机明文保存'),
        ),
        h(
          'div',
          { className: 'flex items-center gap-1.5' },
          h(Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: onCancel }, '取消'),
          h(
            Button,
            { type: 'submit', size: 'sm', disabled: busy || !form.name.trim() },
            h(Icon, { name: 'Save', className: 'size-3.5' }),
            busy ? '保存中…' : editing ? '保存修改' : '创建账号',
          ),
        ),
      ),

      h(
        ScrollArea,
        { className: 'min-h-0 flex-1' },
        h(
          'div',
          { className: 'flex flex-col gap-4 p-5' },
          // 核心信息网格
          h(
            'div',
            { className: 'grid gap-3 sm:grid-cols-2' },
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: 'acc-name' }, '站点 / 名称 *'),
              h(Input, {
                id: 'acc-name',
                value: form.name,
                placeholder: '例如：GitHub 测试账号',
                onChange: (event) => setField('name', event.target.value),
              }),
            ),
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: 'acc-url' }, '主网址'),
              h(Input, {
                id: 'acc-url',
                value: form.url,
                placeholder: 'https://example.com/login',
                onChange: (event) => setField('url', event.target.value),
              }),
            ),
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: 'acc-username' }, '账号 / 用户名'),
              h(Input, {
                id: 'acc-username',
                value: form.username,
                autoComplete: 'off',
                placeholder: 'name@example.com',
                onChange: (event) => setField('username', event.target.value),
              }),
            ),
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: 'acc-password' }, '密码'),
              h(
                'div',
                { className: 'flex items-center gap-1.5' },
                h(Input, {
                  id: 'acc-password',
                  type: showPassword ? 'text' : 'password',
                  value: form.password,
                  autoComplete: 'off',
                  placeholder:
                    editing && editing.hasPassword && !passwordDirty ? '读取原密码中或留空保持不变' : '输入密码',
                  className: 'min-w-0 flex-1 font-mono',
                  onChange: (event) => {
                    setPasswordDirty(true);
                    setField('password', event.target.value);
                  },
                }),
                h(
                  Button,
                  {
                    type: 'button',
                    size: 'sm',
                    variant: 'ghost',
                    onClick: () => setShowPassword((prev) => !prev),
                  },
                  showPassword ? '隐藏' : '显示',
                ),
                h(
                  Button,
                  {
                    type: 'button',
                    size: 'sm',
                    variant: generatorOpen ? 'secondary' : 'ghost',
                    onClick: () => setGeneratorOpen((prev) => !prev),
                  },
                  h(Icon, { name: 'Sparkles', className: 'size-3.5' }),
                  '生成',
                ),
              ),
            ),
          ),

          generatorOpen
            ? h(PasswordGeneratorPanel, {
                onApply: (pwd) => {
                  setPasswordDirty(true);
                  setField('password', pwd);
                  setShowPassword(true);
                  setGeneratorOpen(false);
                },
              })
            : null,

          h(
            'div',
            { className: 'grid gap-3 sm:grid-cols-2' },
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: 'acc-totp' }, 'TOTP 密钥 / otpauth URI'),
              h(Input, {
                id: 'acc-totp',
                value: form.totpSecret,
                autoComplete: 'off',
                placeholder: 'JBSWY3DPEHPK3PXP 或 otpauth://totp/...',
                className: 'font-mono text-xs',
                onChange: (event) => {
                  setTotpDirty(true);
                  setField('totpSecret', event.target.value);
                },
              }),
              h(FieldDescription, null, '支持 Base32 密钥或完整 otpauth:// URI（支持 SHA-1/256/512）。'),
            ),
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: 'acc-tags' }, '标签'),
              h(Input, {
                id: 'acc-tags',
                value: form.tags,
                placeholder: '逗号分隔，如：测试, 管理后台, 2FA',
                onChange: (event) => setField('tags', event.target.value),
              }),
              h(
                'label',
                { className: 'mt-1.5 flex cursor-pointer items-center gap-2 text-xs text-foreground select-none' },
                h(Switch, {
                  size: 'sm',
                  checked: form.pinned,
                  onCheckedChange: (next) => setField('pinned', Boolean(next)),
                }),
                '置顶此账号（快捷浮窗与列表优先排序）',
              ),
            ),
          ),

          h(
            Field,
            null,
            h(FieldLabel, { htmlFor: 'acc-note' }, '备注'),
            h(Textarea, {
              id: 'acc-note',
              className: 'min-h-20',
              value: form.note,
              placeholder: '角色、测试环境说明、注意事项…',
              onChange: (event) => setField('note', event.target.value),
            }),
          ),

          // 可折叠高级配置
          h(
            Collapsible,
            { open: advancedOpen, onOpenChange: setAdvancedOpen },
            h(
              CollapsibleTrigger,
              {
                className:
                  'flex w-full items-center justify-between rounded-[var(--radius-lg)] border border-border bg-surface-fog px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover',
              },
              h(
                'span',
                { className: 'flex items-center gap-1.5' },
                h(Icon, { name: 'Sliders', className: 'size-3.5 text-muted-foreground' }),
                '高级匹配规则、选择器模板与扩展字段',
              ),
              h(Icon, {
                name: advancedOpen ? 'ChevronUp' : 'ChevronDown',
                className: 'size-3.5 text-muted-foreground',
              }),
            ),
            h(
              CollapsibleContent,
              null,
              h(
                'div',
                { className: cn(cardSurfaceClass, 'mt-2 flex flex-col gap-3') },
                h(
                  'div',
                  { className: 'grid gap-3 sm:grid-cols-2' },
                  h(
                    Field,
                    null,
                    h(FieldLabel, null, '额外匹配网址（urls）'),
                    h(Textarea, {
                      className: 'min-h-16 font-mono text-xs',
                      value: form.urlsText,
                      placeholder: '每行或逗号分隔多个备用登录 URL',
                      onChange: (event) => setField('urlsText', event.target.value),
                    }),
                  ),
                  h(
                    Field,
                    null,
                    h(FieldLabel, null, '域名白名单（allowedHosts）'),
                    h(Textarea, {
                      className: 'min-h-16 font-mono text-xs',
                      value: form.allowedHostsText,
                      placeholder: '例如：login.example.com, *.example.com',
                      onChange: (event) => setField('allowedHostsText', event.target.value),
                    }),
                  ),
                  h(
                    Field,
                    null,
                    h(FieldLabel, null, '显示别名（displayAliases）'),
                    h(Input, {
                      value: form.displayAliasesText,
                      placeholder: '逗号分隔别名或备用域名',
                      onChange: (event) => setField('displayAliasesText', event.target.value),
                    }),
                  ),
                  h(
                    Field,
                    null,
                    h(FieldLabel, null, '偏好环境 ID（envIds）'),
                    h(Input, {
                      value: form.envIdsText,
                      placeholder: '逗号分隔环境 ID，如：cap, dev',
                      className: 'font-mono text-xs',
                      onChange: (event) => setField('envIdsText', event.target.value),
                    }),
                  ),
                ),

                h(Separator),

                h(
                  'div',
                  { className: 'flex items-center justify-between gap-2' },
                  h('span', { className: 'text-xs font-medium text-foreground' }, '页面选择器模板（可选）'),
                  environmentId
                    ? h(
                        Button,
                        {
                          type: 'button',
                          size: 'xs',
                          variant: 'secondary',
                          disabled: detecting,
                          onClick: () => void fillSelectorsFromPage(),
                        },
                        h(Icon, { name: 'Search', className: 'size-3' }),
                        detecting ? '探测中…' : '从当前页探测填入',
                      )
                    : null,
                ),
                h(
                  'div',
                  { className: 'grid gap-2.5 sm:grid-cols-2' },
                  h(
                    Field,
                    null,
                    h(FieldLabel, { className: 'text-xs' }, '账号选择器 (username)'),
                    h(Input, {
                      value: form.selUsername,
                      placeholder: '#username 或 {"kind":"label","text":"账号"}',
                      className: 'font-mono text-xs',
                      onChange: (event) => setField('selUsername', event.target.value),
                    }),
                  ),
                  h(
                    Field,
                    null,
                    h(FieldLabel, { className: 'text-xs' }, '密码选择器 (password)'),
                    h(Input, {
                      value: form.selPassword,
                      placeholder: 'input[type="password"]',
                      className: 'font-mono text-xs',
                      onChange: (event) => setField('selPassword', event.target.value),
                    }),
                  ),
                  h(
                    Field,
                    null,
                    h(FieldLabel, { className: 'text-xs' }, 'TOTP 选择器 (totp)'),
                    h(Input, {
                      value: form.selTotp,
                      placeholder: 'input[autocomplete="one-time-code"]',
                      className: 'font-mono text-xs',
                      onChange: (event) => setField('selTotp', event.target.value),
                    }),
                  ),
                  h(
                    Field,
                    null,
                    h(FieldLabel, { className: 'text-xs' }, '提交按钮选择器 (submit)'),
                    h(Input, {
                      value: form.selSubmit,
                      placeholder: 'button[type="submit"]',
                      className: 'font-mono text-xs',
                      onChange: (event) => setField('selSubmit', event.target.value),
                    }),
                  ),
                ),

                h(Separator),

                h(
                  'div',
                  { className: 'grid gap-3 sm:grid-cols-2' },
                  h(
                    Field,
                    null,
                    h(FieldLabel, null, '应用线索（appHints）'),
                    h(Input, {
                      value: form.appHintsText,
                      placeholder: '逗号分隔关键词',
                      onChange: (event) => setField('appHintsText', event.target.value),
                    }),
                  ),
                  h(
                    Field,
                    null,
                    h(FieldLabel, null, '人工验证提示（manualVerificationHint）'),
                    h(Input, {
                      value: form.manualVerificationHint,
                      placeholder: '例如：需人工完成滑块或短信验证',
                      onChange: (event) => setField('manualVerificationHint', event.target.value),
                    }),
                  ),
                ),

                h(Separator),

                // 扩展字段键值对
                h(
                  'div',
                  { className: 'flex items-center justify-between' },
                  h('span', { className: 'text-xs font-medium text-foreground' }, '扩展字段（extraFields）'),
                  h(
                    Button,
                    {
                      type: 'button',
                      size: 'xs',
                      variant: 'secondary',
                      onClick: () => {
                        setExtraDirty(true);
                        setForm((prev) => ({
                          ...prev,
                          extraRows: [...prev.extraRows, { key: '', value: '', loaded: true }],
                        }));
                      },
                    },
                    h(Icon, { name: 'Plus', className: 'size-3' }),
                    '添加字段',
                  ),
                ),
                form.extraRows.length === 0
                  ? h(
                      'p',
                      { className: 'text-[11px] text-muted-foreground' },
                      '可附加租户 ID、工作区编码、PIN 等自定义字段。',
                    )
                  : h(
                      'div',
                      { className: 'flex flex-col gap-1.5' },
                      ...form.extraRows.map((row, idx) =>
                        h(
                          'div',
                          { key: idx, className: 'flex items-center gap-1.5' },
                          h(Input, {
                            value: row.key,
                            placeholder: '字段名（如 tenant）',
                            className: 'w-36 font-mono text-xs',
                            onChange: (event) => {
                              setExtraDirty(true);
                              const val = event.target.value;
                              setForm((prev) => ({
                                ...prev,
                                extraRows: prev.extraRows.map((r, i) =>
                                  i === idx ? { ...r, key: val, loaded: true } : r,
                                ),
                              }));
                            },
                          }),
                          h(Input, {
                            value: row.value,
                            placeholder: row.loaded ? '字段值' : '读取原值中…',
                            className: 'min-w-0 flex-1 font-mono text-xs',
                            onChange: (event) => {
                              setExtraDirty(true);
                              const val = event.target.value;
                              setForm((prev) => ({
                                ...prev,
                                extraRows: prev.extraRows.map((r, i) =>
                                  i === idx ? { ...r, value: val, loaded: true } : r,
                                ),
                              }));
                            },
                          }),
                          h(
                            IconButton,
                            {
                              type: 'button',
                              size: 'icon-xs',
                              title: '删除此字段',
                              onClick: () => {
                                setExtraDirty(true);
                                setForm((prev) => ({
                                  ...prev,
                                  extraRows: prev.extraRows.filter((_, i) => i !== idx),
                                }));
                              },
                            },
                            h(Icon, { name: 'X' }),
                          ),
                        ),
                      ),
                    ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  return { AccountDetailView, AccountEditorView };
}
