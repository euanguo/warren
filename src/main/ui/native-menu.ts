import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { NativeMenuItem } from '../../shared/types.ts';

/**
 * 原生桌面菜单服务。
 *
 * 侧栏环境行、分组、标签条等菜单不再用 DOM `ContextMenu` 硬撑在 `WebContentsView` 上，
 * 而是由主进程调用系统 `Menu.popup()` 呈现：真毛玻璃、零延迟、可自然越出窗口。
 */
export function popupNativeMenu(
  window: BrowserWindow,
  items: NativeMenuItem[],
  position?: { x: number; y: number },
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (id: string | null) => {
      if (settled) return;
      settled = true;
      resolve(id);
    };

    const convert = (item: NativeMenuItem): MenuItemConstructorOptions => {
      if (item.type === 'separator') return { type: 'separator' };
      const hasSubmenu = Array.isArray(item.submenu) && item.submenu.length > 0;
      const itemId = item.id;
      return {
        label: item.label ?? '',
        type: hasSubmenu ? 'submenu' : item.type === 'checkbox' ? 'checkbox' : 'normal',
        enabled: item.enabled ?? true,
        checked: item.checked,
        accelerator: item.accelerator,
        submenu: hasSubmenu ? item.submenu!.map(convert) : undefined,
        click: hasSubmenu || !itemId ? undefined : () => finish(itemId),
      };
    };

    const menu = Menu.buildFromTemplate(items.map(convert));
    menu.popup({
      window,
      x: position ? Math.round(position.x) : undefined,
      y: position ? Math.round(position.y) : undefined,
      callback: () => {
        // click 在 macOS NSMenu 关闭回调前或同轮触发，用 microtask 给 click 让路
        queueMicrotask(() => finish(null));
      },
    });
  });
}
