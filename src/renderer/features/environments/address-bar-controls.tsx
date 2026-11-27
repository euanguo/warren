import type { MouseEvent, RefObject } from 'react';
import { PluginBoundary } from '@/app/plugin-surfaces';
import { ActionTooltip } from '@/components/action-tooltip';
import { Icon } from '@/components/icons';
import { PluginBrandGlyph } from '@/components/identity-glyphs';
import { Button, IconButton } from '@/components/ui/button';
import type {
  PluginInspectorTab,
  PluginPopoverSurface,
  PluginRailPage,
  PluginStatusBadge,
} from '@/lib/plugin-sdk-types';
import { cn } from '@/lib/utils';
import type { SpaceId, ViewportRect } from '@shared/types';

interface Props {
  envId?: string;
  spaceId: SpaceId;
  url: string;
  running: boolean;
  editable: boolean;
  zoomPercent: number;
  presetLabel: string | null;
  hasActiveDownload: boolean;
  inspectorOpen: boolean;
  devToolsOpen: boolean;
  pinnedPopovers: PluginPopoverSurface[];
  standaloneBadges: PluginStatusBadge[];
  statusBadgeByPlugin: Map<string, PluginStatusBadge>;
  pluginInspectorTabs: PluginInspectorTab[];
  pluginRailPages: PluginRailPage[];
  activePluginPopoverKey: string | null;
  viewportBtnRef: RefObject<HTMLButtonElement | null>;
  downloadBtnRef: RefObject<HTMLButtonElement | null>;
  pageToolsBtnRef: RefObject<HTMLButtonElement | null>;
  title: (label: string) => string;
  onResetZoom: () => void;
  onOpenViewportPopover: (anchor?: HTMLElement | null) => void;
  onOpenDownloadsPopover: (anchor?: HTMLElement | null) => void;
  onOpenPluginPopover?: (pluginId: string, surfaceId: string, anchorRect: ViewportRect) => void;
  onOpenPluginPage?: (pluginId: string, surfaceId: string) => void;
  onOpenPluginSurface?: (
    kind: 'popover' | 'inspectorTab',
    pluginId: string,
    surfaceId: string,
    anchorRect?: ViewportRect,
  ) => void;
  registerPluginAnchor?: (key: string, el: HTMLElement | null) => void;
  onOpenQuickSlotContextMenu: (event: MouseEvent<HTMLButtonElement>, pluginId: string) => void;
  onOpenPageToolsMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onToggleDevTools: () => void;
  onOpenDevToolsMenu: (event: MouseEvent) => void;
  onToggleInspector: () => void;
}

