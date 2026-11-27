import { BrowserWindow, screen, type WebContents } from 'electron';
import path from 'node:path';
import { computePopoverBounds, shouldFocusPopover, toLocalPopoverPoint } from './popover-layout.ts';
import type {
  PopoverActionEvent,
  PopoverId,
  PopoverOpenOptions,
  PopoverState,
  PopoverUpdateOptions,
} from '../../shared/types.ts';

export interface PopoverHostOptions {
  mainWindow: BrowserWindow;
  preloadPath: string;
  loadUrl: (surface: 'popover') => { devUrl?: string; filePath?: string };
  onAction: (event: PopoverActionEvent) => void;
  onDismissed: (payload: { id: PopoverId; reason: string }) => void;
}

interface Slot {
  win: BrowserWindow;
  ready: Promise<void>;
  focusable: boolean;
}

/**
 * 非模态子窗口池（复刻 Ardia Wave 3B `NSPanel` Popover 协议）。
 *
 * 拆成两个预热子窗：
 * - 非聚焦池（`focusable: false`）：专供地址栏历史联想、工具悬停浮卡，不抢主窗输入光标；
 * - 可聚焦池（`focusable: true`）：专供 `⌘F` 查找条、快捷表单浮卡，可直接接收键盘打字。
 */
export class PopoverHost {
  #mainWindow: BrowserWindow;
  #preloadPath: string;
  #loadUrl: PopoverHostOptions['loadUrl'];
  #onAction: PopoverHostOptions['onAction'];
  #onDismissed: PopoverHostOptions['onDismissed'];
  #nonFocusable?: Slot;
  #focusable?: Slot;
  #activeId: PopoverId | null = null;
  #activeSlot?: Slot;
  #lastUsedAt = Date.now();
  #currentOptions?: PopoverOpenOptions;
  #lastBounds?: { x: number; y: number; width: number; height: number };
  #hoverTimer?: ReturnType<typeof setInterval>;
  #suppressBlur = false;
  #onMove = () => this.#repositionOrDismiss('move');
  #onResize = () => this.close(undefined, 'resize');
  #onHide = () => this.close(undefined, 'host');

  constructor(options: PopoverHostOptions) {
    this.#mainWindow = options.mainWindow;
    this.#preloadPath = options.preloadPath;
    this.#loadUrl = options.loadUrl;
    this.#onAction = options.onAction;
    this.#onDismissed = options.onDismissed;

    this.#mainWindow.on('move', this.#onMove);
    this.#mainWindow.on('resize', this.#onResize);
    this.#mainWindow.on('hide', this.#onHide);
  }

  /** 预热两个子窗，确保首次触发 0ms 弹出。 */
  warmup(): void {
    this.#lastUsedAt = Date.now();
    this.#ensureSlot(false);
    this.#ensureSlot(true);
  }

