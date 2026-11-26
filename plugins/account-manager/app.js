/**
 * 账号管理插件前端（4 面协同工作台）。
 *
 * 明文是明确产品定位，不是遗漏：界面必须持续展示明文风险提醒。
 * 注意：本文件为无构建步骤纯 ESM，禁止 JSX 与外部 import，仅使用 `app.h` 与 `app.ui`。
 */
export default function register(app) {
  const { h, React, ui, rpc, host, shell, useSignal } = app;
  const { useCallback, useEffect, useMemo, useRef, useState } = React;
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
    ListRowActionButton,
    ListRowActions,
    ListRowLabel,
    ListRowLabelText,
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
          'flex items-start gap-2 rounded-[var(--radius-lg)] border border-[var(--warning)]/35 bg-[var(--warning)]/10 text-[var(--warning)]',
          compact ? 'px-2.5 py-2 text-[11px] leading-snug' : 'px-3 py-2 text-xs leading-relaxed',
          className,
        ),
      },
      h(Icon, { name: 'Shield', className: cn('shrink-0', compact ? 'mt-0.5 size-3.5' : 'mt-0.5 size-4') }),
      h(
        'p',
        { className: 'min-w-0 flex-1' },
        compact
          ? '本插件以明文保存账号密码于本地，仅放测试或低敏感账号；Agent 通道不暴露明文密码与验证码。'
          : '明文存储边界：本插件把账号、密码、TOTP 密钥及备注以明文保存在本地数据库，仅建议存放测试或低敏感账号；高权限或生产核心凭据请勿放入。',
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
                size: 'xs',
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
        className: 'inline-flex items-center gap-1',
        'data-slot': 'account-match-badge',
        'data-match-count': String(count),
      },
      h(Icon, {
        name: 'Key',
        className: cn('size-3.5 shrink-0', count > 0 ? 'text-[var(--theme-accent)]' : 'text-current'),
      }),
      count > 0
        ? h(
            'span',
            {
              className:
                'inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--theme-accent)]/15 px-1 font-mono text-[10px] font-medium tabular-nums text-[var(--theme-accent)]',
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
            { variant: space === 'agent' ? 'secondary' : 'outline', className: 'h-4 px-1.5 text-[10px]' },
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
              className: 'h-7 min-h-7 pl-8 text-xs',
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
                { className: 'flex flex-col gap-2' },
                ...matches.map((item, idx) => {
                  const account = item.account;
                  const reasons = Array.isArray(item.reasons) ? item.reasons : [];
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
                                    'h-4 bg-[var(--theme-accent)]/12 px-1 text-[10px] text-[var(--theme-accent)]',
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
                          ...reasons
                            .slice(0, 2)
                            .map((r) =>
                              h(
                                Badge,
                                { key: `r-${r}`, variant: 'secondary', className: 'h-4 px-1.5 text-[10px]' },
                                REASON_LABELS[r] || r,
                              ),
                            ),
                          ...tagsOf(account.tags)
                            .slice(0, 2)
                            .map((t) =>
                              h(Badge, { key: `t-${t}`, variant: 'outline', className: 'h-4 px-1.5 text-[10px]' }, t),
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
                          variant: 'secondary',
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
      { className: 'flex flex-col gap-3 text-xs', 'data-slot': 'account-inspector' },
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
                '可在地址栏点钥匙快捷新建，或打开全屏「账号」页管理。',
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
                          { variant: 'secondary', className: 'h-4 px-1.5 text-[10px]' },
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
                    { className: 'flex flex-wrap items-center gap-1 pt-0.5' },
                    h(
                      Button,
                      {
                        size: 'xs',
                        disabled: !environmentId || Boolean(busyKey),
                        onClick: () => void runFill(account, { submit: false }),
                      },
                      busyKey === `${account.id}:fill` ? '填充中…' : '一键填充',
                    ),
                    h(
                      Button,
                      {
                        size: 'xs',
                        variant: 'secondary',
                        disabled: !environmentId || Boolean(busyKey),
                        onClick: () => void runFill(account, { submit: true }),
                      },
                      busyKey === `${account.id}:submit` ? '登录中…' : '填充并登录',
                    ),
                    h(
                      Button,
                      {
                        size: 'xs',
                        variant: 'ghost',
                        className: 'ml-auto',
                        onClick: () => setTargetAccountId(String(account.id)),
                      },
                      isSelectedTarget ? '已选定绑定' : '设为绑定目标',
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
                      { variant: 'outline', className: cn('h-4 px-1.5 text-[10px]', stepMeta.cls) },
                      stepMeta.label,
                    )
                  : null,
                detected.hasOtp
                  ? h(
                      Badge,
                      {
                        variant: 'outline',
                        className: 'h-4 bg-[var(--info)]/15 px-1.5 text-[10px] text-[var(--info)]',
                      },
                      '含 OTP/2FA',
                    )
                  : null,
                detected.hasCaptcha
                  ? h(
                      Badge,
                      {
                        variant: 'outline',
                        className: 'h-4 bg-[var(--warning)]/15 px-1.5 text-[10px] text-[var(--warning)]',
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
                              ? h('span', { className: 'font-mono text-[10px] text-muted-foreground' }, confidencePct)
                              : null,
                            field.inCrossOriginFrame
                              ? h(Badge, { variant: 'outline', className: 'h-4 px-1 text-[10px]' }, '跨源框')
                              : field.inShadow
                                ? h(Badge, { variant: 'outline', className: 'h-4 px-1 text-[10px]' }, 'Shadow')
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
                            className: 'truncate font-mono text-[10px] text-muted-foreground',
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
                          size: 'sm',
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

  // ---------------------------------------------------------------------------
  // 面 4：railPage（全屏 3 区主从分栏管理台）
  // ---------------------------------------------------------------------------

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
    loginProfile: '',
    expectedUin: '',
    appHintsText: '',
    manualVerificationHint: '',
    frameAwareFill: false,
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
      loginProfile: account.loginProfile || '',
      expectedUin: account.expectedUin || '',
      appHintsText: (account.appHints || []).join(', '),
      manualVerificationHint: account.manualVerificationHint || '',
      frameAwareFill: Boolean(account.frameAwareFill),
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
              h('span', { className: 'text-muted-foreground' }, '跨框填充'),
              h('span', { className: 'text-foreground' }, account.frameAwareFill ? '已启用（frameAwareFill）' : '默认'),
              account.loginProfile
                ? h(
                    React.Fragment,
                    null,
                    h('span', { className: 'text-muted-foreground' }, '登录配置档'),
                    h('span', { className: 'font-mono text-foreground' }, account.loginProfile),
                  )
                : null,
              account.expectedUin
                ? h(
                    React.Fragment,
                    null,
                    h('span', { className: 'text-muted-foreground' }, '预期 UIN'),
                    h('span', { className: 'font-mono text-foreground' }, account.expectedUin),
                  )
                : null,
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
        loginProfile: form.loginProfile.trim(),
        expectedUin: form.expectedUin.trim(),
        appHints: splitListText(form.appHintsText),
        manualVerificationHint: form.manualVerificationHint.trim(),
        frameAwareFill: Boolean(form.frameAwareFill),
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
                    h(FieldLabel, null, '登录配置档（loginProfile）'),
                    h(Input, {
                      value: form.loginProfile,
                      placeholder: '例如：sso / two-step',
                      onChange: (event) => setField('loginProfile', event.target.value),
                    }),
                  ),
                  h(
                    Field,
                    null,
                    h(FieldLabel, null, '预期 UIN（expectedUin）'),
                    h(Input, {
                      value: form.expectedUin,
                      className: 'font-mono text-xs',
                      onChange: (event) => setField('expectedUin', event.target.value),
                    }),
                  ),
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

                h(
                  'label',
                  { className: 'flex cursor-pointer items-center gap-2 text-xs text-foreground select-none' },
                  h(Switch, {
                    size: 'sm',
                    checked: form.frameAwareFill,
                    onCheckedChange: (next) => setField('frameAwareFill', Boolean(next)),
                  }),
                  '启用跨 iframe 感知填充（frameAwareFill）',
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
        if (isCrossOriginError(err)) {
          try {
            const res = await rpc.call('autoFill', {
              id: account.id,
              environmentId,
              space: space || 'person',
              submit: false,
              allowCrossOrigin: true,
            });
            shell.notify('success', `已跨站填充「${account.name}」`, `已填入：${res?.filled?.join(' / ') || '凭据'}`);
            return;
          } catch (retryErr) {
            shell.notify('error', '填充失败', String((retryErr && retryErr.message) || retryErr));
            return;
          }
        }
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
          h(Icon, { name: 'Key', className: 'size-4 text-[var(--theme-accent)]' }),
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
          { className: 'flex w-48 shrink-0 flex-col border-r border-divider bg-surface-under/40' },
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
                    className: 'h-7 min-h-7 pl-8 text-xs',
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
                    { className: 'flex flex-col gap-0.5 p-2', 'data-slot': 'account-list' },
                    ...visibleAccounts.map((account) => {
                      const selected = mode !== 'create' && selectedId === account.id;
                      const accTags = tagsOf(account.tags);
                      return h(
                        ListRow,
                        {
                          key: account.id,
                          selected,
                          className: 'h-auto min-h-[var(--control-height-compact)] py-1.5',
                          'data-slot': 'account-card',
                          'data-id': String(account.id),
                        },
                        h(
                          ListRowMain,
                          {
                            className: 'items-start',
                            onClick: () => {
                              setSelectedId(account.id);
                              setMode('view');
                            },
                          },
                          h(
                            'div',
                            { className: 'flex min-w-0 flex-1 flex-col gap-0.5' },
                            h(
                              'div',
                              { className: 'flex items-center gap-1.5' },
                              account.pinned
                                ? h(Icon, { name: 'Zap', className: 'size-3 shrink-0 text-[var(--warning)]' })
                                : null,
                              h(ListRowLabelText, { className: 'font-medium text-foreground' }, account.name),
                              account.hasTotp
                                ? h(
                                    Badge,
                                    {
                                      variant: 'outline',
                                      className:
                                        'h-4 shrink-0 bg-[var(--theme-accent)]/12 px-1 text-[10px] text-[var(--theme-accent)]',
                                    },
                                    '2FA',
                                  )
                                : null,
                            ),
                            h(
                              'div',
                              { className: 'flex items-center gap-1.5 text-[11px] text-muted-foreground' },
                              h('span', { className: 'truncate font-mono' }, account.username || '—'),
                              account.useCount > 0
                                ? h('span', { className: 'ml-auto shrink-0 tabular-nums' }, `${account.useCount}次`)
                                : null,
                            ),
                            accTags.length > 0
                              ? h(
                                  'div',
                                  { className: 'mt-0.5 flex flex-wrap gap-1' },
                                  ...accTags
                                    .slice(0, 2)
                                    .map((t) =>
                                      h(Badge, { key: t, variant: 'outline', className: 'h-4 px-1 text-[10px]' }, t),
                                    ),
                                  accTags.length > 2
                                    ? h(
                                        'span',
                                        { className: 'text-[10px] text-muted-foreground' },
                                        `+${accTags.length - 2}`,
                                      )
                                    : null,
                                )
                              : null,
                          ),
                        ),
                        filterMode === 'trash'
                          ? h(
                              ListRowActions,
                              { alwaysVisible: true },
                              h(
                                ListRowActionButton,
                                {
                                  title: '恢复',
                                  'aria-label': '恢复',
                                  onClick: () => void handleRestore(account),
                                },
                                h(Icon, { name: 'RotateClockwise' }),
                              ),
                              h(
                                ListRowActionButton,
                                {
                                  tone: 'destructive',
                                  title: '彻底删除',
                                  'aria-label': '彻底删除',
                                  onClick: () => setPurgingTarget(account),
                                },
                                h(Icon, { name: 'Trash' }),
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

  // ---------------------------------------------------------------------------
  // 注册全套协同 UI 面
  // ---------------------------------------------------------------------------

  app.surfaces.railPage({
    id: 'accounts',
    title: '账号',
    icon: 'User',
    path: 'accounts',
    component: AccountsPage,
  });

  app.surfaces.inspectorTab({
    id: 'site-accounts',
    title: '账号',
    component: AccountsInspectorTab,
  });

  app.surfaces.popover({
    id: 'quick-autofill',
    title: '快捷填充账号',
    icon: 'Key',
    shortcut: '⇧⌘L',
    width: 376,
    height: 440,
    component: QuickAutofillPopover,
  });

  app.surfaces.statusBadge({
    id: 'match-badge',
    title: '当前页匹配账号',
    icon: 'Key',
    component: MatchStatusBadge,
  });

  app.surfaces.commandBarAction({
    id: 'quick-fill',
    title: '一键填充当前页账号',
    description: '自动匹配当前站点并填充账号密码',
    icon: 'Key',
    shortcut: '⇧⌘L',
    command: 'autoFill',
  });
}
