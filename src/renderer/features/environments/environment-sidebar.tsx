import { useEffect, useMemo, useState } from 'react';
import { Button, IconButton } from '@/components/ui/button';
import {
  ListRow,
  ListRowActionButton,
  ListRowActions,
  ListRowLabel,
  ListRowMain,
  ListRowMeta,
} from '@/components/ui/list-row';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
} from '@/components/ui/sidebar';
import { Icon } from '@/components/icons';
import { StatusDot, StatusMark } from '@/components/ui/status-dot';
import {
  disclosureChevronClassName,
  disclosureInnerClassName,
  disclosureShellClassName,
} from '@/lib/disclosure-motion';
import { cn } from '@/lib/utils';
import type { PluginBadgeSnapshot, PluginEnvBadge } from '@/lib/plugin-badges';
import { ownerLabel, statusLabel, statusTone } from '@/lib/labels';
import type { Environment, Group } from '@shared/types';
import type { PluginEnvAction } from '@/lib/plugin-runtime';
import { CreateEnvironmentDialog, type NewEnvironment } from './create-environment-dialog';
import { CreateGroupDialog } from './create-group-dialog';
import { RenameDialog } from './rename-dialog';
import { EditEnvironmentDialog, type EnvironmentEdit } from './edit-environment-dialog';

