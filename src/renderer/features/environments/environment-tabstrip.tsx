import { useState, type DragEvent } from 'react';
import { Icon } from '@/components/icons';
import { IconButton } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { SurfaceTab, SurfaceTabAction, SurfaceTabStrip } from '@/components/ui/surface-tab';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import type { TabRef, TabState } from '@shared/types';

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
  onCloseOthers: (ref: TabRef) => void;
  onCloseRight: (ref: TabRef) => void;
  onReorder: (from: number, to: number) => void;
  onToggleMute: (ref: TabRef, muted: boolean) => void;
}

/**
 * favicon 拉不到时退回占位图标，不要留一个裂图。
 *
 * `key` 挂在 url 上：换页换了图标要重挂一次，否则 `broken` 会黏住——
 * 先 404 过的标签之后再也显示不出图标。
 */
function Favicon({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <Icon name="Globe" />;
  return <img src={url} alt="" className="size-3.5 shrink-0" onError={() => setBroken(true)} />;
}

/**
 * 一个 Environment 的标签条。
 *
 * 标签活在 Environment 里面（共用它的 session / 代理 / 登录态），所以这条
 * 只属于右侧当前环境，不是全局的。
 *
 * 视觉用 `SurfaceTab` / `SurfaceTabStrip`，不要在这里手写 tab chrome。
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
  onCloseOthers,
  onCloseRight,
  onReorder,
  onToggleMute,
}: Props) {
  // 拖拽状态：只有「拖到别的标签上」才画落点指示，拖回原位不画。
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dragging = dragIndex !== null;

  const endDrag = () => {
    setDragIndex(null);
    setDropIndex(null);
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {/* flex-initial：标签条按内容宽、放不下才缩（并横向滚动），
          这样 + 紧跟在最后一个标签后面，而不是被推到最右。 */}
      <SurfaceTabStrip aria-label="标签" className="flex-initial">
        {tabs.map((tab, index) => {
          // about:blank 是「还没去过任何地方」，显示成新标签页；直接把 URL 当标题
          // 会看到一排 "about:blank"，分不清哪个是哪个。
          const label = tab.title || (tab.url && tab.url !== 'about:blank' ? tab.url : '新标签页');
          return (
            // 拖拽包装节点：拖拽逻辑留在这一层，不往 `SurfaceTab` 里塞 props
            // ——那个文件镜像上游 web-next，加本项目独有的东西会让同步变贵。
            <div
              key={tab.id}
              draggable={!locked}
              data-tab-index={index}
              data-tab-id={tab.id}
              onDragStart={(event: DragEvent<HTMLDivElement>) => {
                if (locked) return;
                setDragIndex(index);
                event.dataTransfer.effectAllowed = 'move';
                // 有些平台不带 data 就不触发 drop，随便放一个可读的值
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
              className={cn(
                'flex shrink-0 rounded-[var(--control-radius)]',
                dragging && dragIndex === index && 'opacity-40',
                dragging && dropIndex === index && dragIndex !== index
                  ? 'shadow-[inset_2px_0_0_0_var(--theme-accent)]'
                  : undefined,
              )}
            >
              <ContextMenu>
                <ContextMenuTrigger render={<div className="flex" />}>
                  <SurfaceTab
                    label={label}
                    title={tab.url || label}
                    active={tab.id === activeTabId}
                    icon={
                      tab.loading ? (
                        <Spinner label="加载中" className="size-3.5" />
                      ) : tab.muted ||
                        tab.audible ? undefined : tab // 有声 / 静音时图标位让给喇叭（喇叭走 iconAction，见 SurfaceTab 的说明）
                        .favicon ? (
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
                    // 带上序号：同名标签（同一个 fixture 开好几个）靠 title 和 URL 都分不出来，
                    // 读屏念到一串「关闭 form fixture」时至少还能靠序号定位
                    closeLabel={`关闭第 ${index + 1} 个标签：${label}`}
                    onSelect={locked ? undefined : () => onSelect(tab.id)}
                    onClose={locked ? undefined : () => onClose(tab.id)}
                  />
                </ContextMenuTrigger>
                <ContextMenuContent className="w-52">
                  {/* base-ui：`Label` 必须在 `Group` 里，否则整个 React 树被卸载成白屏 */}
                  <ContextMenuGroup>
                    <ContextMenuLabel className="truncate">{label}</ContextMenuLabel>
                  </ContextMenuGroup>
                  <ContextMenuSeparator />
                  <ContextMenuItem disabled={locked || !canReload} onClick={() => onReload(tab.id)}>
                    <Icon name="Refresh" /> {canReload ? '重新加载' : '重新加载（需要先接管）'}
                  </ContextMenuItem>
                  <ContextMenuItem disabled={!tab.url} onClick={() => void navigator.clipboard.writeText(tab.url)}>
                    <Icon name="Copy" /> 复制链接
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem disabled={locked} onClick={() => onClose(tab.id)}>
                    <Icon name="X" /> 关闭
                  </ContextMenuItem>
                  <ContextMenuItem disabled={locked || tabs.length < 2} onClick={() => onCloseOthers(tab.id)}>
                    关闭其他
                  </ContextMenuItem>
                  <ContextMenuItem disabled={locked || index === tabs.length - 1} onClick={() => onCloseRight(tab.id)}>
                    关闭右侧
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </div>
          );
        })}
      </SurfaceTabStrip>
      <IconButton variant="ghost" title="新建标签" disabled={disabled || locked} onClick={onCreate}>
        <Icon name="Plus" />
      </IconButton>
    </div>
  );
}
