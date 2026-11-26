import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, isIconName, type IconName } from '@/components/icons';
import { Button, IconButton } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useStandaloneThemeSync } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { elevatedDialogSurfaceClass, menuItemInteractiveClass } from '@/theme/surface';
import type { Environment, Group, InstalledPlugin, OverlayRequest } from '@shared/types';

const DEFAULT_START_URL = 'https://example.com';

function OverlayCard({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <dialog
      open
      aria-modal="true"
      className={cn(
        elevatedDialogSurfaceClass,
        'relative z-10 m-0 grid w-full max-w-[440px] gap-0 border-0 p-5 text-sm outline-none animate-in fade-in-0 zoom-in-95 duration-100',
      )}
    >
      <div className="flex flex-col gap-1.5 pr-6">
        <h2 className="text-base leading-none font-medium text-foreground">{title}</h2>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <IconButton
        className="absolute top-3 right-3 text-subtle-foreground hover:bg-surface-hover hover:text-foreground"
        title="关闭"
        onClick={onClose}
      >
        <Icon name="X" />
      </IconButton>
      {children}
    </dialog>
  );
}

function CreateEnvCard({ initialGroupId }: { initialGroupId?: string }) {
  const [id, setId] = useState('');
  const [proxy, setProxy] = useState('');
  const [startUrl, setStartUrl] = useState(DEFAULT_START_URL);
  const [headed, setHeaded] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => idRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const cancel = () => void window.envApi.resolveOverlay(null);

  const submit = async () => {
    const trimmedId = id.trim();
    if (!trimmedId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await window.envApi.create({
        id: trimmedId,
        proxy: proxy.trim() || undefined,
        startUrl: startUrl.trim() || undefined,
        headed,
      });
      if (initialGroupId) {
        await window.envApi.moveToGroup(created.id, initialGroupId);
      }
      await window.envApi.resolveOverlay(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <OverlayCard title="新建环境" description="一个环境 = 独立浏览器存储 + 独立出口。" onClose={cancel}>
      <form
        className="flex flex-col gap-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field>
          <FieldLabel htmlFor="overlay-new-env-id">环境名</FieldLabel>
          <Input
            ref={idRef}
            id="overlay-new-env-id"
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="例如 alpha"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="overlay-new-env-proxy">代理</FieldLabel>
          <Input
            id="overlay-new-env-proxy"
            value={proxy}
            onChange={(event) => setProxy(event.target.value)}
            placeholder="http://host:port（留空直连）"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="overlay-new-env-start-url">启动 URL</FieldLabel>
          <Input
            id="overlay-new-env-start-url"
            value={startUrl}
            onChange={(event) => setStartUrl(event.target.value)}
            placeholder={DEFAULT_START_URL}
          />
        </Field>
        <Field orientation="horizontal">
          <Switch id="overlay-new-env-headed" checked={headed} onCheckedChange={setHeaded} />
          <FieldLabel htmlFor="overlay-new-env-headed">启动后自动切换到这个环境</FieldLabel>
        </Field>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </form>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={cancel}>
          取消
        </Button>
        <Button onClick={() => void submit()} disabled={!id.trim() || submitting}>
          创建
        </Button>
      </div>
    </OverlayCard>
  );
}

function EditEnvCard({ environment }: { environment: Environment }) {
  const [name, setName] = useState(environment.name);
  const [proxy, setProxy] = useState(environment.proxy ?? '');
  const [startUrl, setStartUrl] = useState(environment.startUrl ?? '');
  const [headed, setHeaded] = useState(environment.headed);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const cancel = () => void window.envApi.resolveOverlay(null);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await window.envApi.update(environment.id, {
        name: trimmedName,
        proxy: proxy.trim(),
        startUrl: startUrl.trim(),
        headed,
      });
      await window.envApi.resolveOverlay(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <OverlayCard
      title="编辑环境"
      description={
        <>
          <code>{environment.id}</code>
          {environment.status === 'running' && ' · 正在运行：代理、启动 URL 与「自动切换」下次启动才生效'}
        </>
      }
      onClose={cancel}
    >
      <form
        className="flex flex-col gap-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field>
          <FieldLabel htmlFor="overlay-edit-env-name">显示名</FieldLabel>
          <Input
            ref={nameRef}
            id="overlay-edit-env-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={environment.id}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="overlay-edit-env-proxy">代理</FieldLabel>
          <Input
            id="overlay-edit-env-proxy"
            value={proxy}
            onChange={(event) => setProxy(event.target.value)}
            placeholder="http://host:port（留空直连）"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="overlay-edit-env-start-url">启动 URL</FieldLabel>
          <Input
            id="overlay-edit-env-start-url"
            value={startUrl}
            onChange={(event) => setStartUrl(event.target.value)}
            placeholder="https://example.com"
          />
        </Field>
        <Field orientation="horizontal">
          <Switch id="overlay-edit-env-headed" checked={headed} onCheckedChange={setHeaded} />
          <FieldLabel htmlFor="overlay-edit-env-headed">启动后自动切换到这个环境</FieldLabel>
        </Field>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </form>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={cancel}>
          取消
        </Button>
        <Button onClick={() => void submit()} disabled={!name.trim() || submitting}>
          保存
        </Button>
      </div>
    </OverlayCard>
  );
}

function CreateGroupCard() {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const cancel = () => void window.envApi.resolveOverlay(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const group = await window.envApi.groupCreate(trimmed);
      await window.envApi.resolveOverlay(group);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <OverlayCard title="新建分组" description="分组只影响侧栏的组织方式，不影响运行时。" onClose={cancel}>
      <form
        className="flex flex-col gap-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field>
          <FieldLabel htmlFor="overlay-new-group-name">分组名</FieldLabel>
          <Input
            ref={inputRef}
            id="overlay-new-group-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="生产"
          />
        </Field>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </form>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={cancel}>
          取消
        </Button>
        <Button onClick={() => void submit()} disabled={!name.trim() || submitting}>
          创建
        </Button>
      </div>
    </OverlayCard>
  );
}

function RenameCard({ title, label, initialValue }: { title: string; label: string; initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const cancel = () => void window.envApi.resolveOverlay(null);
  const submit = () => {
    const next = value.trim();
    if (!next) return;
    void window.envApi.resolveOverlay(next);
  };

  return (
    <OverlayCard title={title} onClose={cancel}>
      <form
        className="flex flex-col gap-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field>
          <FieldLabel htmlFor="overlay-rename-value">{label}</FieldLabel>
          <Input
            ref={inputRef}
            id="overlay-rename-value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
      </form>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={cancel}>
          取消
        </Button>
        <Button onClick={submit} disabled={!value.trim()}>
          保存
        </Button>
      </div>
    </OverlayCard>
  );
}

function ConfirmCard({
  title,
  description,
  confirmLabel = '确认',
  destructive = false,
}: {
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
}) {
  const cancel = () => void window.envApi.resolveOverlay(false);
  return (
    <OverlayCard title={title} description={description} onClose={cancel}>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={cancel}>
          取消
        </Button>
        <Button
          variant={destructive ? 'destructive' : 'default'}
          onClick={() => void window.envApi.resolveOverlay(true)}
        >
          {confirmLabel}
        </Button>
      </div>
    </OverlayCard>
  );
}

interface CommandItem {
  id: string;
  icon: IconName;
  title: string;
  subtitle?: string;
  keywords: string;
  run: () => Promise<void> | void;
}

function looksLikeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed)) return `http://${trimmed}`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return null;
}

