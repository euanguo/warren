import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryQuickView } from '@/app/popover-root';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EnvironmentSidebar } from '@/features/environments/environment-sidebar';
import { EnvironmentTabstrip } from '@/features/environments/environment-tabstrip';
import { PluginCard } from '@/features/plugins/plugin-card';
import { MemoryPanel } from '@/features/settings/memory-panel';
import { SettingsPage } from '@/features/settings/settings-page';
import type { Environment, MemorySnapshot, TabState } from '@shared/types';
import { installMockEnvApi } from './setup';

function makeSnapshot(overrides: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    capturedAt: '2026-11-27T12:00:00.000Z',
    totalMemoryKb: 1600 * 1024,
    systemTotalKb: 16 * 1024 * 1024,
    systemFreeKb: 6 * 1024 * 1024,
    softLimitMb: 6144,
    pressure: 'normal',
    reclaimableMemoryKb: 620 * 1024,
    breakdown: {
      environmentsKb: 1020 * 1024,
      pluginsKb: 180 * 1024,
      shellKb: 160 * 1024,
      systemKb: 240 * 1024,
    },
    counts: {
      totalEnvs: 2,
      runningEnvs: 2,
      dormantEnvs: 0,
      activeTabs: 3,
      sleepingTabs: 1,
      runningPlugins: 1,
      processCount: 7,
    },
    environments: [
      {
        id: 'bg-shop',
        name: '后台店铺',
        status: 'running',
        memoryKb: 620 * 1024,
        cpuPercent: 4.5,
        activeTabs: 2,
        sleepingTabs: 1,
        pids: [5001],
        idleSeconds: 420,
        pinned: false,
        reclaimable: true,
        tabs: [
          {
            id: 't-1',
            space: 'person',
            title: '店铺首页',
            url: 'https://shop.example.com',
            active: true,
            sleeping: false,
            audible: false,
            pid: 5001,
            memoryKb: 400 * 1024,
            sharedPidCount: 2,
          },
          {
            id: 't-2',
            space: 'person',
            title: '订单列表',
            url: 'https://shop.example.com/orders',
            active: false,
            sleeping: false,
            audible: false,
            pid: 5001,
            memoryKb: 400 * 1024,
            sharedPidCount: 2,
          },
          {
            id: 't-3',
            space: 'agent',
            title: '历史报表',
            url: 'https://shop.example.com/report',
            active: false,
            sleeping: true,
            audible: false,
            memoryKb: 0,
            sharedPidCount: 0,
          },
        ],
      },
      {
        id: 'cur-work',
        name: '当前工作台',
        status: 'running',
        memoryKb: 400 * 1024,
        cpuPercent: 1.2,
        activeTabs: 1,
        sleepingTabs: 0,
        pids: [5002],
        idleSeconds: 5,
        pinned: false,
        reclaimable: false,
        protectedReason: 'selected',
        tabs: [
          {
            id: 't-cur',
            space: 'person',
            title: '控制台',
            url: 'https://console.example.com',
            active: true,
            sleeping: false,
            audible: false,
            pid: 5002,
            memoryKb: 400 * 1024,
            sharedPidCount: 1,
          },
        ],
      },
    ],
    plugins: [
      {
        id: 'com.warren.whistle',
        name: 'Whistle 代理',
        runtime: 'host',
        status: 'running',
        pid: 6001,
        memoryKb: 180 * 1024,
        cpuPercent: 0.8,
      },
    ],
    processes: [
      {
        pid: 5001,
        type: 'Tab',
        category: 'environment',
        label: '后台店铺 (2 标签)',
        memoryKb: 620 * 1024,
        cpuPercent: 4.5,
      },
      {
        pid: 6001,
        type: 'Utility',
        category: 'plugin',
        label: '插件：Whistle 代理',
        memoryKb: 180 * 1024,
        cpuPercent: 0.8,
      },
      {
        pid: 1001,
        type: 'Browser',
        category: 'system',
        label: 'Electron 主进程',
        memoryKb: 240 * 1024,
        cpuPercent: 1.0,
      },
    ],
    ...overrides,
  };
}

