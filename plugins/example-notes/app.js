/**
 * 记忆插件前端。
 *
 * 没有构建步骤：普通 ESM，由主进程经 `warren-plugin://com.example.notes/app.js` 供给。
 * React **和组件库**都由宿主注入（`app.React` / `app.h` / `app.ui`）——不要自带 React，
 * 也不要手写 chrome。清单见 `plugins/README.md`。
 *
 * 界面上的四件事：看（过滤 + 列表）、加、改、流转。给 agent 的那条路是命令 `context`，
 * 它回一份能直接塞进上下文的摘要 —— 那是这个插件存在的理由，不是这个面板。
 *
 * 新增用**行内 composer**（不弹窗）：它是高频动作、只有两三个字段；
 * 四个字段以上的、低频的（比如 whistle 的「新建实例」）才用 Dialog。
 */
export default function register(app) {
  const { h, React, ui } = app;
  const { useCallback, useEffect, useState } = React;
  const {
    Button,
    Input,
    Textarea,
    Checkbox,
    Badge,
    Field,
    FieldLabel,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Empty,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
    EmptyDescription,
    Icon,
    cn,
    toast,
    cardSurfaceClass,
  } = ui;

  const KIND_LABEL = { todo: '待办', fact: '记忆' };
  const STATUS_LABEL = { open: '待办', doing: '进行中', done: '已完成', dropped: '已放弃' };

  /** 受控 Select 的取值 → 文案。空串表示「不过滤」。 */
  const optionLabel = (labels, value) => labels[value] ?? String(value);

  const badge = app.surfaces.envBadge({ id: 'todos', title: '待办数', icon: 'List' });

  /** 环境行只放一个「未完成待办数」；数据变了就重算。 */
  function useBadges() {
    const refresh = useCallback(async () => {
      const { items, environments } = await app.rpc.call('list', {});
      const counts = new Map();
      for (const item of items) {
        if (item.kind === 'todo' && item.status !== 'done' && item.status !== 'dropped' && item.envId) {
          counts.set(item.envId, (counts.get(item.envId) || 0) + 1);
        }
      }
      for (const env of environments) {
        const count = counts.get(env.id) || 0;
        badge.set(env.id, count ? { label: String(count), tone: 'info' } : null);
      }
    }, []);
    useEffect(() => {
      void refresh();
    }, [refresh]);
    app.useSignal('changed', refresh);
  }

  function useMemory(initialFilters) {
    const [state, setState] = useState({ items: [], environments: [] });
    const [filters, setFilters] = useState(initialFilters);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => {
      app.rpc
        .call('list', filters)
        .then((next) => {
          setState(next);
          setError(null);
        })
        .catch((err) => setError(String(err.message || err)));
    }, [filters]);

    useEffect(() => {
      load();
    }, [load]);
    app.useSignal('changed', load);

    /** 写操作统一走这里：成功用返回值刷新，失败弹 toast（宿主自己的报错方式） */
    const run = useCallback(async (work, failure) => {
      setBusy(true);
      try {
        const result = await work();
        if (result && Array.isArray(result.items)) setState((prev) => ({ ...prev, items: result.items }));
        setError(null);
        return result;
      } catch (err) {
        toast.error(failure, { description: String(err.message || err) });
        return null;
      } finally {
        setBusy(false);
      }
    }, []);

    return { ...state, filters, setFilters, error, busy, load, run };
  }

  function AddRow({ environmentId, run }) {
    const [kind, setKind] = useState('todo');
    const [title, setTitle] = useState('');
    const [tags, setTags] = useState('');

    const add = async () => {
      if (!title.trim()) return;
      const result = await run(
        () =>
          app.rpc.call('add', {
            environmentId,
            // 没选环境就是记到全局：rail 页默认那个下拉就是「新增到：全局」
            scope: environmentId ? 'env' : 'global',
            kind,
            title: title.trim(),
            tags: tags.trim(),
          }),
        '添加失败',
      );
      if (result) {
        setTitle('');
        setTags('');
      }
    };

    return h(
      'div',
      { className: 'flex flex-wrap items-center gap-2', 'data-slot': 'memory-add' },
      h(
        Select,
        { value: kind, onValueChange: (value) => setKind(value) },
        h(
          SelectTrigger,
          { className: 'w-24' },
          h(SelectValue, null, (value) => optionLabel(KIND_LABEL, value)),
        ),
        h(SelectContent, null, h(SelectItem, { value: 'todo' }, '待办'), h(SelectItem, { value: 'fact' }, '记忆')),
      ),
      h(Input, {
        className: 'min-w-40 flex-1',
        placeholder: kind === 'todo' ? '要做什么…' : '记下什么…',
        value: title,
        onChange: (event) => setTitle(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') void add();
        },
      }),
      h(Input, {
        className: 'w-32',
        placeholder: '标签,逗号分隔',
        value: tags,
        onChange: (event) => setTags(event.target.value),
      }),
      h(Button, { disabled: !title.trim(), onClick: add }, '添加'),
    );
  }

  function ItemRow({ item, busy, run }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(null);

    const startEdit = () => {
      setDraft({ title: item.title, body: item.body, tags: item.tags });
      setEditing(true);
    };

    const save = async () => {
      const result = await run(() => app.rpc.call('update', { id: item.id, ...draft }), '保存失败');
      if (result) setEditing(false);
    };

    const done = item.kind === 'todo' && (item.status === 'done' || item.status === 'dropped');

    return h(
      'div',
      {
        className: cn(cardSurfaceClass, 'flex flex-col gap-2'),
        'data-slot': 'memory-item',
        'data-id': String(item.id),
        'data-kind': item.kind,
        'data-status': item.status,
      },
      h(
        'div',
        { className: 'flex items-start gap-2 text-xs' },
        item.kind === 'todo' &&
          h(Checkbox, {
            className: 'mt-0.5',
            checked: done,
            disabled: busy,
            onCheckedChange: (checked) =>
              run(() => app.rpc.call('setStatus', { id: item.id, status: checked ? 'done' : 'open' }), '改状态失败'),
          }),
        h(Badge, { variant: 'outline' }, KIND_LABEL[item.kind] || item.kind),
        h('span', { className: cn('min-w-0 flex-1', done && 'text-muted-foreground line-through') }, item.title),
        item.kind === 'todo' && item.status === 'doing'
          ? h('span', { className: 'shrink-0 text-[var(--warning)]' }, STATUS_LABEL.doing)
          : null,
        item.tags
          ? h(
              'span',
              { className: 'shrink-0 text-muted-foreground/70' },
              item.tags
                .split(',')
                .filter(Boolean)
                .map((tag) => `#${tag}`)
                .join(' '),
            )
          : null,
        h(
          'span',
          { className: 'shrink-0 text-muted-foreground' },
          item.scope === 'global' ? '全局' : item.envId || '—',
        ),
        h(Button, { size: 'sm', variant: 'ghost', onClick: startEdit }, '编辑'),
        h(
          Button,
          {
            size: 'sm',
            variant: 'ghost',
            disabled: busy,
            onClick: () => run(() => app.rpc.call('remove', { id: item.id }), '删除失败'),
          },
          '删除',
        ),
      ),
      item.body && !editing
        ? h('p', { className: 'whitespace-pre-wrap pl-6 text-xs text-muted-foreground' }, item.body)
        : null,
      item.sourceUrl && !editing
        ? h('p', { className: 'truncate pl-6 text-xs text-muted-foreground/70' }, item.sourceUrl)
        : null,
      editing
        ? h(
            'div',
            { className: 'flex flex-col gap-3 pl-6' },
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: `mem-title-${item.id}` }, '标题'),
              h(Input, {
                id: `mem-title-${item.id}`,
                value: draft.title,
                onChange: (event) => setDraft({ ...draft, title: event.target.value }),
              }),
            ),
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: `mem-body-${item.id}` }, '正文'),
              h(Textarea, {
                id: `mem-body-${item.id}`,
                placeholder: '给 agent 看的细节',
                value: draft.body,
                onChange: (event) => setDraft({ ...draft, body: event.target.value }),
              }),
            ),
            h(
              Field,
              null,
              h(FieldLabel, { htmlFor: `mem-tags-${item.id}` }, '标签'),
              h(Input, {
                id: `mem-tags-${item.id}`,
                placeholder: '逗号分隔',
                value: draft.tags,
                onChange: (event) => setDraft({ ...draft, tags: event.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'flex gap-2' },
              h(Button, { size: 'sm', disabled: busy, onClick: save }, '保存'),
              h(Button, { size: 'sm', variant: 'ghost', onClick: () => setEditing(false) }, '取消'),
            ),
          )
        : null,
    );
  }

  function FilterBar({ filters, setFilters }) {
    const select = (key, placeholder, options) =>
      h(
        Select,
        {
          value: filters[key] ?? '',
          onValueChange: (value) => setFilters({ ...filters, [key]: value || undefined }),
        },
        h(
          SelectTrigger,
          { className: 'w-32' },
          h(SelectValue, { placeholder }, (value) => {
            if (!value) return placeholder;
            const found = options.find((option) => option.value === value);
            return found ? found.label : String(value);
          }),
        ),
        h(
          SelectContent,
          null,
          h(SelectItem, { value: '' }, placeholder),
          ...options.map((option) => h(SelectItem, { key: option.value, value: option.value }, option.label)),
        ),
      );

    return h(
      'div',
      { className: 'flex flex-wrap items-center gap-2', 'data-slot': 'memory-filter' },
      select('kind', '全部类型', [
        { value: 'todo', label: '只看待办' },
        { value: 'fact', label: '只看记忆' },
      ]),
      select('status', '全部状态', [
        { value: 'open', label: '未开始' },
        { value: 'doing', label: '进行中' },
        { value: 'done', label: '已完成' },
        { value: 'dropped', label: '已放弃' },
      ]),
      select('scope', '本环境 + 全局', [{ value: 'global', label: '只看全局' }]),
      h(Input, {
        className: 'w-32',
        placeholder: '标签',
        value: filters.tag || '',
        onChange: (event) => setFilters({ ...filters, tag: event.target.value || undefined }),
      }),
    );
  }

  function MemoryPage() {
    useBadges();
    const { values } = app.useSettings();
    const { items, environments, filters, setFilters, error, busy, load, run } = useMemory({});
    const [scopeEnv, setScopeEnv] = useState('');
    const title = values.find((item) => item.key === 'title')?.value || '记忆';

    return h(
      'div',
      {
        className: 'flex h-full flex-col gap-4 overflow-auto',
        style: { maxWidth: '1040px', marginInline: 'auto', width: '100%', padding: '20px 24px' },
        'data-slot': 'notes-page',
      },
      h(
        'div',
        { className: 'flex items-center gap-2.5' },
        h(
          'span',
          {
            'aria-hidden': true,
            style: { '--brand-hue': 274 },
            className: 'plugin-brand-chip flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-md)]',
          },
          h(Icon, { name: 'List', className: 'size-4' }),
        ),
        h('h1', { className: 'text-lg font-semibold text-foreground' }, title),
        h('span', { className: 'text-xs text-muted-foreground' }, `${items.length} 条 · 按环境或全局沉淀给 Agent`),
        h(
          Button,
          { variant: 'outline', size: 'sm', className: 'ml-auto', onClick: load },
          h(Icon, { name: 'Refresh', className: 'size-3.5' }),
          '刷新',
        ),
      ),
      error && h('p', { className: 'text-xs text-destructive' }, error),
      h(AddRow, { environmentId: scopeEnv, run }),
      h(
        'div',
        { className: 'flex flex-wrap items-center gap-2' },
        h(
          Select,
          { value: scopeEnv, onValueChange: (value) => setScopeEnv(value) },
          h(
            SelectTrigger,
            { className: 'w-44' },
            h(SelectValue, { placeholder: '新增到：全局' }, (value) =>
              value ? `新增到：${environments.find((env) => env.id === value)?.name ?? value}` : '新增到：全局',
            ),
          ),
          h(
            SelectContent,
            null,
            h(SelectItem, { value: '' }, '新增到：全局'),
            ...environments.map((env) => h(SelectItem, { key: env.id, value: env.id }, `新增到：${env.name}`)),
          ),
        ),
        h(FilterBar, { filters, setFilters }),
      ),
      items.length === 0
        ? h(
            Empty,
            null,
            h(
              EmptyHeader,
              null,
              h(EmptyMedia, { variant: 'icon' }, h(Icon, { name: 'List' })),
              h(EmptyTitle, null, '还没有条目'),
              h(EmptyDescription, null, '上面加一条试试。'),
            ),
          )
        : h(
            'div',
            { className: 'flex flex-col gap-2' },
            ...items.map((item) => h(ItemRow, { key: item.id, item, busy, run })),
          ),
    );
  }

  function InspectorTab(props) {
    useBadges();
    const { items, error, busy, run } = useMemory({ environmentId: props.environmentId });
    const [page, setPage] = useState(null);
    useEffect(() => {
      if (!props.environmentId) return undefined;
      let cancelled = false;
      app.host.browser
        .info(props.environmentId)
        .then((info) => {
          if (!cancelled) setPage(info);
        })
        .catch(() => {
          if (!cancelled) setPage(null);
        });
      return () => {
        cancelled = true;
      };
    }, [props.environmentId]);
    if (error) return h('p', { className: 'text-xs text-destructive' }, error);
    if (!props.environmentId) return h('p', { className: 'text-xs text-muted-foreground' }, '环境未启动。');
    const open = items.filter((item) => item.kind === 'todo' && item.status !== 'done' && item.status !== 'dropped');
    return h(
      'div',
      { className: 'flex flex-col gap-2', 'data-slot': 'notes-inspector' },
      h('p', { className: 'text-xs text-muted-foreground' }, `待办 ${open.length} · 共 ${items.length} 条（含全局）`),
      page ? h('p', { className: 'truncate text-xs text-muted-foreground' }, `${page.title} · ${page.url}`) : null,
      h(AddRow, { environmentId: props.environmentId, run }),
      ...items.slice(0, 20).map((item) => h(ItemRow, { key: item.id, item, busy, run })),
    );
  }

  function AboutSection() {
    return h(
      'div',
      { className: 'flex flex-col gap-2 text-xs text-muted-foreground' },
      h('p', null, '记忆是给 agent 用的：它的上下文会被压缩 / 清空，这个库不会。'),
      h(
        'p',
        null,
        '两类条目：**待办**有状态机（未开始 / 进行中 / 已完成 / 已放弃），**记忆**是事实。两个作用域：本环境、全局。',
      ),
      h(
        'pre',
        { className: cn(cardSurfaceClass, 'overflow-x-auto font-mono text-xs') },
        [
          'warren plugin run com.example.notes context --env cap',
          'warren plugin run com.example.notes add --env cap \\',
          '  --input=\'{"kind":"todo","title":"补 e2e","tags":"test","priority":2}\'',
          'warren plugin run com.example.notes setStatus --env cap --input=\'{"id":1,"status":"done"}\'',
          'warren plugin run com.example.notes search --env cap --input=\'{"query":"登录"}\'',
        ].join('\n'),
      ),
      h('p', null, '「同步用 API Key」是 secret：只存在 Vault 里，插件前端永远拿不到明文。'),
    );
  }

  app.surfaces.railPage({ id: 'notes', title: '记忆', icon: 'List', path: 'notes', component: MemoryPage });
  app.surfaces.settingsSection({ id: 'about', title: '记忆使用说明', component: AboutSection });
  app.surfaces.inspectorTab({ id: 'page', title: '记忆', component: InspectorTab });
}
