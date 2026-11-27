import { Icon } from '@/components/icons';
import { Button, IconButton } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Kbd } from '@/components/ui/kbd';
import { WarrenMark } from '@/components/warren-mark';
import { cn } from '@/lib/utils';
import { egressLabel } from './sidebar-env-row';
import type { Environment, SpaceId, ViewportRect } from '@shared/types';
import { VIEWPORT_PRESET_SPECS, type SimulatedPageLayout } from '@shared/viewport-presets';

export function PanelExclusivityNoticeBar({
  collapsed,
  compact,
  onSwitchToBottomCoexist,
  onDismiss,
}: {
  collapsed: 'inspector' | 'devtools';
  compact: boolean;
  onSwitchToBottomCoexist: () => void;
  onDismiss: () => void;
}) {
  return (
    <output
      data-slot="panel-exclusivity-bar"
      className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-under px-3 text-xs text-foreground animate-in fade-in-0 slide-in-from-top-1 duration-150 motion-reduce:animate-none"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="Info" className="size-3.5 shrink-0 text-[var(--info)]" />
        <span className="truncate">
          {collapsed === 'inspector'
            ? '已收起工作台抽屉为右侧 DevTools 留出空间'
            : '已收起右侧 DevTools 为工作台留出空间'}
        </span>
        {!compact && (
          <span className="hidden truncate text-muted-foreground xl:inline">· 切到底部停靠即可与工作台并存</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="xs" variant="outline" data-slot="panel-exclusivity-bottom-dock" onClick={onSwitchToBottomCoexist}>
          <Icon name="DockBottom" className="size-3.5" />
          改用底部停靠并行查看
        </Button>
        <IconButton size="icon-xs" variant="ghost" aria-label="关闭提示" onClick={onDismiss}>
          <Icon name="X" />
        </IconButton>
      </div>
    </output>
  );
}

export function StageEmptyPlaceholder({
  current,
  running,
  locked,
  activeSpaceId,
  onStart,
  onTabCreate,
}: {
  current?: Environment;
  running: boolean;
  locked: boolean;
  activeSpaceId: SpaceId;
  onStart: (id: string) => void;
  onTabCreate: (id: string, space: SpaceId) => void;
}) {
  return (
    <Empty className="absolute inset-0 border-0 pb-8">
      <EmptyHeader>
        <EmptyMedia className="relative mb-2">
          <div aria-hidden className="warren-brand-aura pointer-events-none absolute -inset-12 rounded-full" />
          <div className="relative flex size-16 items-center justify-center rounded-[var(--radius-2xl)] border border-border-heavy/80 bg-surface-elevated/90 [box-shadow:var(--shadow-raised)]">
            <WarrenMark className="size-11" />
          </div>
        </EmptyMedia>
        <EmptyTitle>
          {!current ? '还没有选择环境' : running ? '这个空间还没有标签' : `环境「${current.name}」未启动`}
        </EmptyTitle>
        {!current || running ? (
          <EmptyDescription>
            {!current
              ? '新建或从左侧选择一个隔离环境，页面会在这里显示。'
              : '新建标签页开始浏览，或在上方地址栏直接输入网址。'}
          </EmptyDescription>
        ) : (
          <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-elevated px-2.5 py-0.5 text-muted-foreground">
              <span>网络出口</span>
              <span className="font-mono font-medium text-foreground">{egressLabel(current.proxy)}</span>
            </span>
            {current.startUrl && (
              <span className="inline-flex max-w-[420px] items-center gap-1.5 rounded-full border border-border bg-surface-elevated px-2.5 py-0.5 text-muted-foreground">
                <span className="shrink-0">默认页</span>
                <span className="truncate font-mono font-medium text-foreground">{current.startUrl}</span>
              </span>
            )}
          </div>
        )}
      </EmptyHeader>
      {!current ? (
        <Button
          data-slot="stage-create-env-button"
          onClick={() => void window.envApi.openOverlay({ kind: 'create-env' })}
        >
          <Icon name="Plus" />
          新建环境
        </Button>
      ) : running ? (
        !locked && (
          <Button onClick={() => onTabCreate(current.id, activeSpaceId)}>
            <Icon name="Plus" />
            新建标签页
          </Button>
        )
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2">
            <Button data-slot="stage-start-button" onClick={() => onStart(current.id)}>
              <Icon name="Play" />
              启动「{current.name}」
            </Button>
            <Button
              variant="outline"
              data-slot="stage-edit-button"
              onClick={() => void window.envApi.openOverlay({ kind: 'edit-env', environment: current })}
            >
              <Icon name="Pencil" />
              编辑配置
            </Button>
          </div>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            按 <Kbd>Enter</Kbd> 立即启动
          </span>
        </div>
      )}
    </Empty>
  );
}

export function SimulatedViewportBackdrop({
  container,
  layout,
  roundedOuter = true,
  onReset,
}: {
  container: ViewportRect;
  layout: SimulatedPageLayout;
  roundedOuter?: boolean;
  onReset?: () => void;
}) {
  if (!layout.emulated || layout.preset === 'auto') return null;
  const spec = VIEWPORT_PRESET_SPECS[layout.preset];
  const relLeft = layout.bounds.x - container.x;
  const relTop = layout.bounds.y - container.y;
  const scalePct = Math.round(layout.scale * 100);
  const pillCenterX = relLeft + layout.bounds.width / 2;
  const pillTop = Math.max(8, relTop - 32);

  return (
    <div
      data-slot="viewport-canvas"
      style={{
        left: container.x,
        top: container.y,
        width: container.width,
        height: container.height,
      }}
      className={cn(
        'absolute overflow-hidden bg-surface-recessed select-none',
        'bg-[radial-gradient(color-mix(in_srgb,var(--border-heavy)_42%,transparent)_1px,transparent_1px)] [background-size:16px_16px]',
        roundedOuter && 'rounded-[var(--shell-stage-radius)]',
      )}
    >
      <div
        data-slot="viewport-pill"
        style={{ left: pillCenterX, top: pillTop }}
        className="absolute z-10 flex h-6 max-w-[calc(100%-16px)] -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-heavy/80 bg-surface-elevated/95 pr-1 pl-2.5 text-[length:var(--font-size-micro)] text-foreground [box-shadow:var(--shadow-chip)]"
      >
        <Icon name={spec.icon} className="size-3.5 shrink-0 text-[var(--theme-accent)]" />
        <span className="truncate font-medium">{spec.label}</span>
        <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
          {layout.logicalWidth} × {layout.logicalHeight}
        </span>
        {scalePct < 100 && (
          <span
            data-slot="viewport-scale"
            className="shrink-0 rounded-full bg-surface-fog px-1.5 py-px font-mono text-[10px] text-muted-foreground tabular-nums"
          >
            {scalePct}%
          </span>
        )}
        {onReset && (
          <button
            type="button"
            data-slot="viewport-reset"
            aria-label="还原自适应视口"
            title="还原自适应工作区"
            onClick={onReset}
            className="flex size-4 shrink-0 items-center justify-center rounded-full text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground outline-none focus-visible:border focus-visible:border-focus"
          >
            <Icon name="X" className="size-3" />
          </button>
        )}
      </div>
      <div
        aria-hidden
        data-slot="viewport-frame"
        style={{
          left: relLeft,
          top: relTop,
          width: layout.bounds.width,
          height: layout.bounds.height,
        }}
        className="pointer-events-none absolute rounded-[8px] bg-background ring-1 ring-border-heavy [box-shadow:var(--elevation-popover)]"
      />
    </div>
  );
}

export function TargetUrlPreviewPill({ url }: { url: string }) {
  return (
    <div
      data-slot="target-url-preview"
      className="pointer-events-none absolute bottom-1.5 left-1.5 z-10 max-w-[65%] truncate rounded-[var(--radius-sm)] border border-border-heavy bg-popover/95 px-2 py-0.5 font-mono text-[length:var(--font-size-micro)] text-popover-foreground [box-shadow:var(--elevation-popover)] animate-in fade-in-0 duration-120 motion-reduce:animate-none"
    >
      {url}
    </div>
  );
}
