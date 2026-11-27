import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '@/components/icons';
import { EnvIdentityAvatar, PluginBrandGlyph } from '@/components/identity-glyphs';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { elevatedDialogSurfaceClass, menuItemInteractiveClass } from '@/theme/surface';
import type { Environment, Group, InstalledPlugin } from '@shared/types';

interface CommandItem {
  id: string;
  group: string;
  icon: IconName;
  pluginBrand?: { pluginId: string; icon?: string; fallback?: IconName };
  envChip?: { id: string; name: string; status: Environment['status']; error?: string };
  title: string;
  subtitle?: string;
  shortcut?: string;
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
      section: 'memory',
      title: '设置 · 性能与内存',
      subtitle: '实时内存归因 / 环境与标签休眠 / 水位守卫 / 后台降频',
      icon: 'Zap',
      keywords: 'memory performance ram cpu hibernate sleep throttle cache xingneng neicun',
    },
    {
      section: 'agent',
      title: '设置 · Agent 与审批',
      subtitle: 'CLI / Skill / 控制权审批 / Lease TTL / 胶囊',
      icon: 'Robot',
      keywords: 'agent cli skill approval control lease ttl shenpi',
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

export function CommandBarCard({ initialQuery = '' }: { initialQuery?: string }) {
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
          group: '快速打开',
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
                group: '快速打开',
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
      const envSubtitle =
        env.status === 'running'
          ? env.currentUrl || '运行中'
          : env.status === 'dormant'
            ? '已休眠 · 保留登录态'
            : env.status === 'starting'
              ? '启动中…'
              : env.status === 'error'
                ? `异常：${env.error || '启动失败'}`
                : '未启动';
      list.push({
        id: `select:${env.id}`,
        group: '环境',
        icon: 'Globe',
        envChip: { id: env.id, name: env.name, status: env.status, error: env.error },
        title: env.name,
        subtitle: envSubtitle,
        keywords: `${env.id} ${env.name} ${env.proxy ?? ''} switch select 切换 环境`,
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
        group: '分组',
        icon: 'Folder',
        title: group.name,
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
          group: '当前环境操作',
          icon: 'Plus',
          title: `在「${current.name}」新建标签页`,
          shortcut: '⌘T',
          keywords: 'new tab xinjian biaoqian',
          run: async () => {
            await window.envApi.tabCreate(current.id, space);
            await window.envApi.resolveOverlay({ command: 'newTab' });
          },
        },
        {
          id: 'action:toggle-space',
          group: '当前环境操作',
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
          group: '当前环境操作',
          icon: 'Code',
          title: '打开 Chrome 开发者工具',
          shortcut: '⌥⌘I',
          keywords: 'devtools chrome inspect kaifazhe',
          run: async () => {
            await window.envApi.openDevTools(current.id, space);
            await window.envApi.resolveOverlay({ command: 'devtools' });
          },
        },
        {
          id: 'action:devtools-right',
          group: '当前环境操作',
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
          group: '当前环境操作',
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
          group: '当前环境操作',
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
            group: '全局页面与扩展',
            icon: 'ExternalLink',
            pluginBrand: { pluginId: plugin.id, icon: surface.icon, fallback: 'ExternalLink' },
            title: `打开「${surface.title}」管理页`,
            subtitle: plugin.name,
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
            group: '系统设置',
            icon: 'Plug',
            pluginBrand: { pluginId: plugin.id, icon: surface.icon, fallback: 'Plug' },
            title: `${plugin.name} · ${surface.title}`,
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
            group: '全局页面与扩展',
            icon: 'Plug',
            pluginBrand: { pluginId: plugin.id, icon: surface.icon, fallback: 'Plug' },
            title: `打开「${surface.title}」浮窗`,
            subtitle: `${plugin.name} · 快捷浮窗`,
            shortcut: surface.shortcut,
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
            group: '全局页面与扩展',
            icon: 'PanelRight',
            pluginBrand: { pluginId: plugin.id, icon: surface.icon, fallback: 'PanelRight' },
            title: `展开「${surface.title}」随页侧栏`,
            subtitle: `${plugin.name} · 工作台`,
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
        list.push({
          id: `plugin:${plugin.id}:${surface.id}`,
          group: '全局页面与扩展',
          icon: 'Zap',
          pluginBrand: { pluginId: plugin.id, icon: surface.icon, fallback: 'Zap' },
          title: surface.title,
          subtitle: `${plugin.name} · 执行动作`,
          shortcut: surface.shortcut,
          keywords: `${plugin.id} ${plugin.name} ${surface.title} ${surface.description ?? ''} plugin command`,
          run: async () => {
            await window.envApi.pluginRun(plugin.id, surface.command!, current?.id);
            await window.envApi.resolveOverlay({ command: 'pluginRun', pluginId: plugin.id, action: surface.id });
          },
        });
      }
    }
    list.push(
      {
        id: 'memory:hibernate-background',
        group: '性能与内存',
        icon: 'Zap',
        title: '一键休眠全部后台环境',
        subtitle: '释放非当前查看且非持权环境的渲染进程，保留登录态',
        keywords: 'memory hibernate sleep background idle xiumian neicun shifang',
        run: async () => {
          await window.envApi.hibernateBackground();
          await window.envApi.resolveOverlay({ command: 'memoryHibernateBackground' });
        },
      },
      {
        id: 'memory:sleep-idle-tabs',
        group: '性能与内存',
        icon: 'Stop',
        title: '释放全部非激活标签',
        subtitle: '休眠后台标签渲染进程，点击标签时自动恢复',
        keywords: 'memory tab sleep idle release biaoqian xiumian neicun',
        run: async () => {
          await window.envApi.sleepIdleTabs();
          await window.envApi.resolveOverlay({ command: 'memorySleepIdleTabs' });
        },
      },
      {
        id: 'memory:clear-caches',
        group: '性能与内存',
        icon: 'Trash',
        title: '清理全部浏览器 HTTP 缓存',
        subtitle: '仅清理磁盘/内存缓存，保留所有环境的 Cookie 与登录态',
        keywords: 'memory clear cache http qingli huancun',
        run: async () => {
          await window.envApi.clearAllCaches();
          await window.envApi.resolveOverlay({ command: 'memoryClearAllCaches' });
        },
      },
    );
    for (const item of SETTINGS_COMMANDS) {
      list.push({
        id: `settings:${item.section}`,
        group: '系统设置',
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
  const [runError, setRunError] = useState<string | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (clampedIndex < 0) return;
    itemRefs.current[clampedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [clampedIndex]);

  const executeItem = async (item: CommandItem | undefined) => {
    if (!item) return;
    setRunError(null);
    try {
      await item.run();
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <dialog
      open
      aria-modal="true"
      aria-label="全局命令栏"
      className={cn(
        elevatedDialogSurfaceClass,
        'warren-dialog-enter relative z-10 m-0 flex w-full max-w-[620px] flex-col overflow-hidden border-0 p-0 text-[13px] outline-none',
      )}
    >
      <div className="flex h-12 items-center gap-2.5 border-b border-border px-4">
        <Icon name="Search" className="text-muted-foreground" />
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
              void executeItem(filtered[clampedIndex]);
            }
          }}
          placeholder="搜索环境、操作、地址或设置…"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="max-h-[304px] overflow-y-auto px-2 py-1.5">
        {filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">没有匹配的命令</p>
        ) : (
          filtered.map((item, idx) => {
            const showGroup = idx === 0 || filtered[idx - 1]?.group !== item.group;
            return (
              <div key={item.id}>
                {showGroup && (
                  <div
                    className={cn(
                      'px-2.5 pt-2 pb-1 text-[length:var(--font-size-micro)] font-medium text-subtle-foreground select-none',
                      idx === 0 && 'pt-0.5',
                    )}
                  >
                    {item.group}
                  </div>
                )}
                <button
                  ref={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                  type="button"
                  onMouseEnter={() => setHighlighted(idx)}
                  onClick={() => void executeItem(item)}
                  className={cn(
                    menuItemInteractiveClass,
                    'flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left',
                    idx === clampedIndex
                      ? 'bg-surface-highlight opacity-100 hover:bg-surface-highlight'
                      : 'hover:bg-transparent',
                  )}
                >
                  {item.envChip ? (
                    <EnvIdentityAvatar
                      envId={item.envChip.id}
                      name={item.envChip.name}
                      status={item.envChip.status}
                      hasError={Boolean(item.envChip.error)}
                      size="sm"
                      ringClassName={
                        idx === clampedIndex ? 'ring-[var(--surface-selected-solid)]' : 'ring-surface-elevated'
                      }
                    />
                  ) : item.pluginBrand ? (
                    <PluginBrandGlyph
                      pluginId={item.pluginBrand.pluginId}
                      icon={item.pluginBrand.icon}
                      fallback={item.pluginBrand.fallback}
                      className="size-4"
                    />
                  ) : (
                    <Icon name={item.icon} className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {item.subtitle && (
                    <span className="max-w-[200px] shrink-0 truncate font-mono text-xs text-muted-foreground">
                      {item.subtitle}
                    </span>
                  )}
                  {item.shortcut && <Kbd className="shrink-0">{item.shortcut}</Kbd>}
                </button>
              </div>
            );
          })
        )}
      </div>
      {runError && (
        <div
          role="alert"
          className="border-t border-destructive/30 bg-destructive/10 px-3.5 py-1.5 text-xs text-destructive"
        >
          执行失败：{runError}
        </div>
      )}
      <div className="flex items-center justify-between border-t border-border bg-sheet-inset px-4 py-2 text-[length:var(--font-size-micro)] text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑↓</Kbd> 选择
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>↵</Kbd> 执行
          </span>
        </span>
        <span className="flex items-center gap-2.5">
          <span>{filtered.length} 项</span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Esc</Kbd> 关闭
          </span>
        </span>
      </div>
    </dialog>
  );
}