const SETTINGS_COMMANDS: Array<{ section: string; title: string; subtitle: string; icon: IconName; keywords: string }> =
  [
    {
      section: 'general',
      title: '设置 · 通用与外观',
      subtitle: '主题 / 紧凑顶栏 / 圆角 / 数据目录',
      icon: 'Sliders',
      keywords: 'general appearance theme dark light system waiguan zhuti',
    },
    {
      section: 'browser',
      title: '设置 · 浏览器与 DevTools',
      subtitle: '默认停靠位 / 视口 / 并发上限 / 休眠 / 按域偏好',
      icon: 'Code',
      keywords: 'browser devtools dock viewport hibernate maxrunning domain liulanqi',
    },
    {
      section: 'agent',
      title: '设置 · Agent 与审批',
      subtitle: 'CLI / Skill / 控制权审批 / Lease TTL / 胶囊',
      icon: 'Robot',
      keywords: 'agent cli skill approval control lease ttl shenpi',
    },
    {
      section: 'vault',
      title: '设置 · 凭据与安全边界',
      subtitle: 'Keychain / 代理凭据录入 / 安全说明',
      icon: 'Key',
      keywords: 'vault credentials password proxy anquan pingju',
    },
    {
      section: 'plugins',
      title: '设置 · 插件管理',
      subtitle: '启停 / 权限矩阵 / 隔离日志 / 安装',
      icon: 'Plug',
      keywords: 'plugins permissions install logs chajian',
    },
    {
      section: 'diagnostics',
      title: '设置 · 诊断与关于',
      subtitle: '系统自检 Doctor / 清理历史 / 版本信息',
      icon: 'Activity',
      keywords: 'diagnostics doctor sqlite rpc version about zhenduan',
    },
  ];

