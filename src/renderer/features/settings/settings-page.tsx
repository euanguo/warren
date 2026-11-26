import { useEffect, useMemo, useRef } from 'react';
import { PluginSurfaceHost } from '@/app/plugin-surfaces';
import { Icon, type IconName } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PluginsPanel } from '@/features/plugins/plugins-panel';
import { VaultPanel } from '@/features/plugins/vault-panel';
import { AgentPanel } from '@/features/settings/agent-panel';
import { ApprovalPanel } from '@/features/settings/approval-panel';
import { BrowserPanel } from '@/features/settings/browser-panel';
import { DiagnosticsPanel } from '@/features/settings/diagnostics-panel';
import { GeneralPanel } from '@/features/settings/general-panel';
import type { PluginSettingsSection } from '@/lib/plugin-runtime';
import { setSettingsQuery, useNavigationState, type SettingsSection } from '@/state/navigation-store';
import type { Environment, InstalledPlugin } from '@shared/types';

export type { SettingsSection };

const SECTION_TRIGGER_CLASS = 'h-auto! flex-none justify-start gap-2 px-2.5 py-1.5 text-left';

interface SectionDescriptor {
  id: SettingsSection;
  group: '基础' | '研发' | '自动化' | '安全' | '扩展' | '维护';
  title: string;
  subtitle: string;
  icon: IconName;
  keywords: string;
  pluginSection?: PluginSettingsSection;
}

const BUILTIN_SECTIONS: SectionDescriptor[] = [
  {
    id: 'general',
    group: '基础',
    title: '通用与外观',
    subtitle: '切换深浅主题、调整顶栏密度与页面圆角、管理数据根目录。',
    icon: 'Sliders',
    keywords: '通用 外观 主题 深色 浅色 跟随系统 紧凑 顶栏 圆角 数据目录 theme dark light system compact warren_home',
  },
  {
    id: 'browser',
    group: '研发',
    title: '浏览器与 DevTools',
    subtitle: '设置开发者工具默认停靠方式、默认视口、并发与休眠阈值以及按域偏好。',
    icon: 'Code',
    keywords: '浏览器 devtools 开发者工具 停靠 右侧 底部 独立 视口 缩放 并发 休眠 按域 历史 dock viewport maxrunning',
  },
  {
    id: 'agent',
    group: '自动化',
    title: 'Agent 与审批',
    subtitle: '配置控制权审批门控、Lease 租约时长、底部控制胶囊与内置 Skill 安装。',
    icon: 'Robot',
    keywords: 'agent 审批 控制权 租约 lease ttl 胶囊 skill claude codex opencode cli',
  },
  {
    id: 'vault',
    group: '安全',
    title: '凭据与安全边界',
    subtitle: '使用系统 Keychain 安全录入或移除凭据，审视无明文回流机制。',
    icon: 'Key',
    keywords: '凭据 vault key keychain 代理 密码 token 安全 边界',
  },
  {
    id: 'plugins',
    group: '扩展',
    title: '插件管理',
    subtitle: '安装、启停、重载插件，批准 confirm 权限矩阵，检索插件子进程日志。',
    icon: 'Plug',
    keywords: '插件 管理 权限 日志 安装 vm host sandbox plugin',
  },
  {
    id: 'diagnostics',
    group: '维护',
    title: '诊断与关于',
    subtitle: '执行全局健康自检（Doctor）、导出脱敏报告、查看运行时与数据目录。',
    icon: 'Activity',
    keywords: '诊断 自检 doctor 关于 版本 sqlite wal rpc socket 清理 报告',
  },
];

