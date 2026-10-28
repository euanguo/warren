import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { IconButton } from '@/components/ui/button';
import { MenuLabel, MenuSurface } from '@/components/ui/menu';
import { Spinner } from '@/components/ui/spinner';
import { addressSecurity, resolveAddressInput } from '@/lib/address-input';
import { cn } from '@/lib/utils';
import { menuItemInteractiveClass } from '@/theme/surface';
import type { NavigationAction, UrlHistoryEntry } from '@shared/types';

const SECURITY_ICON = {
  secure: { name: 'Lock', className: 'text-[var(--success)]', label: '连接安全（https）' },
  insecure: {
    name: 'AlertTriangle',
    className: 'text-[var(--warning)]',
    label: '连接不安全（http）',
  },
  none: { name: 'Globe', className: 'text-muted-foreground/60', label: '未知连接状态' },
} as const;

interface Props {
  url: string;
  loading: boolean;
  /** 导航是写操作：只有人持控制权时地址栏才可编辑（PRD 5.3）。 */
  editable: boolean;
  /** 环境是否在运行。决定「不能改」的理由：没启动 vs 没接管。 */
  running: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  inspectorOpen: boolean;
  /** ⌘L 的自增令牌。菜单加速键在主进程，够不到这里的 ref，只能靠令牌触发。 */
  focusToken?: number;
  onToggleInspector: () => void;
  onOpenDevTools: () => void;
  onNavigate: (action: NavigationAction) => void;
}

/**
 * 地址栏行：前进/后退/刷新 + omnibox。
 *
 * 交互照抄 bb 的 `BrowserTabContent.tsx`：**失焦时显示实时 URL，聚焦时切到草稿并全选**。
 * 不这么做的话，页面自己跳转会把用户正在敲的地址冲掉。
 */
