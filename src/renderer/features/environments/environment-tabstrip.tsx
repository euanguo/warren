import { useState, type DragEvent, type MouseEvent } from 'react';
import { Icon } from '@/components/icons';
import { IconButton } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { SurfaceTab, SurfaceTabAction, SurfaceTabStrip } from '@/components/ui/surface-tab';
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
}

function Favicon({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <Icon name="Globe" />;
  return <img src={url} alt="" className="size-3.5 shrink-0" onError={() => setBroken(true)} />;
}

/**
 * 一个 Environment 的标签条，使用系统原生 `popupMenu` 右键菜单，不遮挡底部网页。
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
}: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dragging = dragIndex !== null;

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
    else if (picked === 'close') onClose(tab.id);
    else if (picked === 'close-others') onCloseOthers(tab.id);
    else if (picked === 'close-right') onCloseRight(tab.id);
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <SurfaceTabStrip aria-label="标签" className="flex-initial [app-region:no-drag] [-webkit-app-region:no-drag]">
        {tabs.map((tab, index) => {
          const label = tab.title || (tab.url && tab.url !== 'about:blank' ? tab.url : '新标签页');
          return (
            <div
              key={tab.id}
              draggable={!locked}
              data-tab-index={index}
              data-tab-id={tab.id}
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
                'flex shrink-0 rounded-[var(--control-radius)]',
                dragging && dragIndex === index && 'opacity-40',
                dragging && dropIndex === index && dragIndex !== index
                  ? 'shadow-[inset_2px_0_0_0_var(--theme-accent)]'
                  : undefined,
              )}
            >
              <SurfaceTab
                label={label}
                title={tab.url || label}
                active={tab.id === activeTabId}
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
                closeLabel={`关闭第 ${index + 1} 个标签：${label}`}
                onSelect={locked ? undefined : () => onSelect(tab.id)}
                onClose={locked ? undefined : () => onClose(tab.id)}
              />
            </div>
          );
        })}
      </SurfaceTabStrip>
      <IconButton
        variant="ghost"
        title="新建标签 (⌘T)"
        disabled={disabled || locked}
        onClick={onCreate}
        className="[app-region:no-drag] [-webkit-app-region:no-drag]"
      >
        <Icon name="Plus" />
      </IconButton>
    </div>
  );
}
