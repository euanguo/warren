import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppTitlebar } from '@/app/app-titlebar';
import { PluginSurfaceHost } from '@/app/plugin-surfaces';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EnvironmentInspector } from '@/features/environments/environment-inspector';
import { EnvironmentSidebar } from '@/features/environments/environment-sidebar';
import { EnvironmentStage } from '@/features/environments/environment-stage';
import { SettingsPage } from '@/features/settings/settings-page';
import type { Environment } from '@shared/types';

function makeEnvs(count: number): Environment[] {
  const now = '2026-01-01T00:00:00.000Z';
  return Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? 'cap' : `env-${index}`,
    name: index === 0 ? 'cap' : `环境 ${index}`,
    storagePath: `/tmp/warren-ui-${index}`,
    createdBy: 'human',
    status: index === 0 ? 'running' : 'stopped',
    headed: true,
    order: index,
    createdAt: now,
    updatedAt: now,
    owner: 'none',
    activeSpaceId: 'person',
    spaces: [
      {
        id: 'person',
        label: '我的',
        owner: 'none',
        tabs: [
          {
            id: 'p1',
            space: 'person',
            url: 'http://127.0.0.1:8899/cap/form.html',
            title: 'form fixture',
            loading: false,
            audible: false,
            muted: false,
            createdAt: now,
          },
        ],
      },
      {
        id: 'agent',
        label: 'Agent',
        owner: 'none',
        tabs: [
          {
            id: 'a1',
            space: 'agent',
            url: 'http://127.0.0.1:8899/cap/form.html',
            title: 'agent tab',
            loading: false,
            audible: false,
            muted: false,
            createdAt: now,
          },
        ],
      },
    ],
  }));
}