export function AddressBarRightControls({
  envId,
  spaceId,
  url,
  running,
  editable,
  zoomPercent,
  presetLabel,
  hasActiveDownload,
  inspectorOpen,
  devToolsOpen,
  pinnedPopovers,
  standaloneBadges,
  statusBadgeByPlugin,
  pluginInspectorTabs,
  pluginRailPages,
  activePluginPopoverKey,
  viewportBtnRef,
  downloadBtnRef,
  pageToolsBtnRef,
  title,
  onResetZoom,
  onOpenViewportPopover,
  onOpenDownloadsPopover,
  onOpenPluginPopover,
  onOpenPluginPage,
  onOpenPluginSurface,
  registerPluginAnchor,
  onOpenQuickSlotContextMenu,
  onOpenPageToolsMenu,
  onToggleDevTools,
  onOpenDevToolsMenu,
  onToggleInspector,
}: Props) {
  return (
    <>
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
            onClick={() => onOpenViewportPopover(viewportBtnRef.current)}
            className="gap-1 px-1.5 font-mono text-[length:var(--font-size-micro)] text-[var(--theme-accent)]"
          >
            <Icon name="Viewport" className="size-3.5" />
            {presetLabel}
          </Button>
        </ActionTooltip>
      )}

      <ActionTooltip label={hasActiveDownload ? '查看进行中的下载' : '下载记录'} side="top">
        <IconButton
          ref={downloadBtnRef}
          variant="ghost"
          data-slot="downloads-trigger"
          aria-label="下载记录"
          onClick={() => onOpenDownloadsPopover(downloadBtnRef.current)}
          className="relative"
        >
          <Icon name="Download" />
          {hasActiveDownload && (
            <span
              data-slot="downloads-active-dot"
              className="absolute top-1.5 right-1.5 size-1.5 animate-pulse rounded-full bg-[var(--theme-accent)]"
            />
          )}
        </IconButton>
      </ActionTooltip>

      {pinnedPopovers.map((pop) => {
        const key = `${pop.pluginId}:${pop.id}`;
        const badge = statusBadgeByPlugin.get(pop.pluginId);
        const isActive = activePluginPopoverKey === key;
        return (
          <ActionTooltip key={key} label={pop.title} shortcut={pop.shortcut} side="top">
            <button
              ref={(el) => registerPluginAnchor?.(key, el)}
              type="button"
              data-slot="plugin-quick-button"
              data-plugin-id={pop.pluginId}
              data-surface-id={pop.id}
              aria-expanded={isActive}
              aria-label={pop.title}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onOpenPluginPopover?.(pop.pluginId, pop.id, {
                  x: Math.round(rect.left),
                  y: Math.round(rect.top),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                });
              }}
              onContextMenu={(event) => onOpenQuickSlotContextMenu(event, pop.pluginId)}
              className={cn(
                'inline-flex h-[var(--control-height-icon)] shrink-0 items-center gap-1.5 rounded-[var(--control-radius)] border border-border-strong bg-control px-2 text-xs text-foreground outline-none transition-none hover:bg-control-hover focus-visible:border-focus focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)] active:scale-[0.97]',
                isActive && 'border-accent-strong bg-accent-soft text-foreground',
              )}
            >
              {badge?.component ? (
                <PluginBoundary pluginId={badge.pluginId} title={badge.title}>
                  <badge.component pluginId={badge.pluginId} environmentId={envId} space={spaceId} url={url} />
                </PluginBoundary>
              ) : (
                <PluginBrandGlyph pluginId={pop.pluginId} icon={pop.icon} />
              )}
            </button>
          </ActionTooltip>
        );
      })}

      {standaloneBadges.map((badge) => {
        const key = `badge:${badge.pluginId}:${badge.id}`;
        const firstTab = pluginInspectorTabs.find((tab) => tab.pluginId === badge.pluginId);
        const firstPage = pluginRailPages.find((page) => page.pluginId === badge.pluginId);
        return (
          <ActionTooltip key={key} label={badge.title} side="top">
            <button
              type="button"
              data-slot="plugin-status-badge"
              data-plugin-id={badge.pluginId}
              data-surface-id={badge.id}
              aria-label={badge.title}
              onClick={() => {
                if (firstTab) onOpenPluginSurface?.('inspectorTab', badge.pluginId, firstTab.id);
                else if (firstPage) onOpenPluginPage?.(badge.pluginId, firstPage.id);
              }}
              onContextMenu={(event) => onOpenQuickSlotContextMenu(event, badge.pluginId)}
              className="inline-flex h-[var(--control-height-icon)] shrink-0 items-center gap-1 rounded-[var(--control-radius)] px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:border focus-visible:border-focus"
            >
              {badge.component ? (
                <PluginBoundary pluginId={badge.pluginId} title={badge.title}>
                  <badge.component pluginId={badge.pluginId} environmentId={envId} space={spaceId} url={url} />
                </PluginBoundary>
              ) : (
                <PluginBrandGlyph pluginId={badge.pluginId} icon={badge.icon} />
              )}
            </button>
          </ActionTooltip>
        );
      })}

      {(pinnedPopovers.length > 0 || standaloneBadges.length > 0) && (
        <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
      )}

      <ActionTooltip label={running ? '页面工具（查找 / 视口 / 复制链接）' : '启动环境后可用页面工具'} side="top">
        <IconButton
          ref={pageToolsBtnRef}
          variant="ghost"
          data-slot="page-tools-trigger"
          aria-label="页面工具"
          disabled={!running}
          onClick={onOpenPageToolsMenu}
          className="disabled:opacity-50"
        >
          <Icon name="More" />
        </IconButton>
      </ActionTooltip>

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
          onContextMenu={onOpenDevToolsMenu}
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
    </>
  );
}
