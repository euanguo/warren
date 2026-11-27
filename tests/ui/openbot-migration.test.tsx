import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelResizer } from '@/components/ui/panel-resizer';
import { Switch } from '@/components/ui/switch';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EnvironmentInspector } from '@/features/environments/environment-inspector';
import { EnvironmentTabstrip } from '@/features/environments/environment-tabstrip';
import { GeneralPanel } from '@/features/settings/general-panel';
import { applyTheme } from '@/lib/theme';
import { refreshPluginsAndSettings } from '@/state/plugin-store';
import { BUILTIN_SKINS } from '@shared/skin';
import type { Environment, TabState } from '@shared/types';
import { installMockEnvApi } from './setup';

function makeEnv(): Environment {
  return {
    id: 'alpha',
    name: 'Alpha Workspace',
    storagePath: '/tmp/alpha',
    createdBy: 'human',
    status: 'running',
    headed: true,
    order: 0,
    createdAt: '2026-11-27T00:00:00.000Z',
    updatedAt: '2026-11-27T00:00:00.000Z',
    owner: 'none',
    activeSpaceId: 'person',
    spaces: [{ id: 'person', label: '我的', owner: 'none', tabs: [] }],
  };
}

function makeTab(id: string, title: string): TabState {
  return {
    id,
    url: `https://example.com/${id}`,
    title,
    loading: false,
    audible: false,
    muted: false,
    space: 'person',
    createdAt: '2026-11-27T00:00:00.000Z',
  };
}

describe('OpenBot 设计体系迁移与可配置配色皮肤回归测试', () => {
  beforeEach(() => {
    installMockEnvApi();
    applyTheme('dark', 'neutral', {});
  });

  it('GeneralPanel 展示全部可抽离内置配色皮肤，切换皮肤时仅更新色板变量', async () => {
    const mocks = installMockEnvApi();
    await refreshPluginsAndSettings(false);

    render(<GeneralPanel />);

    for (const skin of BUILTIN_SKINS) {
      expect(document.querySelector(`[data-slot="skin-option-${skin.id}"]`)).not.toBeNull();
    }

    const neutralBtn = document.querySelector<HTMLButtonElement>('[data-slot="skin-option-neutral"]')!;
    expect(neutralBtn.getAttribute('aria-pressed')).toBe('true');
    expect(neutralBtn.querySelector('[data-slot="choice-radio"][data-checked="true"]')).not.toBeNull();

    const paperBtn = document.querySelector<HTMLButtonElement>('[data-slot="skin-option-paper"]')!;
    fireEvent.click(paperBtn);

    await waitFor(() => {
      expect(mocks.api.setSettings).toHaveBeenCalledWith({ skin: 'paper', skinOverrides: {} });
    });

    applyTheme('dark', 'paper');
    expect(document.documentElement.dataset.skin).toBe('paper');
    expect(document.documentElement.style.getPropertyValue('--bg-canvas')).toBe('#1c1a17');
    expect(document.documentElement.style.getPropertyValue('--radius-card')).toBe('');
  });

  it('PanelResizer 支持键盘步进、双击重置与迟滞吸附紧凑态（snap）', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const onCompactChange = vi.fn();

    const { rerender } = render(
      <PanelResizer
        label="调整侧栏"
        controls="sidebar"
        direction="left"
        value={200}
        defaultValue={248}
        min={176}
        max={400}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        snap={{
          compactValue: 72,
          compact: false,
          collapseThreshold: 110,
          expandThreshold: 118,
          onCompactChange,
        }}
      />,
    );

    const handle = screen.getByRole('separator', { name: '调整侧栏' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenCalledWith(212);
    expect(onResizeEnd).toHaveBeenCalledWith(212);

    fireEvent.keyDown(handle, { key: 'Home' });
    expect(onCompactChange).toHaveBeenCalledWith(true);

    onResize.mockClear();
    onCompactChange.mockClear();
    rerender(
      <PanelResizer
        label="调整侧栏"
        controls="sidebar"
        direction="left"
        value={200}
        defaultValue={248}
        min={176}
        max={400}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        snap={{
          compactValue: 72,
          compact: true,
          collapseThreshold: 110,
          expandThreshold: 118,
          onCompactChange,
        }}
      />,
    );

    fireEvent.doubleClick(handle);
    expect(onCompactChange).toHaveBeenCalledWith(false);
    expect(onResize).toHaveBeenCalledWith(248);
  });

  it('Switch 具备物理弹簧结构并正确响应点击切换', () => {
    const onChange = vi.fn();
    render(<Switch aria-label="测试开关" checked={false} onCheckedChange={onChange} />);

    const sw = screen.getByRole('switch', { name: '测试开关' });
    expect(sw.querySelector('[data-slot="switch-thumb"]')).not.toBeNull();
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalled();
  });

  it('EnvironmentTabstrip 挂载凹角 TabShape 与 variant=chrome 标签', () => {
    render(
      <TooltipProvider>
        <EnvironmentTabstrip
          tabs={[makeTab('t1', '首页'), makeTab('t2', '设置')]}
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
        />
      </TooltipProvider>,
    );

    expect(document.querySelector('[data-slot="tab-shape"]')).not.toBeNull();
    const tabs = document.querySelectorAll<HTMLElement>('[data-slot="surface-tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].dataset.variant).toBe('chrome');
    expect(tabs[0].dataset.state).toBe('active');
  });

  it('EnvironmentInspector 使用边缘 mask-fade 标签栏，并支持最大化与关闭回调', () => {
    const onToggleMaximize = vi.fn();
    const onClose = vi.fn();

    render(
      <TooltipProvider>
        <EnvironmentInspector
          current={makeEnv()}
          events={[]}
          snapshotLoading={false}
          consoleEntries={[]}
          networkEntries={[]}
          netRules={[]}
          netHits={[]}
          onNetRuleToggle={vi.fn()}
          activeTab="events"
          onTabChange={vi.fn()}
          onRefreshSnapshot={vi.fn()}
          maximized={false}
          onToggleMaximize={onToggleMaximize}
          onClose={onClose}
        />
      </TooltipProvider>,
    );

    const tabsList = document.querySelector<HTMLElement>('[data-slot="tabs-list"]');
    expect(tabsList?.className).toContain('warren-fade-x');
    expect(tabsList?.dataset.variant).toBe('pill');
    expect(tabsList?.className).not.toContain('data-[variant=pill]:p-0');

    fireEvent.click(document.querySelector('[data-slot="inspector-maximize-toggle"]')!);
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.click(document.querySelector('[data-slot="inspector-close"]')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