export function EnvironmentAddressBar({
  url,
  loading,
  editable,
  running,
  canGoBack,
  canGoForward,
  inspectorOpen,
  focusToken = 0,
  onToggleInspector,
  onOpenDevTools,
  onNavigate,
}: Props) {
  const [draft, setDraft] = useState(url);
  const [editing, setEditing] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [history, setHistory] = useState<UrlHistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘L / Ctrl+L 聚焦地址栏，和真实浏览器一致。不可编辑时什么都不做。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'l') return;
      if (!editable) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editable]);

  // ⌘L 的第二条来路：应用菜单的加速键（页面持焦点时键事件到不了渲染层的 DOM）。
  // 令牌从 0 起，所以首次挂载不会抢焦点。
  useEffect(() => {
    if (!focusToken || !editable) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken, editable]);

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

  const security = SECURITY_ICON[addressSecurity(url)];

  /**
   * 按钮不能用的**理由**要说清楚，而且不能三个按钮都变成同一句话——
   * 那样 hover 谁都分不出是哪个键。所以保留动作名，把理由附在后面。
   */
  const disabledReason = editable ? null : running ? '需要先接管控制权' : '环境未启动';
  const title = (label: string) => (disabledReason ? `${label}（${disabledReason}）` : label);

  const submit = (input = draft) => {
    const target = resolveAddressInput(input);
    if (target === null) {
      // 不静默搜索——裸词解析不出来就说清楚，见 lib/address-input.ts
      toast.error('这不是一个可访问的地址', {
        description: '只接受 http/https 地址，例如 example.com 或 https://example.com/path',
      });
      return;
    }
    if (target !== url) onNavigate({ kind: 'goto', url: target });
    setHistoryOpen(false);
    inputRef.current?.blur();
  };

  const suggestionsVisible = historyOpen && history.length > 0;
  const chooseHistory = (entry: UrlHistoryEntry) => {
    setDraft(entry.url);
    setHistoryQuery(entry.url);
    submit(entry.url);
  };

  return (
    <div className="flex h-[var(--shell-address-row-height)] shrink-0 items-center gap-1 px-2">
      <IconButton
        variant="ghost"
        title={title('后退')}
        disabled={!editable || !canGoBack}
        onClick={() => onNavigate({ kind: 'back' })}
      >
        <Icon name="ChevronLeft" />
      </IconButton>
      <IconButton
        variant="ghost"
        title={title('前进')}
        disabled={!editable || !canGoForward}
        onClick={() => onNavigate({ kind: 'forward' })}
      >
        <Icon name="ChevronRight" />
      </IconButton>
      <IconButton
        variant="ghost"
        title={title('刷新')}
        disabled={!editable}
        onClick={() => onNavigate({ kind: 'reload' })}
      >
        <Icon name="Refresh" />
      </IconButton>

      <div className="relative min-w-0 flex-1">
        <div
          className={cn(
            'flex h-8 min-w-0 items-center gap-2 rounded-full border border-border/70 bg-[var(--input-fill)] px-3',
            'focus-within:border-focus',
            !editable && 'opacity-70',
          )}
        >
          <span title={security.label} className="flex shrink-0 items-center">
            <Icon name={security.name} className={security.className} aria-label={security.label} />
          </span>
          <input
            ref={inputRef}
            type="text"
            value={editing ? draft : url}
            readOnly={!editable}
            spellCheck={false}
            autoComplete="off"
            placeholder={editable ? '输入地址，例如 example.com' : running ? '需要先接管才能改地址' : '环境未启动'}
            aria-label="地址栏"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="address-history"
            aria-expanded={suggestionsVisible}
            aria-activedescendant={
              suggestionsVisible && highlighted >= 0 ? `address-history-${highlighted}` : undefined
            }
            aria-disabled={!editable}
            onChange={(event) => {
              setDraft(event.target.value);
              setHistoryQuery(event.target.value);
              setHistoryOpen(true);
            }}
            onFocus={(event) => {
              if (!editable) {
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
                  return;
                }
                setEditing(false);
                inputRef.current?.blur();
              }
            }}
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground read-only:cursor-default"
          />
          {loading && <Spinner className="ml-auto shrink-0" />}
        </div>

        {suggestionsVisible && (
          <MenuSurface
            id="address-history"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 地址联想不能把候选列表塞进表单控件，datalist 也无法承载高亮/计数样式
            role="listbox"
            data-open="true"
            aria-label="跨环境地址历史"
            className="absolute inset-x-0 top-[calc(100%+4px)] max-h-80 overflow-y-auto"
          >
            <MenuLabel>{historyQuery ? '历史联想' : '最近访问（所有环境）'}</MenuLabel>
            {history.map((entry, index) => (
              <button
                key={entry.url}
                id={`address-history-${index}`}
                type="button"
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 候选需要组合键高亮和鼠标选择，语义上就是 listbox option
                role="option"
                aria-selected={index === highlighted}
                data-highlighted={index === highlighted ? '' : undefined}
                className={cn(
                  menuItemInteractiveClass,
                  'flex w-full items-center gap-2 px-[var(--control-pad-x-compact)] py-[var(--control-pad-y-compact)] text-left',
                  index === highlighted && 'bg-surface-hover opacity-100',
                )}
                onMouseEnter={() => setHighlighted(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  chooseHistory(entry);
                }}
              >
                <Icon name="Globe" className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.url}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{entry.visitCount} 次</span>
              </button>
            ))}
          </MenuSurface>
        )}
      </div>

      {/* 复制按钮放胶囊外面：胶囊里塞不下 28 的按钮，塞 20 的又比行里其他按钮小一圈 */}
      <IconButton
        variant="ghost"
        title="复制当前 URL"
        disabled={url.length === 0}
        onClick={() => void navigator.clipboard.writeText(url)}
      >
        <Icon name="Copy" />
      </IconButton>

      <IconButton
        variant="ghost"
        title={editable ? '开发者工具' : title('开发者工具')}
        disabled={!editable}
        onClick={onOpenDevTools}
      >
        <Icon name="Code" />
      </IconButton>

      <IconButton
        variant="ghost"
        title={inspectorOpen ? '收起检查器' : '展开检查器'}
        aria-expanded={inspectorOpen}
        onClick={onToggleInspector}
        className="aria-expanded:bg-surface-active aria-expanded:text-foreground"
      >
        <Icon name="PanelRight" />
      </IconButton>
    </div>
  );
}
