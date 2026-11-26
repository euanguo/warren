/**
 * 账号管理 UI 共享常量、纯格式化 helper、TOTP Hook、明文警告条、密码生成器与填充调度 Hook。
 */
export function createAccountUiContext(app) {
  const { h, React, ui, rpc, host, shell, useSignal } = app;
  const { useCallback, useEffect, useState } = React;
  const {
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
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
    Field,
    FieldDescription,
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
    Separator,
    Spinner,
    Switch,
    Textarea,
    cardSurfaceClass,
    cn,
  } = ui;

  // ---------------------------------------------------------------------------
  // 常量与通用工具
  // ---------------------------------------------------------------------------

  const REASON_LABELS = {
    'exact-origin': '精确站点',
    'exact-host-port': '同主机端口',
    'exact-host': '同域名',
    'extra-url-origin': '附加网址精确',
    'extra-url-host': '附加网址同域',
    'same-domain': '同主域',
    'allowed-host': '白名单域',
    'alias-host': '别名域名',
    'alias-match': '别名命中',
    'preferred-env': '绑定环境',
    pinned: '置顶',
    frequent: '常用',
    recent: '最近使用',
    'query-match': '关键词',
  };

  const STEP_META = {
    single: { label: '账号 + 密码', cls: 'bg-[var(--success)]/15 text-[var(--success)]' },
    'username-only': { label: '仅账号（两步登录）', cls: 'bg-[var(--info)]/15 text-[var(--info)]' },
    'password-only': { label: '仅密码', cls: 'bg-[var(--info)]/15 text-[var(--info)]' },
    'totp-only': { label: '仅验证码 / TOTP', cls: 'bg-[var(--warning)]/15 text-[var(--warning)]' },
    none: { label: '未发现登录框', cls: 'bg-surface-fog text-subtle-foreground' },
  };

  const SORT_OPTIONS = [
    { value: 'updated', label: '最近更新' },
    { value: 'recent', label: '最近使用' },
    { value: 'frequent', label: '常用优先' },
    { value: 'name', label: '名称排序' },
  ];

  const IMPORT_FORMAT_OPTIONS = [
    { value: 'auto', label: '自动识别（JSON / CSV）' },
    { value: 'json', label: 'Warren JSON' },
    { value: 'csv', label: '通用 CSV' },
    { value: 'chrome-csv', label: 'Chrome 导出 CSV' },
  ];

  const IMPORT_STRATEGY_OPTIONS = [
    { value: 'skip', label: '跳过重复项' },
    { value: 'overwrite', label: '覆盖已有账号' },
    { value: 'duplicate', label: '保留副本' },
  ];

  const FIELD_LABELS = {
    username: '账号输入框',
    password: '密码输入框',
    totp: 'TOTP / 验证码框',
    submit: '登录 / 提交按钮',
  };

  function hostOf(rawUrl) {
    if (!rawUrl) return '';
    try {
      return new URL(rawUrl).hostname.toLowerCase();
    } catch {
      return String(rawUrl).toLowerCase();
    }
  }

  function hostWithPortOf(rawUrl) {
    if (!rawUrl) return '';
    try {
      return new URL(rawUrl).host.toLowerCase();
    } catch {
      return hostOf(rawUrl);
    }
  }

  function tagsOf(value) {
    return String(value || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  function splitListText(value) {
    const seen = new Set();
    const out = [];
    for (const item of String(value || '').split(/[\n,]+/)) {
      const s = item.trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  function formatSelectorTarget(target) {
    if (!target) return '';
    if (typeof target === 'string') return target;
    try {
      return JSON.stringify(target);
    } catch {
      return String(target);
    }
  }

  function formatTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getFullYear() === now.getFullYear()) {
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function formatTotpCode(code) {
    const raw = String(code || '');
    if (raw.length === 6) return `${raw.slice(0, 3)} ${raw.slice(3)}`;
    if (raw.length === 8) return `${raw.slice(0, 4)} ${raw.slice(4)}`;
    return raw;
  }

  function isCrossOriginError(err) {
    const code = String((err && err.code) || '').toUpperCase();
    const msg = String((err && err.message) || err || '');
    return (
      code.includes('DOMAIN') ||
      code.includes('ORIGIN') ||
      code.includes('HOST') ||
      code === 'PATH_DENIED' ||
      /跨站|白名单|allowedDomains|域名不匹配|domain/i.test(msg)
    );
  }

  function spaceLabel(space) {
    return space === 'agent' ? 'Agent 空间' : '我的空间';
  }

  async function copyText(text, label) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      shell.notify('success', `已复制${label}`);
      return true;
    } catch (err) {
      shell.notify('error', `复制${label}失败`, String((err && err.message) || err));
      return false;
    }
  }

  function sortLabelOf(value) {
    return SORT_OPTIONS.find((item) => item.value === value)?.label || '最近更新';
  }

  function parseSelectorInput(rawText) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // 解析失败时按普通 CSS 选择器字符串处理
      }
    }
    return trimmed;
  }

  // ---------------------------------------------------------------------------
  // 共享 Hooks 与复用组件（TOTP / 明文警告 / 密码生成器 / 自动填充）
  // ---------------------------------------------------------------------------

  function useTotp(accountId, enabled) {
    const [state, setState] = useState({
      code: '',
      period: 30,
      remaining: 0,
      loading: false,
      error: '',
    });

    const fetchCode = useCallback(async () => {
      if (!enabled || !accountId) return;
      setState((prev) => ({ ...prev, loading: !prev.code, error: '' }));
      try {
        const res = await rpc.call('totpCode', { id: accountId });
        setState({
          code: String(res?.code || ''),
          period: Number(res?.period || 30) || 30,
          remaining: Number(res?.remainingSeconds || 30) || 30,
          loading: false,
          error: '',
        });
      } catch (err) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: String((err && err.message) || err),
        }));
      }
    }, [accountId, enabled]);

    useEffect(() => {
      if (!enabled || !accountId) {
        setState({ code: '', period: 30, remaining: 0, loading: false, error: '' });
        return undefined;
      }
      void fetchCode();
      const timer = window.setInterval(() => {
        setState((prev) => {
          if (!prev.code) return prev;
          if (prev.remaining <= 1) {
            void fetchCode();
            return { ...prev, remaining: 0 };
          }
          return { ...prev, remaining: prev.remaining - 1 };
        });
      }, 1000);
      return () => window.clearInterval(timer);
    }, [accountId, enabled, fetchCode]);

    return { ...state, refresh: fetchCode };
  }

  function TotpLiveBar({ accountId, compact = false }) {
    const totp = useTotp(accountId, Boolean(accountId));
    const pct = totp.period > 0 ? Math.max(0, Math.min(100, Math.round((totp.remaining / totp.period) * 100))) : 0;
    const expiring = totp.remaining > 0 && totp.remaining <= 5;

    if (totp.error) {
      return h(
        'div',
        { className: 'rounded-[var(--radius-sm)] bg-destructive/10 px-2 py-1 text-[11px] text-destructive' },
        `TOTP 异常：${totp.error}`,
      );
    }

    return h(
      'button',
      {
        type: 'button',
        title: '点击复制动态验证码',
        onClick: () => void copyText(totp.code, '动态验证码'),
        disabled: !totp.code,
        className: cn(
          'group/totp flex w-full flex-col gap-1 rounded-[var(--radius-sm)] border border-border/80 bg-surface-fog text-left transition-colors hover:bg-surface-hover',
          compact ? 'px-2 py-1' : 'px-3 py-2',
        ),
      },
      h(
        'div',
        { className: 'flex items-center justify-between gap-2' },
        h(
          'span',
          { className: 'flex items-center gap-1.5 text-[11px] text-muted-foreground' },
          h(Icon, { name: 'Key', className: 'size-3 text-[var(--theme-accent)]' }),
          '动态码',
        ),
        h(
          'span',
          {
            className: cn(
              'font-mono font-semibold tracking-wider tabular-nums',
              compact ? 'text-sm' : 'text-base',
              expiring ? 'text-[var(--warning)]' : 'text-foreground',
            ),
          },
          totp.loading && !totp.code ? '••••••' : formatTotpCode(totp.code || '------'),
        ),
        h(
          'span',
          {
            className: cn(
              'flex items-center gap-1 font-mono text-[11px] tabular-nums',
              expiring ? 'text-[var(--warning)]' : 'text-muted-foreground',
            ),
          },
          totp.code ? `${totp.remaining}s` : '—',
          h(Icon, {
            name: 'Copy',
            className: 'size-3 opacity-60 transition-opacity group-hover/totp:opacity-100',
          }),
        ),
      ),
      h(
        'div',
        { className: 'h-1 w-full overflow-hidden rounded-full bg-border/80' },
        h('div', {
          className: cn(
            'h-full rounded-full transition-[width] duration-700 ease-linear',
            expiring ? 'bg-[var(--warning)]' : 'bg-[var(--theme-accent)]',
          ),
          style: { width: `${pct}%` },
        }),
      ),
    );
  }

  function PlaintextWarning({ compact = false, className = '' }) {
    return h(
      'div',
      {
        'data-slot': 'account-plaintext-warning',
        className: cn(
          'flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-lg)] border border-[var(--warning)]/35 bg-[var(--warning)]/10 text-[var(--warning)]',
          compact ? 'px-2.5 py-2 text-[11px] leading-snug' : 'px-3 py-2 text-xs leading-relaxed',
          className,
        ),
      },
      h(
        'div',
        { className: 'flex min-w-0 flex-1 items-start gap-2' },
        h(Icon, { name: 'Shield', className: cn('shrink-0', compact ? 'mt-0.5 size-3.5' : 'mt-0.5 size-4') }),
        h(
          'p',
          { className: 'min-w-0 flex-1' },
          compact
            ? '本插件以明文保存账号密码于本地，仅放测试或低敏感账号；Agent 通道不暴露明文密码与验证码。'
            : '明文存储边界：本插件把账号、密码、TOTP 密钥及备注以明文保存在本地数据库，仅建议存放测试或低敏感账号；高权限或生产核心凭据请勿放入。',
        ),
      ),
      h(
        Button,
        {
          size: 'xs',
          variant: 'outline',
          className: 'shrink-0 border-[var(--warning)]/40 text-foreground',
          onClick: () => shell.openSettings?.('vault'),
        },
        h(Icon, { name: 'Key', className: 'size-3.5' }),
        compact ? '加密 Vault' : '前往加密 Vault',
      ),
    );
  }

  function PasswordGeneratorPanel({ onApply, compact = false }) {
    const [length, setLength] = useState(20);
    const [uppercase, setUppercase] = useState(true);
    const [lowercase, setLowercase] = useState(true);
    const [numbers, setNumbers] = useState(true);
    const [symbols, setSymbols] = useState(true);
    const [excludeAmbiguous, setExcludeAmbiguous] = useState(true);
    const [preview, setPreview] = useState('');
    const [busy, setBusy] = useState(false);

    const generate = useCallback(async () => {
      if (!uppercase && !lowercase && !numbers && !symbols) {
        shell.notify('error', '至少选择一种字符集');
        return '';
      }
      setBusy(true);
      try {
        const res = await rpc.call('generatePassword', {
          length,
          uppercase,
          lowercase,
          numbers,
          symbols,
          excludeAmbiguous,
        });
        const pwd = String(res?.password || '');
        setPreview(pwd);
        return pwd;
      } catch (err) {
        shell.notify('error', '生成密码失败', String((err && err.message) || err));
        return '';
      } finally {
        setBusy(false);
      }
    }, [length, uppercase, lowercase, numbers, symbols, excludeAmbiguous]);

    useEffect(() => {
      void generate();
    }, [generate]);

    const toggleBox = (label, checked, onChange) =>
      h(
        'label',
        { className: 'flex cursor-pointer items-center gap-1.5 text-xs text-foreground select-none' },
        h(Checkbox, { checked, onCheckedChange: (next) => onChange(Boolean(next)) }),
        h('span', null, label),
      );

    return h(
      'div',
      {
        className: cn(
          cardSurfaceClass,
          'flex flex-col gap-2.5 bg-surface-fog',
          compact ? 'p-2.5 text-xs' : 'p-3 text-xs',
        ),
      },
      h(
        'div',
        { className: 'flex items-center justify-between gap-2' },
        h(
          'span',
          { className: 'flex items-center gap-1.5 font-medium text-foreground' },
          h(Icon, { name: 'Sparkles', className: 'size-3.5 text-[var(--theme-accent)]' }),
          '强密码生成器',
        ),
        h(
          'div',
          { className: 'flex items-center gap-1' },
          h(
            IconButton,
            {
              size: 'icon-xs',
              title: '重新生成',
              disabled: busy,
              onClick: () => void generate(),
            },
            h(Icon, { name: 'Refresh' }),
          ),
          h(
            IconButton,
            {
              size: 'icon-xs',
              title: '复制生成密码',
              disabled: !preview,
              onClick: () => void copyText(preview, '生成密码'),
            },
            h(Icon, { name: 'Copy' }),
          ),
        ),
      ),
      h(
        'div',
        {
          className:
            'rounded-[var(--radius-sm)] border border-border bg-background px-2.5 py-1.5 font-mono text-xs break-all text-foreground',
        },
        preview || '生成中…',
      ),
      h(
        'div',
        { className: 'flex items-center gap-2' },
        h('span', { className: 'shrink-0 text-muted-foreground' }, `长度 ${length}`),
        h('input', {
          type: 'range',
          min: 8,
          max: 64,
          value: length,
          onChange: (event) => setLength(Number(event.target.value) || 20),
          className: 'h-1.5 flex-1 accent-[var(--theme-accent)]',
        }),
      ),
      h(
        'div',
        { className: 'flex flex-wrap gap-x-3 gap-y-1.5' },
        toggleBox('大写 A-Z', uppercase, setUppercase),
        toggleBox('小写 a-z', lowercase, setLowercase),
        toggleBox('数字 0-9', numbers, setNumbers),
        toggleBox('符号 !@#', symbols, setSymbols),
        toggleBox('排除易混字符', excludeAmbiguous, setExcludeAmbiguous),
      ),
      onApply
        ? h(
            'div',
            { className: 'flex justify-end' },
            h(
              Button,
              {
                size: 'sm',
                disabled: !preview || busy,
                onClick: () => onApply(preview),
              },
              '填入密码框',
            ),
          )
        : null,
    );
  }

  function useAutoFillRunner(environmentId, space, onSuccess) {
    const [busyKey, setBusyKey] = useState('');
    const [crossOriginCandidate, setCrossOriginCandidate] = useState(null);

    const runFill = useCallback(
      async (account, { submit = false, allowCrossOrigin = false } = {}) => {
        if (!environmentId) {
          shell.notify('error', '未选中运行中的环境', '请先选择并启动一个环境后再填充');
          return false;
        }
        const key = `${account.id}:${submit ? 'submit' : 'fill'}`;
        setBusyKey(key);
        try {
          const res = await rpc.call('autoFill', {
            id: account.id,
            environmentId,
            space,
            submit,
            ...(allowCrossOrigin ? { allowCrossOrigin: true } : {}),
          });
          setCrossOriginCandidate(null);
          const filledText = Array.isArray(res?.filled) && res.filled.length ? res.filled.join(' / ') : '凭据';
          const submitSuffix = res?.submitted ? '并已提交登录' : '';
          shell.notify('success', `已填充「${account.name}」${submitSuffix}`, `填入字段：${filledText}`);
          if (res?.manualVerificationHint) {
            shell.notify('info', '需人工验证配合', res.manualVerificationHint);
          }
          onSuccess?.(res, account);
          return true;
        } catch (err) {
          if (!allowCrossOrigin && isCrossOriginError(err)) {
            setCrossOriginCandidate({
              accountId: account.id,
              submit,
              message: String((err && err.message) || err),
            });
            shell.notify('info', '站点与账号白名单不一致', '可在卡片中确认「仍要填到此页（允许跨站）」');
          } else {
            shell.notify('error', submit ? '填充并登录失败' : '一键填充失败', String((err && err.message) || err));
          }
          return false;
        } finally {
          setBusyKey('');
        }
      },
      [environmentId, space, onSuccess],
    );

    return { busyKey, crossOriginCandidate, setCrossOriginCandidate, runFill };
  }

  // ---------------------------------------------------------------------------
  // 面 1：statusBadge（地址栏微标 —— 禁止内嵌 <button>）
  // ---------------------------------------------------------------------------

  return {
    app,
    h,
    React,
    ui,
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
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
    Field,
    FieldDescription,
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
    Separator,
    Spinner,
    Switch,
    Textarea,
    cardSurfaceClass,
    cn,
    REASON_LABELS,
    STEP_META,
    SORT_OPTIONS,
    IMPORT_FORMAT_OPTIONS,
    IMPORT_STRATEGY_OPTIONS,
    FIELD_LABELS,
    hostOf,
    hostWithPortOf,
    tagsOf,
    splitListText,
    formatSelectorTarget,
    formatTime,
    formatTotpCode,
    isCrossOriginError,
    spaceLabel,
    copyText,
    sortLabelOf,
    parseSelectorInput,
    useTotp,
    TotpLiveBar,
    PlaintextWarning,
    PasswordGeneratorPanel,
    useAutoFillRunner,
  };
}
