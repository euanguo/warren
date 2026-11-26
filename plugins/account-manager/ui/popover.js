/**
 * 地址栏匹配微标（statusBadge）与快捷填充/新增浮窗（popover）。
 */
export function createPopoverViews(ctx) {
  const {
    h,
    React,
    rpc,
    host,
    shell,
    useSignal,
    Badge,
    Button,
    Field,
    FieldLabel,
    Icon,
    IconButton,
    Input,
    Spinner,
    cardSurfaceClass,
    cn,
    REASON_LABELS,
    hostOf,
    hostWithPortOf,
    tagsOf,
    spaceLabel,
    copyText,
    TotpLiveBar,
    PlaintextWarning,
    useAutoFillRunner,
  } = ctx;
  const { useCallback, useEffect, useRef, useState } = React;
  function MatchStatusBadge({ environmentId, url, space }) {
    const [count, setCount] = useState(0);
    const [tick, setTick] = useState(0);

    useSignal(
      'changed',
      useCallback(() => setTick((n) => n + 1), []),
    );

    useEffect(() => {
      if (!environmentId && !url) {
        setCount(0);
        return undefined;
      }
      let cancelled = false;
      rpc
        .call('match', {
          ...(url ? { url } : {}),
          ...(environmentId ? { environmentId } : {}),
          ...(space ? { space } : {}),
          limit: 20,
        })
        .then((res) => {
          if (!cancelled) setCount(Array.isArray(res?.matches) ? res.matches.length : 0);
        })
        .catch(() => {
          if (!cancelled) setCount(0);
        });
      return () => {
        cancelled = true;
      };
    }, [environmentId, url, space, tick]);

    return h(
      'span',
      {
        className: 'inline-flex items-center gap-1.5',
        'data-slot': 'account-match-badge',
        'data-match-count': String(count),
      },
      h(Icon, {
        name: 'User',
        style: { '--brand-hue': 36 },
        className: cn('plugin-brand-icon size-3.5 shrink-0', count === 0 && 'opacity-75'),
      }),
      count > 0
        ? h(
            'span',
            {
              className:
                'inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--theme-accent)]/20 px-1 font-mono text-[length:var(--font-size-micro)] font-semibold leading-none tabular-nums text-foreground',
            },
            count > 99 ? '99+' : String(count),
          )
        : null,
    );
  }

  // ---------------------------------------------------------------------------
  // 面 2：popover（地址栏快捷填充浮窗）
  // ---------------------------------------------------------------------------

  function QuickCreateInPopover({ currentUrl, onCreated, onCancel }) {
    const initialHost = hostOf(currentUrl);
    const [name, setName] = useState(initialHost || '');
    const [url, setUrl] = useState(currentUrl || '');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [totpSecret, setTotpSecret] = useState('');
    const [busy, setBusy] = useState(false);

    const handleGenPassword = async () => {
      try {
        const res = await rpc.call('generatePassword', { length: 18, excludeAmbiguous: true });
        if (res?.password) setPassword(res.password);
      } catch (err) {
        shell.notify('error', '生成密码失败', String((err && err.message) || err));
      }
    };

    const submit = async (event) => {
      event.preventDefault();
      if (!name.trim()) return;
      setBusy(true);
      try {
        await rpc.call('create', {
          name: name.trim(),
          url: url.trim(),
          username: username.trim(),
          password,
          ...(totpSecret.trim() ? { totpSecret: totpSecret.trim() } : {}),
        });
        shell.notify('success', `已新增账号「${name.trim()}」`);
        onCreated();
      } catch (err) {
        shell.notify('error', '新增账号失败', String((err && err.message) || err));
      } finally {
        setBusy(false);
      }
    };

    return h(
      'form',
      { onSubmit: submit, className: 'flex flex-col gap-2.5 p-3' },
      h(
        'div',
        { className: 'flex items-center justify-between' },
        h('span', { className: 'text-xs font-medium text-foreground' }, '为当前站点快速新建账号'),
        h(Button, { type: 'button', size: 'xs', variant: 'ghost', onClick: onCancel }, '返回列表'),
      ),
      h(PlaintextWarning, { compact: true }),
      h(
        Field,
        null,
        h(FieldLabel, { className: 'text-xs' }, '站点名称'),
        h(Input, {
          value: name,
          placeholder: '例如：公司后台',
          onChange: (event) => setName(event.target.value),
        }),
      ),
      h(
        Field,
        null,
        h(FieldLabel, { className: 'text-xs' }, '网址'),
        h(Input, {
          value: url,
          placeholder: 'https://example.com/login',
          onChange: (event) => setUrl(event.target.value),
        }),
      ),
      h(
        Field,
        null,
        h(FieldLabel, { className: 'text-xs' }, '账号 / 邮箱'),
        h(Input, {
          value: username,
          autoComplete: 'off',
          placeholder: 'username / email',
          onChange: (event) => setUsername(event.target.value),
        }),
      ),
      h(
        Field,
        null,
        h(FieldLabel, { className: 'text-xs' }, '密码'),
        h(
          'div',
          { className: 'flex items-center gap-1.5' },
          h(Input, {
            value: password,
            autoComplete: 'off',
            placeholder: '输入或随机生成',
            className: 'min-w-0 flex-1 font-mono',
            onChange: (event) => setPassword(event.target.value),
          }),
          h(
            Button,
            { type: 'button', size: 'sm', variant: 'secondary', onClick: () => void handleGenPassword() },
            h(Icon, { name: 'Sparkles', className: 'size-3.5' }),
            '生成',
          ),
        ),
      ),
      h(
        Field,
        null,
        h(FieldLabel, { className: 'text-xs' }, 'TOTP 密钥（可选）'),
        h(Input, {
          value: totpSecret,
          autoComplete: 'off',
          placeholder: 'Base32 密钥或 otpauth:// URI',
          className: 'font-mono text-xs',
          onChange: (event) => setTotpSecret(event.target.value),
        }),
      ),
      h(
        'div',
        { className: 'flex justify-end gap-2 pt-1' },
        h(Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: onCancel }, '取消'),
        h(Button, { type: 'submit', size: 'sm', disabled: busy || !name.trim() }, busy ? '保存中…' : '保存账号'),
      ),
    );
  }

  function QuickAutofillPopover({
    environmentId,
    space = 'person',
    url = '',
    closePopover,
    openPluginPage,
    openInspectorTab,
  }) {
    const [resolvedUrl, setResolvedUrl] = useState(url);
    const [query, setQuery] = useState('');
    const [showAll, setShowAll] = useState(false);
    const [creating, setCreating] = useState(false);
    const [matches, setMatches] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const [tick, setTick] = useState(0);
    const searchRef = useRef(null);

    useSignal(
      'changed',
      useCallback(() => setTick((n) => n + 1), []),
    );

    useEffect(() => {
      setResolvedUrl(url || '');
      if (url || !environmentId) return;
      let cancelled = false;
      host.browser
        .info(environmentId, { space })
        .then((info) => {
          if (!cancelled && info?.url) setResolvedUrl(info.url);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [url, environmentId, space]);

    const loadMatches = useCallback(async () => {
      setLoading(true);
      try {
        const res = await rpc.call('match', {
          ...(resolvedUrl ? { url: resolvedUrl } : {}),
          ...(environmentId ? { environmentId } : {}),
          ...(space ? { space } : {}),
          ...(query.trim() ? { query: query.trim() } : {}),
          includeUnmatched: showAll,
          limit: 30,
        });
        const list = Array.isArray(res?.matches) ? res.matches : [];
        setMatches(list);
        if (res?.url && !resolvedUrl) setResolvedUrl(res.url);
        setActiveIndex(0);
        setError('');
      } catch (err) {
        setError(String((err && err.message) || err));
      } finally {
        setLoading(false);
      }
    }, [resolvedUrl, environmentId, space, query, showAll]);

    useEffect(() => {
      void loadMatches();
    }, [loadMatches, tick]);

    useEffect(() => {
      if (!creating) searchRef.current?.focus();
    }, [creating]);

    const { busyKey, crossOriginCandidate, runFill } = useAutoFillRunner(environmentId, space, () => {
      closePopover?.();
    });

    const revealAndCopyPassword = async (account) => {
      try {
        const res = await rpc.call('reveal', { id: account.id, field: 'password' });
        await copyText(String(res?.value || ''), '密码');
      } catch (err) {
        shell.notify('error', '读取密码失败', String((err && err.message) || err));
      }
    };

    const currentHost = hostWithPortOf(resolvedUrl);

    const onSearchKeyDown = (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (matches.length > 0) setActiveIndex((idx) => (idx + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (matches.length > 0) setActiveIndex((idx) => (idx <= 0 ? matches.length - 1 : idx - 1));
        return;
      }
      if (event.key === 'Enter' && matches.length > 0) {
        event.preventDefault();
        const chosen = matches[activeIndex] || matches[0];
        if (chosen) void runFill(chosen.account, { submit: event.metaKey || event.shiftKey });
        return;
      }
      if (event.key === 'Escape') {
        if (query) {
          event.preventDefault();
          setQuery('');
          return;
        }
        closePopover?.();
      }
    };

    if (creating) {
      return h(QuickCreateInPopover, {
        currentUrl: resolvedUrl,
        onCreated: () => {
          setCreating(false);
          setTick((n) => n + 1);
        },
        onCancel: () => setCreating(false),
      });
    }

    return h(
      'div',
      {
        className: 'flex h-full min-h-0 flex-col',
        'data-slot': 'account-quick-popover',
      },
      // 顶部站点上下文与搜索
      h(
        'div',
        { className: 'flex shrink-0 flex-col gap-2 border-b border-divider p-2.5' },
        h(
          'div',
          { className: 'flex items-center gap-1.5 text-[11px]' },
          h(Icon, { name: 'Globe', className: 'size-3.5 shrink-0 text-muted-foreground' }),
          h(
            'span',
            { className: 'min-w-0 flex-1 truncate font-mono text-foreground' },
            currentHost || '当前环境未打开网页',
          ),
          h(
            Badge,
            {
              variant: space === 'agent' ? 'secondary' : 'outline',
              className: 'h-4 px-1.5 text-[length:var(--font-size-micro)]',
            },
            spaceLabel(space),
          ),
          h(
            Button,
            {
              size: 'xs',
              variant: 'ghost',
              onClick: () => setCreating(true),
            },
            h(Icon, { name: 'Plus', className: 'size-3' }),
            '新建',
          ),
        ),
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
              ref: searchRef,
              value: query,
              placeholder: '搜索站点、账号、标签…',
              className: 'pl-8 text-xs',
              onKeyDown: onSearchKeyDown,
              onChange: (event) => setQuery(event.target.value),
            }),
          ),
          h(
            Button,
            {
              size: 'xs',
              variant: showAll ? 'secondary' : 'ghost',
              title: showAll ? '只看当前站点匹配' : '显示全部账号',
              onClick: () => setShowAll((prev) => !prev),
            },
            showAll ? '仅匹配' : '全部',
          ),
        ),
      ),
      // 列表主体
      h(
        'div',
        { className: 'min-h-0 flex-1 overflow-y-auto p-2.5' },
        error ? h('p', { className: 'mb-2 text-xs text-destructive' }, error) : null,
        loading && matches.length === 0
          ? h(
              'div',
              { className: 'flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground' },
              h(Spinner),
              '正在匹配当前站点账号…',
            )
          : matches.length === 0
            ? h(
                'div',
                { className: 'flex flex-col items-center justify-center gap-2.5 py-8 text-center' },
                h(Icon, { name: 'Key', className: 'size-6 text-muted-foreground' }),
                h('p', { className: 'text-xs font-medium text-foreground' }, '当前站点暂无匹配账号'),
                h(
                  'p',
                  { className: 'max-w-56 text-[11px] leading-relaxed text-muted-foreground' },
                  currentHost
                    ? `未找到匹配 ${currentHost} 的凭据，可以直接新建或切换查看全部账号。`
                    : '你可以从全部账号中搜索，或先打开登录页后再使用快捷填充。',
                ),
                h(
                  'div',
                  { className: 'flex flex-wrap justify-center gap-1.5' },
                  h(
                    Button,
                    { size: 'xs', onClick: () => setCreating(true) },
                    h(Icon, { name: 'Plus', className: 'size-3' }),
                    '为当前站点新建账号',
                  ),
                  !showAll
                    ? h(Button, { size: 'xs', variant: 'secondary', onClick: () => setShowAll(true) }, '从全部账号搜索')
                    : null,
                ),
              )
            : h(
                'div',
                { className: 'flex flex-col gap-2 pb-2' },
                ...matches.map((item, idx) => {
                  const account = item.account;
                  const rawReasons = Array.isArray(item.reasons) ? item.reasons : [];
                  // 命中精确站点或同主机时不再重复显示冗余的「同主域」
                  const hasExact = rawReasons.includes('exact-origin') || rawReasons.includes('exact-host');
                  const reasons = hasExact ? rawReasons.filter((r) => r !== 'same-domain') : rawReasons;
                  const isFocused = idx === activeIndex;
                  const filling = busyKey === `${account.id}:fill`;
                  const submitting = busyKey === `${account.id}:submit`;
                  const showCrossConfirm = crossOriginCandidate && crossOriginCandidate.accountId === account.id;

                  return h(
                    'div',
                    {
                      key: account.id,
                      onMouseEnter: () => setActiveIndex(idx),
                      className: cn(
                        cardSurfaceClass,
                        'flex flex-col gap-2 p-2.5 transition-colors',
                        isFocused ? 'border-focus bg-surface-selected' : 'bg-card',
                      ),
                    },
                    // 头部信息行
                    h(
                      'div',
                      { className: 'flex items-start gap-1.5' },
                      h(
                        'div',
                        { className: 'min-w-0 flex-1' },
                        h(
                          'div',
                          { className: 'flex items-center gap-1.5' },
                          account.pinned
                            ? h(Icon, { name: 'Zap', className: 'size-3 shrink-0 text-[var(--warning)]' })
                            : null,
                          h('span', { className: 'truncate text-xs font-medium text-foreground' }, account.name),
                          account.hasTotp
                            ? h(
                                Badge,
                                {
                                  variant: 'outline',
                                  className:
                                    'h-4 bg-[var(--theme-accent)]/12 px-1 text-[length:var(--font-size-micro)] text-[var(--theme-accent)]',
                                },
                                '2FA',
                              )
                            : null,
                        ),
                        h(
                          'div',
                          { className: 'mt-0.5 flex items-center gap-1.5' },
                          h(
                            'span',
                            { className: 'truncate font-mono text-[11px] text-muted-foreground' },
                            account.username || account.usernameHint || '（无用户名）',
                          ),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'flex shrink-0 items-center gap-0.5' },
                        account.username
                          ? h(
                              IconButton,
                              {
                                size: 'icon-xs',
                                title: '复制账号',
                                'aria-label': '复制账号',
                                onClick: () => void copyText(account.username, '账号'),
                              },
                              h(Icon, { name: 'Copy' }),
                            )
                          : null,
                        account.hasPassword
                          ? h(
                              IconButton,
                              {
                                size: 'icon-xs',
                                title: '复制密码',
                                'aria-label': '复制密码',
                                onClick: () => void revealAndCopyPassword(account),
                              },
                              h(Icon, { name: 'Lock' }),
                            )
                          : null,
                      ),
                    ),
                    // 匹配原因微标签 + 标签
                    reasons.length > 0 || tagsOf(account.tags).length > 0
                      ? h(
                          'div',
                          { className: 'flex flex-wrap items-center gap-1' },
                          ...reasons.slice(0, 2).map((r) =>
                            h(
                              Badge,
                              {
                                key: `r-${r}`,
                                variant: 'secondary',
                                className: 'h-4 px-1.5 text-[length:var(--font-size-micro)]',
                              },
                              REASON_LABELS[r] || r,
                            ),
                          ),
                          ...tagsOf(account.tags)
                            .slice(0, 2)
                            .map((t) =>
                              h(
                                Badge,
                                {
                                  key: `t-${t}`,
                                  variant: 'outline',
                                  className: 'h-4 px-1.5 text-[length:var(--font-size-micro)]',
                                },
                                t,
                              ),
                            ),
                        )
                      : null,
                    // 实时 TOTP 倒计时
                    account.hasTotp ? h(TotpLiveBar, { accountId: account.id, compact: true }) : null,
                    // 跨站白名单二次确认条
                    showCrossConfirm
                      ? h(
                          'div',
                          {
                            className:
                              'flex flex-col gap-1.5 rounded-[var(--radius-sm)] border border-[var(--warning)]/35 bg-[var(--warning)]/10 p-2 text-[11px] text-[var(--warning)]',
                          },
                          h('span', null, '当前页面不在该账号允许域名内：'),
                          h(
                            'div',
                            { className: 'flex justify-end gap-1.5' },
                            h(
                              Button,
                              {
                                size: 'xs',
                                variant: 'secondary',
                                onClick: () =>
                                  void runFill(account, {
                                    submit: crossOriginCandidate.submit,
                                    allowCrossOrigin: true,
                                  }),
                              },
                              '仍要填到此页（允许跨站）',
                            ),
                          ),
                        )
                      : null,
                    // 主操作按钮组
                    h(
                      'div',
                      { className: 'flex items-center gap-1.5 pt-0.5' },
                      h(
                        Button,
                        {
                          size: 'xs',
                          variant: isFocused ? 'default' : 'secondary',
                          className: 'flex-1',
                          disabled: !environmentId || Boolean(busyKey),
                          onClick: () => void runFill(account, { submit: false }),
                        },
                        filling ? '填充中…' : '一键填充',
                      ),
                      h(
                        Button,
                        {
                          size: 'xs',
                          variant: 'outline',
                          disabled: !environmentId || Boolean(busyKey),
                          onClick: () => void runFill(account, { submit: true }),
                        },
                        submitting ? '登录中…' : '填充并登录',
                      ),
                    ),
                  );
                }),
              ),
      ),
      // 底部快捷栏
      h(
        'div',
        {
          className:
            'flex shrink-0 items-center justify-between gap-2 border-t border-divider px-2.5 py-1.5 text-[11px]',
        },
        h('span', { className: 'truncate text-muted-foreground' }, '↑↓ 选择 · Enter 填充'),
        h(
          'div',
          { className: 'flex shrink-0 items-center gap-1' },
          h(
            Button,
            {
              size: 'xs',
              variant: 'ghost',
              onClick: () => openInspectorTab?.('site-accounts'),
            },
            '工作台探测',
          ),
          h(
            Button,
            {
              size: 'xs',
              variant: 'ghost',
              onClick: () => openPluginPage?.('accounts'),
            },
            '全部管理',
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 面 3：inspectorTab（右侧工作台随页：当前页账号 + 表单探测 + 选择器绑定）
  // ---------------------------------------------------------------------------

  return { MatchStatusBadge, QuickAutofillPopover };
}
