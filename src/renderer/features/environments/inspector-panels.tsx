import { Icon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { cardSurfaceClass } from '@/theme/surface';
import type {
  AxNode,
  ConsoleEntry,
  CookieSummary,
  EventRecord,
  NetAction,
  NetHit,
  NetRule,
  NetworkEntry,
  SnapshotResult,
} from '@shared/types';

const actorClass: Record<string, string> = {
  agent: 'text-accent-text',
  human: 'text-success-text',
  system: 'text-muted-foreground',
};

const actorText: Record<string, string> = {
  agent: 'Agent',
  human: '人工',
  system: '系统',
};

function formatEventSummary(message: string): string {
  const trimmed = message.trim();
  const gotoMatch = trimmed.match(/^human\s+goto\s+(\S+)(?:\s+on\s+\S+)?$/i);
  if (gotoMatch) return `访问 ${gotoMatch[1]}`;
  if (trimmed.includes('设置更新')) {
    const themeMatch = trimmed.match(/"theme"\s*:\s*"(dark|light|system)"/);
    if (themeMatch) {
      const label = themeMatch[1] === 'dark' ? '深色' : themeMatch[1] === 'light' ? '浅色' : '跟随系统';
      return `切换外观主题为「${label}」`;
    }
    const dockMatch = trimmed.match(/"devToolsDock"\s*:\s*"(right|bottom|detach)"/);
    if (dockMatch) {
      const dockLabel = dockMatch[1] === 'bottom' ? '底部停靠' : dockMatch[1] === 'detach' ? '独立窗口' : '右侧停靠';
      return `切换 DevTools 为${dockLabel}`;
    }
    return '更新应用设置';
  }
  const humanAcquire = trimmed.match(/^human\s+acquired\s+(\S+)/i);
  if (humanAcquire) return `人工接管环境 ${humanAcquire[1]}`;
  const humanRelease = trimmed.match(/^human\s+released\s+(\S+)/i);
  if (humanRelease) return `人工交还环境 ${humanRelease[1]}`;
  const agentAcquire = trimmed.match(/^agent\s+acquired\s+(\S+)(?:\s+\(([^)]+)\))?/i);
  if (agentAcquire) return `Agent 接管 ${agentAcquire[1]}${agentAcquire[2] ? `（${agentAcquire[2]}）` : ''}`;
  const agentRelease = trimmed.match(/^agent\s+released\s+(\S+)/i);
  if (agentRelease) return `Agent 释放 ${agentRelease[1]}`;
  const envState = trimmed.match(/^environment\s+(\S+)\s+(started|stopped|created|removed|hibernated|woken)$/i);
  if (envState) {
    const verbMap: Record<string, string> = {
      started: '已启动',
      stopped: '已停止',
      created: '已新建',
      removed: '已删除',
      hibernated: '已休眠',
      woken: '已唤醒',
    };
    return `环境 ${envState[1]} ${verbMap[envState[2]!.toLowerCase()] ?? envState[2]}`;
  }
  const pluginState = trimmed.match(/^plugin\s+(\S+)\s+(enabled|disabled|reloaded|installed|uninstalled|updated)/i);
  if (pluginState) {
    const verbMap: Record<string, string> = {
      enabled: '已启用',
      disabled: '已停用',
      reloaded: '已重载',
      installed: '已安装',
      uninstalled: '已卸载',
      updated: '已更新',
    };
    return `插件 ${pluginState[1]} ${verbMap[pluginState[2]!.toLowerCase()] ?? pluginState[2]}`;
  }
  if (/^core\s+ready\s+on\s+pid\s+\d+/i.test(trimmed)) return '核心服务已就绪';
  if (trimmed.includes('confirm 层')) {
    return trimmed.replace(/（confirm 层[^）]*）/g, '（需在设置页授权）').replace(/confirm 层/g, '受控权限');
  }
  return trimmed;
}

const consoleLevelClass: Record<string, string> = {
  error: 'text-destructive',
  warn: 'text-[var(--warning)]',
  info: 'text-muted-foreground',
  debug: 'text-muted-foreground/70',
};

function statusClass(status: number): string {
  if (status === 0 || status >= 500) return 'text-destructive';
  if (status >= 400) return 'text-[var(--warning)]';
  return 'text-muted-foreground';
}

