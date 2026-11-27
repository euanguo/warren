export type PluginRuntime = 'sandbox' | 'host';

export type SpaceId = 'person' | 'agent';

export type BuiltinSettingsSection = 'general' | 'browser' | 'memory' | 'agent' | 'plugins' | 'diagnostics';

export interface OverlayFormOption {
  value: string;
  label: string;
}

/** 声明式表单字段：只描述，宿主自己画（校验与裁剪在主进程入口）。 */
export type OverlayFormField =
  | {
      type: 'text';
      key: string;
      label: string;
      placeholder?: string;
      initial?: string;
      required?: boolean;
      maxLength?: number;
    }
  | {
      type: 'textarea';
      key: string;
      label: string;
      placeholder?: string;
      initial?: string;
      required?: boolean;
      maxLength?: number;
    }
  | {
      type: 'number';
      key: string;
      label: string;
      initial?: number;
      min?: number;
      max?: number;
      step?: number;
      required?: boolean;
    }
  | { type: 'select'; key: string; label: string; initial?: string; options: OverlayFormOption[] }
  | { type: 'switch'; key: string; label: string; description?: string; initial?: boolean };

/** text / textarea / select 给字符串，number 给数字（空且非必填时为空串），switch 给布尔。 */
export type OverlayFormValues = Record<string, string | number | boolean>;

export interface OverlayFormRequest {
  title: string;
  description?: string;
  submitLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** 谁在问：显示成标题下的一行小字，一般是插件名。 */
  source?: string;
  fields: OverlayFormField[];
}

/**
 * 可授予权限（共 14 项：`granted` 6 项 + `confirm` 8 项）。
 * 以下 5 项永久留在 `denied` 层，即使声明也不会生效：
 * `browser.evaluate` | `storage.cookie.read` | `storage.cookie.write` | `process.spawn` | `filesystem.read`
 */
export type PluginPermission =
  | 'environment.read'
  | 'environment.write'
  | 'browser.dom.read'
  | 'browser.screenshot'
  | 'browser.navigate'
  | 'browser.input'
  | 'storage.cookie.port'
  | 'vault.fill'
  | 'network.observe'
  | 'network.fetch'
  | 'ui.mount'
  | 'storage.write'
  | 'rpc.serve'
  | 'events.subscribe';

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

export interface PluginSettingValue {
  key: string;
  label: string;
  type: PluginSettingDescriptor['type'];
  description?: string;
  options?: string[];
  value?: string | number | boolean;
  configured: boolean;
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
  shortcut?: string;
}

export type PluginBusEventType =
  'nav.committed' | 'lease.changed' | 'tab.created' | 'tab.activated' | 'space.switched' | 'env.status' | 'net.hit';

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

