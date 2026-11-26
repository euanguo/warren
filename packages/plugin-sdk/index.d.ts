export type PluginRuntime = 'sandbox' | 'host';

export interface PluginCommandDecl {
  name: string;
  summary: string;
}

export interface PluginSettingDescriptor {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'secret';
  label: string;
  description?: string;
  default?: string | number | boolean;
  options?: string[];
}

export type PluginSurfaceKind =
  | 'railPage'
  | 'settingsSection'
  | 'envAction'
  | 'inspectorTab'
  | 'envBadge'
  | 'popover'
  | 'commandBarAction'
  | 'statusBadge';

export interface PluginSurfaceDecl {
  kind: PluginSurfaceKind;
  id: string;
  title: string;
  description?: string;
  icon?: string;
  command?: string;
  path?: string;
}

export type PluginBusEventType = 'nav.committed' | 'lease.changed' | 'tab.created' | 'env.status' | 'net.hit';

export interface PluginEventFilter {
  environmentId?: string;
  types?: PluginBusEventType[];
}

export interface PluginBusEvent {
  type: PluginBusEventType;
  environmentId: string;
  at: string;
  payload: Record<string, unknown>;
}

export interface PluginContributes {
  commands: PluginCommandDecl[];
  settings: PluginSettingDescriptor[];
  surfaces: PluginSurfaceDecl[];
  rpc: string[];
}

export interface WarrenPackageMetadata {
  id: string;
  name: string;
  apiVersion: '4';
  runtime: PluginRuntime;
  server?: string;
  host?: string;
  app?: string;
  icon?: string;
  engines?: { warren?: string };
  permissions: string[];
  contributes: PluginContributes;
}

/** 插件 package.json 的最小形状。 */
export interface WarrenPluginPackageJson {
  name: string;
  version: string;
  description?: string;
  dependencies?: Record<string, string>;
  bundleDependencies?: string[];
  warren: WarrenPackageMetadata;
}

export interface PluginHost {
  log: {
    debug(message: string): Promise<void>;
    info(message: string): Promise<void>;
    warn(message: string): Promise<void>;
    error(message: string): Promise<void>;
  };
  signal: {
    publish(channel: string, payload: unknown): Promise<void>;
  };
  events: {
    emit(type: string, message: string): Promise<{ ok: boolean }>;
    subscribe(
      filter: PluginEventFilter,
      handler: (event: PluginBusEvent) => void | Promise<void>,
    ): Promise<() => Promise<void>>;
  };
  ui: {
    notify(message: string): Promise<void>;
  };
  storage: {
    kv: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<boolean>;
      list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
    };
    sql: {
      exec(sql: string): Promise<void>;
      run(sql: string, params?: unknown[]): Promise<unknown>;
      query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
      migrate(statements: string[]): Promise<number>;
    };
  };
  settings: {
    get(): Promise<Record<string, string | number | boolean | undefined>>;
  };
  environment: {
    list(): Promise<Array<{ id: string; name: string; status: string }>>;
    get(id: string): Promise<{ id: string; name: string; status: string } | null>;
  };
  browser: {
    url(): Promise<string>;
    title(): Promise<string>;
  };
}

export interface PluginContext<I = unknown> {
  pluginId: string;
  environmentId?: string;
  command?: string;
  input?: I;
  leaseId?: string;
  host: PluginHost;
}

export type PluginCommand<I = unknown, O = unknown> = (ctx: PluginContext<I>) => O | Promise<O>;
