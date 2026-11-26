import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error?: Error;
  stack?: string;
}

/**
 * 顶层错误边界。
 *
 * 没有它时，任何一个组件在渲染期抛错都会让 React 卸载整棵树——
 * 窗口变成一片空白，而且没有可见的线索。这个项目里已经真出现过一次：
 * base-ui 的 ContextMenuLabel 少了 ContextMenuGroup 父节点，
 * 结果是整个侧栏消失，而不是只坏那一个菜单。
 *
 * 渲染层的异常要看得见，且要能继续用（至少能去插件面板或看日志）。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 主进程侧也能看到，方便 agent 用 debug.rendererEval / 事件流排查
    console.error('[renderer] uncaught render error', error, info.componentStack);
    this.setState({ stack: info.componentStack ?? undefined });
  }

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full flex-col gap-3 overflow-auto bg-background p-6 text-foreground">
        <h1 className="text-sm font-medium text-destructive">界面渲染出错</h1>
        <p className="text-xs text-muted-foreground">
          环境本身没有受影响：Core 和本地 RPC 仍在运行，agent 侧照常可用。
        </p>
        <pre className="max-h-64 overflow-auto rounded-[var(--radius-md)] border bg-muted/30 p-3 text-xs">
          {error.message}
        </pre>
        {stack && (
          <pre className="max-h-64 overflow-auto rounded-[var(--radius-md)] border bg-muted/30 p-3 text-[length:var(--font-size-micro)] leading-relaxed text-muted-foreground">
            {stack}
          </pre>
        )}
        <div>
          <button
            type="button"
            className="rounded-[var(--radius-md)] border px-3 py-1.5 text-xs hover:bg-accent"
            onClick={() => this.setState({ error: undefined, stack: undefined })}
          >
            重试渲染
          </button>
        </div>
      </div>
    );
  }
}