function CommandBarCard({ initialQuery = '' }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    void Promise.all([
      window.envApi.list(),
      window.envApi.groups(),
      window.envApi.selected(),
      window.envApi.plugins(),
    ]).then(([list, groupList, cur, pluginList]) => {
      setEnvs(list);
      setGroups(groupList);
      setSelectedId(cur);
      setPlugins(pluginList);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const current = envs.find((env) => env.id === selectedId);
  const parsedUrl = looksLikeUrl(query);

  const items = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = [];
    if (parsedUrl && current) {
      const space = current.activeSpaceId ?? 'person';
      list.push(
        {
          id: `url:new-tab:${parsedUrl}`,
          icon: 'Plus',
          title: `在「${current.name}」新标签打开 ${parsedUrl}`,
          subtitle: space === 'agent' ? 'Agent Space' : '我的空间',
          keywords: `${query} url open new tab`,
          run: async () => {
            if (current.status !== 'running') await window.envApi.start(current.id);
            await window.envApi.tabCreate(current.id, space, parsedUrl, true);
            await window.envApi.resolveOverlay({ command: 'openUrl', url: parsedUrl });
          },
        },
        ...(current.status === 'running'
          ? [
              {
                id: `url:goto:${parsedUrl}`,
                icon: 'Globe' as IconName,
                title: `当前标签前往 ${parsedUrl}`,
                subtitle: current.name,
                keywords: `${query} url goto navigate`,
                run: async () => {
                  await window.envApi.humanNavigate(current.id, space, { kind: 'goto', url: parsedUrl });
                  await window.envApi.resolveOverlay({ command: 'navigate', url: parsedUrl });
                },
              },
            ]
          : []),
      );
    }
    for (const env of envs) {
      list.push({
        id: `select:${env.id}`,
        icon: env.status === 'running' ? 'Play' : 'Globe',
        title: `切换到环境：${env.name}`,
        subtitle: env.status === 'running' ? env.currentUrl || '运行中' : '未启动',
        keywords: `${env.id} ${env.name} ${env.proxy ?? ''} switch select`,
        run: async () => {
          if (env.status !== 'running') await window.envApi.start(env.id);
          await window.envApi.select(env.id);
          await window.envApi.resolveOverlay({ command: 'select', envId: env.id });
        },
      });
    }
    for (const group of groups) {
      const firstEnv = envs.find((env) => env.groupId === group.id);
      if (!firstEnv) continue;
      list.push({
        id: `group:${group.id}`,
        icon: 'Folder',
        title: `进入分组：${group.name}`,
        subtitle: `切换至「${firstEnv.name}」`,
        keywords: `${group.name} group fenzu`,
        run: async () => {
          if (firstEnv.status !== 'running') await window.envApi.start(firstEnv.id);
          await window.envApi.select(firstEnv.id);
          await window.envApi.resolveOverlay({ command: 'select', envId: firstEnv.id });
        },
      });
    }
    if (current && current.status === 'running') {
      const space = current.activeSpaceId ?? 'person';
      list.push(
        {
          id: 'action:new-tab',
          icon: 'Plus',
          title: `在「${current.name}」新建标签页`,
          subtitle: '⌘T',
          keywords: 'new tab xinjian biaoqian',
          run: async () => {
            await window.envApi.tabCreate(current.id, space);
            await window.envApi.resolveOverlay({ command: 'newTab' });
          },
        },
        {
          id: 'action:toggle-space',
          icon: space === 'person' ? 'Robot' : 'User',
          title: space === 'person' ? '切换到 Agent 空间' : '切换到我的空间',
          subtitle: current.name,
          keywords: 'space agent person qiehuan',
          run: async () => {
            await window.envApi.spaceSelect(current.id, space === 'person' ? 'agent' : 'person');
            await window.envApi.resolveOverlay({ command: 'spaceSelect' });
          },
        },
        {
          id: 'action:devtools',
          icon: 'Code',
          title: '打开 Chrome 开发者工具',
          subtitle: '⌥⌘I',
          keywords: 'devtools chrome inspect kaifazhe',
          run: async () => {
            await window.envApi.openDevTools(current.id, space);
            await window.envApi.resolveOverlay({ command: 'devtools' });
          },
        },
        {
          id: 'action:devtools-right',
          icon: 'DockRight',
          title: 'DevTools 右侧停靠',
          subtitle: current.name,
          keywords: 'devtools dock right panel youce',
          run: async () => {
            await window.envApi.openDevTools(current.id, space, 'right');
            await window.envApi.resolveOverlay({ command: 'devtools' });
          },
        },
        {
          id: 'action:devtools-bottom',
          icon: 'DockBottom',
          title: 'DevTools 底部停靠',
          subtitle: current.name,
          keywords: 'devtools dock bottom dibu',
          run: async () => {
            await window.envApi.openDevTools(current.id, space, 'bottom');
            await window.envApi.resolveOverlay({ command: 'devtools' });
          },
        },
        {
          id: 'action:devtools-detach',
          icon: 'ExternalWindow',
          title: 'DevTools 独立窗口',
          subtitle: current.name,
          keywords: 'devtools detach window duli',
          run: async () => {
            await window.envApi.openDevTools(current.id, space, 'detach');
            await window.envApi.resolveOverlay({ command: 'devtools' });
          },
        },
      );
    }
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      for (const surface of plugin.contributes.surfaces) {
        if (surface.kind === 'railPage') {
          list.push({
            id: `page:${plugin.id}:${surface.id}`,
            icon: surface.icon && isIconName(surface.icon) ? surface.icon : 'Plug',
            title: `打开「${surface.title}」`,
            subtitle: `${plugin.name} · 全屏页`,
            keywords: `plugin page ${plugin.id} ${plugin.name} ${surface.title}`,
            run: async () => {
              await window.envApi.resolveOverlay({
                command: 'openPluginPage',
                pluginId: plugin.id,
                surfaceId: surface.id,
              });
            },
          });
          continue;
        }
        if (surface.kind === 'settingsSection') {
          list.push({
            id: `settings:plugin:${plugin.id}:${surface.id}`,
            icon: surface.icon && isIconName(surface.icon) ? surface.icon : 'Plug',
            title: `设置 · ${plugin.name} · ${surface.title}`,
            subtitle: '扩展配置',
            keywords: `settings plugin ${plugin.id} ${plugin.name} ${surface.title}`,
            run: async () => {
              await window.envApi.resolveOverlay({
                command: 'openSettings',
                section: `plugin:${plugin.id}:${surface.id}`,
              });
            },
          });
          continue;
        }
        if (surface.kind === 'popover') {
          list.push({
            id: `popover:${plugin.id}:${surface.id}`,
            icon: surface.icon && isIconName(surface.icon) ? surface.icon : 'Plug',
            title: `${plugin.name} · ${surface.title}`,
            subtitle: surface.shortcut || '快捷浮窗',
            keywords: `plugin popover quick ${plugin.id} ${plugin.name} ${surface.title} ${surface.description ?? ''}`,
            run: async () => {
              await window.envApi.resolveOverlay({
                command: 'openPluginPopover',
                pluginId: plugin.id,
                surfaceId: surface.id,
              });
            },
          });
          continue;
        }
        if (surface.kind === 'inspectorTab') {
          list.push({
            id: `inspector:${plugin.id}:${surface.id}`,
            icon: surface.icon && isIconName(surface.icon) ? surface.icon : 'PanelRight',
            title: `工作台 · ${plugin.name} · ${surface.title}`,
            subtitle: '随页工作台',
            keywords: `plugin inspector tab ${plugin.id} ${plugin.name} ${surface.title}`,
            run: async () => {
              await window.envApi.resolveOverlay({
                command: 'openPluginInspectorTab',
                pluginId: plugin.id,
                surfaceId: surface.id,
              });
            },
          });
          continue;
        }
        if (surface.kind !== 'commandBarAction' || !surface.command) continue;
        const iconName: IconName = surface.icon && isIconName(surface.icon) ? surface.icon : 'Plug';
        list.push({
          id: `plugin:${plugin.id}:${surface.id}`,
          icon: iconName,
          title: `${plugin.name} · ${surface.title}`,
          subtitle: surface.shortcut || surface.description || plugin.id,
          keywords: `${plugin.id} ${plugin.name} ${surface.title} ${surface.description ?? ''} plugin`,
          run: async () => {
            await window.envApi.pluginRun(plugin.id, surface.command!, current?.id);
            await window.envApi.resolveOverlay({ command: 'pluginRun', pluginId: plugin.id, action: surface.id });
          },
        });
      }
    }
    for (const item of SETTINGS_COMMANDS) {
      list.push({
        id: `settings:${item.section}`,
        icon: item.icon,
        title: item.title,
        subtitle: item.subtitle,
        keywords: item.keywords,
        run: async () => {
          await window.envApi.resolveOverlay({ command: 'openSettings', section: item.section });
        },
      });
    }
    return list;
  }, [envs, groups, plugins, current, parsedUrl, query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q) ||
        (item.subtitle?.toLowerCase().includes(q) ?? false),
    );
  }, [items, query]);

  const clampedIndex = filtered.length === 0 ? -1 : Math.min(highlighted, filtered.length - 1);

  return (
    <dialog
      open
      aria-modal="true"
      aria-label="全局命令栏"
      className={cn(
        elevatedDialogSurfaceClass,
        'relative z-10 m-0 flex w-full max-w-[560px] flex-col overflow-hidden border-0 p-0 text-sm outline-none animate-in fade-in-0 zoom-in-95 duration-100',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <Icon name="Command" className="text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlighted(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && filtered.length > 0) {
              event.preventDefault();
              setHighlighted((idx) => (idx + 1) % filtered.length);
            } else if (event.key === 'ArrowUp' && filtered.length > 0) {
              event.preventDefault();
              setHighlighted((idx) => (idx <= 0 ? filtered.length - 1 : idx - 1));
            } else if (event.key === 'Enter' && clampedIndex >= 0) {
              event.preventDefault();
              void filtered[clampedIndex]?.run();
            }
          }}
          placeholder="搜索环境、操作、地址或设置…"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <span className="text-[11px] text-muted-foreground">Esc 关闭</span>
      </div>
      <div className="max-h-[296px] overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">没有匹配的命令</p>
        ) : (
          filtered.map((item, idx) => (
            <button
              key={item.id}
              type="button"
              onMouseEnter={() => setHighlighted(idx)}
              onClick={() => void item.run()}
              className={cn(
                menuItemInteractiveClass,
                'flex w-full items-center gap-2.5 px-3 py-2 text-left',
                idx === clampedIndex && 'bg-surface-hover opacity-100',
              )}
            >
              <Icon name={item.icon} className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              {item.subtitle && <span className="shrink-0 text-xs text-muted-foreground">{item.subtitle}</span>}
            </button>
          ))
        )}
      </div>
    </dialog>
  );
}

