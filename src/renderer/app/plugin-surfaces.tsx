/**
 * 插件面的渲染与隔离。
 *
 * 每个插件面都包在自己的错误边界里：一个坏插件只能坏它自己那一块，
 * 不能像 base-ui 那次一样把整棵树卸载成白屏。
 */
import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import type { PluginSurfaceProps } from '@/lib/plugin-sdk-types';

interface BoundaryProps {
  pluginId: string;
  title: string;
  children: ReactNode;
}

interface BoundaryState {
  error?: Error;
}

export class PluginBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = {};

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[plugin:${this.props.pluginId}] 渲染出错`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div data-slot="plugin-surface-error" className="flex h-full flex-col gap-2 overflow-auto p-4 text-sm">
        <div className="flex items-center gap-2 text-destructive">
          <Icon name="AlertTriangle" />
          插件「{this.props.title}」渲染出错
        </div>
        <p className="text-xs text-muted-foreground">
          只有这一块停了，应用的其它部分照常可用。可以在设置 → 插件里停用它。
        </p>
        <pre className="overflow-auto rounded-[var(--radius-md)] border border-border bg-muted/30 p-3 text-xs">
          {error.message}
        </pre>
        <button
          type="button"
          className="self-start rounded-[var(--radius-md)] border border-border px-3 py-1.5 text-xs hover:bg-accent"
          onClick={() => this.setState({ error: undefined })}
        >
          重试渲染
        </button>
      </div>
    );
  }
}

/** 按插件包一层边界再渲染面组件。 */
export function PluginSurfaceHost({
  pluginId,
  title,
  Component,
  props,
}: {
  pluginId: string;
  title: string;
  Component: ComponentType<PluginSurfaceProps>;
  props: PluginSurfaceProps;
}) {
  return (
    <PluginBoundary pluginId={pluginId} title={title}>
      <Component {...props} />
    </PluginBoundary>
  );
}
