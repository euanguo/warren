import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { Icon } from '@/components/icons';
import { IconButton } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { SurfaceTab, SurfaceTabAction, SurfaceTabStrip } from '@/components/ui/surface-tab';
import { TabShape } from '@/components/ui/tab-shape';
import { cn } from '@/lib/utils';
import type { NativeMenuItem, TabRef, TabState } from '@shared/types';

interface Props {
  tabs: TabState[];
  activeTabId?: string;
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

function Favicon({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <Icon name="Globe" />;
  return <img src={url} alt="" className="size-3.5 shrink-0" onError={() => setBroken(true)} />;
}

/**
 * 顶栏浏览器标签条（OpenBot 凹角无界滑动 TabShape + 边缘 mask-fade 渐隐）。
 * 使用系统原生 `popupMenu` 右键菜单，不遮挡底部原生网页。
 */
export function EnvironmentTabstrip({
  tabs,
  activeTabId,
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
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const stripHostRef = useRef<HTMLDivElement>(null);
  const dragging = dragIndex !== null;

  const activeTabTitle = tabs.find((tab) => tab.id === activeTabId)?.title ?? '';

  const syncEdgeFade = useCallback(() => {
    const scroller = stripHostRef.current?.querySelector<HTMLElement>('[data-slot="surface-tab-strip"]');
    if (!scroller) return;
    const start = scroller.scrollLeft > 4;
    const end = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 4;
    scroller.dataset.fadeStart = start ? 'true' : 'false';
    scroller.dataset.fadeEnd = end ? 'true' : 'false';
  }, []);

  useEffect(() => {
    const scroller = stripHostRef.current?.querySelector<HTMLElement>('[data-slot="surface-tab-strip"]');
    if (!scroller) return;
    syncEdgeFade();
    scroller.addEventListener('scroll', syncEdgeFade, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncEdgeFade) : null;
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', syncEdgeFade);
      observer?.disconnect();
    };
  }, [syncEdgeFade, tabs.length]);

  useEffect(() => {
    if (!activeTabId || !stripHostRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const activeEl = [...(stripHostRef.current?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [])].find(
        (el) => el.dataset.tabId === activeTabId,
      );
      activeEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      syncEdgeFade();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTabId, tabs.length, activeTabTitle, syncEdgeFade]);

  const endDrag = () => {
    setDragIndex(null);
    setDropIndex(null);
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
    <div ref={stripHostRef} className="relative flex h-full min-w-0 flex-1 items-end gap-1 overflow-hidden">
      <TabShape
        selected='[data-slot="surface-tab"][data-state="active"]'
        sized='[data-slot="surface-tab"]'
        scroller='[data-slot="surface-tab-strip"]'
      />
      <SurfaceTabStrip
        aria-label="标签"
        className="warren-fade-x h-full min-w-0 max-w-full flex-initial items-end gap-0.5 px-2 [app-region:no-drag] [-webkit-app-region:no-drag]"
      >
        {tabs.map((tab, index) => {
          const label = tab.title || (tab.url && tab.url !== 'about:blank' ? tab.url : '新标签页');
          const isActive = tab.id === activeTabId;
          const nextIsActive = tabs[index + 1]?.id === activeTabId;
          return (
            <div
              key={tab.id}
              draggable={!locked}
              data-tab-index={index}
              data-tab-id={tab.id}
              data-tab-sleeping={tab.sleeping ? 'true' : undefined}
              onDragStart={(event: DragEvent<HTMLDivElement>) => {
                if (locked) return;
                setDragIndex(index);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', tab.id);
              }}
              onDragOver={(event: DragEvent<HTMLDivElement>) => {
                if (!dragging) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropIndex(index);
              }}
              onDrop={(event: DragEvent<HTMLDivElement>) => {
                event.preventDefault();
                if (dragIndex !== null && dragIndex !== index) onReorder(dragIndex, index);
                endDrag();
              }}
              onDragEnd={endDrag}
              onContextMenu={(event) => void openTabMenu(event, tab, index, label)}
              className={cn(
                'group/tab-item relative flex h-full max-w-[184px] shrink-0 items-end',
                tab.sleeping && 'opacity-65',
                !isActive &&
                  index < tabs.length - 1 &&
                  !nextIsActive &&
                  'after:pointer-events-none after:absolute after:top-1/2 after:-right-[1px] after:h-3.5 after:w-px after:-translate-y-1/2 after:bg-border-strong after:transition-opacity hover:after:opacity-0',
                dragging && dragIndex === index && 'opacity-40',
                dragging && dropIndex === index && dragIndex !== index
                  ? 'shadow-[inset_2px_0_0_0_var(--accent-seed)]'
                  : undefined,
              )}
            >
              <SurfaceTab
                variant="chrome"
                className="max-w-[184px]"
                label={label}
                title={tab.sleeping ? `${tab.url || label}（已休眠，点击恢复）` : tab.url || label}
                active={isActive}
                icon={
                  tab.loading ? (
                    <Spinner label="加载中" className="size-3.5" />
                  ) : tab.muted || tab.audible ? undefined : tab.favicon ? (
                    <Favicon key={tab.favicon} url={tab.favicon} />
                  ) : (
                    <Icon name="Globe" />
                  )
                }
                iconAction={
                  !locked && (tab.muted || tab.audible) ? (
                    <SurfaceTabAction
                      label={tab.muted ? `取消静音 ${label}` : `静音 ${label}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleMute(tab.id, !tab.muted);
                      }}
                    >
                      <Icon name={tab.muted ? 'VolumeOff' : 'Volume'} className="size-3.5" />
                    </SurfaceTabAction>
                  ) : undefined
                }
                onSelect={locked ? undefined : () => onSelect(tab.id)}
                onClose={locked ? undefined : () => onClose(tab.id)}
                closeLabel={`关闭 ${label}`}
              />
            </div>
          );
        })}
      </SurfaceTabStrip>
      <div className="flex h-full shrink-0 items-center pb-0.5 [app-region:no-drag] [-webkit-app-region:no-drag]">
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
