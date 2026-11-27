import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TabShape } from '@/components/ui/tab-shape';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EnvironmentTabstrip } from '@/features/environments/environment-tabstrip';
import type { TabState } from '@shared/types';
import { installMockEnvApi } from './setup';

const ROOT = path.resolve(__dirname, '../..');

function makeTab(id: string, title: string, patch: Partial<TabState> = {}): TabState {
  return {
    id,
    url: `https://example.com/${id}`,
    title,
    loading: false,
    audible: false,
    muted: false,
    space: 'person',
    createdAt: '2026-11-28T00:00:00.000Z',
    ...patch,
  };
}

function mockRect(el: Element, rect: { left: number; top: number; width: number; height: number }): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      toJSON: () => ({}),
    }),
  });
}

function mockBoxMetrics(el: HTMLElement, metrics: { offsetLeft?: number; offsetWidth?: number; clientWidth?: number }) {
  if (metrics.offsetLeft !== undefined) {
    Object.defineProperty(el, 'offsetLeft', { configurable: true, value: metrics.offsetLeft });
  }
  if (metrics.offsetWidth !== undefined) {
    Object.defineProperty(el, 'offsetWidth', { configurable: true, value: metrics.offsetWidth });
  }
  if (metrics.clientWidth !== undefined) {
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: metrics.clientWidth });
  }
}