function makeEnv(id: string, status: Environment['status'] = 'running'): Environment {
  return {
    id,
    name: `环境 ${id}`,
    storagePath: `/tmp/${id}`,
    createdBy: 'human',
    status,
    headed: true,
    order: 0,
    createdAt: '2026-11-27T00:00:00.000Z',
    updatedAt: '2026-11-27T00:00:00.000Z',
    owner: 'none',
    activeSpaceId: 'person',
    spaces: [],
  };
}

describe('内存管理面板与快捷入口', () => {
  it('MemoryPanel 展示 PID 去重总内存、共享 PID 标签标注与治理动作', async () => {
    const snap = makeSnapshot();
    const hibernateBackground = vi.fn(async () => ({ hibernated: ['bg-shop'], count: 1 }));
    const sleepIdleTabs = vi.fn(async () => ({ slept: 1 }));
    const clearAllCaches = vi.fn(async () => ({ cleared: 2 }));
    const reclaimShellSurfaces = vi.fn(async () => ({ reclaimed: 1 }));
    const tabSleep = vi.fn(async () => ({ ok: true }));
    const setSettings = vi.fn(async (patch: Partial<import('@shared/types').AppSettings>) => ({
      controlPolicy: 'ask' as const,
      pluginPolicy: 'ask' as const,
      ...patch,
    }));

    installMockEnvApi({
      memorySnapshot: vi.fn(async () => snap),
      hibernateBackground,
      sleepIdleTabs,
      clearAllCaches,
      reclaimShellSurfaces,
      tabSleep,
      setSettings,
      settings: vi.fn(async () => ({
        controlPolicy: 'ask' as const,
        pluginPolicy: 'ask' as const,
        theme: 'dark' as const,
        maxRunning: 8,
        idleHibernateMinutes: 10,
        memorySoftLimitMb: 6144,
        tabSleepMinutes: 20,
        lazyRestoreTabs: true,
        throttleBackgroundTabs: true,
        lruEvictAction: 'hibernate' as const,
        pinnedEnvIds: [],
      })),
    });

    render(
      <TooltipProvider>
        <MemoryPanel />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-slot="memory-total"]')?.textContent).toBe('1.56 GB');
    });

    // 展开环境「后台店铺」查看共享 PID 与休眠标签标注
    fireEvent.click(screen.getByRole('button', { name: '展开环境 后台店铺 标签明细' }));
    expect(screen.getAllByText(/共享 PID · 2 标签/).length).toBe(2);
    expect(screen.getByText('休眠中 · 0 MB')).toBeTruthy();

    // 休眠单个非激活在线标签
    fireEvent.click(screen.getByRole('button', { name: '休眠标签' }));
    await waitFor(() => {
      expect(tabSleep).toHaveBeenCalledWith('bg-shop', 'person', 't-2');
    });

    // 触发顶部一键动作
    fireEvent.click(screen.getByRole('button', { name: /休眠全部后台环境/ }));
    await waitFor(() => expect(hibernateBackground).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '释放非激活标签' }));
    await waitFor(() => expect(sleepIdleTabs).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /清理 HTTP 缓存/ }));
    await waitFor(() => expect(clearAllCaches).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '回收空闲浮层' }));
    await waitFor(() => expect(reclaimShellSurfaces).toHaveBeenCalledTimes(1));

    // 点击「省内存」预设下发正确策略
    fireEvent.click(document.querySelector('[data-slot="memory-preset"][data-preset="eco"]')!);
    await waitFor(() => {
      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          memorySoftLimitMb: 3072,
          maxRunning: 4,
          idleHibernateMinutes: 5,
          tabSleepMinutes: 10,
          lazyRestoreTabs: true,
          throttleBackgroundTabs: true,
          lruEvictAction: 'hibernate',
        }),
      );
    });

    // 高级阈值默认收起，点击可展开
    const advToggle = document.querySelector('[data-slot="memory-advanced-toggle"]') as HTMLButtonElement;
    expect(advToggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-slot="memory-soft-limit"]')).toBeNull();
    fireEvent.click(advToggle);
    expect(advToggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-slot="memory-soft-limit"]')).not.toBeNull();
  });

  it('PluginCard 保存非 secret 设置项后保留输入框内容，卸载前走确认浮层并调用 pluginUninstall', async () => {
    const demoPlugin = {
      id: 'com.demo.p',
      name: '示例插件',
      version: '1.0.0',
      apiVersion: '4',
      packageName: 'demo-p',
      runtime: 'sandbox' as const,
      enabled: true,
      status: 'running' as const,
      permissions: [],
      granted: [],
      needsConfirmation: [],
      settings: [
        { key: 'endpoint', label: '接口地址', type: 'string' as const, value: 'https://a.test', configured: true },
      ],
      skillExposed: false,
      contributes: { commands: [], settings: [], surfaces: [], rpc: [] },
      dir: '/tmp/plugins/com.demo.p',
      installedAt: '2026-01-01T00:00:00.000Z',
      digest: '0'.repeat(64),
      source: 'path:/tmp/plugins/com.demo.p',
      resolved: '/tmp/plugins/com.demo.p',
    };
    const pluginConfigSet = vi.fn(async () => demoPlugin);
    const pluginUninstall = vi.fn(async () => {});
    const openOverlay = vi.fn(async () => true);
    installMockEnvApi({
      pluginConfigSet,
      pluginUninstall,
      openOverlay: openOverlay as unknown as import('@shared/types').EnvApi['openOverlay'],
    });

    const onChanged = vi.fn();
    render(
      <TooltipProvider>
        <PluginCard plugin={demoPlugin} onChanged={onChanged} />
      </TooltipProvider>,
    );

    const input = screen.getByDisplayValue('https://a.test') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://b.test' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(pluginConfigSet).toHaveBeenCalledWith('com.demo.p', 'endpoint', 'https://b.test');
    });
    expect(input.value).toBe('https://b.test');

    fireEvent.click(screen.getByRole('button', { name: '卸载插件 示例插件' }));
    await waitFor(() => {
      expect(openOverlay).toHaveBeenCalledWith(expect.objectContaining({ kind: 'confirm', destructive: true }));
      expect(pluginUninstall).toHaveBeenCalledWith('com.demo.p');
    });
  });

  it('SettingsPage 注册了「性能与内存」分节并可搜索定位', () => {
    render(
      <TooltipProvider>
        <SettingsPage
          section="memory"
          onSectionChange={vi.fn()}
          onChanged={vi.fn()}
          onClose={vi.fn()}
          pluginSections={[]}
          pluginErrors={[]}
          plugins={[]}
          environments={[makeEnv('alpha')]}
        />
      </TooltipProvider>,
    );

    const search = screen.getByRole('textbox', { name: '搜索设置' });
    fireEvent.change(search, { target: { value: '内存' } });
    const tabs = [...document.querySelectorAll('[data-slot="settings-page"] [role="tab"]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(tabs.some((t) => t?.includes('性能与内存'))).toBe(true);
    expect(document.querySelector('[data-slot="memory-panel"]')).not.toBeNull();
  });

  it('EnvironmentSidebar 底部展示内存胶囊，点击打开 memory-quick，右键菜单提供休眠与清缓存', async () => {
    const onHibernate = vi.fn();
    const onClearCache = vi.fn();
    const popupMenu = vi.fn(async () => 'hibernate');
    const controls = installMockEnvApi({
      memorySnapshot: vi.fn(async () => makeSnapshot({ totalMemoryKb: 1024 * 1024, pressure: 'elevated' })),
      popupMenu,
    });

    render(
      <TooltipProvider>
        <SidebarProvider>
          <EnvironmentSidebar
            environments={[makeEnv('alpha', 'running')]}
            groups={[]}
            selected="alpha"
            onSelect={vi.fn()}
            onStart={vi.fn()}
            onStop={vi.fn()}
            onHibernate={onHibernate}
            onClearCache={onClearCache}
            onRemove={vi.fn()}
            onTakeover={vi.fn()}
            onRelease={vi.fn()}
            onRenameGroup={vi.fn()}
            onRemoveGroup={vi.fn()}
            onToggleGroup={vi.fn()}
            onMoveToGroup={vi.fn()}
          />
        </SidebarProvider>
      </TooltipProvider>,
    );

    const capsule = document.querySelector('[data-slot="sidebar-memory-capsule"]') as HTMLButtonElement;
    expect(capsule).not.toBeNull();
    await waitFor(() => {
      expect(capsule.textContent).toContain('1.00 GB');
    });

    fireEvent.click(capsule);
    expect(controls.openPopover).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'memory-quick', placement: 'top-start', focusable: true }),
    );

    // 右键环境行应暴露「休眠（保留登录态）」与「清理 HTTP 缓存」
    fireEvent.contextMenu(screen.getByText('环境 alpha'));
    await waitFor(() => {
      const items = (popupMenu.mock.calls[0] as unknown[] | undefined)?.[0] as Array<{ id?: string; label?: string }>;
      expect(items.some((item) => item.id === 'hibernate' && item.label?.includes('休眠'))).toBe(true);
      expect(items.some((item) => item.id === 'clear-cache')).toBe(true);
      expect(onHibernate).toHaveBeenCalledWith('alpha');
    });
  });

  it('MemoryQuickView 展示高占用环境并可跳转完整内存面板', async () => {
    const controls = installMockEnvApi({
      memorySnapshot: vi.fn(async () => makeSnapshot()),
    });

    render(
      <TooltipProvider>
        <MemoryQuickView />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('后台店铺')).toBeTruthy();
      expect(screen.getByText('1.56 GB')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '完整面板' }));
    expect(controls.dispatchPopoverAction).toHaveBeenCalledWith({
      id: 'memory-quick',
      action: 'openMemoryPanel',
    });
    expect(controls.closePopover).toHaveBeenCalledWith('memory-quick');
  });

  it('EnvironmentTabstrip 标记休眠标签，非激活在线标签右键可触发休眠', async () => {
    const onSleep = vi.fn();
    const popupMenu = vi.fn(async () => 'sleep');
    installMockEnvApi({
      popupMenu,
    });

    const tabs: TabState[] = [
      {
        id: 't1',
        space: 'person',
        title: '激活页',
        url: 'https://a.test',
        loading: false,
        audible: false,
        muted: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 't2',
        space: 'person',
        title: '后台在线页',
        url: 'https://b.test',
        loading: false,
        audible: false,
        muted: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 't3',
        space: 'person',
        title: '后台休眠页',
        url: 'https://c.test',
        loading: false,
        audible: false,
        muted: false,
        sleeping: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    render(
      <TooltipProvider>
        <EnvironmentTabstrip
          tabs={tabs}
          activeTabId="t1"
          canReload
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onReload={vi.fn()}
          onCloseOthers={vi.fn()}
          onCloseRight={vi.fn()}
          onReorder={vi.fn()}
          onToggleMute={vi.fn()}
          onSleep={onSleep}
        />
      </TooltipProvider>,
    );

    const sleepingNode = document.querySelector('[data-tab-id="t3"]');
    expect(sleepingNode?.getAttribute('data-tab-sleeping')).toBe('true');

    const bgOnlineNode = document.querySelector('[data-tab-id="t2"]')!;
    fireEvent.contextMenu(bgOnlineNode);
    await waitFor(() => {
      const items = (popupMenu.mock.calls[0] as unknown[] | undefined)?.[0] as Array<{
        id?: string;
        enabled?: boolean;
      }>;
      const sleepItem = items.find((item) => item.id === 'sleep');
      expect(sleepItem?.enabled).toBe(true);
      expect(onSleep).toHaveBeenCalledWith('t2');
    });
  });
});
