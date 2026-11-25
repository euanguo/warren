import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PluginsPanel } from '@/features/plugins/plugins-panel';
import { VaultPanel } from '@/features/plugins/vault-panel';
import { AgentPanel } from '@/features/settings/agent-panel';
import { ApprovalPanel } from '@/features/settings/approval-panel';
import { PluginSurfaceHost } from '@/app/plugin-surfaces';
import type { PluginSettingsSection } from '@/lib/plugin-runtime';
import type { Environment, InstalledPlugin } from '@shared/types';

/**
 * 设置的分节 id。
 *
 * 内置三节是固定字符串；插件声明的分节用 `plugin:<插件 id>:<面 id>`，
 * 这样插件之间不会撞 id，也一眼看得出来源。
 */
export type SettingsSection = string;

/**
 * 竖向分节条目的类。
 *
 * 组件的基础变体给的是 `h-[calc(100%-1px)]` + `flex-1` —— 那是给**横向** tab 用的
 * （横向时每项要平分宽度、填满控件高度）。竖向列表里这两个会把**每一项都撑到整列高**
 * （实测：列表 870px，每个条目 853px），所以两个都要用 `!` 盖掉。
 */
const SECTION_TRIGGER_CLASS = 'h-auto! flex-none justify-start px-2 py-1.5';

interface Props {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onChanged: () => void;
  /** 插件往设置里加的分节 */
  pluginSections?: PluginSettingsSection[];
  /** 插件加载失败的原因，显示在插件页顶部 */
  pluginErrors?: Array<{ pluginId: string; message: string }>;
  plugins?: InstalledPlugin[];
  /** 审批那一页要列出每个环境的例外 */
  environments?: Environment[];
}

/**
 * 设置页。**不是弹窗** —— 它替换 stage（右侧）那一块，和插件页同一个位置。
 *
 * 为什么不做弹窗：弹窗要自己算高度、自己管滚动，而且浮层压在原生页面视图上还得让位
 * （见 `lib/native-view-overlay-guard.ts`）。做成一个面板后这些都归 stage 那套布局管，
 * 和「插件页替换 stage」走同一条路（App.tsx 的 `stageReplaced`）。
 *
 * 用 Tabs 的 vertical 朝向而不是自己拼两个 div —— 键盘左右/上下切换、
 * `role=tablist` / `aria-selected` 都是它自带的。
 */
export function SettingsPage({
  section,
  onSectionChange,
  onChanged,
  pluginSections = [],
  pluginErrors = [],
  plugins = [],
  environments = [],
}: Props) {
  return (
    <div data-slot="settings-page" className="flex h-full min-h-0 flex-col bg-background">
      {/* 标题行：和侧栏卡片、内容卡片的顶行等高，三列横向才是一条线 */}
      <header className="flex h-[var(--shell-chrome-row-height)] shrink-0 items-center border-b border-border px-4">
        <span className="text-sm font-medium">设置</span>
      </header>

      <Tabs
        orientation="vertical"
        value={section}
        onValueChange={(value) => onSectionChange(value as SettingsSection)}
        className="min-h-0 flex-1 gap-0"
      >
        {/*
          导航列：定宽、整行可点、右侧一条分隔线。默认的胶囊底在这里会变成一块浮起来的小药丸。
          `h-auto!` 要带 important —— 组件的基础变体里有 `group-data-vertical/tabs:h-fit`
          在抢（那是给别处的竖向 tab 用的），不加 `!` 右边那条 `border-r` 画不到底。
          实测：`h-fit` 116px → `h-auto!` 撑满父级。
        */}
        <TabsList className="h-auto! w-44 shrink-0 flex-col items-stretch justify-start gap-0.5 rounded-none border-r border-border bg-transparent p-2">
          <TabsTrigger value="plugins" className={SECTION_TRIGGER_CLASS}>
            插件
          </TabsTrigger>
          <TabsTrigger value="agent" className={SECTION_TRIGGER_CLASS}>
            Agent
          </TabsTrigger>
          <TabsTrigger value="approval" className={SECTION_TRIGGER_CLASS}>
            审批
          </TabsTrigger>
          <TabsTrigger value="vault" className={SECTION_TRIGGER_CLASS}>
            凭据
          </TabsTrigger>
          {pluginSections.map((pluginSection) => (
            <TabsTrigger
              key={`${pluginSection.pluginId}:${pluginSection.id}`}
              value={`plugin:${pluginSection.pluginId}:${pluginSection.id}`}
              className={SECTION_TRIGGER_CLASS}
            >
              {pluginSection.title}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
          <TabsContent value="plugins">
            <PluginsPanel onChanged={onChanged} plugins={plugins} pluginErrors={pluginErrors} />
          </TabsContent>
          <TabsContent value="agent">
            <AgentPanel />
          </TabsContent>
          <TabsContent value="approval">
            <ApprovalPanel environments={environments} />
          </TabsContent>
          <TabsContent value="vault">
            <VaultPanel />
          </TabsContent>
          {pluginSections.map((pluginSection) => (
            <TabsContent
              key={`${pluginSection.pluginId}:${pluginSection.id}`}
              value={`plugin:${pluginSection.pluginId}:${pluginSection.id}`}
            >
              {pluginSection.description && (
                <p className="mb-3 text-xs text-muted-foreground">{pluginSection.description}</p>
              )}
              <PluginSurfaceHost
                pluginId={pluginSection.pluginId}
                title={pluginSection.title}
                Component={pluginSection.component}
                props={{ pluginId: pluginSection.pluginId }}
              />
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </div>
  );
}
