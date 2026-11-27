import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EnvironmentSidebar } from '@/features/environments/environment-sidebar';
import { PluginCard } from '@/features/plugins/plugin-card';
import type { InstalledPlugin } from '@shared/types';

function makeSidebarProps(overrides: { ready?: boolean } = {}) {
  return {
    environments: [],
    groups: [],
    selected: undefined,
    ready: overrides.ready,
    compact: false,
    pluginActions: [],
    onSelect: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onRemove: vi.fn(),
    onTakeover: vi.fn(),
    onRelease: vi.fn(),
    onRenameGroup: vi.fn(),
    onRemoveGroup: vi.fn(),
    onToggleGroup: vi.fn(),
    onMoveToGroup: vi.fn(),
    onRunPluginAction: vi.fn(),
  };
}

describe('启动优化首屏与插件渐进状态', () => {
  it('EnvironmentSidebar 在 ready=false 时展示骨架占位，不误闪「还没有环境」空态', () => {
    const { rerender } = render(
      <TooltipProvider>
        <SidebarProvider>
          <EnvironmentSidebar {...makeSidebarProps({ ready: false })} />
        </SidebarProvider>
      </TooltipProvider>,
    );

    expect(document.querySelector('[data-slot="sidebar-loading"]')).not.toBeNull();
    expect(screen.getByText('正在加载环境…')).toBeTruthy();
    expect(screen.queryByText(/还没有环境/)).toBeNull();

    rerender(
      <TooltipProvider>
        <SidebarProvider>
          <EnvironmentSidebar {...makeSidebarProps({ ready: true })} />
        </SidebarProvider>
      </TooltipProvider>,
    );

    expect(document.querySelector('[data-slot="sidebar-loading"]')).toBeNull();
    expect(screen.getByText(/还没有环境/)).toBeTruthy();
    expect(screen.getByText('0 运行 / 0 环境')).toBeTruthy();
  });

  it('PluginCard 正确展示后台启动中的 starting 状态徽标', () => {
    const plugin: InstalledPlugin = {
      id: 'com.warren.whistle',
      packageName: 'warren-plugin-whistle',
      name: 'Whistle 代理',
      version: '1.0.0',
      apiVersion: '4',
      runtime: 'host',
      host: 'host.mjs',
      permissions: [],
      granted: [],
      needsConfirmation: [],
      enabled: true,
      skillExposed: true,
      status: 'starting',
      contributes: { commands: [], settings: [], surfaces: [], rpc: [] },
      settings: [],
      dir: '/tmp/whistle',
      installedAt: '2026-01-01T00:00:00.000Z',
      digest: 'abc123',
      source: 'path:/tmp/whistle',
      resolved: 'path:/tmp/whistle',
    };

    render(
      <TooltipProvider>
        <PluginCard plugin={plugin} onChanged={vi.fn()} />
      </TooltipProvider>,
    );

    expect(screen.getByText('启动中')).toBeTruthy();
  });
});
