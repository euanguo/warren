import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { PluginSurfaceHost } from '@/app/plugin-surfaces';
import { PluginBrandGlyph } from '@/components/identity-glyphs';
import { Icon, type IconName } from '@/components/icons';
import { Button, IconButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PluginsPanel } from '@/features/plugins/plugins-panel';
import { AgentPanel } from '@/features/settings/agent-panel';
import { ApprovalPanel } from '@/features/settings/approval-panel';
import { BrowserPanel } from '@/features/settings/browser-panel';
import { DiagnosticsPanel } from '@/features/settings/diagnostics-panel';
import { GeneralPanel } from '@/features/settings/general-panel';
import { MemoryPanel } from '@/features/settings/memory-panel';
import type { PluginSettingsSection } from '@/lib/plugin-sdk-types';
import { setSettingsQuery, useNavigationState, type SettingsSection } from '@/state/navigation-store';
import type { Environment, InstalledPlugin } from '@shared/types';

export type { SettingsSection };

const SECTION_TRIGGER_CLASS = 'h-auto! flex-none justify-start gap-2 px-2.5 py-1.5 text-left';

interface SectionRenderContext {
  onChanged: () => void;
  plugins: InstalledPlugin[];
  pluginErrors: Array<{ pluginId: string; message: string }>;
  environments: Environment[];
}

interface SectionDescriptor {
  id: SettingsSection;
  group: '界面与浏览' | '自动化与安全' | '扩展与维护';
  title: string;
  subtitle: string;
  icon: IconName;
  keywords: string;
  pluginSection?: PluginSettingsSection;
  render: (ctx: SectionRenderContext) => ReactNode;
}

const BUILTIN_SECTIONS: SectionDescriptor[] = [
  {
    id: 'general',
    group: '界面与浏览',
    title: '通用与外观',
    subtitle: '切换深浅主题、调整顶栏密度与页面圆角、管理数据根目录。',
    icon: 'Sliders',
    keywords: '通用 外观 主题 深色 浅色 跟随系统 紧凑 顶栏 圆角 数据目录 theme dark light system compact warren_home',
    render: () => <GeneralPanel />,
  },
  {
    id: 'browser',
    group: '界面与浏览',
    title: '浏览器与 DevTools',
    subtitle: '设置开发者工具默认停靠方式、默认视口以及按域偏好与地址历史。',
    icon: 'Code',
    keywords: '浏览器 devtools 开发者工具 停靠 右侧 底部 独立 视口 缩放 按域 历史 dock viewport',
    render: () => <BrowserPanel />,
  },
  {
    id: 'memory',
    group: '界面与浏览',
    title: '性能与内存',
    subtitle: '实时监控进程内存归因、按环境或标签精准休眠、配置水位守卫与后台降频策略。',
    icon: 'Zap',
    keywords: '性能 内存 进程 监控 休眠 缓存 水位 降频 惰性 memory ram cpu pid hibernate sleep cache throttle',
    render: () => <MemoryPanel />,
  },
  {
    id: 'agent',
    group: '自动化与安全',
    title: 'Agent 与审批',
    subtitle: '配置控制权审批门控、Lease 租约时长、页面防误触提示与内置 Skill 安装。',
    icon: 'Robot',
    keywords: 'agent 审批 控制权 租约 lease ttl 胶囊 skill claude codex cursor opencode cli',
    render: ({ environments }) => (
      <div className="flex flex-col gap-5">
        <ApprovalPanel environments={environments} />
        <AgentPanel />
      </div>
    ),
  },
  {
    id: 'plugins',
    group: '扩展与维护',
    title: '插件管理',
    subtitle: '安装、启停、重载插件，批准 confirm 权限矩阵，检索插件子进程日志。',
    icon: 'Plug',
    keywords: '插件 管理 权限 日志 安装 vm host sandbox plugin',
    render: ({ onChanged, plugins, pluginErrors }) => (
      <PluginsPanel onChanged={onChanged} plugins={plugins} pluginErrors={pluginErrors} />
    ),
  },
  {
    id: 'diagnostics',
    group: '扩展与维护',
    title: '诊断与关于',
    subtitle: '执行全局健康自检（Doctor）、导出脱敏报告、查看运行时与数据目录。',
    icon: 'Activity',
    keywords: '诊断 自检 doctor 关于 版本 sqlite wal rpc socket 清理 报告',
    render: () => <DiagnosticsPanel />,
  },
];

const GROUP_ORDER: Array<SectionDescriptor['group']> = ['界面与浏览', '自动化与安全', '扩展与维护'];

interface Props {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onChanged: () => void;
  onClose?: () => void;
  pluginSections?: PluginSettingsSection[];
  pluginErrors?: Array<{ pluginId: string; message: string }>;
  plugins?: InstalledPlugin[];
  environments?: Environment[];
}