const GROUP_ORDER: Array<SectionDescriptor['group']> = ['基础', '研发', '自动化', '安全', '扩展', '维护'];

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
      if (event.key !== 'Escape') return;
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
      group: '扩展',
      title: pluginSection.title,
      subtitle: pluginSection.description || `扩展「${pluginSection.pluginId}」专属配置`,
      icon: 'Plug',
      keywords: `${pluginSection.pluginId} ${pluginSection.title} ${pluginSection.description ?? ''} 插件 扩展`,
      pluginSection,
    }));
    const list = [...BUILTIN_SECTIONS];
    // 把动态插件分节紧挨着「插件管理」插进「扩展」组
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

  return (
    <div data-slot="settings-page" className="flex h-full min-h-0 flex-col bg-background">
      {/* 标题行：左标题 · 中搜索 · 右返回环境，并与工作台保持完全一致的行高。 */}
      <header className="flex h-[var(--shell-chrome-row-height)] shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">设置中心</span>
          {settingsQuery.trim() && (
            <span className="text-xs text-muted-foreground">匹配 {filteredSections.length} 项</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative w-64">
            <Icon
              name="Search"
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchRef}
              value={settingsQuery}
              onChange={(event) => setSettingsQuery(event.target.value)}
              placeholder="搜索设置、选项或插件…"
              aria-label="搜索设置"
              className="h-7 pr-7 pl-8 text-xs"
            />
            {settingsQuery && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => {
                  setSettingsQuery('');
                  searchRef.current?.focus();
                }}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <Icon name="X" className="size-3.5" />
              </button>
            )}
          </div>

          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose} data-slot="settings-back">
              <Icon name="ChevronLeft" />
              <span>返回环境</span>
              <Kbd>Esc</Kbd>
            </Button>
          )}
        </div>
      </header>

      <Tabs
        orientation="vertical"
        value={effectiveSection}
        onValueChange={(value) => onSectionChange(value as SettingsSection)}
        className="min-h-0 flex-1 gap-0"
      >
        <TabsList className="h-auto! w-52 shrink-0 flex-col items-stretch justify-start gap-3 overflow-y-auto rounded-none border-r border-border bg-transparent p-3">
          {GROUP_ORDER.map((groupName) => {
            const items = filteredSections.filter((item) => item.group === groupName);
            if (items.length === 0) return null;
            return (
              <div key={groupName} className="flex flex-col gap-0.5">
                <span className="px-2.5 pb-1 text-[10px] font-medium tracking-wider text-muted-foreground">
                  {groupName}
                </span>
                {items.map((item) => (
                  <TabsTrigger
                    key={item.id}
                    value={item.id}
                    data-settings-section={item.id}
                    className={SECTION_TRIGGER_CLASS}
                  >
                    <Icon name={item.icon} className="size-3.5 shrink-0 opacity-80" />
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

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
          {filteredSections.length === 0 ? (
            <div className="mx-auto flex max-w-2xl flex-col items-start gap-2 py-8">
              <p className="text-sm font-medium">没有找到包含「{settingsQuery}」的设置项</p>
              <p className="text-xs text-muted-foreground">试试主题、DevTools、审批、Vault 或插件关键字。</p>
              <Button size="sm" variant="outline" onClick={() => setSettingsQuery('')}>
                清除搜索
              </Button>
            </div>
          ) : (
            <div className="mx-auto flex max-w-2xl flex-col gap-4">
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

              <TabsContent value="general">
                <GeneralPanel />
              </TabsContent>
              <TabsContent value="browser">
                <BrowserPanel />
              </TabsContent>
              <TabsContent value="agent">
                <div className="flex flex-col gap-5">
                  <ApprovalPanel environments={environments} />
                  <AgentPanel />
                </div>
              </TabsContent>
              <TabsContent value="vault">
                <VaultPanel />
              </TabsContent>
              <TabsContent value="plugins">
                <PluginsPanel onChanged={onChanged} plugins={plugins} pluginErrors={pluginErrors} />
              </TabsContent>
              <TabsContent value="diagnostics">
                <DiagnosticsPanel />
              </TabsContent>
              {pluginSections.map((pluginSection) => (
                <TabsContent
                  key={`${pluginSection.pluginId}:${pluginSection.id}`}
                  value={`plugin:${pluginSection.pluginId}:${pluginSection.id}`}
                >
                  <PluginSurfaceHost
                    pluginId={pluginSection.pluginId}
                    title={pluginSection.title}
                    Component={pluginSection.component}
                    props={{ pluginId: pluginSection.pluginId }}
                  />
                </TabsContent>
              ))}
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );
}
