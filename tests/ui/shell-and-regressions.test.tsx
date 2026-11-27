import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppTitlebar } from '@/app/app-titlebar';
import { AddressSuggestView } from '@/app/popover-root';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarProvider } from '@/components/ui/sidebar';
import { SurfaceTab } from '@/components/ui/surface-tab';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { EnvironmentAddressBar } from '@/features/environments/environment-address-bar';
import { DevToolsResizeHandle } from '@/features/environments/devtools-resize-handle';
import { SimulatedViewportBackdrop } from '@/features/environments/stage-overlays';
import { computeSimulatedPageBounds } from '@shared/viewport-presets';
import { EnvironmentSidebar } from '@/features/environments/environment-sidebar';
import { EnvironmentSpaceSwitcher } from '@/features/environments/environment-space-switcher';
import { SidebarEnvRow } from '@/features/environments/sidebar-env-row';
import type { Environment, TabState, UrlHistoryEntry } from '@shared/types';
import { installMockEnvApi } from './setup';

const ROOT = path.resolve(import.meta.dirname, '../..');

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'cap',
    name: 'cap',
    storagePath: '/tmp/warren-ui-cap',
    createdBy: 'human',
    status: 'running',
    headed: true,
    order: 0,
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
            id: 't1',
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
            title: 'form fixture',
            loading: false,
            audible: false,
            muted: false,
            createdAt: now,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeTabs(count: number): TabState[] {
  const now = '2026-01-01T00:00:00.000Z';
  return Array.from({ length: count }, (_, i) => ({
    id: `tab-${i + 1}`,
    space: 'person',
    url: `http://127.0.0.1:8899/cap/form.html?tab=${i + 1}`,
    title: `127.0.0.1:8899/cap/form-${i + 1}`,
    loading: false,
    audible: false,
    muted: false,
    createdAt: now,
  }));
}

