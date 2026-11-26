import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { ActionTooltip } from '@/components/action-tooltip';
import { Icon } from '@/components/icons';
import { Button, IconButton } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { addressSecurity, resolveAddressInput } from '@/lib/address-input';
import type { PluginInspectorTab, PluginPopoverSurface } from '@/lib/plugin-runtime';
import { cn } from '@/lib/utils';
import type {
  DevToolsDockMode,
  NativeMenuItem,
  NavigationAction,
  SpaceId,
  UrlHistoryEntry,
  ViewportPresetId,
} from '@shared/types';

function splitUrlDisplay(raw: string): { prefix: string; host: string; rest: string } | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!parsed.host) return null;
    const prefix = `${parsed.protocol}//`;
    const host = parsed.host;
    const rest = `${parsed.pathname === '/' && !parsed.search && !parsed.hash ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
    return { prefix, host, rest };
  } catch {
    return null;
  }
}

const SECURITY_ICON = {
  secure: { name: 'Lock', className: 'text-[var(--success)]', label: '连接安全（https）' },
  insecure: {
    name: 'AlertTriangle',
    className: 'text-[var(--warning)]',
    label: '连接不安全（http）',
  },
  none: { name: 'Globe', className: 'text-muted-foreground/60', label: '未知连接状态' },
} as const;

const PRESET_BADGE: Record<ViewportPresetId, string | null> = {
  auto: null,
  'desktop-1440': '1440',
  'laptop-1280': '1280',
  'mobile-390': '390',
};

interface Props {
  envId?: string;
  spaceId: SpaceId;
  url: string;
  loading: boolean;
  editable: boolean;
  /** 环境停机但在「我的」空间时，允许输入网址回车自动先启动环境再跳转。 */
  canStartOnSubmit?: boolean;
  running: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  inspectorOpen: boolean;
  devToolsOpen: boolean;
  devToolsDock: DevToolsDockMode;
  zoomFactor: number;
  viewportPreset: ViewportPresetId;
  hasActiveDownload?: boolean;
  focusToken?: number;
  pluginPopovers?: PluginPopoverSurface[];
  pluginInspectorTabs?: PluginInspectorTab[];
  onToggleInspector: () => void;
  onToggleDevTools: () => void;
  onChangeDevToolsDock: (dock: DevToolsDockMode) => void;
  onResetZoom: () => void;
  onOpenFind: () => void;
  onViewportPresetChanged?: (preset: ViewportPresetId) => void;
  onNavigate: (action: NavigationAction) => void;
  onStartAndNavigate?: (url: string) => void;
  onOpenPluginSurface?: (kind: 'popover' | 'inspectorTab', pluginId: string, surfaceId: string) => void;
}

/**
 * 地址栏行：前进/后退/刷新 + PopoverHost 无焦点地址联想 + 缩放/视口/查找/下载/DevTools/检查器控制组。
 */
export function EnvironmentAddressBar({
  envId,
  spaceId,
  url,
  loading,
  editable,
  canStartOnSubmit = false,
  running,
  canGoBack,
  canGoForward,
  inspectorOpen,
  devToolsOpen,
  devToolsDock,
  zoomFactor,
  viewportPreset,
  hasActiveDownload = false,
  focusToken = 0,
  pluginPopovers = [],
  pluginInspectorTabs = [],
  onToggleInspector,
  onToggleDevTools,
  onChangeDevToolsDock,
  onResetZoom,
  onOpenFind,
  onViewportPresetChanged,
  onNavigate,
  onStartAndNavigate,
  onOpenPluginSurface,
}: Props) {
  const inputEditable = editable || canStartOnSubmit;
  const [draft, setDraft] = useState(url);
  const [editing, setEditing] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [history, setHistory] = useState<UrlHistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const pageToolsBtnRef = useRef<HTMLButtonElement>(null);
  const viewportBtnRef = useRef<HTMLButtonElement>(null);
  const downloadBtnRef = useRef<HTMLButtonElement>(null);
  const copiedTimerRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleCopyUrl = () => {
    if (!url) return;
    void navigator.clipboard.writeText(url);
    setCopiedUrl(true);
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopiedUrl(false), 1500);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'l') return;
      if (!inputEditable) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [inputEditable]);

  useEffect(() => {
    if (!focusToken || !inputEditable) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken, inputEditable]);

  useEffect(() => {
    if (!editing || !historyOpen) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.envApi
        .historySuggest(historyQuery, 8)
        .then((entries) => {
          if (cancelled) return;
          setHistory(entries);
          setHighlighted(-1);
        })
        .catch(() => {
          if (!cancelled) setHistory([]);
        });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [editing, historyOpen, historyQuery]);

  const suggestionsVisible = editing && historyOpen && history.length > 0;

  useEffect(() => {
    if (!suggestionsVisible || !boxRef.current) {
      void window.envApi.closePopover('address-suggest');
      return;
    }
    const rect = boxRef.current.getBoundingClientRect();
    const height = Math.min(320, history.length * 32 + 40);
    void window.envApi.openPopover({
      id: 'address-suggest',
      anchorRect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      size: { width: Math.max(320, Math.round(rect.width)), height },
      placement: 'bottom-start',
      focusable: false,
      beyondWindow: true,
      props: { query: historyQuery, entries: history, highlighted },
    });
  }, [suggestionsVisible, historyQuery, history, highlighted]);

  const security = SECURITY_ICON[addressSecurity(url)];
  const disabledReason = editable ? null : running ? '需要先接管控制权' : '环境未启动';
  const title = (label: string) => (disabledReason ? `${label}（${disabledReason}）` : label);

  const submitRef = useRef<(input?: string) => void>(() => {});
  const presetChangedRef = useRef(onViewportPresetChanged);

  const submit = (input = draft) => {
    const target = resolveAddressInput(input);
    if (target === null) {
      toast.error('这不是一个可访问的地址', {
        description: '只接受 http/https 地址，例如 example.com 或 https://example.com/path',
      });
      return;
    }
    if (!running && canStartOnSubmit) {
      onStartAndNavigate?.(target);
    } else if (target !== url) {
      onNavigate({ kind: 'goto', url: target });
    }
    setHistoryOpen(false);
    void window.envApi.closePopover('address-suggest');
    inputRef.current?.blur();
  };

  useEffect(() => {
    submitRef.current = submit;
    presetChangedRef.current = onViewportPresetChanged;
  });

  useEffect(() => {
    return window.envApi.onPopoverAction((event) => {
      if (event.id === 'address-suggest') {
        if (event.action === 'hover' && typeof event.payload === 'number') {
          setHighlighted(event.payload);
        } else if (event.action === 'pick' && typeof event.payload === 'string') {
          setDraft(event.payload);
          setHistoryQuery(event.payload);
          submitRef.current(event.payload);
        }
      } else if (event.id === 'viewport' && event.action === 'preset' && typeof event.payload === 'string') {
        presetChangedRef.current?.(event.payload as ViewportPresetId);
      }
    });
  }, []);

  const chooseHistory = (entry: UrlHistoryEntry) => {
    setDraft(entry.url);
    setHistoryQuery(entry.url);
    submit(entry.url);
  };

  const openReloadMenu = async (event: MouseEvent) => {
    event.preventDefault();
    if (!editable) return;
    const picked = await window.envApi.popupMenu(
      [
        { id: 'reload', label: '重新加载页面', accelerator: 'CmdOrCtrl+R' },
        { id: 'hard-reload', label: '忽略缓存硬刷新', accelerator: 'CmdOrCtrl+Shift+R' },
      ],
      { x: Math.round(event.clientX), y: Math.round(event.clientY) },
    );
    if (picked === 'reload') onNavigate({ kind: 'reload' });
    else if (picked === 'hard-reload') onNavigate({ kind: 'hardReload' });
  };

  const openDevToolsMenu = async (event: MouseEvent) => {
    event.preventDefault();
    if (!editable) return;
    const picked = await window.envApi.popupMenu(
      [
        { label: 'DevTools 停靠位置', enabled: false },
        { id: 'right', label: '右侧停靠', type: 'checkbox', checked: devToolsDock === 'right' },
        { id: 'bottom', label: '底部停靠', type: 'checkbox', checked: devToolsDock === 'bottom' },
        { id: 'detach', label: '独立窗口', type: 'checkbox', checked: devToolsDock === 'detach' },
      ],
      { x: Math.round(event.clientX), y: Math.round(event.clientY) },
    );
    if (picked === 'right' || picked === 'bottom' || picked === 'detach') {
      onChangeDevToolsDock(picked);
    }
  };

  const openViewportPopover = (anchor?: HTMLElement | null) => {
    const el = anchor ?? viewportBtnRef.current ?? pageToolsBtnRef.current;
    if (!envId || !running || !el) return;
    const rect = el.getBoundingClientRect();
    void window.envApi.openPopover({
      id: 'viewport',
      anchorRect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      size: { width: 248, height: 220 },
      placement: 'bottom-end',
      focusable: true,
      beyondWindow: true,
      props: { envId, space: spaceId, preset: viewportPreset },
    });
  };

  const openDownloadsPopover = (anchor?: HTMLElement | null) => {
    const el = anchor ?? downloadBtnRef.current ?? pageToolsBtnRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    void window.envApi.openPopover({
      id: 'downloads',
      anchorRect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      size: { width: 320, height: 280 },
      placement: 'bottom-end',
      focusable: true,
      beyondWindow: true,
      props: { envId },
    });
  };

  const openPageToolsMenu = async (event: MouseEvent<HTMLButtonElement>) => {
    const anchor = event.currentTarget;
    const rect = anchor.getBoundingClientRect();
    const items: NativeMenuItem[] = [
      { id: 'find', label: '页内查找', accelerator: 'CmdOrCtrl+F', enabled: running },
      {
        id: 'viewport',
        label: presetLabel ? `模拟响应式视口（当前 ${presetLabel}）` : '模拟响应式视口…',
        enabled: running,
      },
      { id: 'downloads', label: hasActiveDownload ? '下载记录（进行中）' : '下载记录…' },
      { id: 'copy-url', label: '复制当前 URL', enabled: url.length > 0 },
    ];
    if (pluginPopovers.length > 0) {
      items.push({ type: 'separator' }, { label: '插件快捷浮卡', enabled: false });
      for (const pop of pluginPopovers) {
        items.push({ id: `popover:${pop.pluginId}:${pop.id}`, label: pop.title, enabled: running });
      }
    }
    if (pluginInspectorTabs.length > 0) {
      items.push({ type: 'separator' }, { label: '工作台插件面板', enabled: false });
      for (const tab of pluginInspectorTabs) {
        items.push({ id: `inspectorTab:${tab.pluginId}:${tab.id}`, label: tab.title, enabled: running });
      }
    }
    const picked = await window.envApi.popupMenu(items, {
      x: Math.round(rect.left),
      y: Math.round(rect.bottom + 4),
    });
    if (!picked) return;
    if (picked === 'find') {
      onOpenFind();
    } else if (picked === 'viewport') {
      openViewportPopover(anchor);
    } else if (picked === 'downloads') {
      openDownloadsPopover(anchor);
    } else if (picked === 'copy-url') {
      handleCopyUrl();
    } else if (picked.startsWith('popover:') || picked.startsWith('inspectorTab:')) {
      const firstSep = picked.indexOf(':');
      const kind = picked.slice(0, firstSep) as 'popover' | 'inspectorTab';
      const rest = picked.slice(firstSep + 1);
      const secondSep = rest.indexOf(':');
      if (secondSep > 0) {
        onOpenPluginSurface?.(kind, rest.slice(0, secondSep), rest.slice(secondSep + 1));
      }
    }
  };

  const zoomPercent = Math.round(zoomFactor * 100);
  const presetLabel = PRESET_BADGE[viewportPreset];
  const urlParts = !editing ? splitUrlDisplay(url) : null;

  return (
    <div
      data-slot="address-bar"
      className="flex h-[var(--shell-address-row-height)] shrink-0 items-center gap-1 border-b border-divider bg-background px-2"
    >
      <ActionTooltip label={title('后退')} shortcut="⌘[" side="top">
        <IconButton
          variant="ghost"
          aria-label="后退"
          disabled={!editable || !canGoBack}
          onClick={() => onNavigate({ kind: 'back' })}
          className="disabled:opacity-40"
        >
          <Icon name="ChevronLeft" />
        </IconButton>
      </ActionTooltip>
      <ActionTooltip label={title('前进')} shortcut="⌘]" side="top">
        <IconButton
          variant="ghost"
          aria-label="前进"
          disabled={!editable || !canGoForward}
          onClick={() => onNavigate({ kind: 'forward' })}
          className="disabled:opacity-40"
        >
          <Icon name="ChevronRight" />
        </IconButton>
      </ActionTooltip>
      <ActionTooltip label={title('刷新（右键硬刷新）')} shortcut="⌘R" side="top">
        <IconButton
          variant="ghost"
          aria-label="刷新"
          disabled={!editable}
          onClick={() => onNavigate({ kind: 'reload' })}
          onContextMenu={(event) => void openReloadMenu(event)}
          className="disabled:opacity-40"
        >
          <Icon name="Refresh" />
        </IconButton>
      </ActionTooltip>

      <div className="flex min-w-0 flex-1 justify-center px-1">
        <div ref={boxRef} className="group/omnibox relative w-full max-w-[820px] min-w-0">
          <div
            className={cn(
              'flex h-[var(--control-height-icon)] min-w-0 items-center gap-2 rounded-full border border-border/80 bg-[var(--input-fill)] px-3 transition-colors',
              'focus-within:border-focus',
              !inputEditable && 'opacity-70',
            )}
          >
            <span title={security.label} className="flex shrink-0 items-center">
              <Icon
                name={security.name}
                className={cn(security.className, canStartOnSubmit && !running && 'text-foreground/70')}
                aria-label={security.label}
              />
            </span>
            <div className="relative flex min-w-0 flex-1 items-center">
              {urlParts && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 flex items-center truncate font-mono text-xs"
                >
                  <span className="shrink-0 text-muted-foreground">{urlParts.prefix}</span>
                  <span className="shrink-0 font-medium text-foreground">{urlParts.host}</span>
                  <span className="truncate text-muted-foreground">{urlParts.rest}</span>
                </div>
              )}
              <input
                ref={inputRef}
                type="text"
                value={editing ? draft : url}
                readOnly={!inputEditable}
                spellCheck={false}
                autoComplete="off"
                placeholder={
                  editable
                    ? '输入地址，例如 example.com'
                    : canStartOnSubmit
                      ? '输入网址回车自动启动并打开…'
                      : running
                        ? 'Agent 空间只读 · 点右上「接管」后可改地址'
                        : '未选择环境'
                }
                aria-label="地址栏"
                role="combobox"
                aria-autocomplete="list"
                aria-controls="address-history"
                aria-expanded={suggestionsVisible}
                aria-activedescendant={
                  suggestionsVisible && highlighted >= 0 ? `address-history-${highlighted}` : undefined
                }
                aria-disabled={!inputEditable}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setHistoryQuery(event.target.value);
                  setHistoryOpen(true);
                }}
                onFocus={(event) => {
                  if (!inputEditable) {
                    event.target.blur();
                    return;
                  }
                  setEditing(true);
                  setDraft(url);
                  setHistoryQuery('');
                  setHistoryOpen(true);
                  event.target.select();
                }}
                onBlur={() => {
                  setEditing(false);
                  setHistoryOpen(false);
                  void window.envApi.closePopover('address-suggest');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' && suggestionsVisible) {
                    event.preventDefault();
                    setHighlighted((index) => (index + 1) % history.length);
                    return;
                  }
                  if (event.key === 'ArrowUp' && suggestionsVisible) {
                    event.preventDefault();
                    setHighlighted((index) => (index <= 0 ? history.length - 1 : index - 1));
                    return;
                  }
                  if (event.key === 'Enter') {
                    if (suggestionsVisible && highlighted >= 0) chooseHistory(history[highlighted]!);
                    else submit();
                    return;
                  }
                  if (event.key === 'Escape') {
                    if (historyOpen) {
                      setHistoryOpen(false);
                      void window.envApi.closePopover('address-suggest');
                      return;
                    }
                    setEditing(false);
                    inputRef.current?.blur();
                  }
                }}
                className={cn(
                  'min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground read-only:cursor-default',
                  urlParts ? 'text-transparent caret-foreground' : 'text-foreground',
                )}
              />
            </div>
            {loading && <Spinner className="ml-auto shrink-0" />}
            {!loading && !editing && url.length > 0 && (
              <ActionTooltip label={copiedUrl ? '已复制当前 URL' : '复制当前 URL'} side="top">
                <button
                  type="button"
                  data-slot="copy-url-button"
                  aria-label="复制当前 URL"
                  onClick={handleCopyUrl}
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full transition-all outline-none focus-visible:border focus-visible:border-focus',
                    copiedUrl
                      ? 'text-[var(--success)] opacity-100'
                      : 'text-subtle-foreground opacity-0 group-hover/omnibox:opacity-100 hover:bg-surface-hover hover:text-foreground focus-visible:opacity-100',
                  )}
                >
                  <Icon name={copiedUrl ? 'Check' : 'Copy'} className="size-3.5" />
                </button>
              </ActionTooltip>
            )}
          </div>
        </div>
      </div>

      {zoomPercent !== 100 && running && (
        <ActionTooltip label="点击复位 100% 缩放" shortcut="⌘0" side="top">
          <Button
            variant="ghost"
            size="xs"
            aria-label={`当前缩放 ${zoomPercent}%，点击复位`}
            onClick={onResetZoom}
            className="px-1.5 font-mono text-[length:var(--font-size-micro)] tabular-nums text-[var(--theme-accent)]"
          >
            {zoomPercent}%
          </Button>
        </ActionTooltip>
      )}

      {presetLabel && running && (
        <ActionTooltip label={`模拟视口 (${presetLabel})`} side="top">
          <Button
            ref={viewportBtnRef}
            variant="ghost"
            size="xs"
            aria-label={`模拟视口 ${presetLabel}`}
            onClick={() => openViewportPopover(viewportBtnRef.current)}
            className="gap-1 px-1.5 font-mono text-[length:var(--font-size-micro)] text-[var(--theme-accent)]"
          >
            <Icon name="Viewport" className="size-3.5" />
            {presetLabel}
          </Button>
        </ActionTooltip>
      )}

      {hasActiveDownload && (
        <ActionTooltip label="查看进行中的下载" side="top">
          <IconButton
            ref={downloadBtnRef}
            variant="ghost"
            aria-label="下载记录"
            onClick={() => openDownloadsPopover(downloadBtnRef.current)}
            className="relative"
          >
            <Icon name="Download" />
            <span className="absolute top-1.5 right-1.5 size-1.5 animate-pulse rounded-full bg-[var(--theme-accent)]" />
          </IconButton>
        </ActionTooltip>
      )}

      <ActionTooltip label="页面工具（查找 / 视口 / 下载）" side="top">
        <IconButton
          ref={pageToolsBtnRef}
          variant="ghost"
          data-slot="page-tools-trigger"
          aria-label="页面工具"
          onClick={(event) => void openPageToolsMenu(event)}
        >
          <Icon name="More" />
        </IconButton>
      </ActionTooltip>

      <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />

      <ActionTooltip
        label={editable ? 'Chrome 开发者工具（右键切停靠）' : title('开发者工具')}
        shortcut="⌥⌘I"
        side="top"
      >
        <IconButton
          variant="ghost"
          data-slot="devtools-toggle"
          aria-label="Chrome 开发者工具"
          disabled={!editable}
          aria-pressed={devToolsOpen}
          aria-expanded={devToolsOpen}
          onClick={onToggleDevTools}
          onContextMenu={(event) => void openDevToolsMenu(event)}
          className="aria-pressed:bg-surface-active aria-pressed:text-foreground"
        >
          <Icon name="Code" />
        </IconButton>
      </ActionTooltip>

      <ActionTooltip label={inspectorOpen ? '收起 Warren 工作台' : '展开 Warren 工作台'} side="top">
        <IconButton
          variant="ghost"
          data-slot="inspector-toggle"
          aria-label={inspectorOpen ? '收起工作台抽屉' : '展开工作台抽屉'}
          aria-expanded={inspectorOpen}
          onClick={onToggleInspector}
          className="aria-expanded:bg-surface-active aria-expanded:text-foreground"
        >
          <Icon name="PanelRight" />
        </IconButton>
      </ActionTooltip>
    </div>
  );
}
