import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Icon } from '@/components/icons';
import { IconButton } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { SurfaceTab, SurfaceTabStrip } from '@/components/ui/surface-tab';
import { TabShape } from '@/components/ui/tab-shape';
import { cn } from '@/lib/utils';
import { controlRingFocusClass } from '@/theme/surface';
import type { NativeMenuItem, TabRef, TabState } from '@shared/types';

interface Props {
  tabs: TabState[];
  activeTabId?: string;
  /** 环境与空间作用域标识，用于跨环境/跨空间切换时复位 TabShape 无滑飞。 */
  scopeKey?: string;
  disabled?: boolean;
  /** Agent 持权的 Agent Space：只能看，不能切/关/拖/静音。 */
  locked?: boolean;
  /** 重新加载是导航（写操作）：人没持控制权时那一项要禁用 */
  canReload: boolean;
  onSelect: (ref: TabRef) => void;
  onClose: (ref: TabRef) => void;
  onCreate: () => void;
  onReload: (ref: TabRef) => void;
  onHardReload?: (ref: TabRef) => void;
  onCloseOthers: (ref: TabRef) => void;
  onCloseRight: (ref: TabRef) => void;
  onReorder: (from: number, to: number) => void;
  onToggleMute: (ref: TabRef, muted: boolean) => void;
  onSleep?: (ref: TabRef) => void;
}

