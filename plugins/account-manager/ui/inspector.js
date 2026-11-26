/**
 * 右侧工作台随页账号检测与一键填充侧栏（inspectorTab）。
 */
export function createInspectorViews(ctx) {
  const {
    h,
    React,
    rpc,
    host,
    shell,
    useSignal,
    Badge,
    Button,
    Icon,
    IconButton,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Separator,
    cardSurfaceClass,
    cn,
    REASON_LABELS,
    STEP_META,
    FIELD_LABELS,
    hostWithPortOf,
    formatSelectorTarget,
    copyText,
    TotpLiveBar,
    PlaintextWarning,
    useAutoFillRunner,
  } = ctx;
  const { useCallback, useEffect, useState } = React;
  function AccountsInspectorTab({ environmentId, space = 'person', url = '', openPluginPage }) {
    const [matches, setMatches] = useState([]);
    const [allAccounts, setAllAccounts] = useState([]);
    const [showUnmatched, setShowUnmatched] = useState(false);
    const [pageUrl, setPageUrl] = useState(url);
    const [detected, setDetected] = useState(null);
    const [detectBusy, setDetectBusy] = useState(false);
    const [saveBusy, setSaveBusy] = useState(false);
    const [targetAccountId, setTargetAccountId] = useState('');
    const [highlightedKey, setHighlightedKey] = useState('');
    const [error, setError] = useState('');
    const [tick, setTick] = useState(0);

    useSignal(
      'changed',
      useCallback(() => setTick((n) => n + 1), []),
    );

    useEffect(() => {
      setPageUrl(url || '');
      if (url || !environmentId) return;
      let cancelled = false;
      host.browser
        .info(environmentId, { space })
        .then((info) => {
          if (!cancelled && info?.url) setPageUrl(info.url);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [url, environmentId, space]);

    const loadData = useCallback(async () => {
      try {
        const [matchRes, listRes] = await Promise.all([
          rpc.call('match', {
            ...(pageUrl ? { url: pageUrl } : {}),
            ...(environmentId ? { environmentId } : {}),
            ...(space ? { space } : {}),
            includeUnmatched: false,
            limit: 12,
          }),
          rpc.call('list', {}),
        ]);
        const nextMatches = Array.isArray(matchRes?.matches) ? matchRes.matches : [];
        const nextAll = Array.isArray(listRes?.accounts) ? listRes.accounts : [];
        setMatches(nextMatches);
        setAllAccounts(nextAll);
        if (matchRes?.url && !pageUrl) setPageUrl(matchRes.url);
        setTargetAccountId((prev) => {
          if (prev && nextAll.some((a) => String(a.id) === prev)) return prev;
          if (nextMatches[0]?.account?.id) return String(nextMatches[0].account.id);
          if (nextAll[0]?.id) return String(nextAll[0].id);
          return '';
        });
        setError('');
      } catch (err) {
        setError(String((err && err.message) || err));
      }
    }, [pageUrl, environmentId, space]);

    useEffect(() => {
      void loadData();
    }, [loadData, tick]);

    const { busyKey, crossOriginCandidate, runFill } = useAutoFillRunner(environmentId, space);

    const runDetect = useCallback(async () => {
      if (!environmentId) {
        shell.notify('error', '请先选择并启动环境');
        return;
      }
      setDetectBusy(true);
      try {
        const res = await rpc.call('detectFields', { environmentId, space });
        setDetected(res);
        if (res?.url) setPageUrl(res.url);
        const count = res?.fields ? Object.keys(res.fields).length : 0;
        if (count > 0) {
          shell.notify('success', `探测完成，识别出 ${count} 个登录控件`);
        } else {
          shell.notify('info', '未探测到明显登录框', '请确认当前标签页已加载登录表单');
        }
      } catch (err) {
        shell.notify('error', '表单探测失败', String((err && err.message) || err));
      } finally {
        setDetectBusy(false);
      }
    }, [environmentId, space]);

    const highlightField = async (key, target) => {
      if (!environmentId || !target) return;
      try {
        await shell.highlight(environmentId, target, space);
        setHighlightedKey(key);
      } catch (err) {
        shell.notify('error', '高亮定位失败', String((err && err.message) || err));
      }
    };

    const clearHighlight = async () => {
      if (!environmentId) return;
      try {
        await shell.highlight(environmentId, undefined, space);
        setHighlightedKey('');
      } catch (err) {
        shell.notify('error', '清除高亮失败', String((err && err.message) || err));
      }
    };

    const saveDetectedSelectors = async () => {
      if (!targetAccountId || !detected?.fields) return;
      const selectors = {};
      for (const k of ['username', 'password', 'totp', 'submit']) {
        const f = detected.fields[k];
        if (f && (f.target || f.selector)) {
          selectors[k] = f.target ?? f.selector;
        }
      }
      if (Object.keys(selectors).length === 0) {
        shell.notify('info', '没有可保存的字段选择器');
        return;
      }
      setSaveBusy(true);
      try {
        await rpc.call('saveSelectors', { id: Number(targetAccountId), selectors });
        const acc = allAccounts.find((a) => String(a.id) === targetAccountId);
        shell.notify('success', `已将选择器模板保存到「${acc?.name || targetAccountId}」`);
        setTick((n) => n + 1);
      } catch (err) {
        shell.notify('error', '保存选择器模板失败', String((err && err.message) || err));
      } finally {
        setSaveBusy(false);
      }
    };

    const copyPassword = async (account) => {
      try {
        const res = await rpc.call('reveal', { id: account.id, field: 'password' });
        await copyText(String(res?.value || ''), '密码');
      } catch (err) {
        shell.notify('error', '读取密码失败', String((err && err.message) || err));
      }
    };

    const currentHost = hostWithPortOf(pageUrl);
    const matchedIds = new Set(matches.map((m) => m.account.id));
    const displayList = showUnmatched
      ? [
          ...matches,
          ...allAccounts.filter((a) => !matchedIds.has(a.id)).map((account) => ({ account, score: 0, reasons: [] })),
        ]
      : matches;
    const targetAccountName = allAccounts.find((a) => String(a.id) === targetAccountId)?.name || '选择目标账号';
    const stepMeta = detected ? STEP_META[detected.step] || STEP_META.none : null;
    const detectedEntries = detected?.fields
      ? ['username', 'password', 'totp', 'submit']
          .filter((k) => Boolean(detected.fields[k]))
          .map((k) => [k, detected.fields[k]])
      : [];

    return h(
      'div',
      { className: 'flex flex-col gap-3 pb-14 text-xs', 'data-slot': 'account-inspector' },
      h(PlaintextWarning, { compact: true }),
      h(
        'div',
        { className: 'flex items-center justify-between gap-2' },
        h(
          'div',
          { className: 'flex min-w-0 items-center gap-1.5 text-muted-foreground' },
          h(Icon, { name: 'Globe', className: 'size-3.5 shrink-0' }),
          h('span', { className: 'truncate font-mono text-[11px]' }, currentHost || '未打开网页'),
        ),
        h(
          Button,
          {
            size: 'xs',
            variant: 'ghost',
            onClick: () => openPluginPage?.('accounts'),
          },
          '全部账号',
          h(Icon, { name: 'ExternalLink', className: 'size-3' }),
        ),
      ),
      error ? h('p', { className: 'text-xs text-destructive' }, error) : null,

      // 上半区：当前页匹配账号
      h(
        'div',
        { className: 'flex flex-col gap-2' },
        h(
          'div',
          { className: 'flex items-center justify-between' },
          h('span', { className: 'font-medium text-foreground' }, `当前页匹配账号（${matches.length}）`),
          allAccounts.length > matches.length
            ? h(
                Button,
                {
                  size: 'xs',
                  variant: 'ghost',
                  onClick: () => setShowUnmatched((prev) => !prev),
                },
                showUnmatched ? '收起其他' : `显示全部 (${allAccounts.length})`,
              )
            : null,
        ),
        displayList.length === 0
          ? h(
              'div',
              { className: cn(cardSurfaceClass, 'flex flex-col gap-1.5 py-3 text-muted-foreground') },
              h('span', { className: 'font-medium text-foreground' }, '当前站点暂无匹配账号'),
              h(
                'p',
                { className: 'text-[11px] leading-relaxed' },
                '可在地址栏点账号快捷图标（⇧⌘L）新建，或打开全屏「账号」页管理。',
              ),
            )
          : h(
              'div',
              { className: 'flex flex-col gap-2' },
              ...displayList.slice(0, 10).map((item) => {
                const account = item.account;
                const reasons = Array.isArray(item.reasons) ? item.reasons : [];
                const isSelectedTarget = String(account.id) === targetAccountId;
                const showCrossConfirm = crossOriginCandidate && crossOriginCandidate.accountId === account.id;
                return h(
                  'div',
                  {
                    key: account.id,
                    className: cn(
                      cardSurfaceClass,
                      'flex flex-col gap-1.5 p-2.5',
                      isSelectedTarget && 'border-focus/60',
                    ),
                  },
                  h(
                    'div',
                    { className: 'flex items-center gap-1.5' },
                    account.pinned
                      ? h(Icon, { name: 'Zap', className: 'size-3 shrink-0 text-[var(--warning)]' })
                      : null,
                    h('span', { className: 'min-w-0 flex-1 truncate font-medium text-foreground' }, account.name),
                    reasons[0]
                      ? h(
                          Badge,
                          { variant: 'secondary', className: 'h-4 px-1.5 text-[length:var(--font-size-micro)]' },
                          REASON_LABELS[reasons[0]] || reasons[0],
                        )
                      : null,
                  ),
                  h(
                    'div',
                    { className: 'flex items-center justify-between gap-1' },
                    h(
                      'span',
                      { className: 'truncate font-mono text-[11px] text-muted-foreground' },
                      account.username || account.usernameHint || '—',
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
                              onClick: () => void copyPassword(account),
                            },
                            h(Icon, { name: 'Lock' }),
                          )
                        : null,
                    ),
                  ),
                  account.hasTotp ? h(TotpLiveBar, { accountId: account.id, compact: true }) : null,
                  showCrossConfirm
                    ? h(
                        'div',
                        {
                          className:
                            'flex items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-[var(--warning)]/10 px-2 py-1 text-[11px] text-[var(--warning)]',
                        },
                        h('span', null, '跨站拦截'),
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
                          '允许跨站填充',
                        ),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'flex flex-wrap items-center gap-1.5 pt-0.5' },
                    h(
                      Button,
                      {
                        size: 'xs',
                        variant: isSelectedTarget ? 'default' : 'secondary',
                        disabled: !environmentId || Boolean(busyKey),
                        onClick: () => void runFill(account, { submit: false }),
                      },
                      busyKey === `${account.id}:fill` ? '填充中…' : '一键填充',
                    ),
                    h(
                      Button,
                      {
                        size: 'xs',
                        variant: 'outline',
                        disabled: !environmentId || Boolean(busyKey),
                        onClick: () => void runFill(account, { submit: true }),
                      },
                      busyKey === `${account.id}:submit` ? '登录中…' : '填充并登录',
                    ),
                    isSelectedTarget
                      ? h(
                          Badge,
                          { variant: 'secondary', className: 'ml-auto text-[length:var(--font-size-micro)]' },
                          '当前绑定目标',
                        )
                      : h(
                          Button,
                          {
                            size: 'xs',
                            variant: 'outline',
                            className: 'ml-auto',
                            onClick: () => setTargetAccountId(String(account.id)),
                          },
                          '设为绑定目标',
                        ),
                  ),
                );
              }),
            ),
      ),

      h(Separator),

      // 下半区：页面登录表单探测 + 高亮 + 选择器绑定
      h(
        'div',
        { className: 'flex flex-col gap-2' },
        h(
          'div',
          { className: 'flex items-center justify-between gap-1.5' },
          h('span', { className: 'font-medium text-foreground' }, '表单探测与选择器绑定'),
          h(
            'div',
            { className: 'flex items-center gap-1' },
            highlightedKey
              ? h(Button, { size: 'xs', variant: 'ghost', onClick: () => void clearHighlight() }, '清除高亮')
              : null,
            h(
              Button,
              {
                size: 'xs',
                variant: 'secondary',
                disabled: !environmentId || detectBusy,
                onClick: () => void runDetect(),
              },
              h(Icon, { name: 'Search', className: 'size-3' }),
              detectBusy ? '探测中…' : '探测登录框',
            ),
          ),
        ),
        !detected
          ? h(
              'p',
              { className: 'text-[11px] leading-relaxed text-muted-foreground' },
              '在隔离世界中无侵入扫描当前页（含 Shadow DOM 与 iframe）登录表单，并支持高亮定位与保存选择器模板。',
            )
          : h(
              'div',
              { className: cn(cardSurfaceClass, 'flex flex-col gap-2.5 p-2.5') },
              h(
                'div',
                { className: 'flex flex-wrap items-center gap-1.5' },
                stepMeta
                  ? h(
                      Badge,
                      {
                        variant: 'outline',
                        className: cn('h-4 px-1.5 text-[length:var(--font-size-micro)]', stepMeta.cls),
                      },
                      stepMeta.label,
                    )
                  : null,
                detected.hasOtp
                  ? h(
                      Badge,
                      {
                        variant: 'outline',
                        className:
                          'h-4 bg-[var(--info)]/15 px-1.5 text-[length:var(--font-size-micro)] text-[var(--info)]',
                      },
                      '含 OTP/2FA',
                    )
                  : null,
                detected.hasCaptcha
                  ? h(
                      Badge,
                      {
                        variant: 'outline',
                        className:
                          'h-4 bg-[var(--warning)]/15 px-1.5 text-[length:var(--font-size-micro)] text-[var(--warning)]',
                      },
                      '含验证码提醒',
                    )
                  : null,
              ),
              detectedEntries.length === 0
                ? h('p', { className: 'text-[11px] text-muted-foreground' }, '当前页未识别到可见登录输入控件。')
                : h(
                    'div',
                    { className: 'flex flex-col gap-1.5' },
                    ...detectedEntries.map(([key, field]) => {
                      const target = field.target ?? field.selector;
                      const confidencePct =
                        typeof field.confidence === 'number' ? `${Math.round(field.confidence * 100)}%` : '';
                      const isHighlighted = highlightedKey === key;
                      return h(
                        'div',
                        {
                          key,
                          className:
                            'flex flex-col gap-1 rounded-[var(--radius-sm)] border border-border/70 bg-surface-fog px-2 py-1.5',
                        },
                        h(
                          'div',
                          { className: 'flex items-center justify-between gap-1.5' },
                          h(
                            'div',
                            { className: 'flex min-w-0 items-center gap-1.5' },
                            h('span', { className: 'font-medium text-foreground' }, FIELD_LABELS[key] || key),
                            confidencePct
                              ? h(
                                  'span',
                                  { className: 'font-mono text-[length:var(--font-size-micro)] text-muted-foreground' },
                                  confidencePct,
                                )
                              : null,
                            field.inCrossOriginFrame
                              ? h(
                                  Badge,
                                  { variant: 'outline', className: 'h-4 px-1 text-[length:var(--font-size-micro)]' },
                                  '跨源框',
                                )
                              : field.inShadow
                                ? h(
                                    Badge,
                                    { variant: 'outline', className: 'h-4 px-1 text-[length:var(--font-size-micro)]' },
                                    'Shadow',
                                  )
                                : null,
                          ),
                          h(
                            Button,
                            {
                              size: 'xs',
                              variant: isHighlighted ? 'secondary' : 'ghost',
                              onClick: () => void highlightField(key, target),
                            },
                            h(Icon, { name: 'Cursor', className: 'size-3' }),
                            isHighlighted ? '已高亮' : '高亮定位',
                          ),
                        ),
                        h(
                          'span',
                          {
                            className: 'truncate font-mono text-[length:var(--font-size-micro)] text-muted-foreground',
                            title: formatSelectorTarget(target),
                          },
                          formatSelectorTarget(target),
                        ),
                      );
                    }),
                  ),
              detectedEntries.length > 0 && allAccounts.length > 0
                ? h(
                    'div',
                    { className: 'flex flex-col gap-1.5 border-t border-divider pt-2' },
                    h('span', { className: 'text-[11px] text-muted-foreground' }, '绑定到账号选择器模板'),
                    h(
                      'div',
                      { className: 'flex items-center gap-1.5' },
                      h(
                        Select,
                        { value: targetAccountId, onValueChange: (val) => setTargetAccountId(String(val || '')) },
                        h(
                          SelectTrigger,
                          { size: 'sm', className: 'min-w-0 flex-1 text-xs' },
                          h(SelectValue, null, targetAccountName),
                        ),
                        h(
                          SelectContent,
                          null,
                          ...allAccounts.map((acc) => h(SelectItem, { key: acc.id, value: String(acc.id) }, acc.name)),
                        ),
                      ),
                      h(
                        Button,
                        {
                          size: 'xs',
                          className: 'px-2.5',
                          disabled: !targetAccountId || saveBusy,
                          onClick: () => void saveDetectedSelectors(),
                        },
                        saveBusy ? '保存中…' : '存为模板',
                      ),
                    ),
                  )
                : null,
            ),
      ),
    );
  }

  return { AccountsInspectorTab };
}
