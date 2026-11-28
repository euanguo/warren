import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NativeTooltip, clampShift, tooltipPlacement } from '@/app/tooltip-root';
import type { OverlayTooltipRequest } from '@shared/types';

const ANCHOR = { x: 100, y: 200, width: 40, height: 20 };

function styleFor(side: OverlayTooltipRequest['side']) {
  return tooltipPlacement({ anchor: ANCHOR, side }) as Record<string, string | number>;
}

describe('原生 tooltip 层', () => {
  it('按方位把锚点矩形换算成浮层坐标', () => {
    expect(styleFor('right')).toMatchObject({ left: 148, top: 210, transform: 'translateY(-50%)' });
    expect(styleFor('left')).toMatchObject({ left: 92, top: 210, transform: 'translate(-100%, -50%)' });
    expect(styleFor('bottom')).toMatchObject({ left: 120, top: 228, transform: 'translateX(-50%)' });
    expect(styleFor('top')).toMatchObject({ left: 120, top: 192, transform: 'translate(-50%, -100%)' });
  });

  it('渲染 label、副说明与快捷键，且不接收鼠标事件', () => {
    const { container } = render(
      <NativeTooltip
        request={{
          anchor: ANCHOR,
          side: 'right',
          label: 'React',
          description: '运行中 · 直连',
          shortcut: '⌘K',
        }}
      />,
    );
    expect(screen.getByText('React')).toBeTruthy();
    expect(screen.getByText('运行中 · 直连')).toBeTruthy();
    expect(screen.getByText('⌘K')).toBeTruthy();
    expect(container.firstElementChild?.className).toContain('pointer-events-none');
    expect(container.querySelector('[data-slot="native-tooltip"]')).toBeTruthy();
  });

  it('贴边时把浮层推回可视区', () => {
    const inside = { left: 100, top: 100, right: 200, bottom: 130 };
    expect(clampShift(inside, 1440, 920)).toEqual({ dx: 0, dy: 0 });

    // 右边缘溢出 29px → 左移 29px；下边缘溢出 10px → 上移 10px
    const overflow = { left: 1380, top: 900, right: 1469, bottom: 1110 };
    expect(clampShift(overflow, 1440, 920)).toEqual({ dx: -33, dy: -194 });
  });

  it('没有请求时不渲染任何东西', () => {
    const { container } = render(<NativeTooltip request={null} />);
    expect(container.innerHTML).toBe('');
  });
});