const DRAG_START_THRESHOLD_PX = 5;
const EDGE_SCROLL_ZONE_PX = 36;
const EDGE_SCROLL_SPEED_PX = 12;
const REVEAL_INSET_PX = 28;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** 拖拽结束后吞掉紧随其后的合成 click，防止触发误切或误操作。 */
function swallowNextClick(): void {
  const swallow = (event: globalThis.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  requestAnimationFrame(() => window.removeEventListener('click', swallow, { capture: true }));
}

function Favicon({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <Icon name="Globe" className="size-3.5 shrink-0" />;
  return <img src={url} alt="" className="size-3.5 shrink-0 rounded-[2px]" onError={() => setBroken(true)} />;
}

/**
 * 顶栏浏览器标签条（严格对齐 OpenBot 凹角无界滑动 TabShape + 弹性均宽 + 连续关闭冻结 + 滚轮横滚 + 指针平滑重排）。
 * 使用系统原生 `popupMenu` 右键菜单，不遮挡底部原生网页。
 */
export function EnvironmentTabstrip({
  tabs,
  activeTabId,
  scopeKey,
  disabled,
  locked = false,
  canReload,
  onSelect,
  onClose,
  onCreate,
  onReload,
  onHardReload,
  onCloseOthers,
  onCloseRight,
  onReorder,
  onToggleMute,
  onSleep,
}: Props) {
  const [draggingActive, setDraggingActive] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const frozenWidthRef = useRef<number | null>(null);
  const frozenStripWidthRef = useRef<number>(0);
  const tabsRef = useRef(tabs);
  const onReorderRef = useRef(onReorder);
  useEffect(() => {
    tabsRef.current = tabs;
    onReorderRef.current = onReorder;
  }, [tabs, onReorder]);

  const activeTabTitle = tabs.find((tab) => tab.id === activeTabId)?.title ?? '';

  const getScroller = useCallback(
    () => trackRef.current?.querySelector<HTMLElement>('[data-slot="surface-tab-strip"]') ?? null,
    [],
  );

  const unfreezeWidths = useCallback(() => {
    if (frozenWidthRef.current === null) return;
    frozenWidthRef.current = null;
    frozenStripWidthRef.current = 0;
    const scroller = getScroller();
    if (scroller) {
      delete scroller.dataset.frozen;
      scroller.style.removeProperty('--chrome-tab-frozen-width');
    }
  }, [getScroller]);

  const syncEdgeFade = useCallback(() => {
    const track = trackRef.current;
    const scroller = getScroller();
    if (!track || !scroller) return;
    const start = scroller.scrollLeft > 2;
    const end = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 2;
    const startFlag = start ? 'true' : 'false';
    const endFlag = end ? 'true' : 'false';
    track.dataset.fadeStart = startFlag;
    track.dataset.fadeEnd = endFlag;
    scroller.dataset.fadeStart = startFlag;
    scroller.dataset.fadeEnd = endFlag;
    // 窗口/容器尺寸变化时解除连续关闭冻结，让剩余标签自然展开
    if (frozenWidthRef.current !== null && Math.abs(scroller.offsetWidth - frozenStripWidthRef.current) > 2) {
      unfreezeWidths();
    }
  }, [getScroller, unfreezeWidths]);

  // 滚轮竖滑自动转标签栏横向滚动 + 边缘渐隐监听
  useEffect(() => {
    const scroller = getScroller();
    if (!scroller) return;

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || scroller.scrollWidth <= scroller.clientWidth) return;
      event.preventDefault();
      scroller.scrollLeft += event.deltaY;
    };

    syncEdgeFade();
    scroller.addEventListener('scroll', syncEdgeFade, { passive: true });
    scroller.addEventListener('wheel', onWheel, { passive: false });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncEdgeFade) : null;
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', syncEdgeFade);
      scroller.removeEventListener('wheel', onWheel);
      observer?.disconnect();
    };
  }, [getScroller, syncEdgeFade, tabs.length]);

  // 切环境/切空间或变为只读锁态时解除宽度冻结
  useEffect(() => {
    unfreezeWidths();
  }, [scopeKey, locked, unfreezeWidths]);

  // 激活标签自动滚入安全可视区（避开左右 24px 渐隐区，避免凹角被裁）
  useEffect(() => {
    const scroller = getScroller();
    if (!activeTabId || !scroller) return;
    const frame = window.requestAnimationFrame(() => {
      const activeEl = [...scroller.querySelectorAll<HTMLElement>('[data-tab-id]')].find(
        (el) => el.dataset.tabId === activeTabId,
      );
      if (activeEl) {
        const left = activeEl.offsetLeft - REVEAL_INSET_PX;
        const right = activeEl.offsetLeft + activeEl.offsetWidth + REVEAL_INSET_PX;
        const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
        if (typeof scroller.scrollTo === 'function') {
          if (left < scroller.scrollLeft) {
            scroller.scrollTo({ left: Math.max(0, left), behavior });
          } else if (right > scroller.scrollLeft + scroller.clientWidth) {
            scroller.scrollTo({ left: right - scroller.clientWidth, behavior });
          }
        } else {
          activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
      syncEdgeFade();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTabId, tabs.length, activeTabTitle, getScroller, syncEdgeFade]);

  // OpenBot 同款指针平滑拖拽重排（跟手 translateX + 邻近让位 + 边缘自动滚动 + FLIP 落位）
  useEffect(() => {
    const scroller = getScroller();
    if (!scroller || locked) return;

    type DragState = {
      pointerId: number;
      tabId: string;
      fromIndex: number;
      targetIndex: number;
      startX: number;
      startY: number;
      startScroll: number;
      clientX: number;
      moving: boolean;
      frame: number;
    };

    let hold: DragState | null = null;

    const getItems = () => [...scroller.querySelectorAll<HTMLElement>(':scope > [data-tab-id]')];

    const clearShifts = () => {
      for (const item of getItems()) {
        item.style.transform = '';
        delete item.dataset.dragged;
      }
    };

    const scrollAtEdge = (x: number) => {
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      const bounds = scroller.getBoundingClientRect();
      const speed =
        x < bounds.left + EDGE_SCROLL_ZONE_PX
          ? -(1 - Math.max(0, x - bounds.left) / EDGE_SCROLL_ZONE_PX)
          : x > bounds.right - EDGE_SCROLL_ZONE_PX
            ? 1 - Math.max(0, bounds.right - x) / EDGE_SCROLL_ZONE_PX
            : 0;
      if (speed !== 0) {
        scroller.scrollLeft += speed * EDGE_SCROLL_SPEED_PX;
      }
    };

    const follow = (state: DragState) => {
      const items = getItems().map((el) => ({
        el,
        id: el.dataset.tabId ?? '',
        left: el.offsetLeft,
        width: el.offsetWidth,
      }));
      const index = items.findIndex((item) => item.id === state.tabId);
      const self = items[index];
      const first = items[0];
      const last = items[items.length - 1];
      if (!self || !first || !last) return;

      const rawOffset = state.clientX - state.startX + (scroller.scrollLeft - state.startScroll);
      const minOffset = first.left - self.left;
      const maxOffset = last.left + last.width - self.left - self.width;
      const offset = Math.min(Math.max(rawOffset, minOffset), maxOffset);
      const edge = offset < 0 ? self.left + offset : self.left + self.width + offset;
      state.targetIndex = items.filter((item, i) => i !== index && item.left + item.width / 2 < edge).length;

      const gap = Number.parseFloat(getComputedStyle(scroller).columnGap || '4') || 4;
      const room = self.width + gap;
      items.forEach((item, i) => {
        if (i === index) {
          item.el.style.transform = `translate3d(${offset}px, 0, 0)`;
          return;
        }
        const shift = i > index && i <= state.targetIndex ? -room : i < index && i >= state.targetIndex ? room : 0;
        item.el.style.transform = shift === 0 ? '' : `translate3d(${shift}px, 0, 0)`;
      });
    };

    const tickEdgeScroll = () => {
      const current = hold;
      if (!current?.moving) return;
      scrollAtEdge(current.clientX);
      follow(current);
      current.frame = requestAnimationFrame(tickEdgeScroll);
    };

    const detachWindow = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('keydown', onKeyDown);
    };

    const finishDrag = (commit: boolean) => {
      const current = hold;
      if (!current) return;
      hold = null;
      detachWindow();
      cancelAnimationFrame(current.frame);
      if (!current.moving) return;

      delete scroller.dataset.dragging;
      setDraggingActive(false);
      clearShifts();
      swallowNextClick();

      if (commit && current.fromIndex !== current.targetIndex) {
        onReorderRef.current(current.fromIndex, current.targetIndex);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && hold?.moving) {
        event.preventDefault();
        finishDrag(false);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const current = hold;
      if (!current || event.pointerId !== current.pointerId) return;
      current.clientX = event.clientX;
      if (!current.moving) {
        if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_START_THRESHOLD_PX) {
          return;
        }
        if (tabsRef.current.length < 2) {
          finishDrag(false);
          return;
        }
        current.moving = true;
        unfreezeWidths();
        scroller.dataset.dragging = 'true';
        const draggedEl = getItems().find((el) => el.dataset.tabId === current.tabId);
        if (draggedEl) draggedEl.dataset.dragged = 'true';
        // 拖拽任意标签时暂隐 TabShape（由被拖激活标签或松手后瞬时落位接管），避免凹角与位移错层
        setDraggingActive(true);
        current.frame = requestAnimationFrame(tickEdgeScroll);
      }
      follow(current);
    };

    const onPointerEnd = (event: PointerEvent) => {
      if (!hold || event.pointerId !== hold.pointerId) return;
      finishDrag(event.type !== 'pointercancel');
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || hold) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('[data-surface-tab-action]')) return;
      const itemEl = target.closest<HTMLElement>('[data-tab-id]');
      const tabId = itemEl?.dataset.tabId;
      if (!itemEl || !tabId) return;
      const fromIndex = tabsRef.current.findIndex((tab) => tab.id === tabId);
      if (fromIndex < 0) return;

      hold = {
        pointerId: event.pointerId,
        tabId,
        fromIndex,
        targetIndex: fromIndex,
        startX: event.clientX,
        startY: event.clientY,
        startScroll: scroller.scrollLeft,
        clientX: event.clientX,
        moving: false,
        frame: 0,
      };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerEnd);
      window.addEventListener('pointercancel', onPointerEnd);
      window.addEventListener('keydown', onKeyDown);
    };

    scroller.addEventListener('pointerdown', onPointerDown);
    return () => {
      scroller.removeEventListener('pointerdown', onPointerDown);
      if (hold) finishDrag(false);
    };
  }, [getScroller, locked, unfreezeWidths]);

  const handleCloseWithFreeze = (tabId: string, index: number) => {
    const scroller = getScroller();
    // 连续关闭非最后一个标签时，冻结当前每格实测宽度，确保下一个标签的 × 直接落回鼠标正下方
    if (scroller && index < tabs.length - 1) {
      const targetEl = [...scroller.querySelectorAll<HTMLElement>('[data-tab-id]')].find(
        (el) => el.dataset.tabId === tabId,
      );
      const width = targetEl?.offsetWidth ?? 0;
      if (width > 0) {
        frozenWidthRef.current = width;
        frozenStripWidthRef.current = scroller.offsetWidth;
        scroller.dataset.frozen = 'true';
        scroller.style.setProperty('--chrome-tab-frozen-width', `${width}px`);
      }
    } else {
      unfreezeWidths();
    }
    onClose(tabId);
  };

  const openTabMenu = async (event: MouseEvent, tab: TabState, index: number, label: string) => {
    event.preventDefault();
    event.stopPropagation();

    const items: NativeMenuItem[] = [
      { label, enabled: false },
      { type: 'separator' },
      {
        id: 'reload',
        label: canReload ? '重新加载' : '重新加载（需要先接管）',
        enabled: !locked && canReload,
      },
      {
        id: 'hard-reload',
        label: canReload ? '忽略缓存硬刷新' : '忽略缓存硬刷新（需要先接管）',
        enabled: !locked && canReload,
      },
      { id: 'copy', label: '复制链接', enabled: Boolean(tab.url) },
      {
        id: 'mute',
        label: tab.muted ? '取消静音' : '静音',
        enabled: !locked,
      },
      ...(onSleep && !tab.sleeping
        ? [
            {
              id: 'sleep',
              label: '休眠标签（释放内存）',
              enabled: !locked && tab.id !== activeTabId && !tab.loading && !tab.audible,
            },
          ]
        : []),
      { type: 'separator' },
      { id: 'close', label: '关闭', enabled: !locked },
      { id: 'close-others', label: '关闭其他', enabled: !locked && tabs.length >= 2 },
      { id: 'close-right', label: '关闭右侧', enabled: !locked && index < tabs.length - 1 },
    ];

    const picked = await window.envApi.popupMenu(items, {
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
    });
    if (!picked) return;

    if (picked === 'reload') onReload(tab.id);
    else if (picked === 'hard-reload') (onHardReload ?? onReload)(tab.id);
    else if (picked === 'copy' && tab.url) void navigator.clipboard.writeText(tab.url);
    else if (picked === 'mute') onToggleMute(tab.id, !tab.muted);
    else if (picked === 'sleep') onSleep?.(tab.id);
    else if (picked === 'close') onClose(tab.id);
    else if (picked === 'close-others') onCloseOthers(tab.id);
    else if (picked === 'close-right') onCloseRight(tab.id);
  };

  return (
    <div className="relative flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
      {/* 独立裁剪轨道：同时包裹 TabShape 与滚动条，保证溢出渐隐与凹角裁切完全同步且绝不压到右侧 + 按钮 */}
      <div
        ref={trackRef}
        data-slot="chrome-tab-track"
        className="warren-fade-x relative isolate flex h-full min-w-0 max-w-full flex-initial items-center overflow-hidden"
      >
        <TabShape
          selected='[data-slot="surface-tab"][data-state="active"]'
          sized='[data-slot="surface-tab-strip"], [data-slot="surface-tab"]'
          scroller='[data-slot="surface-tab-strip"]'
          scopeKey={scopeKey}
          suppressed={draggingActive}
        />
        <SurfaceTabStrip
          aria-label="标签"
          onPointerLeave={unfreezeWidths}
          className="warren-chrome-strip relative z-[1] h-full min-w-0 max-w-full flex-initial items-center [app-region:no-drag] [-webkit-app-region:no-drag]"
        >
          {tabs.map((tab, index) => {
            const label = tab.title || (tab.url && tab.url !== 'about:blank' ? tab.url : '新标签页');
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                data-tab-index={index}
                data-tab-id={tab.id}
                data-active={isActive ? 'true' : undefined}
                data-tab-sleeping={tab.sleeping ? 'true' : undefined}
                onContextMenu={(event) => void openTabMenu(event, tab, index, label)}
                className="warren-chrome-tab-item"
              >
                <SurfaceTab
                  variant="chrome"
                  className={cn('w-full', tab.sleeping && !isActive && 'opacity-60 hover:opacity-90')}
                  label={label}
                  title={tab.sleeping ? `${tab.url || label}（已休眠，点击恢复）` : tab.url || label}
                  active={isActive}
                  icon={
                    tab.loading ? (
                      <Spinner label="加载中" className="size-3.5" />
                    ) : tab.favicon ? (
                      <Favicon key={tab.favicon} url={tab.favicon} />
                    ) : (
                      <Icon name="Globe" className="size-3.5 shrink-0" />
                    )
                  }
                  trailingAction={
                    tab.muted || tab.audible ? (
                      locked ? (
                        <span
                          className="flex size-[18px] shrink-0 items-center justify-center text-muted-foreground"
                          title={tab.muted ? '已静音' : '正在播放音频'}
                        >
                          <Icon name={tab.muted ? 'VolumeOff' : 'Volume'} className="size-3" />
                        </span>
                      ) : (
                        <button
                          type="button"
                          data-surface-tab-action=""
                          aria-label={tab.muted ? `取消静音 ${label}` : `静音 ${label}`}
                          title={tab.muted ? `取消静音 ${label}` : `静音 ${label}`}
                          className={cn(
                            controlRingFocusClass,
                            'flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground transition-colors duration-[var(--duration-fast)] hover:bg-surface-active hover:text-foreground',
                          )}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleMute(tab.id, !tab.muted);
                          }}
                        >
                          <Icon name={tab.muted ? 'VolumeOff' : 'Volume'} className="size-3" />
                        </button>
                      )
                    ) : undefined
                  }
                  onSelect={locked ? undefined : () => onSelect(tab.id)}
                  onClose={locked ? undefined : () => handleCloseWithFreeze(tab.id, index)}
                  closeLabel={`关闭 ${label}`}
                />
              </div>
            );
          })}
        </SurfaceTabStrip>
      </div>
      <div className="flex h-full shrink-0 items-center [app-region:no-drag] [-webkit-app-region:no-drag]">
        <IconButton
          size="icon-sm"
          aria-label="新建标签页"
          title={locked ? 'Agent 操作中 · 只读' : '新建标签页 (⌘T)'}
          disabled={disabled || locked}
          onClick={onCreate}
        >
          <Icon name="Plus" />
        </IconButton>
      </div>
    </div>
  );
}