export function SettingsPage({
  section,
  onSectionChange,
  onChanged,
  onClose,
  pluginSections = [],
  pluginErrors = [],
  plugins = [],
  environments = [],
}: Props) {
  const { settingsQuery } = useNavigationState();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // 子对话框、下拉选择或弹出菜单打开时，把 Esc 留给子浮层消费，避免整页设置被误关
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"][data-open], [data-popup-open]',
        )
      ) {
        return;
      }
      if (settingsQuery.trim()) {
        setSettingsQuery('');
        return;
      }
      onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settingsQuery, onClose]);

  const allSections = useMemo<SectionDescriptor[]>(() => {
    const dynamic: SectionDescriptor[] = pluginSections.map((pluginSection) => ({
      id: `plugin:${pluginSection.pluginId}:${pluginSection.id}`,
      group: '扩展与维护',
      title: pluginSection.title,
      subtitle: pluginSection.description || `扩展「${pluginSection.pluginId}」专属配置`,
      icon: 'Plug',
      keywords: `${pluginSection.pluginId} ${pluginSection.title} ${pluginSection.description ?? ''} 插件 扩展`,
      pluginSection,
      render: () => (
        <PluginSurfaceHost
          pluginId={pluginSection.pluginId}
          title={pluginSection.title}
          Component={pluginSection.component}
          props={{ pluginId: pluginSection.pluginId }}
        />
      ),
    }));
    const list = [...BUILTIN_SECTIONS];
    const idx = list.findIndex((item) => item.id === 'plugins');
    list.splice(idx + 1, 0, ...dynamic);
    return list;
  }, [pluginSections]);

  const filteredSections = useMemo(() => {
    const q = settingsQuery.trim().toLowerCase();
    if (!q) return allSections;
    return allSections.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q),
    );
  }, [allSections, settingsQuery]);

  const effectiveSection = filteredSections.some((item) => item.id === section)
    ? section
    : (filteredSections[0]?.id ?? section);

  const activeDescriptor = allSections.find((item) => item.id === effectiveSection);
  const renderCtx: SectionRenderContext = { onChanged, plugins, pluginErrors, environments };

  return (
    <div data-slot="settings-page" className="flex h-full min-h-0 flex-col bg-background">
      <Tabs
        orientation="vertical"
        value={effectiveSection}
        onValueChange={(value) => onSectionChange(value as SettingsSection)}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex w-56 shrink-0 flex-col border-r border-border/70 bg-surface-under/70">
          <div className="p-2.5 pb-1.5">
            <div className="relative">
              <Icon
                name="Search"
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={searchRef}
                value={settingsQuery}
                onChange={(event) => setSettingsQuery(event.target.value)}
                placeholder="搜索设置…"
                aria-label="搜索设置"
                className="pr-7 pl-8 text-xs"
              />
              {settingsQuery && (
                <IconButton
                  variant="ghost"
                  aria-label="清空搜索"
                  onClick={() => {
                    setSettingsQuery('');
                    searchRef.current?.focus();
                  }}
                  className="absolute top-1/2 right-1 -translate-y-1/2"
                >
                  <Icon name="X" className="size-3.5" />
                </IconButton>
              )}
            </div>
            {settingsQuery.trim() && (
              <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">匹配 {filteredSections.length} 项</p>
            )}
          </div>
          <TabsList className="h-auto! w-full flex-1 flex-col items-stretch justify-start gap-3 overflow-y-auto rounded-none bg-transparent p-3">
            {GROUP_ORDER.map((groupName) => {
              const items = filteredSections.filter((item) => item.group === groupName);
              if (items.length === 0) return null;
              return (
                <div key={groupName} className="flex flex-col gap-0.5">
                  <span className="px-2.5 pb-1 text-[length:var(--font-size-micro)] font-medium tracking-wider text-muted-foreground">
                    {groupName}
                  </span>
                  {items.map((item) => (
                    <TabsTrigger
                      key={item.id}
                      value={item.id}
                      data-settings-section={item.id}
                      className={SECTION_TRIGGER_CLASS}
                    >
                      {item.pluginSection ? (
                        <PluginBrandGlyph pluginId={item.pluginSection.pluginId} icon={item.pluginSection.icon} />
                      ) : (
                        <Icon name={item.icon} className="size-3.5 shrink-0 opacity-80" />
                      )}
                      <span className="truncate">{item.title}</span>
                    </TabsTrigger>
                  ))}
                </div>
              );
            })}
            {filteredSections.length === 0 && (
              <p className="px-2.5 py-4 text-xs text-muted-foreground">没有匹配的设置分区</p>
            )}
          </TabsList>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-8 py-6">
          {filteredSections.length === 0 ? (
            <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 py-8">
              <p className="text-sm font-medium">没有找到包含「{settingsQuery}」的设置项</p>
              <p className="text-xs text-muted-foreground">试试主题、DevTools、内存、审批或插件关键字。</p>
              <Button size="sm" variant="outline" onClick={() => setSettingsQuery('')}>
                清除搜索
              </Button>
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
              {activeDescriptor && (
                <div className="flex flex-col gap-1 border-b border-border pb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">{activeDescriptor.group}</span>
                    <span className="text-[11px] text-muted-foreground">/</span>
                    <h2 className="text-base font-medium">{activeDescriptor.title}</h2>
                  </div>
                  <p className="text-xs text-muted-foreground">{activeDescriptor.subtitle}</p>
                </div>
              )}

              {allSections.map((item) => (
                <TabsContent key={item.id} value={item.id}>
                  {item.render(renderCtx)}
                </TabsContent>
              ))}
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );
}