describe('图一：Tooltip 浅色/深色对比度与 reduced-transparency 契约', () => {
  it('TooltipContent 使用 text-tooltip-foreground 且不回退到 text-popover-foreground', () => {
    render(
      <TooltipProvider delay={0}>
        <Tooltip open>
          <TooltipTrigger render={<button type="button">触发器</button>} />
          <TooltipContent>命令栏与全局搜索</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const popup = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
    expect(popup).not.toBeNull();
    expect(popup?.className).toContain('bg-tooltip');
    expect(popup?.className).toContain('text-tooltip-foreground');
    expect(popup?.className).not.toContain('text-popover-foreground');
  });

  it('theme-tokens.css 在浅色、深色与 reduced-transparency 下保持 tooltip 前景/背景成对定义', () => {
    const css = readFileSync(path.join(ROOT, 'src/renderer/theme/theme-tokens.css'), 'utf8');
    expect(css).toMatch(/--tooltip:\s*#1c1c1e;/);
    expect(css).toMatch(/--tooltip-foreground:\s*#ffffff;/);
    expect(css).toMatch(/--tooltip:\s*#2c2c2e;/);
    expect(css).toMatch(/prefers-reduced-transparency:\s*reduce[\s\S]*--blur-tooltip:\s*0px;/);
  });
});

describe('图二：顶栏多标签 + Agent 控制胶囊横向防溢出与红绿灯避让', () => {
  it('多标签与 Agent 控制胶囊同时出现时顶栏具备完整防溢出约束且保留红绿灯留位', () => {
    const env = makeEnv({ activeSpaceId: 'agent' });
    const tabs = makeTabs(6);
    render(
      <TooltipProvider>
        <AppTitlebar
          route="environments"
          environment={env}
          groups={[]}
          activeSpaceId="agent"
          tabs={tabs}
          activeTabId="tab-1"
          running
          locked
          canNavigate={false}
          sidebarOpen
          railPages={[]}
          pluginActions={[]}
          onToggleSidebar={vi.fn()}
          onSpaceSelect={vi.fn()}
          onTabSelect={vi.fn()}
          onTabClose={vi.fn()}
          onTabCreate={vi.fn()}
          onTabReload={vi.fn()}
          onTabHardReload={vi.fn()}
          onTabCloseOthers={vi.fn()}
          onTabCloseRight={vi.fn()}
          onTabReorder={vi.fn()}
          onTabToggleMute={vi.fn()}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onRemove={vi.fn()}
          onMoveToGroup={vi.fn()}
          onRunPluginAction={vi.fn()}
          onTakeover={vi.fn()}
          onRelease={vi.fn()}
          onOpenCommandBar={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenPluginPage={vi.fn()}
          onBackToEnvironments={vi.fn()}
        />
      </TooltipProvider>,
    );

    const header = document.querySelector<HTMLElement>('[data-slot="app-header"]');
    expect(header).not.toBeNull();
    expect(header?.className).toContain('pl-[84px]');
    expect(header?.className).toContain('w-full');
    expect(header?.className).toContain('min-w-0');
    expect(header?.className).toContain('overflow-hidden');

    const strip = document.querySelector<HTMLElement>('[data-slot="surface-tab-strip"]');
    expect(strip).not.toBeNull();
    expect(strip?.className).toContain('min-w-0');
    expect(strip?.className).toContain('overflow-x-auto');
    expect(strip?.parentElement?.className).toContain('overflow-hidden');
    expect(strip?.parentElement?.className).toContain('min-w-0');

    expect(document.querySelector('[data-slot="sidebar-toggle"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="env-capsule"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="control-pill"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-slot="surface-tab"]').length).toBe(6);
  });

  it('App.tsx 外层壳使用 bg-frame + overflow-clip + 单一 14px 圆角工作区卡片', () => {
    const appSrc = readFileSync(path.join(ROOT, 'src/renderer/app/App.tsx'), 'utf8');
    expect(appSrc).toContain('data-slot="app-frame"');
    expect(appSrc).toContain('overflow-clip bg-frame');
    expect(appSrc).toContain('data-slot="workbench-card"');
    expect(appSrc).toContain('rounded-[var(--shell-card-radius)] border border-border bg-canvas');
  });
});

describe('图三：壳层扁平层次（bg-canvas / bg-sidebar / bg-control）与隐形分割条', () => {
  it('地址栏、侧栏头部输入框与分隔条符合扁平发丝边框契约', () => {
    render(
      <TooltipProvider>
        <SidebarProvider>
          <EnvironmentSidebar
            environments={[makeEnv()]}
            groups={[]}
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
        <EnvironmentAddressBar
          envId="cap"
          spaceId="person"
          url="http://127.0.0.1:8899/cap/form.html"
          loading={false}
          editable
          running
          canGoBack={false}
          canGoForward={false}
          inspectorOpen={false}
          devToolsOpen={false}
          devToolsDock="right"
          zoomFactor={1}
          viewportPreset="auto"
          hasActiveDownload={false}
          pluginPopovers={[]}
          pluginStatusBadges={[]}
          pluginInspectorTabs={[]}
          pluginRailPages={[]}
          onToggleInspector={vi.fn()}
          onToggleDevTools={vi.fn()}
          onChangeDevToolsDock={vi.fn()}
          onResetZoom={vi.fn()}
          onOpenFind={vi.fn()}
          onNavigate={vi.fn()}
        />
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel id="a">A</ResizablePanel>
          <ResizableHandle subtle />
          <ResizablePanel id="b">B</ResizablePanel>
        </ResizablePanelGroup>
      </TooltipProvider>,
    );

    const addressBar = document.querySelector<HTMLElement>('[data-slot="address-bar"]');
    expect(addressBar?.className).toContain('bg-canvas');
    expect(addressBar?.className).toContain('border-b');

    const sidebarHeader = document.querySelector<HTMLElement>('[data-slot="sidebar-header"]');
    expect(sidebarHeader?.className).toContain('border-b');

    const sidebarInput = document.querySelector<HTMLElement>('[data-slot="sidebar-input"]');
    expect(sidebarInput?.className).toContain('bg-control');

    const handle = document.querySelector<HTMLElement>('[data-slot="resizable-handle"]');
    expect(handle?.className).toContain('after:bg-transparent');
  });
});

describe('图四：地址栏联想浮层动态高度与鼠标悬停选中', () => {
  const sampleEntries: UrlHistoryEntry[] = Array.from({ length: 4 }, (_, i) => ({
    url: `http://127.0.0.1:8899/cap/page-${i + 1}.html`,
    title: `Page ${i + 1}`,
    visitCount: (i + 1) * 10,
    lastVisitedAt: '2026-11-26T00:00:00.000Z',
  }));

  it('悬停与方向键更新只调用 updatePopover，不再反复 openPopover 重置浮窗', async () => {
    const mocks = installMockEnvApi();
    mocks.historySuggest.mockResolvedValue(sampleEntries);

    render(
      <TooltipProvider>
        <EnvironmentAddressBar
          envId="cap"
          spaceId="person"
          url="http://127.0.0.1:8899/cap/form.html"
          loading={false}
          editable
          running
          canGoBack={false}
          canGoForward={false}
          inspectorOpen={false}
          devToolsOpen={false}
          devToolsDock="right"
          zoomFactor={1}
          viewportPreset="auto"
          hasActiveDownload={false}
          pluginPopovers={[]}
          pluginStatusBadges={[]}
          pluginInspectorTabs={[]}
          pluginRailPages={[]}
          onToggleInspector={vi.fn()}
          onToggleDevTools={vi.fn()}
          onChangeDevToolsDock={vi.fn()}
          onResetZoom={vi.fn()}
          onOpenFind={vi.fn()}
          onNavigate={vi.fn()}
        />
      </TooltipProvider>,
    );

    const input = screen.getByRole('combobox', { name: '地址栏' });
    fireEvent.focus(input);

    await waitFor(() => {
      expect(mocks.openPopover).toHaveBeenCalledTimes(1);
    });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(mocks.updatePopover).toHaveBeenCalledWith(
        'address-suggest',
        expect.objectContaining({
          props: expect.objectContaining({ highlighted: 0 }),
        }),
      );
    });
    expect(mocks.openPopover).toHaveBeenCalledTimes(1);

    mocks.emitPopoverAction({ id: 'address-suggest', action: 'hover', payload: 2 });
    await waitFor(() => {
      expect(mocks.updatePopover).toHaveBeenCalledWith(
        'address-suggest',
        expect.objectContaining({
          props: expect.objectContaining({ highlighted: 2 }),
        }),
      );
    });
    expect(mocks.openPopover).toHaveBeenCalledTimes(1);
  });

  it('AddressSuggestView 鼠标移入即刻高亮并回传 hover/pick，高度按实测内容动态适配并在上限 320 封顶', async () => {
    const mocks = installMockEnvApi();
    const { rerender } = render(
      <AddressSuggestView props={{ query: '', entries: sampleEntries, highlighted: -1, width: 520 }} />,
    );

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(4);

    // 模拟鼠标移动至第 3 项：立即高亮 + 上报 hover
    fireEvent.mouseMove(options[2]);
    expect(options[2].getAttribute('aria-selected')).toBe('true');
    expect(options[2].hasAttribute('data-highlighted')).toBe(true);
    expect(options[2].className).toContain('bg-surface-selected');
    expect(mocks.dispatchPopoverAction).toHaveBeenCalledWith({
      id: 'address-suggest',
      action: 'hover',
      payload: 2,
    });

    // 键盘切换 highlighted 后立即跟进键盘项
    rerender(<AddressSuggestView props={{ query: '', entries: sampleEntries, highlighted: 3, width: 520 }} />);
    expect(screen.getAllByRole('option')[3].getAttribute('aria-selected')).toBe('true');

    // 点击选中触发 pick
    fireEvent.mouseDown(screen.getAllByRole('option')[1]);
    expect(mocks.dispatchPopoverAction).toHaveBeenCalledWith({
      id: 'address-suggest',
      action: 'pick',
      payload: sampleEntries[1].url,
    });

    // 动态高度测量：内容低于上限时贴合内容；超上限时夹紧到 320
    const content = document.querySelector<HTMLElement>('[data-slot="address-suggest-content"]');
    expect(content).not.toBeNull();
    vi.spyOn(content!, 'getBoundingClientRect').mockReturnValue({
      width: 512,
      height: 150,
      top: 0,
      left: 0,
      bottom: 150,
      right: 512,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    rerender(<AddressSuggestView props={{ query: 'a', entries: sampleEntries, highlighted: 0, width: 520 }} />);
    await waitFor(() => {
      expect(mocks.updatePopover).toHaveBeenCalledWith('address-suggest', {
        size: { width: 520, height: 158 },
      });
    });

    vi.spyOn(content!, 'getBoundingClientRect').mockReturnValue({
      width: 512,
      height: 480,
      top: 0,
      left: 0,
      bottom: 480,
      right: 512,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    rerender(<AddressSuggestView props={{ query: 'ab', entries: sampleEntries, highlighted: 0, width: 520 }} />);
    await waitFor(() => {
      expect(mocks.updatePopover).toHaveBeenCalledWith('address-suggest', {
        size: { width: 520, height: 320 },
      });
    });
  });
});

describe('图五：侧栏环境行比例与 ListRowBody 紧凑排版', () => {
  it('双行模式采用 28px 身份徽章与 1px 紧凑行距，单行模式回落为 20px 紧凑行', () => {
    const onSelect = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <ul>
        <SidebarEnvRow
          env={makeEnv()}
          selected
          compact={false}
          onSelect={onSelect}
          onStart={vi.fn()}
          onStop={onStop}
          onContextMenu={vi.fn()}
        />
      </ul>,
    );

    const row = document.querySelector<HTMLElement>('[data-slot="list-row"]');
    const chip = document.querySelector<HTMLElement>('[data-slot="env-identity-chip"]');
    expect(chip?.className).toContain('size-7');
    expect(row?.style.getPropertyValue('--list-row-body-gap')).toBe('1px');
    expect(row?.style.getPropertyValue('--list-row-gap')).toBe('0.625rem');

    fireEvent.click(document.querySelector('[data-slot="list-row-main"]')!);
    expect(onSelect).toHaveBeenCalledWith('cap');
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(onStop).toHaveBeenCalledWith('cap');

    rerender(
      <ul>
        <SidebarEnvRow
          env={makeEnv()}
          selected={false}
          compact
          onSelect={onSelect}
          onStart={vi.fn()}
          onStop={onStop}
          onContextMenu={vi.fn()}
        />
      </ul>,
    );
    expect(document.querySelector<HTMLElement>('[data-slot="sidebar-compact-env"]')).not.toBeNull();
    expect(document.querySelector<HTMLElement>('[data-slot="env-identity-chip"]')?.className).toContain('size-7');

    const css = readFileSync(path.join(ROOT, 'src/renderer/components/ui/list-row.module.css'), 'utf8');
    expect(css).toContain('gap: var(--list-row-body-gap, 2px);');
    expect(css).not.toContain('corner-shape');
  });
});

describe('图六：SurfaceTab 左右光学对称与 OpenBot 扁平控件无外投影契约', () => {
  it('带图标可关闭标签左右边距光学对称，且无旧微立体外投影', () => {
    const { rerender } = render(
      <SurfaceTab label="form fixture" active icon={<span data-testid="ico" />} onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    const tab = document.querySelector<HTMLElement>('[data-slot="surface-tab"]');
    expect(tab?.className).toContain('pl-2');
    expect(tab?.className).toContain('pr-2.5');
    expect(tab?.className).not.toMatch(/(^|\s)pr-1(\s|$)/);
    expect(tab?.className).not.toContain('--shadow-chip');
    expect(tab?.className).not.toContain('--shadow-raised');

    // 不可关闭时对称 px-2.5
    rerender(<SurfaceTab label="form fixture" active icon={<span data-testid="ico" />} onSelect={vi.fn()} />);
    expect(document.querySelector<HTMLElement>('[data-slot="surface-tab"]')?.className).toContain('px-2.5');
  });

  it('扩散校验：TabsTrigger / SpaceSwitcher / Outline Button 均符合零投影扁平契约', () => {
    render(
      <div>
        <Tabs value="a">
          <TabsList>
            <TabsTrigger value="a">A</TabsTrigger>
          </TabsList>
        </Tabs>
        <EnvironmentSpaceSwitcher
          spaces={[
            { id: 'person', label: '我的', owner: 'none', tabs: [] },
            { id: 'agent', label: 'Agent', owner: 'none', tabs: [] },
          ]}
          activeSpaceId="person"
          onSelect={vi.fn()}
        />
        <Button variant="outline">⌘K</Button>
      </div>,
    );

    const trigger = document.querySelector<HTMLElement>('[data-slot="tabs-trigger"]');
    const thumb = document.querySelector<HTMLElement>('[data-slot="space-switcher-thumb"]');
    const outlineBtn = screen.getByRole('button', { name: '⌘K' });

    expect(trigger?.className).not.toContain('--shadow-chip');
    expect(trigger?.className).not.toContain('--shadow-raised');
    expect(thumb?.className).toContain('warren-sliding-pill');
    expect(thumb?.className).not.toContain('--shadow-chip');
    expect(outlineBtn.className).toContain('border-border-strong');
    expect(outlineBtn.className).not.toContain('--shadow-chip');
    expect(outlineBtn.className).not.toContain('--shadow-raised');
  });
});

describe('DevTools 停靠分栏手柄：无障碍属性、键盘微调、双击重置与拖拽回调', () => {
  it('右侧与底部停靠分别支持方向键、Shift 步进、Enter/双击重置及指针拖拽', () => {
    const onResize = vi.fn();
    const onReset = vi.fn();
    const viewport = { x: 0, y: 0, width: 1200, height: 800 };
    const { rerender } = render(
      <DevToolsResizeHandle
        dock="right"
        size={420}
        viewport={viewport}
        gap={{ x: 774, y: 0, width: 6, height: 800 }}
        onResize={onResize}
        onReset={onReset}
      />,
    );

    const handle = screen.getByRole('separator', { name: '调整右侧 DevTools 宽度' });
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuenow')).toBe('420');
    expect(handle.style.left).toBe('774px');
    expect(handle.style.width).toBe('6px');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith('right', 436);
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith('right', 380);
    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(onReset).toHaveBeenCalledWith('right');

    fireEvent.pointerDown(handle, { button: 0, clientX: 777, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 717, clientY: 200 });
    fireEvent.pointerUp(window, { clientX: 717, clientY: 200 });
    expect(onResize).toHaveBeenLastCalledWith('right', 480);

    fireEvent.doubleClick(handle);
    expect(onResize).toHaveBeenLastCalledWith('right', 420);

    rerender(
      <DevToolsResizeHandle
        dock="bottom"
        size={300}
        viewport={viewport}
        gap={{ x: 0, y: 494, width: 1200, height: 6 }}
        onResize={onResize}
        onReset={onReset}
      />,
    );
    const bottomHandle = screen.getByRole('separator', { name: '调整底部 DevTools 高度' });
    expect(bottomHandle.getAttribute('aria-orientation')).toBe('horizontal');
    fireEvent.keyDown(bottomHandle, { key: 'ArrowUp' });
    expect(onResize).toHaveBeenLastCalledWith('bottom', 316);
  });
});

describe('地址栏下载按钮直接露出与模拟视口居中画布', () => {
  it('无进行中下载时也直接渲染下载记录按钮，有进行中下载时才显示脉冲红点', () => {
    const mocks = installMockEnvApi();
    const baseProps = {
      envId: 'cap',
      spaceId: 'person' as const,
      url: 'https://example.com',
      loading: false,
      editable: true,
      running: true,
      canGoBack: false,
      canGoForward: false,
      inspectorOpen: false,
      devToolsOpen: false,
      devToolsDock: 'right' as const,
      zoomFactor: 1,
      viewportPreset: 'auto' as const,
      pluginPopovers: [],
      pluginStatusBadges: [],
      pluginInspectorTabs: [],
      pluginRailPages: [],
      onToggleInspector: vi.fn(),
      onToggleDevTools: vi.fn(),
      onChangeDevToolsDock: vi.fn(),
      onResetZoom: vi.fn(),
      onOpenFind: vi.fn(),
      onNavigate: vi.fn(),
    };

    const { rerender } = render(
      <TooltipProvider>
        <EnvironmentAddressBar {...baseProps} hasActiveDownload={false} />
      </TooltipProvider>,
    );

    const downloadBtn = screen.getByRole('button', { name: '下载记录' });
    expect(document.querySelector('[data-slot="downloads-active-dot"]')).toBeNull();
    fireEvent.click(downloadBtn);
    expect(mocks.openPopover).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'downloads', props: { envId: 'cap' } }),
    );

    rerender(
      <TooltipProvider>
        <EnvironmentAddressBar {...baseProps} hasActiveDownload />
      </TooltipProvider>,
    );
    expect(document.querySelector('[data-slot="downloads-active-dot"]')).not.toBeNull();
  });

  it('非 auto 模拟视口使用独立画布背景与居中设备框，并展示尺寸标签与一键还原按钮', () => {
    const container = { x: 0, y: 0, width: 1000, height: 800 };
    const layout = computeSimulatedPageBounds(container, 'desktop-1440');
    const onReset = vi.fn();

    render(<SimulatedViewportBackdrop container={container} layout={layout} onReset={onReset} />);

    const canvas = document.querySelector<HTMLElement>('[data-slot="viewport-canvas"]');
    const frame = document.querySelector<HTMLElement>('[data-slot="viewport-frame"]');
    const pill = document.querySelector<HTMLElement>('[data-slot="viewport-pill"]');
    expect(canvas?.className).toContain('bg-surface-recessed');
    expect(frame?.className).toContain('bg-background');
    expect(frame?.style.left).toBe(`${layout.bounds.x}px`);
    expect(frame?.style.width).toBe(`${layout.bounds.width}px`);
    expect(pill?.textContent).toContain('1440 × 900');
    expect(document.querySelector('[data-slot="viewport-scale"]')?.textContent).toContain('%');

    fireEvent.click(screen.getByRole('button', { name: '还原自适应视口' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
