import { useEffect, useRef, useState } from 'react';
import { PluginBoundary } from '@/app/plugin-surfaces';
import { Icon, isIconName, type IconName } from '@/components/icons';
import { IconButton } from '@/components/ui/button';
import { MenuLabel } from '@/components/ui/menu';
import { Spinner } from '@/components/ui/spinner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useStandaloneThemeSync } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { usePluginState } from '@/state/plugin-store';
import { elevatedMenuSurfaceClass, menuItemInteractiveClass } from '@/theme/surface';
import type { DownloadItemInfo, FindInPageResult, SpaceId, UrlHistoryEntry, ViewportPresetId } from '@shared/types';

interface PopoverStatePayload {
  id: string;
  props: Record<string, unknown>;
}

function AddressSuggestView({ props }: { props: Record<string, unknown> }) {
  const query = typeof props.query === 'string' ? props.query : '';
  const entries = Array.isArray(props.entries) ? (props.entries as UrlHistoryEntry[]) : [];
  const highlighted = typeof props.highlighted === 'number' ? props.highlighted : -1;

  return (
    <div
      id="address-history"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 候选需要组合键高亮与无焦点鼠标选择
      role="listbox"
      aria-label="跨环境地址历史"
      className={cn(
        elevatedMenuSurfaceClass,
        'flex h-full flex-col gap-0.5 overflow-y-auto rounded-[var(--radius-menu)] p-1 select-none',
      )}
    >
      <MenuLabel>{query ? '历史联想' : '最近访问（所有环境）'}</MenuLabel>
      {entries.map((entry, index) => (
        <button
          key={entry.url}
          id={`address-history-${index}`}
          type="button"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- listbox 选项需保持父输入框焦点不丢失
          role="option"
          aria-selected={index === highlighted}
          data-highlighted={index === highlighted ? '' : undefined}
          onMouseEnter={() => {
            void window.envApi.dispatchPopoverAction({
              id: 'address-suggest',
              action: 'hover',
              payload: index,
            });
          }}
          onMouseDown={(event) => {
            event.preventDefault();
            void window.envApi.dispatchPopoverAction({
              id: 'address-suggest',
              action: 'pick',
              payload: entry.url,
            });
          }}
          className={cn(
            menuItemInteractiveClass,
            'flex w-full items-center gap-2 px-[var(--control-pad-x-compact)] py-[var(--control-pad-y-compact)] text-left',
            index === highlighted && 'bg-surface-hover opacity-100',
          )}
        >
          <Icon name="Globe" className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.url}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{entry.visitCount} 次</span>
        </button>
      ))}
    </div>
  );
}

