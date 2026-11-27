import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PluginBoundary } from '@/app/plugin-surfaces';
import { PluginBrandGlyph } from '@/components/identity-glyphs';
import { Icon, type IconName } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { MenuLabel } from '@/components/ui/menu';
import { Spinner } from '@/components/ui/spinner';
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot';
import { TooltipProvider } from '@/components/ui/tooltip';
import { formatMemoryKb } from '@/features/settings/memory-panel';
import { useStandaloneThemeSync } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { usePluginState } from '@/state/plugin-store';
import { elevatedMenuSurfaceClass, menuItemInteractiveClass } from '@/theme/surface';
import { ADDRESS_SUGGEST_MAX_HEIGHT, ADDRESS_SUGGEST_MIN_HEIGHT, clampPopoverHeight } from '@shared/popover-sizing';
import { VIEWPORT_PRESET_LIST } from '@shared/viewport-presets';
import type {
  DownloadItemInfo,
  FindInPageResult,
  MemorySnapshot,
  PopoverPropsMap,
  PopoverState,
  ViewportPresetId,
} from '@shared/types';

export function AddressSuggestView({ props }: { props: PopoverPropsMap['address-suggest'] }) {
  const { query, entries, highlighted } = props;
  const preferredWidth = props.width >= 120 ? props.width : 320;
  const [hoverOverride, setHoverOverride] = useState<{ index: number; base: number } | null>(null);
  const activeIndex = hoverOverride && hoverOverride.base === highlighted ? hoverOverride.index : highlighted;
  const contentRef = useRef<HTMLDivElement>(null);
  const lastReportedHeightRef = useRef<number>(0);

  useLayoutEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;
    const syncHeight = () => {
      const rawHeight = contentEl.getBoundingClientRect().height || contentEl.scrollHeight;
      if (rawHeight <= 0) return;
      const nextHeight = clampPopoverHeight(rawHeight + 8, ADDRESS_SUGGEST_MIN_HEIGHT, ADDRESS_SUGGEST_MAX_HEIGHT);
      if (Math.abs(nextHeight - lastReportedHeightRef.current) < 1) return;
      lastReportedHeightRef.current = nextHeight;
      void window.envApi.updatePopover('address-suggest', {
        size: { width: preferredWidth, height: nextHeight },
      });
    };
    syncHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncHeight);
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [entries.length, query, preferredWidth]);

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`address-history-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const handleHover = (index: number) => {
    if (activeIndex === index) return;
    setHoverOverride({ index, base: highlighted });
    void window.envApi.dispatchPopoverAction({
      id: 'address-suggest',
      action: 'hover',
      payload: index,
    });
  };

  return (
    <div
      id="address-history"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 候选需要组合键高亮与无焦点鼠标选择
      role="listbox"
      tabIndex={-1}
      aria-label="跨环境地址历史"
      onMouseLeave={() => setHoverOverride(null)}
      className={cn(
        elevatedMenuSurfaceClass,
        'flex h-full w-full flex-col overflow-y-auto rounded-[var(--radius-menu)] p-1 select-none',
      )}
    >
      <div ref={contentRef} data-slot="address-suggest-content" className="flex flex-col gap-0.5">
        <MenuLabel className="py-1 text-xs">{query ? '历史联想' : '最近访问（所有环境）'}</MenuLabel>
        {entries.map((entry, index) => {
          const isActive = index === activeIndex;
          return (
            <button
              key={entry.url}
              id={`address-history-${index}`}
              type="button"
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- listbox 选项需保持父输入框焦点不丢失
              role="option"
              aria-selected={isActive}
              data-highlighted={isActive ? '' : undefined}
              onMouseEnter={() => handleHover(index)}
              onMouseMove={() => handleHover(index)}
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
                'flex w-full cursor-pointer items-center gap-2 px-[var(--control-pad-x-compact)] py-[var(--control-pad-y-compact)] text-left',
                isActive && 'bg-surface-selected text-foreground opacity-100',
              )}
            >
              <Icon name="Globe" className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.url}</span>
              <span className="shrink-0 text-[length:var(--font-size-micro)] text-muted-foreground">
                {entry.visitCount} 次
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FindInPageView({ props }: { props: PopoverPropsMap['find-in-page'] }) {
  const { envId, space } = props;
  const [query, setQuery] = useState(props.initialQuery ?? '');
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
      <IconButton
        variant="ghost"
        title="上一个 (⇧⌘G)"
        aria-label="上一个匹配项"
        disabled={!query || total === 0}
        onClick={() => step(false)}
      >
        <Icon name="ChevronUp" className="size-3.5" />
      </IconButton>
      <IconButton
        variant="ghost"
        title="下一个 (⌘G)"
        aria-label="下一个匹配项"
        disabled={!query || total === 0}
        onClick={() => step(true)}
      >
        <Icon name="ChevronDown" className="size-3.5" />
      </IconButton>
      <IconButton variant="ghost" title="关闭 (Esc)" aria-label="关闭页内查找" onClick={close}>
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

function DownloadsView({ props }: { props: PopoverPropsMap['downloads'] }) {
  const { envId } = props;
  const [items, setItems] = useState<DownloadItemInfo[]>([]);

  useEffect(() => {
    const pull = () => void window.envApi.downloads(envId).then(setItems);
    pull();
    return window.envApi.onEnvDelta((payload) => {
      if (!payload?.reason || payload.reason === 'downloads') pull();
    });
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
        <IconButton
          variant="ghost"
          title="关闭"
          aria-label="关闭下载记录"
          onClick={() => void window.envApi.closePopover('downloads')}
        >
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
                    aria-label="在 Finder 中显示"
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
  ...VIEWPORT_PRESET_LIST,
];

function ViewportView({ props }: { props: PopoverPropsMap['viewport'] }) {
  const { envId, space, preset: currentPreset } = props;

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

function PluginPopoverView({ props }: { props: PopoverPropsMap['plugin-popover'] }) {
  const { registry, loaded } = usePluginState();
  const { pluginId, surfaceId, environmentId, space, url } = props;

  const surface = registry.popovers.find((item) => item.pluginId === pluginId && item.id === surfaceId);
  const railPage = registry.railPages.find((item) => item.pluginId === pluginId);
  const inspectorTab = registry.inspectorTabs.find((item) => item.pluginId === pluginId);

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

  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('[data-slot="plugin-popover-header"]')) {
      hostRef.current?.focus({ preventScroll: true });
    }
  }, [pluginId, surfaceId]);

  return (
    <div
      ref={hostRef}
      tabIndex={-1}
      data-slot="plugin-popover-host"
      data-plugin-id={pluginId}
      data-surface-id={surfaceId}
      className={cn(
        elevatedMenuSurfaceClass,
        'flex h-full flex-col overflow-hidden rounded-[var(--radius-menu)] border-0 text-xs text-foreground shadow-none outline-none',
      )}
    >
      <div
        data-slot="plugin-popover-header"
        className="flex shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5 py-1.5"
      >
        <PluginBrandGlyph pluginId={pluginId} icon={surface?.icon} />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{surface?.title ?? '插件快捷面板'}</span>
        {surface?.shortcut && <Kbd className="shrink-0 text-[length:var(--font-size-micro)]">{surface.shortcut}</Kbd>}
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

export function MemoryQuickView() {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const pull = () => {
    void window.envApi
      .memorySnapshot()
      .then((next) => {
        if (next) setSnapshot(next);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    let active = true;
    const load = () => {
      void window.envApi
        .memorySnapshot()
        .then((next) => {
          if (active && next) setSnapshot(next);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const topEnvs = (snapshot?.environments ?? []).filter((env) => env.status === 'running').slice(0, 3);
  const tone: StatusDotTone =
    snapshot?.pressure === 'high' ? 'error' : snapshot?.pressure === 'elevated' ? 'warning' : 'success';
  const pressureText = snapshot?.pressure === 'high' ? '高压' : snapshot?.pressure === 'elevated' ? '偏高' : '正常';

  const runQuick = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      pull();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-slot="memory-quick-popover"
      className={cn(
        elevatedMenuSurfaceClass,
        'flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-menu)] text-xs',
      )}
    >
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
        <div className="flex items-center gap-2">
          <StatusDot tone={tone} />
          <span className="font-medium">内存速览</span>
          <Badge variant="outline" className="text-[10px]">
            {pressureText}
          </Badge>
        </div>
        <IconButton
          variant="ghost"
          title="关闭 (Esc)"
          aria-label="关闭"
          onClick={() => void window.envApi.closePopover('memory-quick')}
        >
          <Icon name="X" className="size-3.5" />
        </IconButton>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-lg font-semibold tabular-nums">
            {snapshot ? formatMemoryKb(snapshot.totalMemoryKb) : '采集中…'}
          </span>
          {snapshot && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              可释放约 {formatMemoryKb(snapshot.reclaimableMemoryKb)}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">高占用运行中环境（Top 3）</span>
          {topEnvs.length === 0 ? (
            <p className="py-3 text-center text-[11px] text-muted-foreground">暂无运行中的环境进程</p>
          ) : (
            topEnvs.map((env) => (
              <div
                key={env.id}
                className="flex items-center gap-2 rounded-[var(--control-radius)] border border-border/60 bg-surface-under/40 px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate font-medium" title={env.name}>
                  {env.name}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                  {formatMemoryKb(env.memoryKb)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || Boolean(env.protectedReason)}
                  title={env.protectedReason ? '当前受保护，无法休眠' : '休眠释放内存'}
                  onClick={() => void runQuick(() => window.envApi.hibernate(env.id))}
                >
                  休眠
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-1.5 border-t border-border/70 px-3 py-2">
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || (snapshot?.reclaimableMemoryKb ?? 0) === 0}
            onClick={() => void runQuick(() => window.envApi.hibernateBackground())}
          >
            休眠后台
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void runQuick(() => window.envApi.sleepIdleTabs())}
          >
            释标签
          </Button>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void window.envApi.dispatchPopoverAction({ id: 'memory-quick', action: 'openMemoryPanel' });
            void window.envApi.closePopover('memory-quick');
          }}
        >
          完整面板
        </Button>
      </div>
    </div>
  );
}

/**
 * PopoverHost 子窗口渲染入口（加载 `index.html?surface=popover`）。
 * 依托操作系统 `parent` 子窗，直接凌驾于 `WebContentsView` 与主窗之上，绝不遮挡/节流页面。
 */
export function PopoverRoot() {
  const [state, setState] = useState<PopoverState | null>(null);
  // plugin-popover 内部挂了 usePluginState() 订阅主题同步，避免同一窗口挂两份。
  useStandaloneThemeSync(state !== null && state.id !== 'plugin-popover');

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
      <div className="h-full w-full">
        {state.id === 'address-suggest' && <AddressSuggestView props={state.props} />}
        {state.id === 'find-in-page' && <FindInPageView props={state.props} />}
        {state.id === 'downloads' && <DownloadsView props={state.props} />}
        {state.id === 'viewport' && <ViewportView props={state.props} />}
        {state.id === 'memory-quick' && <MemoryQuickView />}
        {state.id === 'plugin-popover' && <PluginPopoverView props={state.props} />}
      </div>
    </TooltipProvider>
  );
}
