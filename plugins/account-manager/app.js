/**
 * 账号管理插件前端。
 *
 * 明文是产品要求，不是遗漏：界面必须一直显示这个边界。
 */
export default function register(app) {
  const { h, React, ui } = app;
  const { useCallback, useEffect, useState } = React;
  const {
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
    Separator,
    Textarea,
    cardSurfaceClass,
    cn,
    toast,
  } = ui;

  const EMPTY_DRAFT = {
    name: '',
    url: '',
    username: '',
    password: '',
    note: '',
    tags: '',
  };

  function tagsOf(value) {
    return String(value || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  async function copy(text, label) {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    toast.success(`已复制${label}`);
  }

  function AccountDialog({ open, onOpenChange, editing, busy, save }) {
    const [draft, setDraft] = useState(EMPTY_DRAFT);

    /*
     * 编辑时密码不在 list 结果里（后端只给 hasPassword），要显示原值得单独 reveal。
     * 读不到就留空：保存时按「不修改」处理，绝不把空串写回去。
     */
    useEffect(() => {
      if (!open) return;
      if (!editing) {
        setDraft(EMPTY_DRAFT);
        return;
      }
      setDraft({
        name: editing.name,
        url: editing.url,
        username: editing.username,
        password: '',
        note: editing.note,
        tags: editing.tags,
      });
      if (!editing.hasPassword) return;
      let cancelled = false;
      app.rpc
        .call('reveal', { id: editing.id, field: 'password' })
        .then((result) => {
          if (!cancelled) setDraft((current) => ({ ...current, password: String(result?.value ?? '') }));
        })
        .catch(() => {
          // 只有插件界面能 reveal；失败时留空，用户不填就不会覆盖原密码
        });
      return () => {
        cancelled = true;
      };
    }, [open, editing]);

    const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
    const submit = async () => {
      if (!draft.name.trim()) return;
      // 编辑时留空 = 不修改：不能把空串当成新密码写回去
      const { password, ...rest } = draft;
      const payload = editing ? { ...rest, id: editing.id, ...(password ? { password } : {}) } : draft;
      const ok = await save(payload);
      if (ok) onOpenChange(false);
    };

    return h(
      Dialog,
      { open, onOpenChange },
      h(
        DialogContent,
        null,
        h(
          'div',
          { className: 'flex flex-col gap-4', 'data-slot': 'account-editor' },
          h(
            DialogHeader,
            null,
            h(DialogTitle, null, editing ? '编辑账号' : '新增账号'),
            h(DialogDescription, null, '账号、密码和备注都会以明文保存在本机插件数据库。'),
          ),
          h(
            'div',
            { className: 'grid gap-4 sm:grid-cols-2' },
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: 'account-name' }, '站点 / 名称'),
              h(Input, {
                id: 'account-name',
                value: draft.name,
                placeholder: '例如：测试后台',
                onChange: (event) => set('name', event.target.value),
              }),
            ),
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: 'account-url' }, '地址'),
              h(Input, {
                id: 'account-url',
                value: draft.url,
                placeholder: 'https://example.test/login',
                onChange: (event) => set('url', event.target.value),
              }),
            ),
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: 'account-username' }, '账号'),
              h(Input, {
                id: 'account-username',
                value: draft.username,
                autoComplete: 'off',
                onChange: (event) => set('username', event.target.value),
              }),
            ),
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: 'account-password' }, '密码'),
              h(Input, {
                id: 'account-password',
                value: draft.password,
                type: 'text',
                autoComplete: 'off',
                onChange: (event) => set('password', event.target.value),
              }),
            ),
          ),
          h(
            Field,
            null,
            h(FieldLabel, { htmlFor: 'account-note' }, '备注'),
            h(Textarea, {
              id: 'account-note',
              className: 'min-h-24',
              value: draft.note,
              placeholder: '用途、角色、注意事项…',
              onChange: (event) => set('note', event.target.value),
            }),
          ),
          h(
            Field,
            null,
            h(FieldLabel, { htmlFor: 'account-tags' }, '标签'),
            h(Input, {
              id: 'account-tags',
              value: draft.tags,
              placeholder: '逗号分隔，例如：测试, 管理后台',
              onChange: (event) => set('tags', event.target.value),
            }),
            h(FieldDescription, null, '搜索会同时匹配名称、地址、账号、备注和标签。'),
          ),
          h(
            DialogFooter,
            null,
            h(Button, { variant: 'ghost', onClick: () => onOpenChange(false) }, '取消'),
            h(Button, { disabled: busy || !draft.name.trim(), onClick: submit }, editing ? '保存' : '新增'),
          ),
        ),
      ),
    );
  }

  function AccountCard({ account, busy, edit, remove }) {
    const [revealed, setRevealed] = useState(false);
    // 明文只在这一张卡片里、由用户点开时才取一次；后端只对插件界面（caller=ui）开放 reveal
    const [secret, setSecret] = useState('');
    const tags = tagsOf(account.tags);

    const revealPassword = useCallback(async () => {
      const result = await app.rpc.call('reveal', { id: account.id, field: 'password' });
      const value = String(result?.value ?? '');
      setSecret(value);
      return value;
    }, [account.id]);

    const toggle = async () => {
      if (revealed) {
        setRevealed(false);
        return;
      }
      try {
        if (!secret) await revealPassword();
        setRevealed(true);
      } catch (err) {
        toast.error('读取密码失败', { description: String(err.message || err) });
      }
    };

    const copyPassword = async () => {
      try {
        await copy(secret || (await revealPassword()), '密码');
      } catch (err) {
        toast.error('复制密码失败', { description: String(err.message || err) });
      }
    };

    return h(
      'div',
      {
        className: cn(cardSurfaceClass, 'flex flex-col gap-3'),
        'data-slot': 'account-card',
        'data-id': String(account.id),
      },
      h(
        'div',
        { className: 'flex items-start gap-3' },
        h(
          'div',
          { className: 'flex min-w-0 flex-1 flex-col gap-1' },
          h(
            'div',
            { className: 'flex flex-wrap items-center gap-2' },
            h('span', { className: 'truncate text-sm font-medium' }, account.name),
            ...tags.map((tag) => h(Badge, { key: tag, variant: 'outline' }, tag)),
          ),
          account.url
            ? h(
                'a',
                { className: 'truncate text-xs text-muted-foreground hover:underline', href: account.url },
                account.url,
              )
            : null,
        ),
        h(
          'div',
          { className: 'flex shrink-0 gap-1' },
          h(
            IconButton,
            { 'aria-label': '编辑账号', title: '编辑', disabled: busy, onClick: () => edit(account) },
            h(Icon, { name: 'Pencil' }),
          ),
          h(
            IconButton,
            { 'aria-label': '删除账号', title: '删除', disabled: busy, onClick: () => remove(account) },
            h(Icon, { name: 'Trash' }),
          ),
        ),
      ),
      h(Separator),
      h(
        'div',
        { className: 'grid gap-2 text-xs sm:grid-cols-[8rem_minmax(0,1fr)]' },
        h('span', { className: 'text-muted-foreground' }, '账号'),
        h(
          'div',
          { className: 'flex min-w-0 items-center gap-1' },
          h('span', { className: 'truncate font-mono' }, account.username || '—'),
          account.username
            ? h(
                IconButton,
                {
                  size: 'icon-xs',
                  'aria-label': '复制账号',
                  title: '复制账号',
                  onClick: () => copy(account.username, '账号'),
                },
                h(Icon, { name: 'Copy' }),
              )
            : null,
        ),
        h('span', { className: 'text-muted-foreground' }, '密码'),
        h(
          'div',
          { className: 'flex min-w-0 items-center gap-1' },
          h('span', { className: 'min-w-0 flex-1 break-all font-mono' }, revealed ? secret || '—' : '••••••••'),
          h(
            Button,
            { size: 'sm', variant: 'ghost', disabled: !account.hasPassword, onClick: toggle },
            revealed ? '隐藏' : '显示',
          ),
          h(
            IconButton,
            {
              size: 'icon-xs',
              'aria-label': '复制密码',
              title: '复制密码',
              disabled: !account.hasPassword,
              onClick: copyPassword,
            },
            h(Icon, { name: 'Copy' }),
          ),
        ),
      ),
      account.note
        ? h(
            'div',
            { className: 'flex flex-col gap-1' },
            h('span', { className: 'text-xs text-muted-foreground' }, '备注'),
            h('p', { className: 'whitespace-pre-wrap text-xs leading-relaxed' }, account.note),
          )
        : null,
    );
  }

  function AccountsPage() {
    const [state, setState] = useState({ accounts: [] });
    const [query, setQuery] = useState('');
    const [tag, setTag] = useState('');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    const [editing, setEditing] = useState(null);
    const [deleting, setDeleting] = useState(null);

    const load = useCallback(() => {
      app.rpc
        .call('list', { query, tag })
        .then((next) => {
          setState(next);
          setError(null);
        })
        .catch((err) => setError(String(err.message || err)));
    }, [query, tag]);

    useEffect(() => {
      load();
    }, [load]);
    app.useSignal('changed', load);

    const run = useCallback(async (work, failure) => {
      setBusy(true);
      try {
        const result = await work();
        if (result && Array.isArray(result.accounts)) setState(result);
        setError(null);
        return result;
      } catch (err) {
        toast.error(failure, { description: String(err.message || err) });
        return null;
      } finally {
        setBusy(false);
      }
    }, []);

    const save = (draft) =>
      run(() => app.rpc.call(draft.id ? 'update' : 'create', draft), draft.id ? '保存失败' : '新增失败');

    const remove = async () => {
      if (!deleting) return;
      const result = await run(() => app.rpc.call('remove', { id: deleting.id }), '删除失败');
      if (result) setDeleting(null);
    };

    return h(
      'div',
      {
        className: 'flex h-full flex-col gap-3 overflow-auto',
        style: { maxWidth: '1040px', marginInline: 'auto', width: '100%', padding: '16px 24px' },
        'data-slot': 'account-manager-page',
      },
      h(
        'div',
        { className: 'flex flex-wrap items-center gap-2' },
        h('span', { className: 'text-sm font-medium' }, '账号管理'),
        h('span', { className: 'text-xs text-muted-foreground' }, `${state.accounts.length} 条 · 本机明文`),
        h(
          Button,
          {
            className: 'ml-auto',
            onClick: () => {
              setEditing(null);
              setEditorOpen(true);
            },
          },
          h(Icon, { name: 'Plus' }),
          '新增账号',
        ),
      ),
      h(
        'div',
        {
          className: cn(
            cardSurfaceClass,
            'flex flex-wrap items-center justify-between gap-2 border-[var(--warning)]/35 bg-[var(--warning)]/10 text-xs text-[var(--warning)]',
          ),
          'data-slot': 'account-plaintext-warning',
        },
        h(
          'div',
          { className: 'flex min-w-0 flex-1 items-start gap-2' },
          h(Icon, { name: 'Shield', className: 'mt-0.5 shrink-0' }),
          h('p', null, '账号与密码以本机明文保存，仅存放测试或低敏感账号；生产/高权限凭据请使用加密 Vault。'),
        ),
        h(
          Button,
          {
            size: 'xs',
            variant: 'outline',
            className: 'shrink-0 border-[var(--warning)]/35 text-foreground',
            onClick: () => app.navigation?.openSettings?.('vault'),
          },
          h(Icon, { name: 'Key', className: 'size-3.5' }),
          '前往加密 Vault',
        ),
      ),
      h(
        'div',
        { className: 'flex flex-wrap items-center gap-2' },
        h(
          'div',
          { className: 'relative min-w-48 flex-1' },
          h(Icon, {
            name: 'Search',
            className: 'pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground',
          }),
          h(Input, {
            className: 'pl-8',
            value: query,
            placeholder: '搜索名称、地址、账号、备注、标签',
            onChange: (event) => setQuery(event.target.value),
          }),
        ),
        h(Input, {
          className: 'w-40',
          value: tag,
          placeholder: '标签',
          onChange: (event) => setTag(event.target.value),
        }),
        h(
          Button,
          { variant: 'outline', size: 'sm', onClick: load },
          h(Icon, { name: 'Refresh', className: 'size-3.5' }),
          '刷新',
        ),
      ),
      error ? h('p', { className: 'text-xs text-destructive' }, error) : null,
      state.accounts.length === 0
        ? h(
            Empty,
            null,
            h(
              EmptyHeader,
              null,
              h(EmptyMedia, { variant: 'icon' }, h(Icon, { name: 'User' })),
              h(EmptyTitle, null, '还没有账号'),
              h(EmptyDescription, null, '新增测试站点账号，后续可在任意环境侧栏一键填充。'),
            ),
            h(
              EmptyContent,
              null,
              h(
                Button,
                {
                  onClick: () => {
                    setEditing(null);
                    setEditorOpen(true);
                  },
                },
                h(Icon, { name: 'Plus' }),
                '新增第一个测试账号',
              ),
            ),
          )
        : h(
            'div',
            { className: 'flex flex-col gap-2', 'data-slot': 'account-list' },
            ...state.accounts.map((account) =>
              h(AccountCard, {
                key: account.id,
                account,
                busy,
                edit: (item) => {
                  setEditing(item);
                  setEditorOpen(true);
                },
                remove: setDeleting,
              }),
            ),
          ),
      h(AccountDialog, {
        open: editorOpen,
        onOpenChange: setEditorOpen,
        editing,
        busy,
        save,
      }),
      h(
        AlertDialog,
        { open: Boolean(deleting), onOpenChange: (open) => !open && setDeleting(null) },
        h(
          AlertDialogContent,
          null,
          h(
            AlertDialogHeader,
            null,
            h(AlertDialogTitle, null, `删除「${deleting?.name ?? ''}」？`),
            h(AlertDialogDescription, null, '账号、密码和备注会一起删掉，无法撤销。'),
          ),
          h(
            AlertDialogFooter,
            null,
            h(AlertDialogCancel, null, '取消'),
            h(AlertDialogAction, { disabled: busy, onClick: remove }, '删除'),
          ),
        ),
      ),
    );
  }

  function hostOf(rawUrl) {
    if (!rawUrl) return '';
    try {
      return new URL(rawUrl).hostname.toLowerCase();
    } catch {
      return String(rawUrl).toLowerCase();
    }
  }

  function AccountsInspectorTab({ environmentId }) {
    const [accounts, setAccounts] = useState([]);
    const [pageUrl, setPageUrl] = useState('');
    const [busyId, setBusyId] = useState(null);
    const [error, setError] = useState(null);

    const load = useCallback(() => {
      app.rpc
        .call('list', {})
        .then((next) => {
          setAccounts(Array.isArray(next?.accounts) ? next.accounts : []);
          setError(null);
        })
        .catch((err) => setError(String(err.message || err)));
    }, []);

    useEffect(() => {
      load();
    }, [load]);
    app.useSignal('changed', load);

    useEffect(() => {
      if (!environmentId) return undefined;
      let cancelled = false;
      app.host.environment
        .get(environmentId)
        .then((env) => {
          if (!cancelled) setPageUrl(env?.currentUrl || '');
        })
        .catch(() => {
          if (!cancelled) setPageUrl('');
        });
      return () => {
        cancelled = true;
      };
    }, [environmentId]);

    const currentHost = hostOf(pageUrl);
    const sorted = [...accounts].sort((a, b) => {
      const am =
        currentHost && hostOf(a.url) && (currentHost.includes(hostOf(a.url)) || hostOf(a.url).includes(currentHost))
          ? 1
          : 0;
      const bm =
        currentHost && hostOf(b.url) && (currentHost.includes(hostOf(b.url)) || hostOf(b.url).includes(currentHost))
          ? 1
          : 0;
      return bm - am;
    });

    const quickFill = async (account) => {
      if (!environmentId) return;
      setBusyId(account.id);
      try {
        const fields = {};
        if (account.username) {
          fields.username =
            'input[type="email"], input[name*="user" i], input[name*="account" i], input[name*="login" i], input[type="text"]';
        }
        if (account.hasPassword) {
          fields.password = 'input[type="password"]';
        }
        const res = await app.rpc.call('fill', { id: account.id, environmentId, fields });
        toast.success(`已向当前页直填 ${res?.filled?.join(' / ') || '凭据'}`);
      } catch (err) {
        toast.error('直填失败（请确认页面存在登录输入框）', { description: String(err.message || err) });
      } finally {
        setBusyId(null);
      }
    };

    return h(
      'div',
      { className: 'flex flex-col gap-2.5 text-xs', 'data-slot': 'account-inspector' },
      h(
        'div',
        {
          className: cn(
            cardSurfaceClass,
            'flex flex-col gap-1.5 border-[var(--warning)]/35 bg-[var(--warning)]/10 text-[length:var(--font-size-micro)] text-[var(--warning)]',
          ),
          'data-slot': 'account-plaintext-warning',
        },
        h(
          'div',
          { className: 'flex items-start gap-2' },
          h(Icon, { name: 'Shield', className: 'mt-0.5 size-3.5 shrink-0' }),
          h('p', null, '本机明文保存，仅存测试账号；Agent 仅见打码信息。'),
        ),
        h(
          Button,
          {
            size: 'xs',
            variant: 'ghost',
            className: 'h-6 self-start px-1.5 text-[length:var(--font-size-micro)] text-foreground',
            onClick: () => app.navigation?.openSettings?.('vault'),
          },
          h(Icon, { name: 'Key', className: 'size-3' }),
          '高敏凭据改用加密 Vault →',
        ),
      ),
      currentHost
        ? h(
            'div',
            { className: 'flex items-center justify-between gap-2 text-[length:var(--font-size-micro)]' },
            h('span', { className: 'text-muted-foreground' }, '当前站点'),
            h('span', { className: 'truncate font-mono text-foreground' }, currentHost),
          )
        : null,
      error ? h('p', { className: 'text-destructive' }, error) : null,
      sorted.length === 0
        ? h(
            'div',
            { className: cn(cardSurfaceClass, 'flex flex-col gap-2 py-2.5') },
            h('span', { className: 'font-medium text-foreground' }, '还没有可用账号'),
            h(
              'p',
              { className: 'text-[length:var(--font-size-micro)] leading-relaxed text-muted-foreground' },
              '新增测试账号后，可在此按当前站点一键直填登录表单。',
            ),
            h(
              Button,
              {
                size: 'sm',
                className: 'mt-0.5 self-start',
                'data-slot': 'accounts-open-global-cta',
                onClick: () => app.navigation?.openPage?.('accounts'),
              },
              h(Icon, { name: 'Plus', className: 'size-3.5' }),
              '新增测试账号',
            ),
          )
        : h(
            'div',
            { className: 'flex flex-col gap-2' },
            ...sorted.slice(0, 12).map((account) => {
              const matched = Boolean(
                currentHost &&
                hostOf(account.url) &&
                (currentHost.includes(hostOf(account.url)) || hostOf(account.url).includes(currentHost)),
              );
              return h(
                'div',
                { key: account.id, className: cn(cardSurfaceClass, 'flex flex-col gap-1.5 py-2') },
                h(
                  'div',
                  { className: 'flex items-center gap-1.5' },
                  h('span', { className: 'truncate font-medium text-foreground' }, account.name),
                  matched ? h(Badge, { variant: 'secondary', className: 'ml-auto shrink-0' }, '匹配当前站') : null,
                ),
                h(
                  'span',
                  { className: 'truncate font-mono text-[11px] text-muted-foreground' },
                  account.usernameHint || account.username || '—',
                ),
                h(
                  'div',
                  { className: 'flex items-center gap-1.5 pt-0.5' },
                  h(
                    Button,
                    {
                      size: 'xs',
                      disabled: !environmentId || busyId === account.id,
                      onClick: () => void quickFill(account),
                    },
                    busyId === account.id ? '填充中…' : '一键直填',
                  ),
                  account.username
                    ? h(
                        Button,
                        {
                          size: 'xs',
                          variant: 'ghost',
                          onClick: () => void copy(account.username, '账号'),
                        },
                        '复制账号',
                      )
                    : null,
                ),
              );
            }),
          ),
    );
  }

  app.surfaces.railPage({ id: 'accounts', title: '账号', icon: 'User', path: 'accounts', component: AccountsPage });
  app.surfaces.inspectorTab({ id: 'site-accounts', title: '账号', component: AccountsInspectorTab });
}