  /** 回收空闲隐藏态的预热 Popover 子窗，下次触发时按需重建。 */
  reclaimIdle(idleMs = 0): number {
    if (this.#activeId) return 0;
    if (idleMs > 0 && Date.now() - this.#lastUsedAt < idleMs) return 0;
    let reclaimed = 0;
    for (const slot of [this.#nonFocusable, this.#focusable]) {
      if (slot && !slot.win.isDestroyed()) {
        slot.win.destroy();
        reclaimed += 1;
      }
    }
    this.#nonFocusable = undefined;
    this.#focusable = undefined;
    return reclaimed;
  }

  processInfos(): Array<{ pid: number; label: string }> {
    const out: Array<{ pid: number; label: string }> = [];
    if (this.#nonFocusable && !this.#nonFocusable.win.isDestroyed()) {
      const pid = this.#nonFocusable.win.webContents.getOSProcessId();
      if (Number.isInteger(pid) && pid > 0) out.push({ pid, label: 'Popover 浮卡（非聚焦）' });
    }
    if (this.#focusable && !this.#focusable.win.isDestroyed()) {
      const pid = this.#focusable.win.webContents.getOSProcessId();
      if (Number.isInteger(pid) && pid > 0) out.push({ pid, label: 'Popover 浮卡（可聚焦）' });
    }
    return out;
  }

  isOwnedWebContents(wc: WebContents): boolean {
    return wc === this.#nonFocusable?.win.webContents || wc === this.#focusable?.win.webContents;
  }

  currentState(): PopoverState | null {
    if (!this.#activeId || !this.#currentOptions) return null;
    return { id: this.#currentOptions.id, props: this.#currentOptions.props } as PopoverState;
  }

  async open(options: PopoverOpenOptions): Promise<void> {
    this.#lastUsedAt = Date.now();
    const focusable = Boolean(options.focusable);
    const slot = this.#ensureSlot(focusable);
    await slot.ready;

    // 切槽时先藏掉另一个
    this.#stopHoverBridge();
    if (this.#activeSlot && this.#activeSlot !== slot && !this.#activeSlot.win.isDestroyed()) {
      this.#activeSlot.win.hide();
    }

    this.#activeId = options.id;
    this.#activeSlot = slot;
    this.#currentOptions = options;
    this.#suppressBlur = true;

    const bounds = this.#calcBounds(options);
    this.#lastBounds = bounds;
    slot.win.setBounds(bounds);
    slot.win.webContents.send('popover:state', { id: options.id, props: options.props } as PopoverState);
    const shouldFocus = shouldFocusPopover(focusable, !this.#mainWindow.isDestroyed() && this.#mainWindow.isFocused());
    if (shouldFocus) {
      slot.win.show();
      slot.win.focus();
      slot.win.webContents.focus();
    } else {
      slot.win.showInactive();
      if (process.platform === 'darwin') {
        this.#startHoverBridge(slot);
      }
    }
    setTimeout(() => {
      this.#suppressBlur = false;
    }, 80);
  }

  async update<K extends PopoverId>(id: K, patch: PopoverUpdateOptions<K>): Promise<void> {
    if (this.#activeId !== id || !this.#currentOptions || !this.#activeSlot) return;
    if (this.#activeSlot.win.isDestroyed()) return;
    const current = this.#currentOptions as Extract<PopoverOpenOptions, { id: K }>;
    const next = {
      ...current,
      ...patch,
      size: patch.size ? { ...current.size, ...patch.size } : current.size,
      props: patch.props ? { ...current.props, ...patch.props } : current.props,
    } as Extract<PopoverOpenOptions, { id: K }>;
    this.#currentOptions = next;
    if (patch.anchorRect || patch.size || patch.placement || patch.beyondWindow !== undefined) {
      const nextBounds = this.#calcBounds(next);
      const prev = this.#lastBounds;
      if (
        !prev ||
        prev.x !== nextBounds.x ||
        prev.y !== nextBounds.y ||
        prev.width !== nextBounds.width ||
        prev.height !== nextBounds.height
      ) {
        this.#lastBounds = nextBounds;
        this.#activeSlot.win.setBounds(nextBounds);
      }
    }
    if (patch.props) {
      this.#activeSlot.win.webContents.send('popover:state', { id: next.id, props: next.props } as PopoverState);
    }
  }

  close(id?: PopoverId, reason = 'programmatic'): void {
    if (!this.#activeId) return;
    if (id && id !== this.#activeId) return;
    this.#stopHoverBridge();
    const closedId = this.#activeId;
    const slot = this.#activeSlot;
    this.#activeId = null;
    this.#activeSlot = undefined;
    this.#lastUsedAt = Date.now();
    this.#currentOptions = undefined;
    this.#lastBounds = undefined;
    if (slot && !slot.win.isDestroyed()) {
      slot.win.hide();
      slot.win.webContents.send('popover:state', null);
    }
    this.#onDismissed({ id: closedId, reason });
  }

  emitAction(event: PopoverActionEvent): void {
    this.#onAction(event);
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const slot of [this.#nonFocusable, this.#focusable]) {
      if (slot && !slot.win.isDestroyed() && !slot.win.webContents.isDestroyed()) {
        slot.win.webContents.send(channel, ...args);
      }
    }
  }

  destroy(): void {
    this.#stopHoverBridge();
    if (!this.#mainWindow.isDestroyed()) {
      this.#mainWindow.off('move', this.#onMove);
      this.#mainWindow.off('resize', this.#onResize);
      this.#mainWindow.off('hide', this.#onHide);
    }
    this.#activeId = null;
    this.#activeSlot = undefined;
    this.#currentOptions = undefined;
    for (const slot of [this.#nonFocusable, this.#focusable]) {
      if (slot && !slot.win.isDestroyed()) slot.win.destroy();
    }
    this.#nonFocusable = undefined;
    this.#focusable = undefined;
  }

  /**
   * macOS 下 `focusable: false` + `showInactive()` 的子窗非 key window，系统默认不派发 mouseMoved 事件，
   * 导致地址联想列表悬停无高亮。仅在非聚焦浮卡打开期间以 32ms 轻量桥接光标坐标，关闭立即销毁定时器。
   */
  #startHoverBridge(slot: Slot): void {
    this.#stopHoverBridge();
    let lastKey = '';
    let wasInside = false;
    this.#hoverTimer = setInterval(() => {
      if (this.#activeSlot !== slot || slot.win.isDestroyed() || !slot.win.isVisible()) {
        this.#stopHoverBridge();
        return;
      }
      const local = toLocalPopoverPoint(screen.getCursorScreenPoint(), slot.win.getBounds());
      if (local) {
        const key = `${local.x},${local.y}`;
        if (key !== lastKey) {
          lastKey = key;
          wasInside = true;
          slot.win.webContents.sendInputEvent({ type: 'mouseMove', x: local.x, y: local.y });
        }
      } else if (wasInside) {
        wasInside = false;
        lastKey = '';
        slot.win.webContents.sendInputEvent({ type: 'mouseLeave', x: -1, y: -1 });
      }
    }, 32);
  }

  #stopHoverBridge(): void {
    if (this.#hoverTimer) {
      clearInterval(this.#hoverTimer);
      this.#hoverTimer = undefined;
    }
  }

  #ensureSlot(focusable: boolean): Slot {
    const existing = focusable ? this.#focusable : this.#nonFocusable;
    if (existing && !existing.win.isDestroyed()) return existing;

    const win = new BrowserWindow({
      parent: this.#mainWindow,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable,
      vibrancy: process.platform === 'darwin' ? 'popover' : undefined,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.#preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    const source = this.#loadUrl('popover');
    const ready = (
      source.devUrl
        ? win.webContents.loadURL(source.devUrl)
        : win.webContents.loadFile(source.filePath ?? path.resolve('index.html'), { search: 'surface=popover' })
    ).catch(() => {});

    if (focusable) {
      win.on('blur', () => {
        if (this.#suppressBlur || this.#activeSlot?.win !== win) return;
        this.close(undefined, 'blur');
      });
    }

    const slot: Slot = { win, ready, focusable };
    if (focusable) this.#focusable = slot;
    else this.#nonFocusable = slot;
    return slot;
  }

  #repositionOrDismiss(reason: string): void {
    if (!this.#activeId || !this.#currentOptions || !this.#activeSlot) return;
    if (this.#activeSlot.win.isDestroyed()) return;
    if (reason === 'move') {
      this.#activeSlot.win.setBounds(this.#calcBounds(this.#currentOptions));
    }
  }

  #calcBounds(options: PopoverOpenOptions) {
    const contentBounds = this.#mainWindow.getContentBounds();
    const display = screen.getDisplayMatching(contentBounds);
    return computePopoverBounds({
      anchorRect: options.anchorRect,
      windowBounds: contentBounds,
      preferredSize: options.size,
      placement: options.placement,
      beyondWindow: options.beyondWindow,
      workArea: display.workArea,
    });
  }
}