export interface WarrenSkillMetadata {
  entry: string;
  summary?: string;
  triggers?: string[];
  references?: string[];
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
  skill?: string | WarrenSkillMetadata;
  engines?: { warren?: string };
  permissions: PluginPermission[];
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

export interface CookieSummary {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  expirationDate?: number;
}

export interface CookieInput {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
}

export interface PluginHostEnvironmentSummary {
  id: string;
  name: string;
  status: 'stopped' | 'starting' | 'running' | 'dormant' | 'error';
  proxy?: string;
  owner: 'none' | 'agent' | 'human';
  groupId?: string;
  currentUrl?: string;
  title?: string;
  error?: string;
}

export interface PluginHost {
  log: {
    debug(message: string): Promise<void>;
    info(message: string): Promise<void>;
    warn(message: string): Promise<void>;
    error(message: string): Promise<void>;
  };
  signal: {
    publish(channel: string, payload: unknown): Promise<{ ok: boolean } | void>;
  };
  events: {
    emit(type: string, message: string): Promise<{ ok: boolean }>;
    subscribe(
      filter: PluginEventFilter,
      handler: (event: PluginBusEvent) => void | Promise<void>,
    ): Promise<() => Promise<void>>;
    unsubscribe(subscriptionId: string): Promise<{ ok: boolean }>;
  };
  ui: {
    notify(message: string): Promise<{ ok: boolean } | void>;
  };
  storage: {
    kv: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<{ ok: boolean } | void>;
      delete(key: string): Promise<{ deleted: boolean } | boolean>;
      list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
    };
    sql: {
      exec(sql: string): Promise<{ ok: boolean } | void>;
      run(sql: string, params?: unknown[]): Promise<unknown>;
      query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
      migrate(statements: string[]): Promise<{ applied: number } | number>;
    };
  };
  /** 受控 Cookie 搬运通道（需 `storage.cookie.port` 权限，只搬运不返回 Cookie 明文值）。 */
  cookie: {
    names(options?: { url?: string }): Promise<CookieSummary[]>;
    copy(input: { from: string; to?: string; domain?: string; name?: string }): Promise<{ copied: number }>;
    import(input: { cookies: CookieInput[] }): Promise<{ imported: number }>;
    clear(input?: { domain?: string; name?: string }): Promise<{ removed: number }>;
  };
  settings: {
    get(): Promise<Record<string, string | number | boolean | undefined>>;
  };
  environment: {
    list(): Promise<
      Array<{ id: string; name: string; status: string; storagePath: string; proxy?: string; trustedCa?: string }>
    >;
    get(id: string): Promise<{
      id: string;
      name: string;
      status: string;
      storagePath: string;
      proxy?: string;
      trustedCa?: string;
    } | null>;
    update(input: { id: string; proxy?: string | null; trustedCa?: string | null }): Promise<unknown>;
    start(id: string): Promise<unknown>;
    stop(id: string): Promise<{ ok: boolean }>;
  };
  vault: {
    maskHint(username: string): Promise<string>;
  };
  browser: {
    url(): Promise<string>;
    title(): Promise<string>;
    info(
      environmentId?: string,
      options?: { space?: SpaceId },
    ): Promise<{ url: string; title: string; loading: boolean }>;
    detectLoginFields(environmentId?: string, options?: { space?: SpaceId }): Promise<unknown>;
    events(): Promise<unknown[]>;
    snapshot(): Promise<{ url: string; title: string; nodes: unknown[] }>;
    highlight(target?: unknown): Promise<unknown>;
    screenshot(options?: Record<string, unknown>): Promise<unknown>;
    waitFor(predicate: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<void>;
    waitForSelector(target: unknown, options?: { state?: string; timeoutMs?: number }): Promise<unknown>;
    waitForURL(matcher: unknown, options?: { timeoutMs?: number }): Promise<{ url: string }>;
    waitForFunction(fn: string, arg?: unknown, options?: { timeoutMs?: number; polling?: number }): Promise<unknown>;
    waitForLoadState(state?: string, options?: { timeoutMs?: number; idleMs?: number }): Promise<void>;
    waitForTimeout(ms: number): Promise<void>;
    waitForEvent(kind: string, options?: { timeoutMs?: number }): Promise<unknown>;
    navigate(url: string): Promise<{ url: string }>;
    reload(options?: Record<string, unknown>): Promise<{ url: string }>;
    goBack(): Promise<unknown>;
    goForward(): Promise<unknown>;
    click(target: unknown, options?: Record<string, unknown>): Promise<unknown>;
    dblclick(target: unknown, options?: Record<string, unknown>): Promise<unknown>;
    hover(target: unknown, options?: Record<string, unknown>): Promise<unknown>;
    drag(source: unknown, target: unknown, options?: Record<string, unknown>): Promise<unknown>;
    fill(target: unknown, value: string, options?: Record<string, unknown>): Promise<unknown>;
    selectOption(target: unknown, value: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
    focus(target: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
    press(key: string): Promise<unknown>;
    setInputFiles(target: unknown, paths: string | string[]): Promise<unknown>;
    acceptDialog(promptText?: string): Promise<unknown>;
    dismissDialog(): Promise<unknown>;
    openTab(url: string, options?: { environmentId?: string; space?: SpaceId; activate?: boolean }): Promise<unknown>;
    console(): Promise<unknown[]>;
    network(): Promise<unknown[]>;
    fillSecret(
      environmentId: string,
      target: unknown,
      value: string,
      options?: { space?: SpaceId; allowedDomains?: string[]; requireDomains?: boolean },
    ): Promise<{ filled: boolean; space: SpaceId }>;
  };
}

export interface PluginContext<I = unknown> {
  pluginId: string;
  environmentId?: string;
  command?: string;
  input?: I;
  leaseId?: string;
  caller?: 'ui' | 'agent';
  host: PluginHost;
}

export type PluginCommand<I = unknown, O = unknown> = (ctx: PluginContext<I>) => O | Promise<O>;

export type PluginRpcHandler<I = unknown, O = unknown> = (input: I, ctx: PluginContext<I>) => O | Promise<O>;

export interface PluginServerModule {
  activate?(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  commands?: Record<string, PluginCommand>;
  rpc?: Record<string, PluginRpcHandler>;
}

export type PluginEnvBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface PluginEnvBadge {
  icon?: string;
  /** 最多 3 个字符；setter 会自动截断。 */
  label: string;
  tone?: PluginEnvBadgeTone;
}

export interface PluginEnvBadgeSurface {
  id: string;
  title: string;
  icon?: string;
  description?: string;
}

export interface PluginEnvBadgeSetter {
  set(envId: string, badge: PluginEnvBadge | null): void;
  clear(): void;
}

export interface PluginSurfaceProps {
  pluginId: string;
  environmentId?: string;
  space?: SpaceId;
  url?: string;
  closePopover?: () => void;
  openPluginPage?: (surfaceId?: string) => void;
  openInspectorTab?: (surfaceId?: string) => void;
}

export interface PluginShellApi {
  closePopover(): Promise<void>;
  resizePopover(size: { width: number; height: number }): Promise<void>;
  openPopover(surfaceId: string, options?: { width?: number; height?: number }): void;
  openPage(surfaceId?: string): void;
  openSettings(section?: BuiltinSettingsSection): void;
  openInspectorTab(surfaceId?: string): void;
  openTab(environmentId: string, url: string, space?: SpaceId): Promise<void>;
  highlight(environmentId: string, selector?: string, space?: SpaceId): Promise<void>;
  notify(kind: 'success' | 'error' | 'info', title: string, description?: string): void;
  /**
   * 用宿主原生表单收一组值（主窗的面可用；独立浮窗会拒绝，那里用插件自己的内联表单）。
   * 返回 null = 用户取消；提交是值级的，回来之后再写数据，失败自己 toast。
   */
  openForm(request: OverlayFormRequest): Promise<OverlayFormValues | null>;
}

export interface PluginHostApi {
  environment: {
    list(): Promise<PluginHostEnvironmentSummary[]>;
    get(id: string): Promise<PluginHostEnvironmentSummary | null>;
    activeContext(): Promise<{
      environmentId: string | null;
      space: SpaceId;
      tabId: string | null;
      url: string;
      title: string;
    }>;
  };
  browser: {
    info(environmentId: string, options?: { space?: SpaceId }): Promise<{ url: string; title: string }>;
  };
}

export interface PluginSettingsHook {
  values: PluginSettingValue[];
  isLoading: boolean;
  refresh(): Promise<void>;
}

/** 宿主注入的 `app.ui`（对应渲染层 `PLUGIN_UI`，以 React 组件与 Recipe 类名导出）。 */
export interface PluginUi {
  cn(...inputs: unknown[]): string;
  toast: {
    success(message: string, options?: { description?: string }): unknown;
    error(message: string, options?: { description?: string }): unknown;
    info(message: string, options?: { description?: string }): unknown;
    warning(message: string, options?: { description?: string }): unknown;
  };
  cardSurfaceClass: string;
  controlFieldClass: string;
  elevatedMenuSurfaceClass: string;
  menuItemInteractiveClass: string;
  Icon: import('react').ComponentType<{ name: string; className?: string }>;
  PluginBrandGlyph?: import('react').ComponentType<{
    pluginId: string;
    icon?: string;
    variant?: 'icon' | 'chip';
    size?: number;
    className?: string;
    iconClassName?: string;
  }>;
  Button: import('react').ComponentType<Record<string, unknown>>;
  IconButton: import('react').ComponentType<Record<string, unknown>>;
  Input: import('react').ComponentType<Record<string, unknown>>;
  Textarea: import('react').ComponentType<Record<string, unknown>>;
  Switch: import('react').ComponentType<Record<string, unknown>>;
  Checkbox: import('react').ComponentType<Record<string, unknown>>;
  Badge: import('react').ComponentType<Record<string, unknown>>;
  Kbd: import('react').ComponentType<Record<string, unknown>>;
  StatusDot: import('react').ComponentType<Record<string, unknown>>;
  StatusMark: import('react').ComponentType<Record<string, unknown>>;
  Separator: import('react').ComponentType<Record<string, unknown>>;
  Spinner: import('react').ComponentType<Record<string, unknown>>;
  Alert: import('react').ComponentType<Record<string, unknown>>;
  AlertTitle: import('react').ComponentType<Record<string, unknown>>;
  AlertDescription: import('react').ComponentType<Record<string, unknown>>;
  Card: import('react').ComponentType<Record<string, unknown>>;
  CardHeader: import('react').ComponentType<Record<string, unknown>>;
  CardTitle: import('react').ComponentType<Record<string, unknown>>;
  CardDescription: import('react').ComponentType<Record<string, unknown>>;
  CardAction: import('react').ComponentType<Record<string, unknown>>;
  CardContent: import('react').ComponentType<Record<string, unknown>>;
  CardFooter: import('react').ComponentType<Record<string, unknown>>;
  ResizablePanelGroup: import('react').ComponentType<Record<string, unknown>>;
  ResizablePanel: import('react').ComponentType<Record<string, unknown>>;
  ResizableHandle: import('react').ComponentType<Record<string, unknown>>;
  Collapsible: import('react').ComponentType<Record<string, unknown>>;
  CollapsibleTrigger: import('react').ComponentType<Record<string, unknown>>;
  CollapsibleContent: import('react').ComponentType<Record<string, unknown>>;
  Field: import('react').ComponentType<Record<string, unknown>>;
  FieldLabel: import('react').ComponentType<Record<string, unknown>>;
  FieldDescription: import('react').ComponentType<Record<string, unknown>>;
  FieldError: import('react').ComponentType<Record<string, unknown>>;
  Dialog: import('react').ComponentType<Record<string, unknown>>;
  DialogTrigger: import('react').ComponentType<Record<string, unknown>>;
  DialogClose: import('react').ComponentType<Record<string, unknown>>;
  DialogContent: import('react').ComponentType<Record<string, unknown>>;
  DialogHeader: import('react').ComponentType<Record<string, unknown>>;
  DialogTitle: import('react').ComponentType<Record<string, unknown>>;
  DialogDescription: import('react').ComponentType<Record<string, unknown>>;
  DialogFooter: import('react').ComponentType<Record<string, unknown>>;
  AlertDialog: import('react').ComponentType<Record<string, unknown>>;
  AlertDialogContent: import('react').ComponentType<Record<string, unknown>>;
  AlertDialogHeader: import('react').ComponentType<Record<string, unknown>>;
  AlertDialogTitle: import('react').ComponentType<Record<string, unknown>>;
  AlertDialogDescription: import('react').ComponentType<Record<string, unknown>>;
  AlertDialogFooter: import('react').ComponentType<Record<string, unknown>>;
  AlertDialogAction: import('react').ComponentType<Record<string, unknown>>;
  AlertDialogCancel: import('react').ComponentType<Record<string, unknown>>;
  Select: import('react').ComponentType<Record<string, unknown>>;
  SelectTrigger: import('react').ComponentType<Record<string, unknown>>;
  SelectValue: import('react').ComponentType<Record<string, unknown>>;
  SelectContent: import('react').ComponentType<Record<string, unknown>>;
  SelectItem: import('react').ComponentType<Record<string, unknown>>;
  SelectGroup: import('react').ComponentType<Record<string, unknown>>;
  SelectLabel: import('react').ComponentType<Record<string, unknown>>;
  SelectSeparator: import('react').ComponentType<Record<string, unknown>>;
  DropdownMenu: import('react').ComponentType<Record<string, unknown>>;
  DropdownMenuTrigger: import('react').ComponentType<Record<string, unknown>>;
  DropdownMenuContent: import('react').ComponentType<Record<string, unknown>>;
  DropdownMenuItem: import('react').ComponentType<Record<string, unknown>>;
  DropdownMenuLabel: import('react').ComponentType<Record<string, unknown>>;
  DropdownMenuSeparator: import('react').ComponentType<Record<string, unknown>>;
  Tooltip: import('react').ComponentType<Record<string, unknown>>;
  TooltipProvider: import('react').ComponentType<Record<string, unknown>>;
  TooltipTrigger: import('react').ComponentType<Record<string, unknown>>;
  TooltipContent: import('react').ComponentType<Record<string, unknown>>;
  ScrollArea: import('react').ComponentType<Record<string, unknown>>;
  Tabs: import('react').ComponentType<Record<string, unknown>>;
  TabsList: import('react').ComponentType<Record<string, unknown>>;
  TabsTrigger: import('react').ComponentType<Record<string, unknown>>;
  TabsContent: import('react').ComponentType<Record<string, unknown>>;
  Empty: import('react').ComponentType<Record<string, unknown>>;
  EmptyHeader: import('react').ComponentType<Record<string, unknown>>;
  EmptyMedia: import('react').ComponentType<Record<string, unknown>>;
  EmptyTitle: import('react').ComponentType<Record<string, unknown>>;
  EmptyDescription: import('react').ComponentType<Record<string, unknown>>;
  EmptyContent: import('react').ComponentType<Record<string, unknown>>;
  ListRow: import('react').ComponentType<Record<string, unknown>>;
  ListRowMain: import('react').ComponentType<Record<string, unknown>>;
  ListRowLabel: import('react').ComponentType<Record<string, unknown>>;
  ListRowLabelText: import('react').ComponentType<Record<string, unknown>>;
  ListRowMeta: import('react').ComponentType<Record<string, unknown>>;
  ListRowActions: import('react').ComponentType<Record<string, unknown>>;
  ListRowActionButton: import('react').ComponentType<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface PluginAppApi {
  pluginId: string;
  React: typeof import('react');
  h: typeof import('react').createElement;
  ui: PluginUi;
  rpc: { call<T = unknown>(method: string, input?: unknown): Promise<T> };
  host: PluginHostApi;
  shell: PluginShellApi;
  settings: PluginSettingValue[];
  useSettings(): PluginSettingsHook;
  useSignal(channel: string, handler: (payload: unknown) => void): void;
  log(message: string): void;
  surfaces: {
    railPage(surface: {
      id: string;
      title: string;
      icon?: string;
      path?: string;
      component: import('react').ComponentType<PluginSurfaceProps>;
    }): void;
    settingsSection(surface: {
      id: string;
      title: string;
      description?: string;
      icon?: string;
      component: import('react').ComponentType<PluginSurfaceProps>;
    }): void;
    inspectorTab(surface: {
      id: string;
      title: string;
      icon?: string;
      component: import('react').ComponentType<PluginSurfaceProps>;
    }): void;
    popover(surface: {
      id: string;
      title: string;
      icon?: string;
      shortcut?: string;
      width?: number;
      height?: number;
      component: import('react').ComponentType<PluginSurfaceProps>;
    }): void;
    commandBarAction(surface: {
      id: string;
      title: string;
      description?: string;
      icon?: string;
      shortcut?: string;
      command?: string;
      onTrigger?: (environmentId?: string) => Promise<void> | void;
    }): void;
    statusBadge(surface: {
      id: string;
      title: string;
      icon?: string;
      component?: import('react').ComponentType<PluginSurfaceProps>;
    }): void;
    envBadge(surface: PluginEnvBadgeSurface): PluginEnvBadgeSetter;
  };
}

export type PluginRegisterFn = (app: PluginAppApi) => void | Promise<void>;

export interface PluginFrontendModule {
  register: PluginRegisterFn;
}