describe('OpenBot 风格 Chrome 标签栏 CSS 契约与边界行为', () => {
  beforeEach(() => {
    installMockEnvApi();
  });

  it('chrome 标签使用 28px 居中全圆角胶囊、18px 圆形关闭槽位，以及双层凹角 1px 发丝描边', () => {
    render(
      <TooltipProvider>
        <EnvironmentTabstrip
          tabs={[makeTab('t1', 'React'), makeTab('t2', 'Google 搜索')]}
          activeTabId="t2"
          scopeKey="env-a:person"
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

    const tabs = document.querySelectorAll<HTMLElement>('[data-slot="surface-tab"]');
    expect(tabs).toHaveLength(2);
    // 完整四角圆角（不再是贴底切平的 rounded-t-[10px]）
    expect(tabs[0].className).toContain('rounded-[var(--radius-md)]');
    expect(tabs[0].className).not.toContain('rounded-t-[10px]');
    // 紧凑圆形关闭槽位（不再套用方形灰底 IconButton）
    const closeBtn = screen.getByRole('button', { name: '关闭 React' });
    expect(closeBtn.className).toContain('rounded-full');
    expect(closeBtn.className).toContain('size-[18px]');
    expect(closeBtn.className).not.toContain('group-hover/surface-tab:bg-surface-hover');

    // globals.css 具备 OpenBot 连续 1px 描边 + 双层 radial-gradient 凹角 + 双向相邻分隔线隐藏 + 滚动裁切 + 宽度上下限与标题过长右侧渐隐蒙层
    const css = readFileSync(path.join(ROOT, 'src/renderer/globals.css'), 'utf8');
    expect(css).toContain('border: 1px solid var(--border);');
    expect(css).toContain('left: calc(-1 * var(--tab-shape-curve) - 1px);');
    expect(css).toContain('right: calc(-1 * var(--tab-shape-curve) - 1px);');
    expect(css).toContain('--chrome-tab-max: 180px;');
    expect(css).toContain('--chrome-tab-min: 96px;');
    expect(css).toContain('--chrome-tab-floor: 72px;');
    expect(css).toContain(".warren-chrome-tab-label[data-overflow='true']");
    expect(css).toContain(".warren-tab-shape[data-clip-start='true']::before");
    expect(css).toContain(
      ".warren-chrome-tab-item:is([data-active='true'], :hover, :focus-within) + .warren-chrome-tab-item::before",
    );
    expect(css).toContain(".warren-chrome-strip[data-frozen='true'] > .warren-chrome-tab-item");
  });

  it('chrome 标签标题仅在超出最大宽度时触发右侧渐隐蒙层（data-overflow=true），短标题保持锐利', () => {
    const { rerender } = render(
      <TooltipProvider>
        <EnvironmentTabstrip
          tabs={[makeTab('t1', 'React'), makeTab('t2', 'Very Long Page Title That Definitely Overflows The Tab Width')]}
          activeTabId="t2"
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

    const labels = document.querySelectorAll<HTMLElement>('[data-slot="chrome-tab-label"]');
    expect(labels).toHaveLength(2);
    // 无 hard ellipsis 省略号，采用 clip + 右侧 mask 渐隐
    expect(labels[0].className).toContain('[text-overflow:clip]');
    expect(labels[0].className).not.toContain('truncate');

    // 短标题 scrollWidth <= clientWidth → 不开启蒙层
    Object.defineProperty(labels[0], 'scrollWidth', { configurable: true, value: 42 });
    Object.defineProperty(labels[0], 'clientWidth', { configurable: true, value: 132 });
    // 长标题 scrollWidth > clientWidth → 开启右侧渐隐蒙层
    Object.defineProperty(labels[1], 'scrollWidth', { configurable: true, value: 260 });
    Object.defineProperty(labels[1], 'clientWidth', { configurable: true, value: 132 });

    rerender(
      <TooltipProvider>
        <EnvironmentTabstrip
          tabs={[
            makeTab('t1', 'React '),
            makeTab('t2', 'Very Long Page Title That Definitely Overflows The Tab Width!'),
          ]}
          activeTabId="t2"
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

    const updatedLabels = document.querySelectorAll<HTMLElement>('[data-slot="chrome-tab-label"]');
    expect(updatedLabels[0].dataset.overflow).toBe('false');
    expect(updatedLabels[1].dataset.overflow).toBe('true');
  });

  it('连续关闭非末尾标签时冻结宽度，移出标签栏或关闭末尾标签后立即解冻', () => {
    const onClose = vi.fn();
    render(
      <TooltipProvider>
        <EnvironmentTabstrip
          tabs={[makeTab('t1', '标签一'), makeTab('t2', '标签二'), makeTab('t3', '标签三')]}
          activeTabId="t1"
          canReload
          onSelect={vi.fn()}
          onClose={onClose}
          onCreate={vi.fn()}
          onReload={vi.fn()}
          onCloseOthers={vi.fn()}
          onCloseRight={vi.fn()}
          onReorder={vi.fn()}
          onToggleMute={vi.fn()}
        />
      </TooltipProvider>,
    );

    const strip = document.querySelector<HTMLElement>('[data-slot="surface-tab-strip"]')!;
    const item1 = document.querySelector<HTMLElement>('[data-tab-id="t1"]')!;
    mockBoxMetrics(strip, { offsetWidth: 420 });
    mockBoxMetrics(item1, { offsetWidth: 132 });

    // 关闭第 1 个标签 → 触发冻结并记录宽度
    fireEvent.click(screen.getByRole('button', { name: '关闭 标签一' }));
    expect(onClose).toHaveBeenCalledWith('t1');
    expect(strip.dataset.frozen).toBe('true');
    expect(strip.style.getPropertyValue('--chrome-tab-frozen-width')).toBe('132px');

    // 指针移出标签条 → 自动解冻
    fireEvent.pointerLeave(strip);
    expect(strip.dataset.frozen).toBeUndefined();
    expect(strip.style.getPropertyValue('--chrome-tab-frozen-width')).toBe('');

    // 关闭末尾标签 → 不应冻结
    fireEvent.click(screen.getByRole('button', { name: '关闭 标签三' }));
    expect(strip.dataset.frozen).toBeUndefined();
  });

  it('音频/静音按钮固定位于标题右侧 trailingAction，不顶替左侧图标与关闭槽位', () => {
    const onToggleMute = vi.fn();
    render(
      <TooltipProvider>
        <EnvironmentTabstrip
          tabs={[makeTab('t1', '音乐播放', { audible: true, muted: false })]}
          activeTabId="t1"
          canReload
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onReload={vi.fn()}
          onCloseOthers={vi.fn()}
          onCloseRight={vi.fn()}
          onReorder={vi.fn()}
          onToggleMute={onToggleMute}
        />
      </TooltipProvider>,
    );

    const closeBtn = screen.getByRole('button', { name: '关闭 音乐播放' });
    const muteBtn = screen.getByRole('button', { name: '静音 音乐播放' });
    expect(closeBtn).toBeTruthy();
    expect(muteBtn).toBeTruthy();
    // 静音按钮位于关闭按钮之后（DOM 顺序靠右）
    expect(closeBtn.compareDocumentPosition(muteBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(muteBtn);
    expect(onToggleMute).toHaveBeenCalledWith('t1', true);
  });

  it('Agent 只读锁态下屏蔽悬停背景、关闭按钮、静音切换与拖拽', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onReorder = vi.fn();
    render(
      <TooltipProvider>
        <EnvironmentTabstrip
          tabs={[makeTab('t1', 'Agent 正在操作', { audible: true }), makeTab('t2', '另一页')]}
          activeTabId="t1"
          locked
          canReload={false}
          onSelect={onSelect}
          onClose={onClose}
          onCreate={vi.fn()}
          onReload={vi.fn()}
          onCloseOthers={vi.fn()}
          onCloseRight={vi.fn()}
          onReorder={onReorder}
          onToggleMute={vi.fn()}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByRole('button', { name: /关闭/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /静音/ })).toBeNull();
    const idleTab = document.querySelectorAll<HTMLElement>('[data-slot="surface-tab"]')[1];
    expect(idleTab.className).not.toContain('warren-chrome-tab-idle');
    expect(idleTab.className).not.toContain('hover:bg-surface-hover');
    fireEvent.pointerDown(idleTab, { button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: 10 });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('滚轮竖向滑动转换为横向滚动，且不拦截 ctrlKey 缩放手势', () => {
    render(
      <TooltipProvider>
        <EnvironmentTabstrip
          tabs={[makeTab('t1', '一'), makeTab('t2', '二'), makeTab('t3', '三')]}
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

    const strip = document.querySelector<HTMLElement>('[data-slot="surface-tab-strip"]')!;
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 600 });
    Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 240 });
    strip.scrollLeft = 10;

    fireEvent.wheel(strip, { deltaY: 40, deltaX: 0 });
    expect(strip.scrollLeft).toBe(50);

    // ctrlKey 按下时不劫持滚轮（happy-dom 的 WheelEvent 构造器忽略 ctrlKey init，显式定义以模拟真实事件）
    const zoomWheel = new WheelEvent('wheel', { deltaY: 40, deltaX: 0, bubbles: true, cancelable: true });
    Object.defineProperty(zoomWheel, 'ctrlKey', { value: true });
    strip.dispatchEvent(zoomWheel);
    expect(strip.scrollLeft).toBe(50);
  });

  it('指针拖拽重排支持平滑跟手与目标落位，按 Escape 取消不触发重排', () => {
    const onReorder = vi.fn();
    render(
      <TooltipProvider>
        <EnvironmentTabstrip
          tabs={[makeTab('t1', '第一'), makeTab('t2', '第二'), makeTab('t3', '第三')]}
          activeTabId="t1"
          canReload
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onReload={vi.fn()}
          onCloseOthers={vi.fn()}
          onCloseRight={vi.fn()}
          onReorder={onReorder}
          onToggleMute={vi.fn()}
        />
      </TooltipProvider>,
    );

    const strip = document.querySelector<HTMLElement>('[data-slot="surface-tab-strip"]')!;
    const items = [...strip.querySelectorAll<HTMLElement>(':scope > [data-tab-id]')];
    items.forEach((el, idx) => mockBoxMetrics(el, { offsetLeft: 10 + idx * 124, offsetWidth: 120 }));

    // 向右拖拽第 1 个标签越过第 2 个标签中点后松手
    fireEvent.pointerDown(items[0], { button: 0, isPrimary: true, pointerId: 7, clientX: 60, clientY: 16 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 200, clientY: 16 });
    expect(strip.dataset.dragging).toBe('true');
    expect(items[0].dataset.dragged).toBe('true');
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 200, clientY: 16 });
    expect(onReorder).toHaveBeenCalledWith(0, 1);
    expect(strip.dataset.dragging).toBeUndefined();

    // 拖拽途中按 Escape 取消，不应再调用 onReorder
    onReorder.mockClear();
    fireEvent.pointerDown(items[0], { button: 0, isPrimary: true, pointerId: 8, clientX: 60, clientY: 16 });
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 220, clientY: 16 });
    expect(strip.dataset.dragging).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(strip.dataset.dragging).toBeUndefined();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('TabShape 正确处理跨环境复位、滚动边缘裁切（clipStart / clipEnd）与拖拽暂隐', async () => {
    const { rerender } = render(
      <div data-testid="row" style={{ position: 'relative' }}>
        <TabShape scroller='[data-slot="surface-tab-strip"]' scopeKey="env-1:person" />
        <div data-slot="surface-tab-strip">
          <div data-slot="surface-tab" data-state="active" data-testid="tab-1">
            Tab 1
          </div>
          <div data-slot="surface-tab" data-state="idle" data-testid="tab-2">
            Tab 2
          </div>
        </div>
      </div>,
    );

    const row = screen.getByTestId('row');
    const strip = document.querySelector<HTMLElement>('[data-slot="surface-tab-strip"]')!;
    const shape = document.querySelector<HTMLElement>('[data-slot="tab-shape"]')!;
    const tab1 = screen.getByTestId('tab-1');
    const tab2 = screen.getByTestId('tab-2');

    mockBoxMetrics(row, { offsetWidth: 400, clientWidth: 400 });
    mockRect(row, { left: 0, top: 0, width: 400, height: 38 });
    mockRect(strip, { left: 0, top: 0, width: 400, height: 38 });
    // Tab 1 正常在视口内（距左 10px，宽 140px）
    mockRect(tab1, { left: 10, top: 5, width: 140, height: 28 });
    mockRect(tab2, { left: 154, top: 5, width: 140, height: 28 });

    // 触发一次重算
    fireEvent.scroll(strip);
    expect(shape.dataset.ready).toBe('true');
    expect(shape.dataset.hidden).toBeUndefined();
    expect(shape.dataset.clipStart).toBeUndefined();
    expect(shape.style.getPropertyValue('--tab-shape-left')).toBe('10px');
    expect(shape.style.getPropertyValue('--tab-shape-height')).toBe('33px');

    // 模拟 Tab 1 局部滚出左边缘（left = -40，仅余 100px 在视口内）→ 触发 data-clip-start
    mockRect(tab1, { left: -40, top: 5, width: 140, height: 28 });
    fireEvent.scroll(strip);
    expect(shape.dataset.clipStart).toBe('true');
    expect(shape.style.getPropertyValue('--tab-shape-left')).toBe('0px');

    // 模拟 Tab 1 几乎完全滚出左边缘（剩余宽 4px < 6px）→ 自动隐藏
    mockRect(tab1, { left: -136, top: 5, width: 140, height: 28 });
    fireEvent.scroll(strip);
    expect(shape.dataset.hidden).toBe('true');

    // 恢复可见并测试 suppressed 拖拽暂隐
    mockRect(tab1, { left: 10, top: 5, width: 140, height: 28 });
    rerender(
      <div data-testid="row" style={{ position: 'relative' }}>
        <TabShape scroller='[data-slot="surface-tab-strip"]' scopeKey="env-1:person" suppressed />
        <div data-slot="surface-tab-strip">
          <div data-slot="surface-tab" data-state="active" data-testid="tab-1">
            Tab 1
          </div>
        </div>
      </div>,
    );
    await waitFor(() => {
      expect(shape.dataset.hidden).toBe('true');
    });

    // 切换 scopeKey 跨环境时以瞬时模式重置，不留旧延迟方向
    rerender(
      <div data-testid="row" style={{ position: 'relative' }}>
        <TabShape scroller='[data-slot="surface-tab-strip"]' scopeKey="env-2:agent" />
        <div data-slot="surface-tab-strip">
          <div data-slot="surface-tab" data-state="active" data-testid="tab-1">
            Tab 1
          </div>
        </div>
      </div>,
    );
    await waitFor(() => {
      expect(shape.dataset.ready).toBe('true');
      expect(shape.dataset.hidden).toBeUndefined();
    });
  });
});