function FindInPageView({ props }: { props: Record<string, unknown> }) {
  const envId = typeof props.envId === 'string' ? props.envId : '';
  const space: SpaceId = props.space === 'agent' ? 'agent' : 'person';
  const [query, setQuery] = useState(typeof props.initialQuery === 'string' ? props.initialQuery : '');
  const [result, setResult] = useState<FindInPageResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    return window.envApi.onFindResult((next) => {
      if (next.envId === envId) setResult(next);
    });
  }, [envId]);

  useEffect(() => {
    if (!envId) return;
    if (!query) {
      void window.envApi.stopFindInPage(envId, space);
      return;
    }
    const timer = window.setTimeout(() => {
      void window.envApi.findInPage(envId, space, query, { forward: true, findNext: false });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [envId, space, query]);

  const close = () => {
    if (envId) void window.envApi.stopFindInPage(envId, space);
    void window.envApi.closePopover('find-in-page');
  };

  const step = (forward: boolean) => {
    if (!envId || !query) return;
    void window.envApi.findInPage(envId, space, query, { forward, findNext: true });
  };

  const total = result?.matches ?? 0;
  const active = result?.activeMatchOrdinal ?? 0;

  return (
    <div
      className={cn(
        elevatedMenuSurfaceClass,
        'flex h-full items-center gap-1.5 rounded-[var(--radius-menu)] px-2.5 py-1.5',
      )}
    >
      <Icon name="Search" className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="页内查找…"
        onChange={(event) => {
          setQuery(event.target.value);
          if (!event.target.value) setResult(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            step(!event.shiftKey);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {query ? `${active} / ${total}` : '0 / 0'}
      </span>
      <IconButton variant="ghost" title="上一个 (⇧⌘G)" disabled={!query || total === 0} onClick={() => step(false)}>
        <Icon name="ChevronUp" className="size-3.5" />
      </IconButton>
      <IconButton variant="ghost" title="下一个 (⌘G)" disabled={!query || total === 0} onClick={() => step(true)}>
        <Icon name="ChevronDown" className="size-3.5" />
      </IconButton>
      <IconButton variant="ghost" title="关闭 (Esc)" onClick={close}>
        <Icon name="X" className="size-3.5" />
      </IconButton>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DownloadsView({ props }: { props: Record<string, unknown> }) {
  const envId = typeof props.envId === 'string' ? props.envId : undefined;
  const [items, setItems] = useState<DownloadItemInfo[]>([]);

  useEffect(() => {
    const pull = () => void window.envApi.downloads(envId).then(setItems);
    pull();
    const unsubDelta = window.envApi.onEnvDelta(pull);
    const unsubState = window.envApi.onStateChanged(pull);
    return () => {
      unsubDelta();
      unsubState();
    };
  }, [envId]);

  return (
    <div
      className={cn(
        elevatedMenuSurfaceClass,
        'flex h-full flex-col gap-1 overflow-hidden rounded-[var(--radius-menu)] p-2 text-xs',
      )}
    >
      <div className="flex items-center justify-between px-1.5 py-1">
        <span className="font-medium text-foreground">下载记录</span>
        <IconButton variant="ghost" title="关闭" onClick={() => void window.envApi.closePopover('downloads')}>
          <Icon name="X" className="size-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-2 py-8 text-center text-muted-foreground">当前没有下载记录</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <li
                key={item.downloadId}
                className="flex items-center gap-2 rounded-[var(--radius-menu-item)] border border-border/50 px-2.5 py-2"
              >
                <Icon name="Download" className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground" title={item.filename}>
                    {item.filename}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {item.state === 'progressing'
                      ? `${formatBytes(item.receivedBytes)} / ${item.totalBytes > 0 ? formatBytes(item.totalBytes) : '未知大小'}`
                      : item.state === 'completed'
                        ? `已完成 · ${formatBytes(item.totalBytes || item.receivedBytes)}`
                        : item.state === 'cancelled'
                          ? '已取消'
                          : '下载中断'}
                  </div>
                </div>
                {item.state === 'completed' && (
                  <IconButton
                    variant="ghost"
                    title="在 Finder 中显示"
                    onClick={() => void window.envApi.revealDownload(item.downloadId)}
                  >
                    <Icon name="FolderOpen" className="size-3.5" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const VIEWPORT_PRESETS: Array<{ id: ViewportPresetId; label: string; detail: string; icon: IconName }> = [
  { id: 'auto', label: '自适应工作区', detail: '随舞台宽度自动铺满', icon: 'Viewport' },
  { id: 'desktop-1440', label: '桌面标准', detail: '1440 × 900 · DPR 1', icon: 'Desktop' },
  { id: 'laptop-1280', label: '笔记本视口', detail: '1280 × 800 · DPR 1', icon: 'Laptop' },
  { id: 'mobile-390', label: '移动端设备', detail: '390 × 844 · Touch / DPR 2', icon: 'Mobile' },
];

function ViewportView({ props }: { props: Record<string, unknown> }) {
  const envId = typeof props.envId === 'string' ? props.envId : '';
  const space: SpaceId = props.space === 'agent' ? 'agent' : 'person';
  const currentPreset = (typeof props.preset === 'string' ? props.preset : 'auto') as ViewportPresetId;

  const choose = async (preset: ViewportPresetId) => {
    if (!envId) return;
    await window.envApi.setViewportPreset(envId, space, preset);
    await window.envApi.dispatchPopoverAction({ id: 'viewport', action: 'preset', payload: preset });
    await window.envApi.closePopover('viewport');
  };

  return (
    <div
      role="menu"
      className={cn(elevatedMenuSurfaceClass, 'flex h-full flex-col gap-0.5 rounded-[var(--radius-menu)] p-1 text-xs')}
    >
      <MenuLabel>模拟视口尺寸</MenuLabel>
      {VIEWPORT_PRESETS.map((preset) => {
        const active = preset.id === currentPreset;
        return (
          <button
            key={preset.id}
            type="button"
            role="menuitem"
            onClick={() => void choose(preset.id)}
            className={cn(
              menuItemInteractiveClass,
              'flex w-full items-center gap-2.5 px-2.5 py-2 text-left',
              active && 'bg-surface-hover opacity-100',
            )}
          >
            <Icon name={preset.icon} className="shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-foreground">{preset.label}</div>
              <div className="text-[11px] text-muted-foreground">{preset.detail}</div>
            </div>
            {active && <Icon name="Check" className="size-3.5 text-[var(--theme-accent)]" />}
          </button>
        );
      })}
    </div>
  );
}

function PluginPopoverView({ props }: { props: Record<string, unknown> }) {
  const { registry, loaded } = usePluginState();
  const pluginId = typeof props.pluginId === 'string' ? props.pluginId : '';
  const surfaceId = typeof props.surfaceId === 'string' ? props.surfaceId : '';
  const environmentId = typeof props.environmentId === 'string' ? props.environmentId : undefined;
  const space: SpaceId = props.space === 'agent' ? 'agent' : 'person';
  const url = typeof props.url === 'string' ? props.url : '';

  const surface = registry.popovers.find((item) => item.pluginId === pluginId && item.id === surfaceId);
  const railPage = registry.railPages.find((item) => item.pluginId === pluginId);
  const inspectorTab = registry.inspectorTabs.find((item) => item.pluginId === pluginId);
  const iconName: IconName = surface?.icon && isIconName(surface.icon) ? surface.icon : 'Plug';

  const closePopover = () => {
    void window.envApi.closePopover('plugin-popover');
  };
  const openPluginPage = (targetSurfaceId?: string) => {
    const id = targetSurfaceId ?? railPage?.id;
    if (!id) return;
    void window.envApi.dispatchPopoverAction({
      id: 'plugin-popover',
      action: 'openPluginPage',
      payload: { pluginId, surfaceId: id },
    });
    closePopover();
  };
  const openInspectorTab = (targetSurfaceId?: string) => {
    const id = targetSurfaceId ?? inspectorTab?.id;
    if (!id) return;
    void window.envApi.dispatchPopoverAction({
      id: 'plugin-popover',
      action: 'openInspectorTab',
      payload: { pluginId, surfaceId: id },
    });
    closePopover();
  };

  return (
    <div
      data-slot="plugin-popover-host"
      data-plugin-id={pluginId}
      data-surface-id={surfaceId}
      className={cn(
        elevatedMenuSurfaceClass,
        'flex h-full flex-col overflow-hidden rounded-[var(--radius-menu)] text-xs text-foreground',
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5 py-1.5">
        <Icon name={iconName} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{surface?.title ?? '插件快捷面板'}</span>
        {surface?.shortcut && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{surface.shortcut}</span>
        )}
        {inspectorTab && (
          <IconButton
            variant="ghost"
            title="在右侧工作台打开"
            aria-label="在右侧工作台打开"
            onClick={() => openInspectorTab(inspectorTab.id)}
          >
            <Icon name="PanelRight" className="size-3.5" />
          </IconButton>
        )}
        {railPage && (
          <IconButton
            variant="ghost"
            title="打开完整管理页"
            aria-label="打开完整管理页"
            onClick={() => openPluginPage(railPage.id)}
          >
            <Icon name="ExternalLink" className="size-3.5" />
          </IconButton>
        )}
        <IconButton variant="ghost" title="关闭 (Esc)" aria-label="关闭" onClick={closePopover}>
          <Icon name="X" className="size-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded ? (
          <div className="flex h-full items-center justify-center gap-2 p-6 text-muted-foreground">
            <Spinner />
            <span>正在加载插件面板…</span>
          </div>
        ) : !surface ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
            <Icon name="AlertTriangle" className="size-5 text-[var(--warning)]" />
            <p className="text-foreground">未找到该插件快捷面板</p>
            <p className="font-mono text-[11px]">{`${pluginId}:${surfaceId}`}</p>
          </div>
        ) : (
          <PluginBoundary pluginId={pluginId} title={surface.title}>
            <surface.component
              pluginId={pluginId}
              environmentId={environmentId}
              space={space}
              url={url}
              closePopover={closePopover}
              openPluginPage={openPluginPage}
              openInspectorTab={openInspectorTab}
            />
          </PluginBoundary>
        )}
      </div>
    </div>
  );
}

/**
 * PopoverHost 子窗口渲染入口（加载 `index.html?surface=popover`）。
 * 依托操作系统 `parent` 子窗，直接凌驾于 `WebContentsView` 与主窗之上，绝不遮挡/节流页面。
 */
export function PopoverRoot() {
  useStandaloneThemeSync();
  const [state, setState] = useState<PopoverStatePayload | null>(null);

  useEffect(() => {
    void window.envApi.getPopoverState().then(setState);
    return window.envApi.onPopoverState(setState);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && state) {
        event.preventDefault();
        void window.envApi.closePopover(state.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state]);

  if (!state) return null;

  return (
    <TooltipProvider>
      <div className="h-full w-full p-0.5">
        {state.id === 'address-suggest' && <AddressSuggestView props={state.props} />}
        {state.id === 'find-in-page' && <FindInPageView props={state.props} />}
        {state.id === 'downloads' && <DownloadsView props={state.props} />}
        {state.id === 'viewport' && <ViewportView props={state.props} />}
        {state.id === 'plugin-popover' && <PluginPopoverView props={state.props} />}
      </div>
    </TooltipProvider>
  );
}