/**
 * OverlayHost 的独立渲染入口（加载 `index.html?surface=overlay`）。
 * 常驻预热在 WindowLayerManager 最顶层 `'overlay'` 槽位，弹窗零延迟且不藏底层网页。
 */
export function OverlayRoot() {
  useStandaloneThemeSync();
  const [request, setRequest] = useState<OverlayRequest | null>(null);

  useEffect(() => {
    void window.envApi.getOverlayState().then(setRequest);
    return window.envApi.onOverlayState(setRequest);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && request) {
        event.preventDefault();
        void window.envApi.resolveOverlay(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [request]);

  if (!request) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="关闭浮层"
        tabIndex={-1}
        onClick={() => void window.envApi.resolveOverlay(null)}
        className="fixed inset-0 cursor-default bg-overlay backdrop-blur-[2px]"
      />
      {request.kind === 'create-env' && <CreateEnvCard initialGroupId={request.initialGroupId} />}
      {request.kind === 'edit-env' && <EditEnvCard environment={request.environment} />}
      {request.kind === 'create-group' && <CreateGroupCard />}
      {request.kind === 'rename' && (
        <RenameCard title={request.title} label={request.label} initialValue={request.initialValue} />
      )}
      {request.kind === 'confirm' && (
        <ConfirmCard
          title={request.title}
          description={request.description}
          confirmLabel={request.confirmLabel}
          destructive={request.destructive}
        />
      )}
      {request.kind === 'command-bar' && <CommandBarCard initialQuery={request.initialQuery} />}
    </div>
  );
}