function AxTree({ nodes }: { nodes: AxNode[] }) {
  return (
    <div className="flex flex-col gap-0.5 font-mono text-xs">
      {nodes.map((node, index) => (
        <div key={`${node.backendNodeId ?? index}`} className="flex gap-2">
          <span className="shrink-0 text-muted-foreground">{node.role}</span>
          <span className="truncate">{node.name || node.value || ''}</span>
        </div>
      ))}
    </div>
  );
}

/** 规则动作的中文短名。列表最窄只有 260px，长英文串会把匹配串挤没。 */
function actionLabel(action: NetAction): string {
  switch (action.type) {
    case 'mock':
      return `mock ${action.status}`;
    case 'block':
      return '阻断';
    case 'redirect':
      return `跳转 ${action.to}`;
    case 'delay':
      return `延迟 ${action.ms}ms`;
    case 'setRequestHeaders':
      return `改请求头 ${Object.keys(action.headers).join(',')}`;
    case 'setResponseHeaders':
      return `改响应头 ${Object.keys(action.headers).join(',')}`;
    case 'passthrough':
      return '放行（临时）';
  }
}

export function EventsInspectorPanel({
  totalCount,
  events,
  actorFilter,
  onlyCurrentEnv = false,
  onToggleOnlyCurrentEnv,
  query,
  expandedEventId,
  onActorFilterChange,
  onQueryChange,
  onToggleExpand,
}: {
  totalCount: number;
  events: EventRecord[];
  actorFilter: 'all' | 'agent' | 'human' | 'system';
  onlyCurrentEnv?: boolean;
  onToggleOnlyCurrentEnv?: () => void;
  query: string;
  expandedEventId: string | null;
  onActorFilterChange: (next: 'all' | 'agent' | 'human' | 'system') => void;
  onQueryChange: (next: string) => void;
  onToggleExpand: (id: string) => void;
}) {
  return (
    <>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 px-2.5 py-2">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                ['all', '全部'],
                ['agent', 'Agent'],
                ['human', '人工'],
                ['system', '系统'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => onActorFilterChange(value)}
                className={cn(
                  'rounded-[var(--radius-sm)] border px-2 py-0.5 text-[length:var(--font-size-micro)] transition-none outline-none focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]',
                  actorFilter === value
                    ? 'border-surface-selected-border bg-surface-tab-selected font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-control-hover hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {onToggleOnlyCurrentEnv && (
            <button
              type="button"
              aria-pressed={onlyCurrentEnv}
              onClick={onToggleOnlyCurrentEnv}
              className={cn(
                'rounded-[var(--radius-sm)] border px-2 py-0.5 text-[length:var(--font-size-micro)] transition-none outline-none focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]',
                onlyCurrentEnv
                  ? 'border-surface-selected-border bg-surface-tab-selected font-medium text-foreground'
                  : 'border-border text-muted-foreground hover:bg-control-hover hover:text-foreground',
              )}
            >
              仅当前环境
            </button>
          )}
        </div>
        <input
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="筛选事件…"
          aria-label="筛选事件"
          className="h-6 w-full rounded-[var(--radius-sm)] border border-border-strong bg-control px-2 text-[length:var(--font-size-micro)] text-foreground outline-none placeholder:text-subtle-foreground focus:border-focus"
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-2 pt-1.5 pr-3 pb-5 text-xs leading-5">
          {events.length === 0 && (
            <p className="px-1.5 py-2 text-muted-foreground">
              {totalCount === 0 ? '暂无事件。' : '没有匹配的事件记录。'}
            </p>
          )}
          {events.map((event) => {
            const expanded = expandedEventId === event.id;
            return (
              <button
                key={event.id}
                type="button"
                onClick={() => onToggleExpand(event.id)}
                title={expanded ? '点击收起' : `${event.message}（点击展开全文）`}
                className={cn(
                  'flex w-full items-start gap-2 rounded-[var(--radius-sm)] border border-transparent px-1.5 py-0.5 text-left transition-none outline-none hover:bg-surface-hover focus-visible:[box-shadow:0_0_0_1px_var(--border-focus)]',
                  expanded && 'border-surface-selected-border bg-surface-selected hover:bg-surface-selected',
                )}
              >
                <span className="shrink-0 font-mono text-[length:var(--font-size-micro)] text-muted-foreground tabular-nums">
                  {new Date(event.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <span
                  className={cn(
                    'w-10 shrink-0 text-[length:var(--font-size-micro)] font-medium',
                    actorClass[event.actor],
                  )}
                >
                  {actorText[event.actor] ?? event.actor}
                </span>
                <span className={cn('min-w-0 flex-1', expanded ? 'break-all whitespace-pre-wrap' : 'truncate')}>
                  {expanded ? event.message : formatEventSummary(event.message)}
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </>
  );
}

export function SnapshotInspectorPanel({
  loading,
  running,
  snapshot,
  onRefresh,
}: {
  loading: boolean;
  running: boolean;
  snapshot?: SnapshotResult;
  onRefresh: () => void;
}) {
  return (
    <ScrollArea className="h-full">
      <div className="px-3 py-2">
        {loading && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner /> 正在读取可访问性树…
          </span>
        )}
        {!loading && !snapshot && (
          <div className="flex flex-col items-start gap-2 py-2">
            <p className="text-xs text-muted-foreground">读取当前页面的可访问性节点树，便于检查 Agent 感知结构。</p>
            <Button size="xs" variant="outline" disabled={!running} onClick={onRefresh}>
              <Icon name="RotateClockwise" className="size-3.5" />
              读取当前页面快照
            </Button>
          </div>
        )}
        {!loading && snapshot && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              {snapshot.title} · {snapshot.nodes.length} 个节点
            </p>
            <AxTree nodes={snapshot.nodes} />
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

export function ConsoleInspectorPanel({ entries }: { entries: ConsoleEntry[] }) {
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-0.5 px-3 py-2 font-mono text-xs">
        {entries.length === 0 && <p className="text-muted-foreground">还没有 console 输出。</p>}
        {entries
          .slice(-120)
          .reverse()
          .map((entry, index) => (
            <div key={`${entry.at}-${index}`} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground">{entry.at.slice(11, 19)}</span>
              <span className={cn('w-10 shrink-0', consoleLevelClass[entry.level])}>{entry.level}</span>
              <span className="truncate">{entry.message}</span>
              {entry.source && <span className="shrink-0 text-muted-foreground">{entry.source}</span>}
            </div>
          ))}
      </div>
    </ScrollArea>
  );
}

export function NetworkInspectorPanel({ entries }: { entries: NetworkEntry[] }) {
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-0.5 px-3 py-2 font-mono text-xs">
        {entries.length === 0 && <p className="text-muted-foreground">还没有网络请求。</p>}
        {entries
          .slice(-120)
          .reverse()
          .map((entry, index) => (
            <div key={`${entry.at}-${index}`} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground">{entry.at.slice(11, 19)}</span>
              <span className={cn('w-9 shrink-0', statusClass(entry.status))}>{entry.status || 'ERR'}</span>
              <span className="w-12 shrink-0 text-muted-foreground">{entry.method}</span>
              <span className="truncate">{entry.url}</span>
            </div>
          ))}
      </div>
    </ScrollArea>
  );
}

/**
 * 「规则」页：人看得见的规则表 + 命中记录。
 *
 * 这是相对 CDP Fetch 的核心优势——拦截规则不是 agent 的暗箱，人也能看、能关。
 */
export function NetRulesPanel({
  rules,
  hits,
  onToggle,
}: {
  rules: NetRule[];
  hits: NetHit[];
  onToggle: (ruleId: string, enabled: boolean) => void;
}) {
  const hitsOf = (ruleId: string) => hits.filter((hit) => hit.ruleId === ruleId).length;
  return (
    <div className="flex flex-col gap-2 px-3 py-2 text-xs">
      {rules.length === 0 && (
        <div className={cn(cardSurfaceClass, 'flex flex-col gap-2 py-2.5')}>
          <span className="font-medium text-foreground">还没有请求拦截规则</span>
          <p className="text-[length:var(--font-size-micro)] leading-relaxed text-muted-foreground">
            可通过 CLI 为当前环境添加 Mock、阻断或改头规则，或在全局「代理」页使用 Whistle 图形化配置。
          </p>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText('warren net rule add')}
            title="点击复制命令"
            className="inline-flex items-center gap-1.5 self-start rounded-[var(--radius-sm)] border border-border bg-[var(--input-fill)] px-2 py-1 font-mono text-[length:var(--font-size-micro)] text-foreground transition-colors hover:bg-surface-hover"
          >
            <span>warren net rule add</span>
            <Icon name="Copy" className="size-3 text-subtle-foreground" />
          </button>
        </div>
      )}
      {rules.map((rule) => (
        <div key={rule.id} className="flex items-start gap-2" data-slot="net-rule">
          <Switch
            checked={rule.enabled}
            onCheckedChange={(checked) => onToggle(rule.id, checked)}
            aria-label={`${rule.enabled ? '关闭' : '启用'}规则 ${rule.id}`}
            className="mt-0.5"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-mono">{rule.match.url}</span>
              <Badge variant="outline" className="shrink-0">
                {actionLabel(rule.action)}
              </Badge>
            </div>
            <div className="truncate font-mono text-muted-foreground">
              {rule.id.slice(0, 8)} · {rule.match.method ?? '*'} · 命中 {hitsOf(rule.id)}
              {/* 临时放行会自己消失，剩多久要写出来——不然「规则怎么没了」没法解释 */}
              {/* 倒计时本来就该每次轮询重算，渲染期读时钟是刻意的（没有 SSR，不存在水合不一致） */}
              {/* oxlint-disable-next-line react/purity */}
              {rule.expiresAt ? ` · 剩 ${Math.max(0, Math.round((rule.expiresAt - Date.now()) / 1000))}s` : ''}
            </div>
          </div>
        </div>
      ))}
      <div className="mt-1 flex flex-col gap-0.5 border-t border-border pt-2 font-mono">
        <p className="text-muted-foreground">命中记录（最近 {hits.length} 条）</p>
        {hits.slice(0, 40).map((hit, index) => (
          <div key={`${hit.at}-${index}`} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">{hit.at.slice(11, 19)}</span>
            <span className={cn('w-9 shrink-0', statusClass(hit.status))}>{hit.status || 'ERR'}</span>
            <span className="w-16 shrink-0 text-muted-foreground">{hit.action}</span>
            <span className="truncate">{hit.url}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StorageInspectorPanel({ cookies, onRefresh }: { cookies?: CookieSummary[]; onRefresh?: () => void }) {
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-0.5 px-3 py-2 font-mono text-xs">
        {onRefresh && (
          <div className="mb-1.5 flex items-center justify-between border-b border-border/60 pb-1.5 font-sans">
            <span className="text-[11px] text-muted-foreground">
              {cookies ? `共 ${cookies.length} 条 Cookie 元数据` : '正在读取…'}
            </span>
            <Button size="xs" variant="ghost" onClick={onRefresh}>
              <Icon name="RotateClockwise" className="size-3" />
              刷新
            </Button>
          </div>
        )}
        {!cookies && <p className="font-sans text-muted-foreground">正在读取…</p>}
        {cookies?.length === 0 && <p className="font-sans text-muted-foreground">这个环境还没有 cookie。</p>}
        {cookies?.map((cookie) => (
          <div key={`${cookie.domain}${cookie.path}${cookie.name}`} className="flex items-baseline gap-2">
            <span className="truncate">{cookie.name}</span>
            <span className="shrink-0 text-muted-foreground">
              {cookie.secure ? 'S' : '-'}
              {cookie.httpOnly ? 'H' : '-'}
            </span>
            <span className="truncate text-muted-foreground">{cookie.domain}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">
              {cookie.session
                ? '会话'
                : cookie.expirationDate
                  ? new Date(cookie.expirationDate * 1000).toLocaleDateString()
                  : '—'}
            </span>
          </div>
        ))}
        {cookies && cookies.length > 0 && (
          <p className="mt-2 font-sans text-[length:var(--font-size-micro)] leading-relaxed text-muted-foreground">
            出于安全策略，此处仅展示 Cookie 名称、作用域与安全标志，不回传明文值（S = Secure，H = HttpOnly）。
          </p>
        )}
      </div>
    </ScrollArea>
  );
}