interface Props {
  environments: Environment[];
  groups: Group[];
  selected?: string;
  onCreate: (input: NewEnvironment) => void;
  onSelect: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onRemove: (id: string) => void;
  onTakeover: (id: string) => void;
  onRelease: (id: string) => void;
  /** 插件往环境菜单里加的动作（清单声明的，不需要插件前端） */
  pluginActions?: PluginEnvAction[];
  onRunPluginAction?: (pluginId: string, command: string, environmentId: string) => void;
  /** 插件往环境行放的状态芯片（renderer-only store） */
  pluginBadges?: PluginBadgeSnapshot;
  /** 侧栏收起时只留 icon，label 进 title */
  compact?: boolean;
  /** 编辑环境：改显示名 / 代理 / 启动 URL / 自动切换 */
  onEditEnvironment: (id: string, patch: EnvironmentEdit) => void;
  onCreateGroup: (name: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRemoveGroup: (id: string) => void;
  onToggleGroup: (id: string, collapsed: boolean) => void;
  onMoveToGroup: (environmentId: string, groupId: string | undefined) => void;
}

/** 未分组环境用的伪分组，让渲染逻辑只有一条路径 */
const UNGROUPED = '__ungrouped__';
const UNGROUPED_COLLAPSED_KEY = 'warren.sidebar.ungroupedCollapsed';

/**
 * 出口展示：留空是直连；配了代理就只留 `host[:port]`，把 `http://` 那一截省掉。
 * 行里这一格只有一百来像素，多一个字就少一个信息。
 */
function egress(proxy?: string): string {
  if (!proxy) return '直连';
  try {
    return new URL(proxy).host;
  } catch {
    return proxy;
  }
}

/**
 * 行 title：名字 · 状态 · 归属 · 出口。
 *
 * 行里为了密度省掉了「已停止」这类词（状态有底色块、归属有图标），鼠标停上去
 * 用原生 title 把话说全。
 */
function rowTitle(env: Environment): string {
  const parts = [env.name, statusLabel[env.status] ?? env.status];
  // 页面标题从行里挪到了这里（见那一行的注释）：信息不能丢，只是不占宽度
  if (env.title) parts.push(env.title);
  if (env.owner !== 'none') parts.push(ownerLabel[env.owner]);
  parts.push(egress(env.proxy));
  // 页面加载失败时环境仍然是「运行中」（视图、标签都在），所以错误单独说一句
  if (env.error) parts.push(`页面加载失败：${env.error}`);
  return parts.join(' · ');
}

function badgeToneClass(tone: PluginEnvBadge['tone']): string {
  switch (tone) {
    case 'info':
      return 'text-[var(--info)]';
    case 'success':
      return 'text-[var(--success)]';
    case 'warning':
      return 'text-[var(--warning)]';
    case 'danger':
      return 'text-destructive';
    default:
      return 'text-muted-foreground';
  }
}

/**
 * 一个环境一个槽：按 pluginId 字典序取第一个；其余只在 tooltip 里列出。
 * 顺序必须是确定的，不能依赖 readdir / 加载顺序。
 */
function badgesForEnv(
  envId: string,
  snapshot: PluginBadgeSnapshot | undefined,
): { first?: PluginEnvBadge; labels: string[] } {
  if (!snapshot) return { labels: [] };
  const labels: string[] = [];
  let first: PluginEnvBadge | undefined;
  for (const pluginId of Object.keys(snapshot).sort()) {
    const badge = snapshot[pluginId]?.[envId];
    if (!badge) continue;
    if (!first) first = badge;
    labels.push(badge.label);
  }
  return { first, labels };
}

interface Bucket {
  key: string;
  group?: Group;
  environments: Environment[];
}

function buildBuckets(environments: Environment[], groups: Group[]): Bucket[] {
  const sorted = [...environments].sort((a, b) => a.order - b.order);
  const buckets: Bucket[] = groups.map((group) => ({
    key: group.id,
    group,
    environments: sorted.filter((env) => env.groupId === group.id),
  }));
  const orphans = sorted.filter((env) => !env.groupId || !groups.some((g) => g.id === env.groupId));
  // 未分组桶只在有环境、或已经存在分组时出现，避免空列表里多一个空标题
  if (orphans.length > 0 || groups.length > 0) {
    buckets.push({ key: UNGROUPED, environments: orphans });
  }
  return buckets;
}

export function EnvironmentSidebar(props: Props) {
  const {
    environments,
    groups,
    selected,
    onCreate,
    onSelect,
    onStart,
    onStop,
    onRemove,
    onTakeover,
    onRelease,
    pluginActions = [],
    onRunPluginAction,
    pluginBadges,
    compact = false,
    onEditEnvironment,
    onCreateGroup,
    onRenameGroup,
    onRemoveGroup,
    onToggleGroup,
    onMoveToGroup,
  } = props;

  const [query, setQuery] = useState('');
  /** 两个新建表单都在弹窗里，这里只管开关；表单自己的草稿归弹窗。 */
  const [createEnvOpen, setCreateEnvOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  /** 改名的目标。名字由弹窗自己编辑，这里只记「改谁」。环境改名走「编辑环境」那个弹窗。 */
  const [renaming, setRenaming] = useState<{ kind: 'group'; id: string; name: string } | null>(null);
  /** 正在编辑的环境。整个对象传进去，弹窗自己填字段。 */
  const [editing, setEditing] = useState<Environment | null>(null);
  /**
   * 「未分组」这一桶的收起态。
   *
   * 它不是一个 Group 记录（没有 id、不能改名、不能排序），所以没地方存；而收起
   * 是纯界面状态，和检查器宽度一样走 localStorage。真分组仍以主进程的
   * `group.collapsed` 为准——那是持久化数据，CLI 也能改。
   */
  const [ungroupedCollapsed, setUngroupedCollapsed] = useState(
    () => localStorage.getItem(UNGROUPED_COLLAPSED_KEY) === '1',
  );
  useEffect(() => {
    localStorage.setItem(UNGROUPED_COLLAPSED_KEY, ungroupedCollapsed ? '1' : '0');
  }, [ungroupedCollapsed]);
  const [confirming, setConfirming] = useState<{
    kind: 'env' | 'group';
    id: string;
    name: string;
  } | null>(null);
  /**
   * 侧栏自己的 DOM 节点，当右键菜单的碰撞边界。
   *
   * 菜单是 portal，默认可以飘到右边的页面区域上；而页面是原生视图，压上去就被盖住，
   * 只能把整页让开（页面会黑一下）。把边界钉在侧栏上，菜单一开始就待在侧栏里，
   * 页面根本不用让开——菜单照常点，页面照常活着。
   */
  const [sidebarEl, setSidebarEl] = useState<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return environments;
    return environments.filter((env) =>
      [env.id, env.name, env.proxy, env.title, env.currentUrl]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q)),
    );
  }, [environments, query]);

  const buckets = useMemo(() => buildBuckets(filtered, groups), [filtered, groups]);
  const runningCount = environments.filter((env) => env.status === 'running').length;

  const copy = (text: string) => void navigator.clipboard.writeText(text);
  const envsInGroup = (groupId: string) => environments.filter((env) => env.groupId === groupId);

  return (
    <>
      {/*
        用 collapsible="none"：它渲染的是在流内的 flex 容器（w = --sidebar-width），
        能正确嵌进 ResizablePanel。默认的 collapsible="icon" 用 position:fixed +
        w-(--sidebar-width)，那个宽度相对视口解析，会变成整窗宽。
        收起态由外层 ResizablePanel 的 collapse() 负责（见 App.tsx）。
      */}
      <Sidebar ref={setSidebarEl} collapsible="none" className="h-full" data-collapsed="false">
        {/*
          chrome 行：高度必须和 rail 顶格、内容卡片的标签行一致（三列横向一条线）。
          放的是这个侧栏的主操作，对齐 bb 的 SidebarTopReserveRow。
        */}
        <div className="flex h-[var(--shell-chrome-row-height)] shrink-0 items-center px-1.5">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setCreateEnvOpen(true)}>
            <Icon name="Plus" />
            <span className="truncate">新建环境</span>
          </Button>
        </div>

        <SidebarHeader className="pt-0">
          <div className="relative">
            <Icon
              name="Search"
              className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
            />
            <SidebarInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索环境…"
              className="pl-7"
            />
          </div>
        </SidebarHeader>

        <SidebarContent>
          {environments.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">还没有环境。点上方「新建环境」开始。</p>
          )}

          {environments.length > 0 && filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">没有匹配「{query}」的环境。</p>
          )}

          {buckets.map((bucket) => {
            const group = bucket.group;
            // 「未分组」也收得起：它只是没有 Group 记录，不是不能折叠
            const collapsed = group ? group.collapsed : ungroupedCollapsed;
            const toggle = () => (group ? onToggleGroup(group.id, !collapsed) : setUngroupedCollapsed(!collapsed));
            const running = bucket.environments.filter((env) => env.status === 'running').length;

            const body = (
              <>
                <SidebarGroupLabel
                  /*
                    段头长得像行：高度、圆角、hover 都跟环境行同一套。
                    它本来就是个能点的控件（收起/展开），只有它没有 hover 反馈的话，
                    看起来就是一段静态文字，没人知道能点。
                  */
                  className="h-[var(--size-row)] cursor-pointer select-none rounded-[var(--control-radius)] transition-colors duration-150 ease-out hover:bg-surface-hover motion-reduce:transition-none"
                  onClick={toggle}
                >
                  {/* 一个图标转过去，不是两个图标互换——换图标是瞬跳，转是有过程的 */}
                  <Icon name="ChevronRight" className={disclosureChevronClassName(!collapsed, 'size-4')} />
                  <span className="truncate">{group?.name ?? '未分组'}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {/* 收起时只剩计数，得有个东西回答「下面在跑吗」 */}
                    {collapsed && running > 0 && <StatusDot tone="success" />}
                    <span className="text-[10px] tabular-nums opacity-60">{bucket.environments.length}</span>
                  </span>
                </SidebarGroupLabel>

                {/*
                  收起/展开走 220ms 的 grid 行高过渡（见 lib/disclosure-motion）：
                  shell 是那一行 0fr↔1fr，inner 负责把溢出的内容剪掉。
                  内容不卸载，所以不能只靠视觉——`inert` 把收起的那一坨从 tab 序和
                  无障碍树里摘掉，否则键盘还能 Tab 进看不见的环境行。
                */}
                <div className={disclosureShellClassName(!collapsed)}>
                  <SidebarGroupContent className={disclosureInnerClassName()} inert={collapsed}>
                    {/*
                      整宽平铺，不是树：分组当段头，环境行不缩进、也没有引导线。
                      参考 bb nest 的顶层——它的项目行就是整宽的（左边一枚字母牌，
                      右边 count + + + 收起箭头），只有再往下一层才画连接线。
                    */}
                    {/*
                      间距是一套：行↔行 2 / 段头↔第一行 2 / 组↔组 4（分组上下各 2）。
                      段头那 2px 用 margin 不用 padding——分组收起时内容被 0fr 剪掉，
                      padding 会留一个 2px 的底（盒子再小也不会小于自己的 padding），
                      margin 不会。
                    */}
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {bucket.environments.map((env) => {
                        const badge = badgesForEnv(env.id, pluginBadges);
                        return (
                          <ContextMenu key={env.id}>
                            <ContextMenuTrigger render={<li className="relative" />}>
                              {/*
                              一行：状态块 + 归属图标 + 名字 + 出口 + 动作。
                              动作按钮是 ListRowMain 的**兄弟**而不是子节点——button 里套
                              button 是无效结构，读屏会把整行念成一串按钮。ListRow 是 div。
                            */}
                              <ListRow selected={env.id === selected}>
                                <ListRowMain onClick={() => onSelect(env.id)} title={rowTitle(env)}>
                                  {/*
                                  这一行只放三样东西，按主次排：**名字**（你用它寻址，撑满剩余宽度）
                                  → 状态块 → 出口（产品的核心概念，但要硬上限）。

                                  页面标题**不在这里**：它属于页面不属于环境，选中那个环境的标签条
                                  已经显示了，鼠标停上来的 title 里也有。以前它和出口一起抢宽度，
                                  名字被挤到只剩几个字符（实测）。
                                */}
                                  <ListRowLabel className="flex-1">
                                    {/* 状态有底色块、归属有图标，都不占字：
                                      「已停止」「AI 操作中」这些词全放到 title 里 */}
                                    {/* 页面挂了但环境在跑：状态块直接变红，光靠 title 说不清楚 */}
                                    <StatusMark tone={env.error ? 'error' : statusTone(env.status)} />
                                    {/* flex-1 + min-w-0：名字吃掉剩下的全部宽度，别的都让位给它。
                                      ml-0.5 是因为 label 的 gap 只有 4，点和名字贴在一起了。 */}
                                    <span className="ml-0.5 min-w-0 flex-1 truncate text-sm">{env.name}</span>
                                    {/*
                                    归属图标放名字**后面**：放前面的话，AI 一接管它就把名字
                                    往右顶一截，整列名字跟着跳。放后面只顶右边那串出口，
                                    而出口本来就靠右对齐。
                                  */}
                                    {env.owner !== 'none' && (
                                      <span
                                        className="ml-1 flex shrink-0 items-center text-muted-foreground"
                                        title={ownerLabel[env.owner]}
                                      >
                                        <Icon name={env.owner === 'agent' ? 'Robot' : 'User'} className="size-3.5" />
                                      </span>
                                    )}
                                    {/*
                                    审批策略**偏离全局**时才标一下。默认（跟随全局）不显示——
                                    每行都挂一个图标等于没有信息。
                                  */}
                                    {env.approval && (
                                      <span
                                        className="ml-1 flex shrink-0 items-center text-[var(--warning)]"
                                        title={env.approval === 'auto' ? '审批：自动放行' : '审批：总是要审批'}
                                      >
                                        <Icon name={env.approval === 'auto' ? 'Zap' : 'Lock'} className="size-3.5" />
                                      </span>
                                    )}
                                    {badge.first && (
                                      <span
                                        data-slot="env-badge"
                                        className={cn(
                                          'ml-1 flex max-w-[3.5rem] shrink-0 items-center gap-0.5 text-[10px]',
                                          badgeToneClass(badge.first.tone),
                                        )}
                                        title={
                                          badge.labels.length > 1
                                            ? `插件状态：${badge.labels.join(' / ')}`
                                            : `插件状态：${badge.first.label}`
                                        }
                                      >
                                        <Icon name={badge.first.icon ?? 'Zap'} className="size-3.5" />
                                        {!compact && <span className="truncate">{badge.first.label}</span>}
                                      </span>
                                    )}
                                    {/*
                                    出口靠右，每行对齐成一列，扫一眼就能比。
                                    **40% 是硬上限**（以前是 65% 且 shrink-0，一个长代理就能把名字挤没）；
                                    超了由 ListRowMeta 自己省略，完整值在 title 里。
                                  */}
                                    <ListRowMeta
                                      className={cn('ml-1 shrink-0 pl-1', badge.first ? 'max-w-[28%]' : 'max-w-[40%]')}
                                      title={egress(env.proxy)}
                                    >
                                      {egress(env.proxy)}
                                    </ListRowMeta>
                                  </ListRowLabel>
                                </ListRowMain>
                                {/*
                                行上只放一个动词：跑着给「停止」、停着给「启动」。

                                控制权（接管 / 交还）不放这儿：它一出现就多一个按钮，行尾
                                那一簇的宽度就跟着变，右边的出口要么被顶得跟别的行不齐，
                                要么得留一块空位等它——两个都难看。它本来就在标题栏
                                （选中那个环境）和右键菜单里，少这一处不影响。
                              */}
                                <ListRowActions alwaysVisible>
                                  {env.status === 'running' ? (
                                    <ListRowActionButton title="停止" aria-label="停止" onClick={() => onStop(env.id)}>
                                      <Icon name="Stop" />
                                    </ListRowActionButton>
                                  ) : (
                                    <ListRowActionButton
                                      tone="success"
                                      title="启动"
                                      aria-label="启动"
                                      onClick={() => onStart(env.id)}
                                    >
                                      <Icon name="Play" />
                                    </ListRowActionButton>
                                  )}
                                </ListRowActions>
                              </ListRow>
                            </ContextMenuTrigger>

                            <ContextMenuContent
                              className="w-56"
                              collisionBoundary={sidebarEl ?? undefined}
                              collisionPadding={4}
                            >
                              {/* base-ui 的 GroupLabel 必须在 Group 里，否则抛 MenuGroupContext is missing
                                并让整个 React 树崩掉（不是只坏这一个菜单）。 */}
                              <ContextMenuGroup>
                                <ContextMenuLabel className="flex items-center gap-1.5">
                                  <StatusDot tone={statusTone(env.status)} />
                                  {env.name}
                                  <span className="ml-auto text-[10px] font-normal opacity-60">
                                    {statusLabel[env.status] ?? env.status}
                                  </span>
                                </ContextMenuLabel>
                              </ContextMenuGroup>
                              <ContextMenuSeparator />
                              {env.status === 'running' ? (
                                <ContextMenuItem onClick={() => onStop(env.id)}>
                                  <Icon name="Stop" /> 停止
                                </ContextMenuItem>
                              ) : (
                                <ContextMenuItem onClick={() => onStart(env.id)}>
                                  <Icon name="Play" /> 启动
                                </ContextMenuItem>
                              )}
                              <ContextMenuSeparator />
                              <ContextMenuItem disabled={env.owner === 'human'} onClick={() => onTakeover(env.id)}>
                                <Icon name="Grab" /> 接管 Agent Space
                              </ContextMenuItem>
                              <ContextMenuItem disabled={env.owner !== 'human'} onClick={() => onRelease(env.id)}>
                                <Icon name="Release" /> 交还 Agent Space
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem onClick={() => copy(`warren exec ${env.id}`)}>
                                <Icon name="Copy" /> 复制 CLI 寻址
                              </ContextMenuItem>
                              <ContextMenuItem
                                disabled={!env.currentUrl}
                                onClick={() => env.currentUrl && copy(env.currentUrl)}
                              >
                                <Icon name="Copy" /> 复制当前 URL
                              </ContextMenuItem>
                              <ContextMenuItem
                                disabled={!env.currentUrl}
                                onClick={() => env.currentUrl && window.open(env.currentUrl, '_blank')}
                              >
                                <Icon name="ExternalLink" /> 在外部浏览器打开
                              </ContextMenuItem>
                              <ContextMenuSeparator />
                              <ContextMenuItem onClick={() => setEditing(env)}>
                                <Icon name="Pencil" /> 编辑…
                              </ContextMenuItem>
                              <ContextMenuSub>
                                <ContextMenuSubTrigger>
                                  <Icon name="Folder" /> 移动到分组
                                </ContextMenuSubTrigger>
                                <ContextMenuSubContent
                                  className="w-44"
                                  collisionBoundary={sidebarEl ?? undefined}
                                  collisionPadding={4}
                                >
                                  {groups.length === 0 && <ContextMenuItem disabled>还没有分组</ContextMenuItem>}
                                  {groups.map((target) => (
                                    <ContextMenuItem
                                      key={target.id}
                                      disabled={env.groupId === target.id}
                                      onClick={() => onMoveToGroup(env.id, target.id)}
                                    >
                                      {target.name}
                                    </ContextMenuItem>
                                  ))}
                                  {env.groupId && (
                                    <>
                                      <ContextMenuSeparator />
                                      <ContextMenuItem onClick={() => onMoveToGroup(env.id, undefined)}>
                                        <Icon name="FolderMinus" /> 移出分组
                                      </ContextMenuItem>
                                    </>
                                  )}
                                </ContextMenuSubContent>
                              </ContextMenuSub>
                              {pluginActions.length > 0 && (
                                <>
                                  <ContextMenuSeparator />
                                  {pluginActions.map((action) => (
                                    <ContextMenuItem
                                      key={`${action.pluginId}:${action.id}`}
                                      onClick={() => onRunPluginAction?.(action.pluginId, action.command, env.id)}
                                    >
                                      <Icon name={action.icon ?? 'Puzzle'} /> {action.title}
                                    </ContextMenuItem>
                                  ))}
                                </>
                              )}
                              <ContextMenuSeparator />
                              <ContextMenuItem
                                variant="destructive"
                                onClick={() => setConfirming({ kind: 'env', id: env.id, name: env.name })}
                              >
                                <Icon name="Trash" /> 删除环境…
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        );
                      })}
                      {bucket.environments.length === 0 && (
                        <li className="px-2 py-1.5 text-xs text-muted-foreground">空分组</li>
                      )}
                    </ul>
                  </SidebarGroupContent>
                </div>
              </>
            );

            if (!group) {
              return (
                <SidebarGroup key={bucket.key} className="py-0.5">
                  {body}
                </SidebarGroup>
              );
            }

            return (
              <ContextMenu key={bucket.key}>
                <ContextMenuTrigger render={<SidebarGroup className="py-0.5" />}>{body}</ContextMenuTrigger>
                <ContextMenuContent className="w-56" collisionBoundary={sidebarEl ?? undefined} collisionPadding={4}>
                  <ContextMenuGroup>
                    <ContextMenuLabel>{group.name}</ContextMenuLabel>
                  </ContextMenuGroup>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => setCreateEnvOpen(true)}>
                    <Icon name="Plus" /> 新建环境
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => setRenaming({ kind: 'group', id: group.id, name: group.name })}>
                    <Icon name="Pencil" /> 重命名分组…
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onToggleGroup(group.id, !group.collapsed)}>
                    {group.collapsed ? <Icon name="ChevronDown" /> : <Icon name="ChevronRight" />}
                    {group.collapsed ? '展开' : '折叠'}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => envsInGroup(group.id).forEach((env) => onStart(env.id))}>
                    <Icon name="Play" /> 启动组内全部
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => envsInGroup(group.id).forEach((env) => onStop(env.id))}>
                    <Icon name="Stop" /> 停止组内全部
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() =>
                      copy(
                        envsInGroup(group.id)
                          .map((env) => `warren exec ${env.id}`)
                          .join('\n'),
                      )
                    }
                  >
                    <Icon name="Copy" /> 复制组内 CLI 寻址
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onClick={() => setConfirming({ kind: 'group', id: group.id, name: group.name })}
                  >
                    <Icon name="Trash" /> 删除分组（环境保留）
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </SidebarContent>

        <SidebarFooter>
          {/* 这里原来有一条 SidebarSeparator：它带左右内边距，探不到卡片左边，
              看起来像「分割线断了」。footer 和列表本来就靠留白分开，直接去掉。 */}
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {runningCount} 运行 / {environments.length} 环境
            </span>
            <div className="ml-auto flex items-center gap-0.5">
              <IconButton variant="ghost" title="新建分组" onClick={() => setCreateGroupOpen(true)}>
                <Icon name="FolderPlus" />
              </IconButton>
            </div>
          </div>
        </SidebarFooter>
      </Sidebar>

      <CreateEnvironmentDialog open={createEnvOpen} onOpenChange={setCreateEnvOpen} onCreate={onCreate} />

      <CreateGroupDialog open={createGroupOpen} onOpenChange={setCreateGroupOpen} onCreate={onCreateGroup} />

      <RenameDialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title="重命名分组"
        label="分组名"
        initialValue={renaming?.name ?? ''}
        onSubmit={(value) => {
          if (renaming) onRenameGroup(renaming.id, value);
        }}
      />

      <EditEnvironmentDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        environment={editing ?? undefined}
        onSubmit={(id, patch) => onEditEnvironment(id, patch)}
      />

      <AlertDialog open={Boolean(confirming)} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.kind === 'group' ? `删除分组「${confirming?.name}」？` : `删除环境「${confirming?.name}」？`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === 'group'
                ? '组内环境会保留并移出分组，不会被删除。'
                : '该环境的独立浏览器存储（Cookie、登录态）会一并删除，无法撤销。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirming) return;
                if (confirming.kind === 'group') onRemoveGroup(confirming.id);
                else onRemove(confirming.id);
                setConfirming(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