describe('无头迁移：原 scripts/regress/ui.cjs 核心外壳 / 工作台 / 设置 / 插件隔离用例', () => {
  it('7.1–7.2 侧栏列出 >=7 个环境行、分组段头（含未分组）与实时搜索过滤', () => {
    const envs = makeEnvs(7);
    const now = '2026-01-01T00:00:00.000Z';
    render(
      <TooltipProvider>
        <SidebarProvider>
          <EnvironmentSidebar
            environments={envs}
            groups={[{ id: 'g1', name: '工作组', collapsed: false, order: 0, createdAt: now, updatedAt: now }]}
            selected="cap"
            compact={false}
            pluginActions={[]}
            onSelect={vi.fn()}
            onStart={vi.fn()}
            onStop={vi.fn()}
            onRemove={vi.fn()}
            onTakeover={vi.fn()}
            onRelease={vi.fn()}
            onRenameGroup={vi.fn()}
            onRemoveGroup={vi.fn()}
            onToggleGroup={vi.fn()}
            onMoveToGroup={vi.fn()}
            onRunPluginAction={vi.fn()}
          />
        </SidebarProvider>
      </TooltipProvider>,
    );

    expect(document.querySelectorAll('[data-slot="list-row"]').length).toBe(7);
    const groupLabels = [...document.querySelectorAll('[data-slot="sidebar-group-label"]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(groupLabels.some((label) => label?.startsWith('未分组'))).toBe(true);

    const search = screen.getByRole('textbox', { name: '搜索环境' });
    fireEvent.change(search, { target: { value: 'cap' } });
    expect(document.querySelectorAll('[data-slot="list-row"]').length).toBe(1);
  });

  it('7.3–7.8 顶栏全局入口、我的空间零接管噪音、Agent 空间控制胶囊与接管/交还流转', () => {
    const env = makeEnvs(1)[0];
    const onTakeover = vi.fn();
    const onRelease = vi.fn();
    const onSpaceSelect = vi.fn();

    const baseProps = {
      route: 'environments' as const,
      environment: env,
      groups: [],
      tabs: env.spaces![0].tabs,
      activeTabId: 'p1',
      running: true,
      canNavigate: true,
      sidebarOpen: true,
      railPages: [],
      pluginActions: [],
      onToggleSidebar: vi.fn(),
      onSpaceSelect,
      onTabSelect: vi.fn(),
      onTabClose: vi.fn(),
      onTabCreate: vi.fn(),
      onTabReload: vi.fn(),
      onTabHardReload: vi.fn(),
      onTabCloseOthers: vi.fn(),
      onTabCloseRight: vi.fn(),
      onTabReorder: vi.fn(),
      onTabToggleMute: vi.fn(),
      onStart: vi.fn(),
      onStop: vi.fn(),
      onRemove: vi.fn(),
      onMoveToGroup: vi.fn(),
      onRunPluginAction: vi.fn(),
      onTakeover,
      onRelease,
      onOpenCommandBar: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenPluginPage: vi.fn(),
      onBackToEnvironments: vi.fn(),
    };

    const { rerender } = render(
      <TooltipProvider>
        <AppTitlebar {...baseProps} activeSpaceId="person" locked={false} />
      </TooltipProvider>,
    );

    expect(screen.getByRole('button', { name: '扩展与全局页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '设置' })).toBeTruthy();
    expect(document.querySelector('[data-slot="env-capsule"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="control-pill"]')).toBeNull();

    // 切到 Agent Space（只读）
    fireEvent.click(document.querySelector('[data-space="agent"]')!);
    expect(onSpaceSelect).toHaveBeenCalledWith('cap', 'agent');

    rerender(
      <TooltipProvider>
        <AppTitlebar {...baseProps} activeSpaceId="agent" locked />
      </TooltipProvider>,
    );
    expect(document.querySelector('[data-slot="control-pill"]')?.textContent).toContain('Agent 空闲（只读）');
    fireEvent.click(screen.getByRole('button', { name: '接管编辑' }));
    expect(onTakeover).toHaveBeenCalledWith('cap');

    // 人接管后显示「你正在接管」与「交还」
    const takenEnv: Environment = {
      ...env,
      owner: 'human',
      spaces: env.spaces!.map((space) => (space.id === 'agent' ? { ...space, owner: 'human' } : space)),
    };
    rerender(
      <TooltipProvider>
        <AppTitlebar {...baseProps} environment={takenEnv} activeSpaceId="agent" locked={false} />
      </TooltipProvider>,
    );
    expect(document.querySelector('[data-slot="control-pill"]')?.textContent).toContain('你正在接管');
    fireEvent.click(screen.getByRole('button', { name: '交还' }));
    expect(onRelease).toHaveBeenCalledWith('cap');
  });

  it('7.9 停机环境选中后中央直接展示启动按钮并响应点击', () => {
    const stoppedEnv = makeEnvs(2)[1];
    const onStart = vi.fn();
    render(
      <TooltipProvider>
        <EnvironmentStage
          current={stoppedEnv}
          events={[]}
          snapshotLoading={false}
          onRefreshSnapshot={vi.fn()}
          onReadCookies={vi.fn()}
          consoleEntries={[]}
          networkEntries={[]}
          netRules={[]}
          netHits={[]}
          onNetRuleToggle={vi.fn()}
          stageRef={{ current: null }}
          stageReplaced={false}
          onStart={onStart}
          onStartAndNavigate={vi.fn()}
          onTabSelect={vi.fn()}
          onTabClose={vi.fn()}
          onTabCreate={vi.fn()}
          onTabReopen={vi.fn()}
          onNavigate={vi.fn()}
          pluginTabs={[]}
          pluginPopovers={[]}
          pluginStatusBadges={[]}
          pluginRailPages={[]}
        />
      </TooltipProvider>,
    );

    const startBtn = document.querySelector<HTMLButtonElement>('[data-slot="stage-start-button"]');
    expect(startBtn).not.toBeNull();
    fireEvent.click(startBtn!);
    expect(onStart).toHaveBeenCalledWith(stoppedEnv.id);
  });

  it('8.x 检查器各分页切换均可渲染有效面板内容', () => {
    const env = makeEnvs(1)[0];
    const onTabChange = vi.fn();
    const { rerender } = render(
      <TooltipProvider>
        <EnvironmentInspector
          current={env}
          events={[
            {
              id: 'ev1',
              environmentId: 'cap',
              actor: 'system',
              type: 'env.started',
              message: '环境已启动',
              createdAt: '2026-11-26T00:00:00.000Z',
            },
          ]}
          snapshotLoading={false}
          consoleEntries={[]}
          networkEntries={[]}
          netRules={[]}
          netHits={[]}
          onNetRuleToggle={vi.fn()}
          activeTab="events"
          onTabChange={onTabChange}
          onRefreshSnapshot={vi.fn()}
          pluginTabs={[]}
          environmentId="cap"
          space="person"
          url="http://127.0.0.1:8899/cap/form.html"
          onOpenPluginPage={vi.fn()}
        />
      </TooltipProvider>,
    );

    for (const tab of ['events', 'snapshot', 'console', 'network', 'rules', 'storage'] as const) {
      rerender(
        <TooltipProvider>
          <EnvironmentInspector
            current={env}
            events={[
              {
                id: 'ev1',
                environmentId: 'cap',
                actor: 'system',
                type: 'env.started',
                message: '环境已启动',
                createdAt: '2026-11-26T00:00:00.000Z',
              },
            ]}
            snapshotLoading={false}
            consoleEntries={[]}
            networkEntries={[]}
            netRules={[]}
            netHits={[]}
            onNetRuleToggle={vi.fn()}
            activeTab={tab}
            onTabChange={onTabChange}
            onRefreshSnapshot={vi.fn()}
            pluginTabs={[]}
            environmentId="cap"
            space="person"
            url="http://127.0.0.1:8899/cap/form.html"
            onOpenPluginPage={vi.fn()}
          />
        </TooltipProvider>,
      );
      const visiblePanel = [...document.querySelectorAll('[data-slot="tabs-content"]')].find(
        (el) => !el.hasAttribute('hidden'),
      );
      expect((visiblePanel?.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('10.1–10.3 设置页分节完整、可搜索过滤、可切换分节', () => {
    const onSectionChange = vi.fn();
    render(
      <TooltipProvider>
        <SettingsPage
          section="general"
          onSectionChange={onSectionChange}
          onChanged={vi.fn()}
          onClose={vi.fn()}
          pluginSections={[]}
          pluginErrors={[]}
          plugins={[]}
          environments={makeEnvs(2)}
        />
      </TooltipProvider>,
    );

    const tabs = [...document.querySelectorAll('[data-slot="settings-page"] [role="tab"]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(tabs.some((t) => t?.includes('插件'))).toBe(true);
    expect(tabs.some((t) => t?.includes('Agent'))).toBe(true);
    expect(tabs.some((t) => t?.includes('性能与内存'))).toBe(true);
    expect(tabs.some((t) => t?.includes('凭据'))).toBe(false);

    const search = screen.getByRole('textbox', { name: '搜索设置' });
    fireEvent.change(search, { target: { value: '内存' } });
    expect(document.querySelectorAll('[data-slot="settings-page"] [data-settings-section]').length).toBe(1);
  });

  it('11.x 坏插件在 PluginSurfaceHost 内被隔离渲染错误卡片，不拖垮宿主节点', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function BrokenPlugin(): ReactNode {
      throw new Error('simulated plugin crash');
    }

    render(
      <div>
        <div data-testid="host-shell">宿主正常</div>
        <PluginSurfaceHost
          pluginId="com.example.broken"
          title="坏插件"
          Component={BrokenPlugin}
          props={{
            pluginId: 'com.example.broken',
            environmentId: 'cap',
            space: 'person',
            url: 'http://127.0.0.1:8899/cap/form.html',
            openPluginPage: vi.fn(),
            openInspectorTab: vi.fn(),
          }}
        />
      </div>,
    );

    expect(screen.getByTestId('host-shell').textContent).toBe('宿主正常');
    const errorBox = document.querySelector('[data-slot="plugin-surface-error"]');
    expect(errorBox).not.toBeNull();
    expect(errorBox?.textContent).toContain('simulated plugin crash');
    errSpy.mockRestore();
  });
});
